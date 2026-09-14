//! The run loop (section 2.4): lock, config, effective modes, adapters on
//! scoped threads, sink, buckets, envelopes, outbox, upload, summary.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use observatory_contract::IdentityRequest;
use observatory_contract::settings::{DetailLevel, ProjectAttribution, ToolDetail};
use observatory_contract::{
    AdapterCoverage, AgentClass, Arch, BucketEntry, CollectionSettings, ConfigDocument, Counter,
    CoverageState, CursorState, DetailCode, Envelope, Nullable, Platform, Provider, Record, Run, Sha256Hex,
    Stamp, Text, Uuid,
};
use serde::Serialize;
use thiserror::Error;

use crate::adapter::{
    Adapter, AdapterId, BindingContext, Cursor, IdentityState, MemorySink, Outcome, Preflight, RunContext,
};
use crate::config::{CompanionConfig, ConfigError};
use crate::discovery;
use crate::effective::{Effective, effective};
use crate::http::{Client, ConfigFetch, HttpError};
use crate::outbox;
use crate::paths;
use crate::pyjson::{digest, epoch_text};
use crate::state::{AdapterStateRow, CachedConfig, RecordRow, RunRow, State, StateError};
use crate::{VERSION, lock};

#[derive(Debug, Error)]
pub enum RunError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Http(#[from] HttpError),
    #[error("the pinned backfill start is not a valid date")]
    InvalidSince,
    #[error("the state identity for a binding changed; re-confirm it in the Observatory")]
    IdentityChanged,
}

/// How the effective config document was obtained.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigSource {
    Fetched,
    NotModified,
    Cached,
    Defaults,
}

#[derive(Debug)]
pub struct RunOptions {
    pub dry_run: bool,
    /// Whether to contact the Observatory for the config document.
    pub fetch_config: bool,
    pub budget: Duration,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions { dry_run: false, fetch_config: true, budget: Duration::from_secs(300) }
    }
}

/// Everything decided before adapters run. `doctor` uses this without collecting.
#[derive(Debug)]
pub struct Prepared {
    pub config: CompanionConfig,
    pub config_dir: PathBuf,
    pub ctx: RunContext,
    pub config_source: ConfigSource,
    pub config_error: Option<String>,
    pub lock: Option<lock::RunLock>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AdapterSummary {
    pub adapter: AdapterId,
    pub state: CoverageState,
    pub detail: Option<DetailCode>,
    pub mode: String,
    pub records: u64,
    pub files: u64,
    pub bytes_read: u64,
    pub malformed: u64,
    pub invalid: u64,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RunSummary {
    pub ok: bool,
    pub run_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub dry_run: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<&'static str>,
    pub config: ConfigSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_error: Option<String>,
    pub settings_version: u64,
    pub since: String,
    pub adapters: Vec<AdapterSummary>,
    pub buckets_pending: usize,
    pub records_pending: usize,
    pub envelopes: usize,
    pub upload_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publication: Option<outbox::Publication>,
    pub total_duration_ms: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub detailed_reports: Vec<crate::detailed::DetailedOutcome>,
}

fn default_since(now: Timestamp) -> String {
    let date = now.to_zoned(TimeZone::UTC).date();
    format!("{:04}-{:02}-01", date.year(), date.month())
}

fn validate_since(text: &str) -> bool {
    text.len() == 10 && text.parse::<Date>().is_ok()
}

fn resolve_roots(binding: &crate::config::LocalBinding) -> Vec<PathBuf> {
    if let Some(roots) = &binding.roots {
        return roots.clone();
    }
    match binding.provider {
        Provider::Claude => paths::claude_projects_root().into_iter().collect(),
        Provider::Codex => binding
            .codex_home
            .clone()
            .or_else(paths::codex_home)
            .map(|home| paths::codex_session_roots(&home))
            .unwrap_or_default(),
        Provider::Cursor | Provider::AnthropicApi | Provider::OpenaiApi => Vec::new(),
    }
}

fn local_identity(binding: &crate::config::LocalBinding) -> Option<Sha256Hex> {
    match binding.provider {
        Provider::Claude => discovery::claude_identity().map(|identity| identity.evidence_hash),
        Provider::Codex => binding
            .codex_home
            .clone()
            .or_else(paths::codex_home)
            .and_then(|home| discovery::codex_identity(&home))
            .map(|identity| identity.evidence_hash),
        Provider::Cursor | Provider::AnthropicApi | Provider::OpenaiApi => None,
    }
}

/// Loads configuration and state, fetches or reuses the config document, and
/// builds the run context. Takes the single-run lock when `take_lock` is set.
pub fn prepare(config_dir: &Path, options: &RunOptions, take_lock: bool) -> Result<Prepared, RunError> {
    let config = CompanionConfig::load(config_dir)?;
    let now = Timestamp::now();
    let lock = if take_lock { lock::acquire(&config.lock_path(config_dir))? } else { None };
    if take_lock && lock.is_none() {
        // Return a context anyway; `execute` reports the skip.
    }
    let state_path = config.state_path(config_dir);
    let state = State::open(&state_path)?;
    state.set_meta_if_absent("install_id", config.install_id.as_str())?;

    // Pin the backfill start on first run; it cannot change without new state.
    let since_text = match state.meta("since")? {
        Some(pinned) => pinned,
        None => {
            let chosen = config.since.clone().unwrap_or_else(|| default_since(now));
            if !validate_since(&chosen) {
                return Err(RunError::InvalidSince);
            }
            state.set_meta("since", &chosen)?;
            chosen
        }
    };
    let since = epoch_text(&format!("{since_text}T00:00:00Z")).ok_or(RunError::InvalidSince)?;

    // Config document: fetch with If-None-Match, fall back to the cache, else defaults.
    let cached = state.cached_config()?;
    let mut config_source = ConfigSource::Defaults;
    let mut config_error = None;
    let mut document: Option<ConfigDocument> = None;
    if options.fetch_config {
        match Client::new(&config.url, Some(config.key.clone())) {
            Ok(client) => match client.fetch_config(cached.as_ref().and_then(|c| c.etag.as_deref())) {
                Ok(ConfigFetch::Document { document: fetched, etag, text }) => {
                    state.save_cached_config(&CachedConfig {
                        document: text,
                        settings_version: fetched.settings_version.get(),
                        etag,
                        fetched_at: Stamp::from_timestamp(now).as_str().to_owned(),
                    })?;
                    document = Some(*fetched);
                    config_source = ConfigSource::Fetched;
                }
                Ok(ConfigFetch::NotModified) => {
                    config_source = ConfigSource::NotModified;
                }
                Err(error) => {
                    config_error = Some(outbox::error_code(&error));
                }
            },
            Err(error) => config_error = Some(outbox::error_code(&error)),
        }
    }
    if document.is_none()
        && let Some(cached) = &cached
        && let Ok(parsed) = serde_json::from_str::<ConfigDocument>(&cached.document)
    {
        document = Some(parsed);
        if config_source == ConfigSource::Defaults {
            config_source = ConfigSource::Cached;
        }
    }
    let (settings, settings_version) = match &document {
        Some(document) => (document.settings.clone(), document.settings_version.get()),
        None => (CollectionSettings::defaults(), 0),
    };

    // Bindings: the server's view when we have it, this machine's paths always.
    let mut bindings = Vec::new();
    let mut local_bindings = config.bindings.clone();
    if let Some(document) = &document {
        for server in &document.bindings {
            let local = match config.binding(&server.binding_id) {
                Some(local) => local.clone(),
                None => crate::config::LocalBinding {
                    binding_id: server.binding_id.clone(),
                    account_id: server.account_id.clone(),
                    provider: server.provider,
                    roots: None,
                    codex_home: None,
                    cursor_state_db: None,
                    detailed_report: None,
                },
            };
            if config.binding(&server.binding_id).is_none() {
                local_bindings.push(local.clone());
            }
            let roots = resolve_roots(&local);
            let pin_key = format!("identity:{}", local.binding_id);
            let pin = digest(&serde_json::json!([local.account_id.as_str(), local.provider.as_str(), roots]));
            let previous_pin = state.meta(&pin_key)?;
            let evidence = local_identity(&local);
            // A null server hash means the binding was created without evidence or the Observatory
            // approved a re-confirmation. Either way the install may post what it observes now; a
            // hash the Observatory has not approved is refused with 409 and pauses the binding.
            let mut server_hash = server.identity_hash.clone().into_inner();
            let mut identity_conflict = false;
            if server_hash.is_none()
                && options.fetch_config
                && let Some(local_hash) = &evidence
                && let Ok(client) = Client::new(&config.url, Some(config.key.clone()))
            {
                match client.confirm_identity(
                    &server.binding_id,
                    &IdentityRequest { identity_hash: local_hash.clone() },
                ) {
                    Ok(response) => server_hash = response.identity_hash.into_inner(),
                    Err(HttpError::Status(409)) => identity_conflict = true,
                    Err(_) => {}
                }
            }
            let identity = if identity_conflict || previous_pin.as_deref().is_some_and(|p| p != pin.as_str())
            {
                IdentityState::Changed
            } else if let Some(hash) = &server_hash {
                match &evidence {
                    Some(local_hash) if local_hash != hash => IdentityState::Changed,
                    _ => IdentityState::Confirmed,
                }
            } else if state.meta(&format!("identity_hash:{}", local.binding_id))?.is_some() {
                // The server hash is null after having been set and could not be re-confirmed yet.
                IdentityState::Changed
            } else {
                IdentityState::Unconfirmed
            };
            if previous_pin.is_none() {
                state.set_meta(&pin_key, pin.as_str())?;
            }
            if let Some(hash) = &server_hash {
                state.set_meta(&format!("identity_hash:{}", local.binding_id), hash.as_str())?;
            }
            bindings.push(BindingContext {
                binding_id: server.binding_id.clone(),
                account_id: server.account_id.clone(),
                provider: server.provider,
                enabled: server.enabled,
                identity_hash: server_hash.clone(),
                identity,
                roots,
                codex_home: local.codex_home.clone().or_else(paths::codex_home),
                cursor_state_db: local.cursor_state_db.clone().or_else(paths::cursor_state_db),
            });
        }
    } else {
        for local in &config.bindings {
            let roots = resolve_roots(local);
            bindings.push(BindingContext {
                binding_id: local.binding_id.clone(),
                account_id: local.account_id.clone(),
                provider: local.provider,
                enabled: true,
                identity_hash: None,
                identity: IdentityState::Unconfirmed,
                roots,
                codex_home: local.codex_home.clone().or_else(paths::codex_home),
                cursor_state_db: local.cursor_state_db.clone().or_else(paths::cursor_state_db),
            });
        }
    }
    let mut config = config;
    if local_bindings.len() != config.bindings.len() {
        config.bindings = local_bindings;
        config.save(config_dir)?;
    }

    let ctx = RunContext::new(
        now,
        since_text,
        since,
        settings,
        settings_version,
        document,
        bindings,
        config.deny.clone(),
        config_dir.to_path_buf(),
        state_path,
        config.statusline_inbox(config_dir),
        options.dry_run,
        options.budget,
    );
    Ok(Prepared { config, config_dir: config_dir.to_path_buf(), ctx, config_source, config_error, lock })
}

struct Collected {
    adapter: AdapterId,
    result: Result<Outcome, crate::adapter::AdapterError>,
    sink: MemorySink,
    elapsed: Duration,
}

fn coverage_entry(
    adapter: AdapterId,
    parser_version: &str,
    state: CoverageState,
    detail: Option<DetailCode>,
    outcome: Option<&Outcome>,
    duration: Duration,
    invalid: u64,
) -> AdapterCoverage {
    let parser = Text::<0, 30>::truncated(parser_version)
        .unwrap_or_else(|_| Text::try_from(String::new()).unwrap_or_else(|_| unreachable!()));
    let count = |value: u64| Counter::saturating(value);
    match outcome {
        Some(outcome) => AdapterCoverage {
            adapter,
            state,
            detail_code: Nullable(detail),
            stores_discovered: count(outcome.stores_discovered),
            files: count(outcome.files),
            bytes_read: count(outcome.bytes_read),
            records_emitted: count(outcome.records_emitted),
            malformed: count(outcome.malformed + invalid),
            rejected_by_server: Counter::ZERO,
            duration_ms: count(duration.as_millis() as u64),
            cursor_state: outcome.cursor_state,
            probe_requests: count(outcome.probe_requests),
            parser_version: parser,
            capabilities: outcome.capabilities.clone(),
        },
        None => AdapterCoverage {
            duration_ms: count(duration.as_millis() as u64),
            ..AdapterCoverage::not_running(adapter, state, detail, parser)
        },
    }
}

fn log_line(config_dir: &Path, line: &str) {
    let logs = config_dir.join("logs");
    if paths::ensure_private_dir(&logs).is_err() {
        return;
    }
    let path = logs.join("companion.log");
    if fs::metadata(&path).map(|m| m.len() > 2_000_000).unwrap_or(false) {
        let _ = fs::rename(&path, logs.join("companion.log.1"));
    }
    if let Ok(mut file) = fs::OpenOptions::new().append(true).create(true).open(&path) {
        let _ = file.write_all(line.as_bytes());
        let _ = file.write_all(b"\n");
    }
}

fn record_matches_execution_settings(
    record: &Record,
    detail_level: DetailLevel,
    include_subagents: bool,
) -> bool {
    match detail_level {
        DetailLevel::BucketsOnly
            if matches!(
                record,
                Record::ActivityRequest(_)
                    | Record::AgentEvent(_)
                    | Record::ToolEvent(_)
                    | Record::ResourceAccess(_)
            ) =>
        {
            return false;
        }
        DetailLevel::Requests if matches!(record, Record::ToolEvent(_) | Record::ResourceAccess(_)) => {
            return false;
        }
        _ => {}
    }
    if include_subagents {
        return true;
    }
    match record {
        Record::AgentEvent(_) => false,
        Record::ActivityRequest(request) => {
            request.parent_session_hash.as_ref().is_none()
                && request.agent.as_ref().is_none_or(|agent| {
                    agent.class == AgentClass::Main
                        || (agent.key.as_ref().is_none()
                            && agent.parent_key.as_ref().is_none()
                            && agent.depth.as_ref().is_none())
                })
        }
        _ => true,
    }
}

fn apply_current_privacy_policy(
    record: &mut Record,
    project_attribution: ProjectAttribution,
    tool_detail: ToolDetail,
) {
    if project_attribution == ProjectAttribution::Off
        && let Record::ActivityRequest(request) = record
    {
        request.project_hash = Nullable::NULL;
        request.project = None;
    }
    let agent = match record {
        Record::ActivityRequest(request) => request.agent.as_mut(),
        Record::AgentEvent(event) => Some(&mut event.agent),
        _ => None,
    };
    let Some(agent) = agent else { return };
    let allowed = agent.name.as_ref().is_some_and(|name| match agent.class {
        AgentClass::Builtin => {
            tool_detail != ToolDetail::Off
                && matches!(
                    name.as_str(),
                    "general-purpose"
                        | "Explore"
                        | "Plan"
                        | "claude-code-guide"
                        | "statusline-setup"
                        | "claude"
                        | "codex-auto-review"
                )
        }
        AgentClass::Custom => tool_detail == ToolDetail::HashedCustom && name.as_str().starts_with("h:"),
        AgentClass::Main | AgentClass::Unknown => false,
    });
    if !allowed {
        agent.name = Nullable::NULL;
    }
}

fn pending_records_for_agent_setting(
    state: &State,
    detail_level: DetailLevel,
    include_subagents: bool,
    project_attribution: ProjectAttribution,
    tool_detail: ToolDetail,
) -> Result<Vec<Record>, StateError> {
    pending_records_for_agent_setting_with_limit(
        state,
        detail_level,
        include_subagents,
        project_attribution,
        tool_detail,
        50_000,
    )
}

fn pending_records_for_agent_setting_with_limit(
    state: &State,
    detail_level: DetailLevel,
    include_subagents: bool,
    project_attribution: ProjectAttribution,
    tool_detail: ToolDetail,
    limit: usize,
) -> Result<Vec<Record>, StateError> {
    let mut records = Vec::new();
    let mut cursor: Option<(String, String)> = None;
    let page_size = limit.clamp(1, 1_000);
    while records.len() < limit {
        let page = state.pending_records_after(
            page_size,
            cursor.as_ref().map(|(updated_at, id)| (updated_at.as_str(), id.as_str())),
        )?;
        if page.is_empty() {
            break;
        }
        for row in &page {
            match serde_json::from_str::<Record>(&row.record) {
                Ok(mut record) => {
                    apply_current_privacy_policy(&mut record, project_attribution, tool_detail);
                    let revised = serde_json::to_string(&record).map_err(|_| StateError::Corrupt)?;
                    if revised != row.record {
                        let content_hash = observatory_contract::stable_json::content_hash(&record)
                            .map_err(|_| StateError::Corrupt)?;
                        state.upsert_record(&RecordRow {
                            record_id: row.record_id.clone(),
                            binding_id: row.binding_id.clone(),
                            adapter: row.adapter.clone(),
                            record_type: row.record_type.clone(),
                            semantic_key: row.semantic_key.clone(),
                            content_hash: content_hash.as_str().to_owned(),
                            published_hash: row.published_hash.clone(),
                            rejected_reason: row.rejected_reason.clone(),
                            record: revised,
                            updated_at: row.updated_at.clone(),
                        })?;
                    }
                    if !record_matches_execution_settings(&record, detail_level, include_subagents) {
                        continue;
                    }
                    records.push(record);
                    if records.len() == limit {
                        break;
                    }
                }
                Err(_) => state.mark_record_rejected(&row.record_id, "invalid")?,
            }
        }
        let last = page.last().expect("a nonempty page has a last row");
        cursor = Some((last.updated_at.clone(), last.record_id.clone()));
    }
    Ok(records)
}

/// Replaces queued data with records rebuilt under the current privacy policy,
/// while retaining one coverage-only envelope for every earlier offline run.
fn rebuild_outbox_preserving_coverage(
    state: &State,
    bodies: &[String],
    now: Timestamp,
) -> Result<(), StateError> {
    let mut seen_runs = HashSet::new();
    let mut prior_runs = Vec::new();
    for row in state.outbox()? {
        let mut envelope: Envelope = serde_json::from_str(&row.payload).map_err(|_| StateError::Corrupt)?;
        if envelope.coverage.is_empty() || !seen_runs.insert(envelope.run.run_id.as_str().to_owned()) {
            continue;
        }
        envelope.buckets.clear();
        envelope.records.clear();
        let payload = envelope.to_json().map_err(|_| StateError::Corrupt)?;
        prior_runs.push((payload, row.created_at));
    }

    state.begin()?;
    let rebuilt = (|| {
        state.clear_outbox()?;
        for (payload, created_at) in prior_runs {
            let hash = Sha256Hex::digest(payload.as_bytes());
            state.enqueue_outbox(hash.as_str(), &payload, &created_at)?;
        }
        outbox::enqueue(state, bodies, now)?;
        Ok(())
    })();
    match rebuilt {
        Ok(()) => state.commit(),
        Err(error) => {
            state.rollback()?;
            Err(error)
        }
    }
}

/// Runs one collection cycle with the given adapters.
pub fn execute(prepared: Prepared, adapters: &[Box<dyn Adapter>]) -> Result<RunSummary, RunError> {
    let started = Instant::now();
    let Prepared { config, config_dir, ctx, config_source, config_error, lock } = prepared;
    let run_id = Uuid::v4();
    let started_at = Stamp::from_timestamp(ctx.now);
    if lock.is_none() {
        return Ok(RunSummary {
            ok: true,
            run_id: run_id.to_string(),
            started_at: started_at.to_string(),
            finished_at: started_at.to_string(),
            dry_run: ctx.dry_run,
            skipped: Some("companion_already_running"),
            config: config_source,
            config_error,
            settings_version: ctx.settings_version,
            since: ctx.since_text.clone(),
            adapters: Vec::new(),
            buckets_pending: 0,
            records_pending: 0,
            envelopes: 0,
            upload_bytes: 0,
            publication: None,
            total_duration_ms: 0,
            detailed_reports: Vec::new(),
        });
    }
    let state = State::open(&ctx.state_path)?;

    // Effective mode and preflight per adapter; then run the enabled ones concurrently.
    let mut decided: Vec<(usize, Effective, Preflight, Option<Cursor>)> = Vec::new();
    for (index, adapter) in adapters.iter().enumerate() {
        let id = adapter.id();
        let effective = effective(id, &ctx.settings, &ctx.deny, &ctx.bindings);
        let preflight = if effective.runs { adapter.preflight(&ctx) } else { Preflight::Ready };
        let cursor = state.adapter_state(id.as_str())?.and_then(|row| row.cursor).map(Cursor);
        decided.push((index, effective, preflight, cursor));
    }

    let mut collected: Vec<Collected> = Vec::new();
    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for (index, effective, preflight, cursor) in &decided {
            let adapter = &adapters[*index];
            if !effective.runs || matches!(preflight, Preflight::Blocked { .. }) {
                continue;
            }
            let ctx_ref = &ctx;
            let cursor = cursor.clone();
            handles.push(scope.spawn(move || {
                let begun = Instant::now();
                let mut sink = MemorySink::default();
                let result = adapter.collect(ctx_ref, cursor, &mut sink);
                Collected { adapter: adapter.id(), result, sink, elapsed: begun.elapsed() }
            }));
        }
        for handle in handles {
            match handle.join() {
                Ok(item) => collected.push(item),
                Err(_) => tracing::error!(code = "adapter_panicked", "an adapter thread panicked"),
            }
        }
    });

    // Persist records from every sink, isolating anything invalid.
    let retention_days = ctx.settings.local_raw_retention_days.get();
    let stored_at = Stamp::from_timestamp(ctx.now);
    let mut coverage: Vec<AdapterCoverage> = Vec::new();
    let mut summaries: Vec<AdapterSummary> = Vec::new();
    let mut adapter_rows: Vec<AdapterStateRow> = Vec::new();
    for (index, effective, preflight, _) in &decided {
        let adapter = &adapters[*index];
        let id = adapter.id();
        let ran = collected.iter().find(|c| c.adapter == id);
        let (state_value, detail, outcome, duration, invalid, records) = match (ran, preflight) {
            (Some(item), _) => {
                let mut invalid = 0u64;
                let mut emitted = 0u64;
                state.begin()?;
                for entry in &item.sink.records {
                    let mut violations = Vec::new();
                    entry.record.validate(ctx.now, "record", &mut violations);
                    if !violations.is_empty() {
                        invalid += 1;
                        tracing::warn!(
                            adapter = id.as_str(),
                            code = "record_invalid",
                            count = violations.len(),
                            "record isolated"
                        );
                        continue;
                    }
                    let (Ok(content_hash), Ok(text)) = (
                        observatory_contract::stable_json::content_hash(&entry.record),
                        serde_json::to_string(&entry.record),
                    ) else {
                        invalid += 1;
                        continue;
                    };
                    let row = RecordRow {
                        record_id: entry.record.record_id().as_str().to_owned(),
                        binding_id: entry.record.binding_id().as_str().to_owned(),
                        adapter: id.as_str().to_owned(),
                        record_type: entry.record.record_type().as_str().to_owned(),
                        semantic_key: entry.record.semantic_key(),
                        content_hash: content_hash.as_str().to_owned(),
                        published_hash: None,
                        rejected_reason: None,
                        record: text,
                        updated_at: stored_at.as_str().to_owned(),
                    };
                    state.upsert_record(&row)?;
                    emitted += 1;
                    if retention_days > 0
                        && let Some(raw) = &entry.raw
                        && let Ok(raw_text) = serde_json::to_string(raw)
                    {
                        state.save_observation(
                            &row.record_id,
                            id.as_str(),
                            entry.record.observed_at().as_str(),
                            &raw_text,
                            stored_at.as_str(),
                        )?;
                    }
                }
                state.commit()?;
                match &item.result {
                    Ok(outcome) => {
                        (outcome.state, outcome.detail, Some(outcome.clone()), item.elapsed, invalid, emitted)
                    }
                    Err(error) => {
                        let (state_value, detail) = error.coverage();
                        (state_value, Some(detail), None, item.elapsed, invalid, emitted)
                    }
                }
            }
            (None, Preflight::Blocked { state: blocked, detail }) => {
                (*blocked, Some(*detail), None, Duration::ZERO, 0, 0)
            }
            (None, Preflight::Ready) => (effective.state, effective.detail, None, Duration::ZERO, 0, 0),
        };
        let parser_version = adapter.parser_version();
        let entry =
            coverage_entry(id, parser_version, state_value, detail, outcome.as_ref(), duration, invalid);
        summaries.push(AdapterSummary {
            adapter: id,
            state: state_value,
            detail,
            mode: effective.mode_path.clone(),
            records,
            files: entry.files.get(),
            bytes_read: entry.bytes_read.get(),
            malformed: entry.malformed.get(),
            invalid,
            duration_ms: entry.duration_ms.get(),
        });
        adapter_rows.push(AdapterStateRow {
            adapter: id.as_str().to_owned(),
            effective: if effective.runs { "on".into() } else { "off".into() },
            reason: detail.map(|d| d.as_str().to_owned()),
            last_run_at: Some(stored_at.as_str().to_owned()),
            last_state: Some(state_value.as_str().to_owned()),
            cursor: outcome.and_then(|o| o.next_cursor).map(|c| c.0),
        });
        coverage.push(entry);
    }
    if retention_days > 0 {
        let cutoff = Stamp::from_timestamp(
            Timestamp::from_second(ctx.now.as_second() - retention_days as i64 * 86_400).unwrap_or(ctx.now),
        );
        state.prune_observations(cutoff.as_str())?;
    } else {
        state.clear_observations()?;
    }
    for row in &adapter_rows {
        state.save_adapter_state(row)?;
    }

    // Buckets whose digest changed since the last receipt.
    let mut buckets: Vec<BucketEntry> = Vec::new();
    for binding in &ctx.bindings {
        if !binding.runnable() {
            continue;
        }
        for row in state.bucket_rows_for_agent_setting(
            binding.binding_id.as_str(),
            ctx.settings.execution.include_subagents,
        )? {
            let key = outbox::bucket_key(&binding.binding_id, &row);
            let hash = outbox::bucket_digest(&row);
            if state.published_hash(&key)?.as_deref() != Some(hash.as_str())
                && let Some(bucket) = outbox::bucket_from_row(&row)
            {
                buckets.push(BucketEntry { binding_id: binding.binding_id.clone(), bucket });
            }
        }
    }
    let records = pending_records_for_agent_setting(
        &state,
        ctx.settings.execution.detail_level,
        ctx.settings.execution.include_subagents,
        ctx.settings.execution.project_attribution,
        ctx.settings.execution.tool_detail,
    )?;

    let finished_at = Stamp::from_timestamp(Timestamp::now());
    let run = Run {
        run_id: run_id.clone(),
        started_at: started_at.clone(),
        finished_at: finished_at.clone(),
        companion_version: Text::truncated(VERSION)
            .unwrap_or_else(|_| Text::try_from("0".to_owned()).unwrap_or_else(|_| unreachable!())),
        platform: Platform::current(),
        arch: Arch::current(),
        settings_version: Counter::saturating(ctx.settings_version),
    };
    let buckets_pending = buckets.len();
    let records_pending = records.len();
    let bodies = outbox::build_bodies(&run, buckets, records, coverage).map_err(|_| StateError::Corrupt)?;
    let upload_bytes: u64 = bodies.iter().map(|body| body.len() as u64).sum();
    let mut publication = None;
    if !ctx.dry_run {
        // Rebuild durable envelopes from pending source rows under the current
        // settings. This prevents an offline envelope created under an older
        // privacy choice from being uploaded after that choice changes. Keep
        // each earlier run's coverage evidence in a data-free envelope.
        let client = Client::new(&config.url, Some(config.key.clone()))?;
        rebuild_outbox_preserving_coverage(&state, &bodies, ctx.now)?;
        publication = Some(outbox::upload(&state, &client, ctx.now)?);
    }
    // The detailed monthly report: the kept v1 analyzer adapter, per binding that names it.
    let mut detailed_reports = Vec::new();
    if ctx.settings.detailed_monthly_report {
        for local in &config.bindings {
            let Some(settings) = &local.detailed_report else { continue };
            let runnable = ctx.bindings.iter().any(|b| b.binding_id == local.binding_id && b.runnable());
            if !runnable {
                continue;
            }
            let result = crate::detailed::run(
                &config_dir,
                &config.url,
                local,
                settings,
                ctx.dry_run,
                Duration::from_secs(300),
            );
            detailed_reports.push(crate::detailed::DetailedOutcome {
                binding_id: local.binding_id.to_string(),
                account_id: local.account_id.as_str().to_owned(),
                provider: local.provider,
                result,
            });
        }
    }
    let summary = RunSummary {
        ok: publication.as_ref().is_none_or(|p| p.error.is_none()),
        run_id: run_id.to_string(),
        started_at: started_at.to_string(),
        finished_at: finished_at.to_string(),
        dry_run: ctx.dry_run,
        skipped: None,
        config: config_source,
        config_error,
        settings_version: ctx.settings_version,
        since: ctx.since_text.clone(),
        adapters: summaries,
        buckets_pending,
        records_pending,
        envelopes: bodies.len(),
        upload_bytes,
        publication,
        total_duration_ms: started.elapsed().as_millis() as u64,
        detailed_reports,
    };
    if let Ok(text) = serde_json::to_string(&summary) {
        state.save_run(&RunRow {
            run_id: run_id.to_string(),
            started_at: started_at.to_string(),
            finished_at: finished_at.to_string(),
            summary: text.clone(),
        })?;
        if !ctx.dry_run {
            log_line(&config_dir, &text);
        }
    }
    drop(lock);
    Ok(summary)
}

/// `prepare` then `execute`.
pub fn run(
    config_dir: &Path,
    options: RunOptions,
    adapters: &[Box<dyn Adapter>],
) -> Result<RunSummary, RunError> {
    let prepared = prepare(config_dir, &options, true)?;
    execute(prepared, adapters)
}

/// A no-op cursor state helper for adapters that do not page.
pub fn complete() -> CursorState {
    CursorState::Complete
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn save_record(state: &State, record: &Record, updated_at: &str) {
        let text = serde_json::to_string(record).unwrap();
        let hash = observatory_contract::stable_json::content_hash(record).unwrap();
        state
            .upsert_record(&RecordRow {
                record_id: record.record_id().as_str().to_owned(),
                binding_id: record.binding_id().as_str().to_owned(),
                adapter: "claude_execution".into(),
                record_type: record.record_type().as_str().into(),
                semantic_key: record.semantic_key(),
                content_hash: hash.as_str().into(),
                published_hash: None,
                rejected_reason: None,
                record: text,
                updated_at: updated_at.into(),
            })
            .unwrap();
    }

    #[test]
    fn pending_uploads_are_rebuilt_under_the_current_subagent_setting() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/wire/valid/detail-contract-events.json"
        ))
        .unwrap();
        let main = fixture["records"][0].clone();
        let mut child = main.clone();
        child["record_id"] = json!("00000000-0000-4000-8000-000000000001");
        child["semantic_key"] = json!("1".repeat(64));
        child["agent"]["key"] = json!("2".repeat(64));
        child["agent"]["parent_key"] = json!("3".repeat(64));
        child["agent"]["parent_identity_basis"] = json!("provider");
        child["agent"]["class"] = json!("builtin");
        child["agent"]["depth"] = json!(1);
        let mut unknown = main.clone();
        unknown["record_id"] = json!("10000000-0000-4000-8000-000000000002");
        unknown["semantic_key"] = json!("4".repeat(64));
        unknown["agent"] = json!({
            "key": null,
            "identity_basis": "unknown",
            "parent_key": null,
            "parent_identity_basis": "unknown",
            "class": "custom",
            "name": "h:1234567890abcdef",
            "depth": null
        });
        let mut legacy_child = main.clone();
        legacy_child["record_id"] = json!("00000000-0000-4000-8000-000000000002");
        legacy_child["semantic_key"] = json!("5".repeat(64));
        legacy_child["parent_session_hash"] = json!("6".repeat(64));
        legacy_child.as_object_mut().unwrap().remove("agent");
        let records: Vec<Record> = [main, child, unknown, legacy_child]
            .into_iter()
            .map(|value| serde_json::from_value(value).unwrap())
            .collect();
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        for record in &records {
            save_record(&state, record, "2026-09-02T04:01:00.000Z");
        }
        state.enqueue_outbox("stale", "{}", "2026-09-02T04:01:00.000Z").unwrap();

        let filtered = pending_records_for_agent_setting(
            &state,
            DetailLevel::Requests,
            false,
            ProjectAttribution::Off,
            ToolDetail::Off,
        )
        .unwrap();
        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().all(|record| record_matches_execution_settings(
            record,
            DetailLevel::Requests,
            false
        )));
        assert!(filtered.iter().all(|record| match record {
            Record::ActivityRequest(request) => {
                request.agent.as_ref().is_none_or(|agent| agent.name.as_ref().is_none())
                    && request.project_hash.as_ref().is_none()
                    && request.project.is_none()
            }
            _ => true,
        }));
        assert_eq!(
            pending_records_for_agent_setting(
                &state,
                DetailLevel::Requests,
                true,
                ProjectAttribution::Hashed,
                ToolDetail::Off,
            )
            .unwrap()
            .len(),
            4
        );
        let first_allowed = pending_records_for_agent_setting_with_limit(
            &state,
            DetailLevel::Requests,
            false,
            ProjectAttribution::Off,
            ToolDetail::Off,
            1,
        )
        .unwrap();
        assert_eq!(first_allowed.len(), 1);
        assert!(record_matches_execution_settings(&first_allowed[0], DetailLevel::Requests, false));
        assert_eq!(state.clear_outbox().unwrap(), 1);
        assert_eq!(state.outbox_len().unwrap(), 0);
    }

    #[test]
    fn queued_detail_records_follow_the_current_detail_level() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/wire/valid/detail-contract-events.json"
        ))
        .unwrap();
        let records: Vec<Record> = [0, 5, 6, 11, 15]
            .into_iter()
            .map(|index| serde_json::from_value(fixture["records"][index].clone()).unwrap())
            .collect();
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        for record in &records {
            save_record(&state, record, "2026-09-02T04:01:00.000Z");
        }

        let pending = |detail_level| {
            pending_records_for_agent_setting(
                &state,
                detail_level,
                true,
                ProjectAttribution::Hashed,
                ToolDetail::HashedCustom,
            )
            .unwrap()
        };
        assert_eq!(pending(DetailLevel::BucketsOnly).len(), 1);
        assert_eq!(pending(DetailLevel::Requests).len(), 3);
        assert_eq!(pending(DetailLevel::RequestsWithTools).len(), 5);
    }

    #[test]
    fn outbox_rebuild_preserves_prior_run_coverage_without_prior_data() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let make_run = |id: &str, started: &str| Run {
            run_id: id.parse().unwrap(),
            started_at: Stamp::parse(started).unwrap(),
            finished_at: Stamp::parse(started).unwrap(),
            companion_version: Text::try_from("test".to_owned()).unwrap(),
            platform: Platform::current(),
            arch: Arch::current(),
            settings_version: Counter::ZERO,
        };
        let old_run = make_run("00000000-0000-4000-8000-000000000010", "2026-09-02T04:00:00.000Z");
        let old_coverage = vec![coverage_entry(
            AdapterId::ClaudeExecution,
            "4",
            CoverageState::Ok,
            None,
            None,
            Duration::ZERO,
            0,
        )];
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/wire/valid/detail-contract-events.json"
        ))
        .unwrap();
        let record: Record = serde_json::from_value(fixture["records"][0].clone()).unwrap();
        let old_bodies = outbox::build_bodies(&old_run, vec![], vec![record], old_coverage).unwrap();
        outbox::enqueue(&state, &old_bodies, "2026-09-02T04:00:00Z".parse::<Timestamp>().unwrap()).unwrap();

        let new_run = make_run("00000000-0000-4000-8000-000000000011", "2026-09-02T05:00:00.000Z");
        let new_bodies = outbox::build_bodies(&new_run, vec![], vec![], vec![]).unwrap();
        rebuild_outbox_preserving_coverage(
            &state,
            &new_bodies,
            "2026-09-02T05:00:00Z".parse::<Timestamp>().unwrap(),
        )
        .unwrap();

        let queued: Vec<Envelope> = state
            .outbox()
            .unwrap()
            .into_iter()
            .map(|row| serde_json::from_str(&row.payload).unwrap())
            .collect();
        assert_eq!(queued.len(), 2);
        let retained = queued.iter().find(|envelope| envelope.run.run_id == old_run.run_id).unwrap();
        assert_eq!(retained.coverage.len(), 1);
        assert!(retained.records.is_empty());
        assert!(retained.buckets.is_empty());
        assert!(queued.iter().any(|envelope| envelope.run.run_id == new_run.run_id));
    }
}
