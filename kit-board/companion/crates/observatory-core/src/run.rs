//! The run loop (section 2.4): lock, config, effective modes, adapters on
//! scoped threads, sink, buckets, envelopes, outbox, upload, summary.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::time::{Duration, Instant};

use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use observatory_contract::IdentityRequest;
use observatory_contract::settings::{DetailLevel, ProjectAttribution, ToolDetail};
use observatory_contract::{
    AdapterCapability, AdapterCoverage, AgentClass, Arch, BackfillState, BindingCapability, BindingIdentity,
    BucketEntry, BuildInfo, CapabilitiesDocument, CapabilityCoverage, Code, CollectionSettings,
    ConfigDocument, ConfigSourceKind, Counter, CoverageState, CursorState, DetailCode,
    DetailedReportCapability, Discovered as DiscoveredCapability, EffectiveSettings, Envelope, Features,
    IsoDate, Lit, MachineId, ModePath, Nullable, Platform, Provider, QueueState, Reader, Readers, Record,
    ResourceAttributionState, Run, ScheduleCapability, ScheduleState, Scheduler, Sha256Hex, Stamp, Text,
    ToolClass, Uuid,
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
use crate::inbox::{oauth_usage_reader_denied, prune_statusline_files, statusline_reader_denied};
use crate::outbox;
use crate::paths;
use crate::pyjson::{digest, epoch_text};
use crate::resources::{ResourceConfiguration, resource_attribution_denied};
use crate::service;
use crate::state::{
    AdapterStateRow, CachedConfig, RecordRow, RunRow, SUPERSEDED_CONFIGURATION, State, StateError,
};
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
    /// True when the run was told not to contact the Observatory (`--offline`).
    pub offline: bool,
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
    /// The per-dimension capability rows the adapter reported, when it ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<CapabilityCoverage>>,
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
    /// Whether this build's capability document reached the Observatory this run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<CapabilitiesOutcome>,
    /// The installed schedule read back beside the desired cadence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<ScheduleSummary>,
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

/// The knowledge sources a run classifies against: every `companion.json`
/// entry that validates, normalized against this machine's home directory.
/// Entries that fail validation are skipped; the returned messages name the
/// key and the failing part by position, never a path.
pub fn configured_resources(config: &CompanionConfig) -> (ResourceConfiguration, Vec<String>) {
    let mut valid = Vec::new();
    let mut skipped = Vec::new();
    for resource in &config.resources {
        match resource.validate() {
            Ok(()) => valid.push(resource.clone()),
            Err(problem) => skipped.push(format!("knowledge source skipped: {problem}")),
        }
    }
    let home = paths::home_dir().map(|home| home.to_string_lossy().into_owned());
    (ResourceConfiguration::from_local(&valid, home.as_deref()), skipped)
}

/// What `prepare` weighs for one binding's identity.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct IdentityEvidence {
    /// The server's hash after this run's confirmation attempt, if any.
    server_hash: Option<Sha256Hex>,
    /// The account this machine's config names now, when readable.
    local: Option<Sha256Hex>,
    /// The server hash was set in an earlier run.
    previously_set: bool,
    /// The roots pin recorded earlier differs from the current roots.
    pin_drifted: bool,
    /// Confirmation answered 409.
    refused: bool,
}

/// What the run decided about a binding's identity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct IdentityDecision {
    state: IdentityState,
    /// A real conflict, as opposed to a local mismatch: a 409, a roots-pin drift
    /// the server and the machine do not both explain away, or a withdrawn hash.
    conflict: bool,
    /// The server and the machine name the same account, so the roots pin may
    /// follow an edited root set instead of marking the binding `Changed` forever.
    refresh_pin: bool,
}

fn decide_identity(evidence: &IdentityEvidence) -> IdentityDecision {
    let agrees = matches!((&evidence.server_hash, &evidence.local),
        (Some(server), Some(local)) if server == local);
    let conflict = evidence.refused
        || (evidence.pin_drifted && !agrees)
        || (evidence.server_hash.is_none() && evidence.previously_set);
    let state = if conflict {
        IdentityState::Changed
    } else if evidence.server_hash.is_some() {
        match (&evidence.server_hash, &evidence.local) {
            // Another account is signed in now; the binding keeps its own hash and waits.
            (Some(server), Some(local)) if server != local => IdentityState::Changed,
            _ => IdentityState::Confirmed,
        }
    } else {
        IdentityState::Unconfirmed
    };
    IdentityDecision { state, conflict, refresh_pin: agrees && !conflict }
}

/// Whether to post the local evidence as a binding's identity: only when the
/// server holds none for it, no sibling binding of the same provider already
/// holds that hash, and no enabled sibling is waiting for a hash too. The
/// Observatory refuses a sibling's hash as `identity_taken`; and with two
/// enabled bindings both unconfirmed, the evidence is ambiguous between them,
/// so neither posts it. Skipping the post leaves the binding `Unconfirmed`, and
/// the allowance reader reports what it cannot tell apart (`identity_ambiguous`
/// for unstamped samples, `unpaired_identity` for stamped ones). Disabling one
/// of the bindings in the Observatory leaves one candidate, which then confirms.
fn should_confirm<'a>(
    server_hash: Option<&Sha256Hex>,
    local: Option<&Sha256Hex>,
    siblings: impl IntoIterator<Item = (bool, Option<&'a Sha256Hex>)>,
) -> bool {
    match (server_hash, local) {
        (None, Some(local)) => !siblings.into_iter().any(|(enabled, hash)| match hash {
            Some(hash) => hash == local,
            None => enabled,
        }),
        _ => false,
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
        Provider::Cursor => binding
            .cursor_state_db
            .clone()
            .or_else(paths::cursor_state_db)
            .and_then(|path| discovery::cursor_identity(&path))
            .map(|identity| identity.evidence_hash),
        Provider::AnthropicApi | Provider::OpenaiApi => None,
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
    // Created on the first run of a build that has one; re-keys stored hashes then.
    let privacy_key = state.privacy_key()?;

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
            // approved a re-confirmation. Either way the install may post what it observes now,
            // unless a sibling binding already holds that hash or an enabled sibling has none
            // either; a hash the Observatory has not approved is refused with 409 and pauses
            // the binding.
            let mut server_hash = server.identity_hash.clone().into_inner();
            let mut refused = false;
            let siblings = document
                .bindings
                .iter()
                .filter(|other| other.binding_id != server.binding_id && other.provider == server.provider)
                .map(|other| (other.enabled, other.identity_hash.as_ref()));
            if options.fetch_config
                && should_confirm(server_hash.as_ref(), evidence.as_ref(), siblings)
                && let Some(local_hash) = &evidence
                && let Ok(client) = Client::new(&config.url, Some(config.key.clone()))
            {
                match client.confirm_identity(
                    &server.binding_id,
                    &IdentityRequest { identity_hash: local_hash.clone() },
                ) {
                    Ok(response) => server_hash = response.identity_hash.into_inner(),
                    Err(HttpError::Status(409)) => refused = true,
                    Err(_) => {}
                }
            }
            let hash_key = format!("identity_hash:{}", local.binding_id);
            let decision = decide_identity(&IdentityEvidence {
                server_hash: server_hash.clone(),
                local: evidence,
                // The server hash is null after having been set and could not be re-confirmed yet.
                previously_set: state.meta(&hash_key)?.is_some(),
                pin_drifted: previous_pin.as_deref().is_some_and(|p| p != pin.as_str()),
                refused,
            });
            if previous_pin.is_none() || decision.refresh_pin {
                state.set_meta(&pin_key, pin.as_str())?;
            }
            if let Some(hash) = &server_hash {
                state.set_meta(&hash_key, hash.as_str())?;
            }
            bindings.push(BindingContext {
                binding_id: server.binding_id.clone(),
                account_id: server.account_id.clone(),
                provider: server.provider,
                enabled: server.enabled,
                identity_hash: server_hash.clone(),
                identity: decision.state,
                identity_conflict: decision.conflict,
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
                identity_conflict: false,
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
        privacy_key,
    );
    let (resources, skipped) = configured_resources(&config);
    for warning in skipped {
        tracing::warn!(code = "resource_invalid", "{warning}");
    }
    let ctx = ctx.with_resources(resources).with_claude_credentials_path(paths::claude_credentials_file());
    Ok(Prepared {
        offline: !options.fetch_config,
        config,
        config_dir: config_dir.to_path_buf(),
        ctx,
        config_source,
        config_error,
        lock,
    })
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
    detail_level: DetailLevel,
    project_attribution: ProjectAttribution,
    tool_detail: ToolDetail,
) {
    if project_attribution == ProjectAttribution::Off
        && let Record::ActivityRequest(request) = record
    {
        request.project_hash = Nullable::NULL;
        request.project = None;
    }
    if let Record::ActivityRequest(request) = record {
        if detail_level != DetailLevel::RequestsWithTools {
            request.tool_calls = Nullable::NULL;
            request.tools = None;
        } else if tool_detail == ToolDetail::Off {
            request.tools = None;
        } else if let Some(tools) = request.tools.as_mut() {
            tools.retain(|tool| {
                is_builtin_tool_name(tool.name.as_str())
                    || (tool_detail == ToolDetail::HashedCustom && tool.name.as_str().starts_with("h:"))
            });
            if tools.is_empty() {
                request.tools = None;
            }
        }
    }
    if let Record::ToolEvent(event) = record {
        let name_allowed = event.tool.name.as_ref().is_some_and(|name| match event.tool.class {
            ToolClass::Builtin => tool_detail != ToolDetail::Off && is_builtin_tool_name(name.as_str()),
            ToolClass::Mcp | ToolClass::Function | ToolClass::Custom => {
                tool_detail == ToolDetail::HashedCustom && name.as_str().starts_with("h:")
            }
            ToolClass::Unknown => false,
        });
        if !name_allowed {
            event.tool.name = Nullable::NULL;
        }
        let namespace_allowed =
            event.tool.namespace.as_ref().is_some_and(|namespace| match event.tool.class {
                ToolClass::Builtin => {
                    tool_detail != ToolDetail::Off && is_builtin_tool_namespace(namespace.as_str())
                }
                ToolClass::Mcp | ToolClass::Function | ToolClass::Custom => {
                    tool_detail == ToolDetail::HashedCustom && namespace.as_str().starts_with("h:")
                }
                ToolClass::Unknown => false,
            });
        if !namespace_allowed {
            event.tool.namespace = Nullable::NULL;
        }
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

fn is_builtin_tool_namespace(value: &str) -> bool {
    matches!(value, "clock" | "codex_app" | "collaboration" | "image_gen" | "multi_agent_v1" | "web")
}

fn is_builtin_tool_name(value: &str) -> bool {
    matches!(
        value,
        "Agent"
            | "AskUserQuestion"
            | "Bash"
            | "BashOutput"
            | "Edit"
            | "EnterPlanMode"
            | "ExitPlanMode"
            | "Glob"
            | "Grep"
            | "KillShell"
            | "LS"
            | "MultiEdit"
            | "NotebookEdit"
            | "Read"
            | "Skill"
            | "SlashCommand"
            | "Task"
            | "TaskOutput"
            | "TaskStop"
            | "TodoWrite"
            | "WebFetch"
            | "WebSearch"
            | "Write"
            | "apply_patch"
            | "automation_update"
            | "capture_screen_context"
            | "close_agent"
            | "consume_usage_reset"
            | "create_goal"
            | "create_sidebar_section"
            | "create_thread"
            | "delete_sidebar_section"
            | "end_realtime_voice_call"
            | "exec"
            | "exec_command"
            | "followup_task"
            | "fork_thread"
            | "get_goal"
            | "get_handoff_status"
            | "get_usage_limits"
            | "handoff_thread"
            | "imagegen"
            | "interrupt_agent"
            | "list_agents"
            | "list_archived_threads"
            | "list_projects"
            | "list_threads"
            | "load_workspace_dependencies"
            | "local_shell"
            | "move_project_to_sidebar_section"
            | "move_thread_to_sidebar_section"
            | "navigate_to_codex_page"
            | "open_in_codex"
            | "read_thread"
            | "read_thread_terminal"
            | "request_user_input"
            | "request_user_input_async"
            | "rename_sidebar_section"
            | "reorder_section"
            | "reorder_sidebar_projects"
            | "reorder_sidebar_sections"
            | "run"
            | "send_message"
            | "send_message_to_thread"
            | "set_thread_archived"
            | "set_thread_title"
            | "share_thread"
            | "shell_command"
            | "sleep"
            | "spawn_agent"
            | "uninstall_plugin"
            | "update_goal"
            | "update_plan"
            | "view_image"
            | "wait"
            | "wait_agent"
            | "wait_threads"
            | "web_search"
            | "write_stdin"
    )
}

#[cfg(test)]
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
        None,
    )
}

/// The machine-local rules a queued record must pass before an upload: the
/// adapter/provider/mode deny list and the knowledge-source policy.
struct LocalPolicy<'a> {
    settings: &'a CollectionSettings,
    deny: &'a [String],
    resources: ResourceUploadPolicy,
}

/// Which queued `resource.access` records may leave now. `Denied` keeps every
/// row pending on this machine, like a denied project attribution; `Current`
/// admits only rows stamped with each configured key's present token, and
/// marks the rest `superseded_configuration` so they never upload (a removed
/// key, a changed root set, or a transcript deleted before the change).
enum ResourceUploadPolicy {
    Denied,
    Current(BTreeMap<String, String>),
}

impl ResourceUploadPolicy {
    fn current(
        state: &State,
        deny: &[String],
        resources: &ResourceConfiguration,
    ) -> Result<Self, StateError> {
        if resource_attribution_denied(deny) {
            return Ok(ResourceUploadPolicy::Denied);
        }
        let mut versions = BTreeMap::new();
        for resource in &resources.resources {
            if let Some(digest) = resources.resource_version(&resource.key) {
                let token = state.resource_config_token(&digest)?;
                versions.insert(resource.key.clone(), format!("cfg:{token}"));
            }
        }
        Ok(ResourceUploadPolicy::Current(versions))
    }
}

fn pending_records_for_current_settings(
    state: &State,
    settings: &CollectionSettings,
    deny: &[String],
    resources: &ResourceConfiguration,
) -> Result<Vec<Record>, StateError> {
    let policy =
        LocalPolicy { settings, deny, resources: ResourceUploadPolicy::current(state, deny, resources)? };
    pending_records_for_agent_setting_with_limit(
        state,
        settings.execution.detail_level,
        settings.execution.include_subagents,
        crate::adapter::restrict_project_attribution(settings.execution.project_attribution, deny),
        settings.execution.tool_detail,
        50_000,
        Some(&policy),
    )
}

fn pending_records_for_agent_setting_with_limit(
    state: &State,
    detail_level: DetailLevel,
    include_subagents: bool,
    project_attribution: ProjectAttribution,
    tool_detail: ToolDetail,
    limit: usize,
    local_policy: Option<&LocalPolicy<'_>>,
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
                    if local_policy.is_some_and(|policy| {
                        let adapter = record.adapter();
                        let gate = policy.settings.gate(adapter);
                        policy
                            .deny
                            .iter()
                            .any(|entry| observatory_contract::settings::denied(entry, adapter, &gate))
                    }) {
                        continue;
                    }
                    // A statusline reading stays home under a deny of the statusline reader even
                    // while the server selects `oauth_usage`, whose gate names the other reader.
                    if let Record::AllowanceReading(reading) = &record
                        && reading.adapter == AdapterId::ClaudeAccount
                        && reading.reader == Reader::Statusline
                        && local_policy.is_some_and(|policy| statusline_reader_denied(policy.deny))
                    {
                        continue;
                    }
                    if let Record::AllowanceReading(reading) = &record
                        && reading.adapter == AdapterId::ClaudeAccount
                        && reading.reader == Reader::OauthUsage
                        && local_policy.is_some_and(|policy| oauth_usage_reader_denied(policy.deny))
                    {
                        continue;
                    }
                    if let Record::ResourceAccess(access) = &record
                        && let Some(policy) = local_policy
                    {
                        match &policy.resources {
                            ResourceUploadPolicy::Denied => continue,
                            ResourceUploadPolicy::Current(versions) => {
                                let current = versions.get(access.resource_key.as_str()).map(String::as_str);
                                let stamped = access.configuration_version.as_ref().map(|code| code.as_str());
                                if current.is_none() || current != stamped {
                                    state.mark_record_rejected(&row.record_id, SUPERSEDED_CONFIGURATION)?;
                                    continue;
                                }
                            }
                        }
                    }
                    apply_current_privacy_policy(&mut record, detail_level, project_attribution, tool_detail);
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
                    // Tool and resource rows join their caller through the invocation.
                    let invocation = match &record {
                        Record::ToolEvent(event) => Some((&event.binding_id, &event.invocation_key)),
                        Record::ResourceAccess(access) => Some((&access.binding_id, &access.invocation_key)),
                        _ => None,
                    };
                    if !include_subagents
                        && let Some((binding, invocation_key)) = invocation
                        && state.tool_invocation_is_subagent(binding.as_str(), invocation_key.as_str())?
                    {
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
    let Prepared { config, config_dir, ctx, config_source, config_error, lock, offline } = prepared;
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
            capabilities: None,
            schedule: None,
        });
    }
    let state = State::open(&ctx.state_path)?;
    // Rows the adapters write now carry this generation; their emission marks
    // refer to it, and it advances again once the records are persisted.
    state.advance_change_generation()?;

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
    // The run prunes the statusline inbox, not the reader, so a blocked or denied
    // reader never lets the hook's part files accumulate.
    let inbox_keep_days = ctx.settings.local_raw_retention_days.get().max(2) as i64;
    let pruned = prune_statusline_files(&ctx.statusline_inbox, ctx.now, inbox_keep_days);
    if pruned > 0 {
        tracing::debug!(
            code = "statusline_inbox_pruned",
            count = pruned,
            "old statusline part files removed"
        );
    }

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
                        // The records are durable now; marks such as an emission generation may follow.
                        for (key, value) in &outcome.after_persist {
                            state.set_meta(key, value)?;
                        }
                        if !outcome.after_persist_emitted.is_empty() {
                            state.begin()?;
                            for mark in &outcome.after_persist_emitted {
                                state.mark_cursor_emitted(
                                    &mark.binding_id,
                                    &mark.record_id,
                                    &mark.content_digest,
                                    stored_at.as_str(),
                                )?;
                            }
                            state.commit()?;
                        }
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
            // A runnable adapter with no collected item means its thread panicked; the run
            // reports that as a failure rather than echoing the settings-level state.
            (None, Preflight::Ready) if effective.runs => {
                (CoverageState::Failed, Some(DetailCode::AdapterPanicked), None, Duration::ZERO, 0, 0)
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
            capabilities: entry.capabilities.clone(),
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
    // Anything written from here until the next run starts is newer than every
    // emission mark stored above.
    state.advance_change_generation()?;

    // Buckets whose digest changed since the last receipt.
    let mut buckets: Vec<BucketEntry> = Vec::new();
    for binding in &ctx.bindings {
        if !binding.runnable() {
            continue;
        }
        let published = state.published_hashes(binding.binding_id.as_str())?;
        for row in state.bucket_rows_for_agent_setting(
            binding.binding_id.as_str(),
            ctx.settings.execution.include_subagents,
        )? {
            let key = outbox::bucket_key(&binding.binding_id, &row);
            let hash = outbox::bucket_digest(&row);
            if published.get(&key).map(String::as_str) != Some(hash.as_str())
                && let Some(bucket) = outbox::bucket_from_row(&row)
            {
                buckets.push(BucketEntry { binding_id: binding.binding_id.clone(), bucket });
            }
        }
    }
    let records = pending_records_for_current_settings(&state, &ctx.settings, &ctx.deny, &ctx.resources)?;

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
    // What this build can do, read back and posted best-effort after the upload so a
    // slow or refused post never delays or fails collection.
    let desired = (config_source != ConfigSource::Defaults).then(|| ctx.settings.cadence_minutes.get());
    let schedule = schedule_summary(&config_dir, &config.install_id, desired);
    let capabilities = if ctx.dry_run || offline {
        let document = capabilities_document(&config, &ctx, &state, config_source, adapters, &schedule);
        Some(CapabilitiesOutcome {
            posted: false,
            skipped: Some(if ctx.dry_run { "dry_run" } else { "offline" }),
            error: None,
            digest: capabilities_change_digest(&document),
        })
    } else {
        Some(report_capabilities(&config, &ctx, &state, config_source, adapters, &schedule, false))
    };
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
        capabilities,
        schedule: Some(schedule),
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

// --- what this build can do ----------------------------------------------------

/// The installed schedule beside the desired cadence, for the run summary,
/// `doctor`, `status`, and the capability document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ScheduleSummary {
    pub mechanism: Option<&'static str>,
    /// `not_installed`, `installed`, `interval_mismatch`, or `unreadable`.
    pub state: &'static str,
    pub installed_interval_minutes: Option<u64>,
    /// `None` when no fetched or cached settings document exists.
    pub desired_interval_minutes: Option<u64>,
    pub pending: bool,
    pub config_dir_pinned: bool,
    /// The exact local command that applies the desired cadence, when one is needed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
}

/// Reads the schedule back and compares it with the desired cadence. The run never
/// rewrites its own schedule: a job replacing the scheduler entry that started it
/// would kill itself, so a mismatch is reported with the command to run instead.
pub fn schedule_summary(config_dir: &Path, install_id: &Uuid, desired: Option<u64>) -> ScheduleSummary {
    let installed = service::installed_schedule(config_dir, install_id);
    let mismatch = matches!((installed.interval_minutes, desired), (Some(have), Some(want)) if have != want);
    let state =
        if installed.state == "installed" && mismatch { "interval_mismatch" } else { installed.state };
    let pending = state == "interval_mismatch";
    let action = (pending || state == "not_installed")
        .then(|| format!("observatory --config-dir \"{}\" service install", config_dir.to_string_lossy()));
    ScheduleSummary {
        mechanism: installed.mechanism,
        state,
        installed_interval_minutes: installed.interval_minutes,
        desired_interval_minutes: desired,
        pending,
        config_dir_pinned: installed.config_dir_pinned,
        action,
    }
}

/// Whether the capability document was posted this run, and why not.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CapabilitiesOutcome {
    pub posted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<&'static str>,
    /// A closed code (`http_401`, `timeout`, `transport`, `client`); never a message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub digest: String,
}

const CAPABILITIES_DIGEST_KEY: &str = "capabilities_last_digest";
const CAPABILITIES_POSTED_KEY: &str = "capabilities_last_posted_at";
const CAPABILITIES_HEARTBEAT_SECONDS: f64 = 86_400.0;

/// Every adapter in the contract, for deny recognition and the adapter rows.
const ALL_ADAPTERS: [AdapterId; 11] = [
    AdapterId::ClaudeExecution,
    AdapterId::CodexExecution,
    AdapterId::ClaudeAccount,
    AdapterId::CodexAccount,
    AdapterId::CursorExecution,
    AdapterId::CursorAccount,
    AdapterId::AnthropicApi,
    AdapterId::OpenaiApi,
    AdapterId::ClaudeBrowser,
    AdapterId::CodexBrowser,
    AdapterId::CursorBrowser,
];

fn codes(values: &[&str]) -> Vec<Code> {
    values.iter().filter_map(|value| Code::from_str(value).ok()).collect()
}

fn code(value: &str) -> Code {
    Code::from_str(value).unwrap_or_else(|_| Code::from_str("unknown").unwrap_or_else(|_| unreachable!()))
}

/// The mode codes this build actually runs for an adapter; a stub advertises none.
fn build_modes(adapter: AdapterId, implemented: bool) -> Vec<Code> {
    if !implemented {
        return Vec::new();
    }
    codes(match adapter {
        AdapterId::ClaudeExecution => &["claude_local_logs"],
        AdapterId::CodexExecution => &["codex_local_history", "embedded"],
        AdapterId::ClaudeAccount => &["statusline", "oauth_usage"],
        AdapterId::CodexAccount => &["app_server"],
        AdapterId::CursorExecution => &["cursor_local_state"],
        AdapterId::CursorAccount => &["usage_summary", "dashboard_rpc"],
        AdapterId::AnthropicApi => &["anthropic_admin_api"],
        AdapterId::OpenaiApi => &["openai_admin_api"],
        _ => &[],
    })
}

/// Every mode path a deny entry can name, whatever the server currently selects: an
/// entry for a mode that is not selected today still removes it if it is selected
/// later, so it is recognized and reported rather than counted as noise.
const KNOWN_MODE_PATHS: [&str; 17] = [
    "execution.claude_local_logs",
    "execution.codex_local_history",
    "execution.cursor_local_state",
    "execution.project_attribution.hashed",
    "execution.resource_attribution",
    "allowance.claude_reader.statusline",
    "allowance.claude_reader.oauth_usage",
    "allowance.codex_reader.embedded",
    "allowance.codex_reader.app_server",
    "allowance.codex_reader.web_backend",
    "allowance.cursor_reader.usage_summary",
    "allowance.cursor_reader.dashboard_rpc",
    "billing.anthropic_admin_api",
    "billing.openai_admin_api",
    "browser.claude_web",
    "browser.chatgpt_web",
    "browser.cursor_web",
];

/// A deny entry the companion itself acts on: an adapter id, a provider switch, or a
/// mode path or dotted prefix of one. Anything else is counted, never uploaded.
fn recognized_deny(entry: &str) -> bool {
    ALL_ADAPTERS
        .iter()
        .any(|adapter| entry == adapter.as_str() || entry == format!("providers.{}", adapter.provider()))
        || KNOWN_MODE_PATHS
            .iter()
            .any(|path| *path == entry || path.strip_prefix(entry).is_some_and(|rest| rest.starts_with('.')))
}

fn detailed_outcomes_from_last_run(state: &State) -> BTreeMap<String, (Option<Code>, Option<Code>)> {
    let mut outcomes = BTreeMap::new();
    let Ok(Some(row)) = state.last_run() else { return outcomes };
    let Ok(summary) = serde_json::from_str::<serde_json::Value>(&row.summary) else { return outcomes };
    for report in summary["detailed_reports"].as_array().into_iter().flatten() {
        let Some(binding) = report["binding_id"].as_str() else { continue };
        let status = report["result"]["status"].as_str().and_then(|value| Code::from_str(value).ok());
        let error = report["result"]["error"].as_str().and_then(|value| Code::from_str(value).ok());
        outcomes.insert(binding.to_owned(), (status, error));
    }
    outcomes
}

/// Builds the document from what the run already decided. It names ids, codes,
/// flags, and counts only: no root, path, host, hash of a path, or credential.
pub fn capabilities_document(
    config: &CompanionConfig,
    ctx: &RunContext,
    state: &State,
    config_source: ConfigSource,
    adapters: &[Box<dyn Adapter>],
    schedule: &ScheduleSummary,
) -> CapabilitiesDocument {
    let settings = &ctx.settings;
    let adapter_rows: Vec<AdapterCapability> = adapters
        .iter()
        .map(|adapter| {
            let id = adapter.id();
            let implemented = adapter.parser_version() != "0";
            let decided = effective(id, settings, &ctx.deny, &ctx.bindings);
            AdapterCapability {
                adapter: id,
                implemented,
                modes: build_modes(id, implemented),
                parser_version: Text::truncated(adapter.parser_version())
                    .unwrap_or_else(|_| Text::try_from("0".to_owned()).unwrap_or_else(|_| unreachable!())),
                denied: decided.state == CoverageState::DeniedLocally,
            }
        })
        .collect();
    let features = Features {
        detail_levels: codes(&["buckets_only", "requests", "requests_with_tools"]),
        tool_detail: codes(&["off", "builtin_only", "hashed_custom"]),
        project_attribution: codes(&["off", "hashed"]),
        resource_attribution: true,
        include_subagents: true,
        hooks: codes(&["claude_statusline"]),
        schedulers: match schedule.mechanism {
            Some("launchd") => vec![Scheduler::Launchd],
            Some("task_scheduler") => vec![Scheduler::TaskScheduler],
            Some("systemd") => vec![Scheduler::Systemd],
            _ => Vec::new(),
        },
        live_mode: false,
        detailed_monthly_report: true,
        account_history: true,
        claude_oauth_keepalive: true,
    };
    let fingerprint = digest(&serde_json::json!([adapter_rows, features]));
    let resource_attribution = if settings.execution.detail_level != DetailLevel::RequestsWithTools {
        ResourceAttributionState::DetailLevel
    } else if ctx.resources.is_empty() {
        ResourceAttributionState::NoResources
    } else if resource_attribution_denied(&ctx.deny) {
        ResourceAttributionState::DeniedLocally
    } else {
        ResourceAttributionState::On
    };
    let mut deny = Vec::new();
    let mut deny_unrecognized = 0u64;
    for entry in &config.deny {
        match ModePath::from_str(entry) {
            Ok(path) if recognized_deny(entry) && deny.len() < 32 => deny.push(path),
            _ => deny_unrecognized += 1,
        }
    }
    let found = discovery::discover();
    let detailed = detailed_outcomes_from_last_run(state);
    let (records_total, records_pending, records_rejected) = state.record_counts().unwrap_or((0, 0, 0));
    let _ = records_total;
    let adapter_states = state.all_adapter_states().unwrap_or_default();
    let partial: Vec<&AdapterStateRow> =
        adapter_states.iter().filter(|row| row.effective == "on" && row.cursor.is_some()).collect();
    let counter = |value: u64| Counter::saturating(value);
    CapabilitiesDocument {
        schema_version: Lit,
        companion_version: Text::truncated(VERSION)
            .unwrap_or_else(|_| Text::try_from("0".to_owned()).unwrap_or_else(|_| unreachable!())),
        capabilities_digest: fingerprint,
        build: BuildInfo {
            platform: Platform::current(),
            arch: Arch::current(),
            tls_roots: code(crate::http::TLS_ROOTS_LABEL),
            state_schema_version: code(crate::state::SCHEMA_VERSION),
        },
        adapters: adapter_rows,
        features,
        effective: EffectiveSettings {
            settings_version_applied: counter(ctx.settings_version),
            config_source: match config_source {
                ConfigSource::Fetched | ConfigSource::NotModified => ConfigSourceKind::Fetched,
                ConfigSource::Cached => ConfigSourceKind::Cached,
                ConfigSource::Defaults => ConfigSourceKind::Defaults,
            },
            paused: settings.paused,
            cadence_minutes: counter(settings.cadence_minutes.get()),
            detail_level: code(settings.execution.detail_level.as_str()),
            tool_detail: code(settings.execution.tool_detail.as_str()),
            project_attribution: code(settings.execution.project_attribution.as_str()),
            include_subagents: settings.execution.include_subagents,
            resource_attribution,
            resources_configured: counter(ctx.resources.resources.len() as u64),
            readers: Readers {
                claude: code(settings.allowance.claude_reader.as_str()),
                codex: code(settings.allowance.codex_reader.as_str()),
                cursor: code(settings.allowance.cursor_reader.as_str()),
            },
        },
        deny,
        deny_unrecognized: counter(deny_unrecognized),
        discovered: DiscoveredCapability {
            claude: found.claude.present,
            codex: found.codex.present,
            cursor: found.cursor.present,
        },
        bindings: ctx
            .bindings
            .iter()
            .map(|binding| BindingCapability {
                binding_id: binding.binding_id.clone(),
                identity: match binding.identity {
                    IdentityState::Confirmed => BindingIdentity::Confirmed,
                    IdentityState::Unconfirmed => BindingIdentity::Unconfirmed,
                    IdentityState::Changed => BindingIdentity::Changed,
                },
                conflict: binding.identity_conflict,
                roots_present: counter(binding.roots.iter().filter(|root| root.is_dir()).count() as u64),
            })
            .collect(),
        detailed_report: config
            .bindings
            .iter()
            .filter_map(|local| {
                let report = local.detailed_report.as_ref()?;
                let (last_status, last_error_code) =
                    detailed.get(&local.binding_id.to_string()).cloned().unwrap_or((None, None));
                Some(DetailedReportCapability {
                    binding_id: local.binding_id.clone(),
                    configured: true,
                    machine_id: Nullable(MachineId::from_str(&report.machine_id).ok()),
                    last_status: Nullable(last_status),
                    last_error_code: Nullable(last_error_code),
                })
            })
            .collect(),
        schedule: ScheduleCapability {
            mechanism: Nullable(match schedule.mechanism {
                Some("launchd") => Some(Scheduler::Launchd),
                Some("task_scheduler") => Some(Scheduler::TaskScheduler),
                Some("systemd") => Some(Scheduler::Systemd),
                _ => None,
            }),
            state: match schedule.state {
                "installed" => ScheduleState::Installed,
                "interval_mismatch" => ScheduleState::IntervalMismatch,
                "unreadable" => ScheduleState::Unreadable,
                _ => ScheduleState::NotInstalled,
            },
            installed_interval_minutes: Nullable(schedule.installed_interval_minutes.map(counter)),
            config_dir_pinned: schedule.config_dir_pinned,
        },
        queue: QueueState {
            records_pending: counter(records_pending),
            records_rejected: counter(records_rejected),
            outbox_envelopes: counter(state.outbox_len().unwrap_or(0)),
        },
        backfill: BackfillState {
            since: Nullable(
                state.meta("since").ok().flatten().and_then(|value| IsoDate::from_str(&value).ok()),
            ),
            complete: partial.is_empty(),
            last_partial_adapter: Nullable(
                partial.first().and_then(|row| AdapterId::from_str(&row.adapter).ok()),
            ),
        },
    }
}

/// The digest that decides whether the document changed: the queue counters move
/// on every run and are left out.
fn capabilities_change_digest(document: &CapabilitiesDocument) -> String {
    let mut value = serde_json::to_value(document).unwrap_or(serde_json::Value::Null);
    if let Some(map) = value.as_object_mut() {
        map.remove("queue");
    }
    digest(&value).as_str().to_owned()
}

/// Posts the document when it changed since the last acknowledged post or the daily
/// heartbeat is due; `force` posts regardless. Best-effort: an error is a code in
/// the outcome, never a failed run, and a 401 from this endpoint is not a revoked key.
#[allow(clippy::too_many_arguments)]
pub fn report_capabilities(
    config: &CompanionConfig,
    ctx: &RunContext,
    state: &State,
    config_source: ConfigSource,
    adapters: &[Box<dyn Adapter>],
    schedule: &ScheduleSummary,
    force: bool,
) -> CapabilitiesOutcome {
    let document = capabilities_document(config, ctx, state, config_source, adapters, schedule);
    let digest_text = capabilities_change_digest(&document);
    let outcome = |posted: bool, skipped: Option<&'static str>, error: Option<String>| CapabilitiesOutcome {
        posted,
        skipped,
        error,
        digest: digest_text.clone(),
    };
    if let Err(reason) = document.validate() {
        let _ = reason;
        return outcome(false, Some("document_invalid"), None);
    }
    if !force {
        let unchanged =
            state.meta(CAPABILITIES_DIGEST_KEY).ok().flatten().as_deref() == Some(digest_text.as_str());
        let last_posted = state
            .meta(CAPABILITIES_POSTED_KEY)
            .ok()
            .flatten()
            .and_then(|text| text.parse::<f64>().ok())
            .unwrap_or(0.0);
        if unchanged && ctx.now_seconds - last_posted < CAPABILITIES_HEARTBEAT_SECONDS {
            return outcome(false, Some("unchanged"), None);
        }
    }
    let client = match Client::new(&config.url, Some(config.key.clone())) {
        Ok(client) => client,
        Err(_) => return outcome(false, None, Some("client".to_owned())),
    };
    match client.post_capabilities(&document) {
        Ok(_) => {
            let _ = state.set_meta(CAPABILITIES_DIGEST_KEY, &digest_text);
            let _ = state.set_meta(CAPABILITIES_POSTED_KEY, &ctx.now_seconds.to_string());
            outcome(true, None, None)
        }
        Err(error) => {
            let code = match error {
                HttpError::Status(status) => format!("http_{status}"),
                HttpError::Timeout => "timeout".to_owned(),
                HttpError::Transport => "transport".to_owned(),
                _ => "client".to_owned(),
            };
            tracing::warn!(code = "capabilities_not_posted", error = %code, "capability document not accepted");
            outcome(false, None, Some(code))
        }
    }
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

    fn hash(fill: char) -> Sha256Hex {
        Sha256Hex::try_from(std::iter::repeat_n(fill, 64).collect::<String>()).unwrap()
    }

    #[test]
    fn identity_decisions_separate_a_switched_account_from_a_conflict() {
        let confirmed =
            IdentityEvidence { server_hash: Some(hash('a')), local: Some(hash('a')), ..Default::default() };
        assert_eq!(
            decide_identity(&confirmed),
            IdentityDecision { state: IdentityState::Confirmed, conflict: false, refresh_pin: true }
        );
        // Another account signed in: `Changed`, but not a conflict, so stamped readings still bind.
        let switched = IdentityEvidence { local: Some(hash('b')), ..confirmed.clone() };
        assert_eq!(
            decide_identity(&switched),
            IdentityDecision { state: IdentityState::Changed, conflict: false, refresh_pin: false }
        );
        // Unreadable local evidence keeps the server's word.
        let unreadable = IdentityEvidence { local: None, ..confirmed.clone() };
        assert_eq!(decide_identity(&unreadable).state, IdentityState::Confirmed);
        assert!(!decide_identity(&unreadable).refresh_pin);
        // A roots edit is forgiven while both sides name the same account, and refreshes the pin.
        let edited = IdentityEvidence { pin_drifted: true, ..confirmed.clone() };
        assert_eq!(
            decide_identity(&edited),
            IdentityDecision { state: IdentityState::Confirmed, conflict: false, refresh_pin: true }
        );
        let edited_and_switched = IdentityEvidence { pin_drifted: true, ..switched.clone() };
        assert_eq!(decide_identity(&edited_and_switched).state, IdentityState::Changed);
        assert!(decide_identity(&edited_and_switched).conflict);
        assert!(decide_identity(&IdentityEvidence { pin_drifted: true, ..unreadable }).conflict);
        // A 409 is a conflict whatever else is true, and no pin moves under a conflict.
        let refused = IdentityEvidence { refused: true, ..confirmed.clone() };
        assert_eq!(
            decide_identity(&refused),
            IdentityDecision { state: IdentityState::Changed, conflict: true, refresh_pin: false }
        );
        // A withdrawn hash (approve_identity in the Observatory) is a conflict until re-confirmed.
        let withdrawn = IdentityEvidence {
            server_hash: None,
            local: Some(hash('a')),
            previously_set: true,
            ..Default::default()
        };
        assert_eq!(decide_identity(&withdrawn).state, IdentityState::Changed);
        assert!(decide_identity(&withdrawn).conflict);
        // Never confirmed: unconfirmed, no conflict.
        let fresh = IdentityEvidence { server_hash: None, local: Some(hash('a')), ..Default::default() };
        assert_eq!(
            decide_identity(&fresh),
            IdentityDecision { state: IdentityState::Unconfirmed, conflict: false, refresh_pin: false }
        );
    }

    #[test]
    fn confirmation_is_skipped_when_a_sibling_holds_the_local_hash() {
        let a = hash('a');
        let b = hash('b');
        assert!(should_confirm(None, Some(&a), []));
        assert!(should_confirm(None, Some(&a), [(true, Some(&b))]));
        assert!(
            !should_confirm(None, Some(&a), [(true, Some(&b)), (true, Some(&a))]),
            "the sibling's hash would be refused as taken"
        );
        assert!(
            !should_confirm(None, Some(&a), [(false, Some(&a))]),
            "a disabled sibling's hash is refused as taken too"
        );
        assert!(!should_confirm(Some(&a), Some(&a), []), "already confirmed");
        assert!(!should_confirm(None, None, []), "nothing to post");
    }

    #[test]
    fn confirmation_is_skipped_while_an_enabled_sibling_has_no_hash_either() {
        let a = hash('a');
        let b = hash('b');
        // Two enabled bindings, both unconfirmed: the evidence is ambiguous between them.
        assert!(!should_confirm(None, Some(&a), [(true, None)]));
        assert!(!should_confirm(None, Some(&a), [(true, Some(&b)), (true, None)]));
        // Disabling the other binding in the Observatory leaves one candidate, which confirms.
        assert!(should_confirm(None, Some(&a), [(false, None)]));
        assert!(should_confirm(None, Some(&a), [(false, None), (true, Some(&b))]));
    }

    /// A statusline reading as `claude_account` emits it, stored as pending.
    fn queued_statusline_reading(state: &State) -> Record {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/wire/valid/companion-all-record-types.json"
        ))
        .unwrap();
        let mut value = fixture["records"]
            .as_array()
            .unwrap()
            .iter()
            .find(|record| record["record_type"] == "allowance.reading")
            .cloned()
            .unwrap();
        value["record_id"] = json!("00000000-0000-4000-8000-0000000000aa");
        value["adapter"] = json!("claude_account");
        value["channel"] = json!("hook_snapshot");
        value["reader"] = json!("statusline");
        value["meter_key"] = json!("five_hour");
        value["label"] = json!("Claude · 5h");
        value["raw_window_id"] = json!("five_hour");
        let record: Record = serde_json::from_value(value).unwrap();
        save_record(state, &record, "2026-09-02T04:01:00.000Z");
        record
    }

    #[test]
    fn queued_statusline_readings_stay_home_under_a_statusline_deny_whichever_reader_is_selected() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        queued_statusline_reading(&state);
        let no_resources = ResourceConfiguration::default();
        let pending = |settings: &CollectionSettings, deny: &[&str]| {
            let deny: Vec<String> = deny.iter().map(|entry| (*entry).to_owned()).collect();
            pending_records_for_current_settings(&state, settings, &deny, &no_resources).unwrap().len()
        };
        let statusline = CollectionSettings::defaults();
        assert_eq!(pending(&statusline, &[]), 1);
        assert_eq!(pending(&statusline, &["allowance.claude_reader.statusline"]), 0);
        assert_eq!(pending(&statusline, &["allowance.claude_reader"]), 0);
        assert_eq!(pending(&statusline, &["allowance.codex_reader"]), 1, "an unrelated deny");

        // Under `oauth_usage` the adapter's gate names the OAuth reader; the statusline
        // reader's own path still keeps its readings local.
        let mut oauth = CollectionSettings::defaults();
        oauth.allowance.claude_reader = observatory_contract::settings::ClaudeReader::OauthUsage;
        assert_eq!(pending(&oauth, &[]), 1);
        assert_eq!(pending(&oauth, &["allowance.claude_reader.statusline"]), 0);
        assert_eq!(pending(&oauth, &["allowance.claude_reader.oauth_usage"]), 0, "the adapter's gate");
        assert_eq!(pending(&oauth, &["allowance.claude_reader"]), 0);
        assert_eq!(pending(&oauth, &["claude_account"]), 0);
        assert_eq!(pending(&oauth, &["providers.claude"]), 0);
        assert_eq!(pending(&oauth, &["allowance.claude_reader.statusline.extra"]), 1, "not a prefix");
        assert_eq!(pending(&oauth, &["allowance.codex_reader.embedded"]), 1);
        assert_eq!(state.record_counts().unwrap().2, 0, "a deny rejects nothing");
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
        let locally_denied =
            crate::adapter::restrict_project_attribution(ProjectAttribution::Hashed, &["execution".into()]);
        assert_eq!(locally_denied, ProjectAttribution::Off);
        let denied = pending_records_for_agent_setting(
            &state,
            DetailLevel::Requests,
            true,
            locally_denied,
            ToolDetail::Off,
        )
        .unwrap();
        assert!(denied.iter().all(|record| match record {
            Record::ActivityRequest(request) => {
                request.project_hash.as_ref().is_none() && request.project.is_none()
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
        let mut current = CollectionSettings::defaults();
        current.execution.detail_level = DetailLevel::Requests;
        current.execution.include_subagents = true;
        current.execution.project_attribution = ProjectAttribution::Hashed;
        let no_resources = ResourceConfiguration::default();
        for entry in ["claude_execution", "providers.claude", "execution", "execution.claude_local_logs"] {
            assert!(
                pending_records_for_current_settings(&state, &current, &[entry.into()], &no_resources)
                    .unwrap()
                    .is_empty(),
                "{entry} must keep queued Claude records local"
            );
        }
        assert_eq!(
            pending_records_for_current_settings(
                &state,
                &current,
                &["execution.codex_local_history".into()],
                &no_resources
            )
            .unwrap()
            .len(),
            4,
            "an unrelated adapter deny does not drop Claude records"
        );
        let first_allowed = pending_records_for_agent_setting_with_limit(
            &state,
            DetailLevel::Requests,
            false,
            ProjectAttribution::Off,
            ToolDetail::Off,
            1,
            None,
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
    fn queued_tool_names_are_tightened_before_an_offline_upload() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/wire/valid/detail-contract-events.json"
        ))
        .unwrap();
        let mut request = fixture["records"][0].clone();
        request["tool_calls"] = json!(2);
        request["tools"] = json!([
            { "name": "Read", "calls": 1 },
            { "name": "h:1234567890abcdef", "calls": 1 }
        ]);
        let mut custom = fixture["records"][11].clone();
        custom["record_id"] = json!("00000000-0000-4000-8000-000000000099");
        custom["semantic_key"] = custom["invocation_key"].clone();
        custom["tool"] = json!({
            "name": "h:1234567890abcdef",
            "namespace": "h:abcdef1234567890",
            "class": "custom"
        });
        let records: Vec<Record> =
            [request, custom].into_iter().map(|value| serde_json::from_value(value).unwrap()).collect();
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        for record in &records {
            save_record(&state, record, "2026-09-02T04:01:00.000Z");
        }

        let filtered = pending_records_for_agent_setting(
            &state,
            DetailLevel::RequestsWithTools,
            true,
            ProjectAttribution::Off,
            ToolDetail::BuiltinOnly,
        )
        .unwrap();
        let request = filtered.iter().find_map(|record| match record {
            Record::ActivityRequest(request) => Some(request),
            _ => None,
        });
        assert_eq!(request.unwrap().tools.as_ref().unwrap().len(), 1);
        let tool = filtered.iter().find_map(|record| match record {
            Record::ToolEvent(event) => Some(event),
            _ => None,
        });
        assert!(tool.unwrap().tool.name.as_ref().is_none());
        assert!(tool.unwrap().tool.namespace.as_ref().is_none());

        let off = pending_records_for_agent_setting(
            &state,
            DetailLevel::RequestsWithTools,
            true,
            ProjectAttribution::Off,
            ToolDetail::Off,
        )
        .unwrap();
        let request = off.iter().find_map(|record| match record {
            Record::ActivityRequest(request) => Some(request),
            _ => None,
        });
        assert!(request.unwrap().tools.is_none());

        let requests_only = pending_records_for_agent_setting(
            &state,
            DetailLevel::Requests,
            true,
            ProjectAttribution::Off,
            ToolDetail::HashedCustom,
        )
        .unwrap();
        let request = requests_only.iter().find_map(|record| match record {
            Record::ActivityRequest(request) => Some(request),
            _ => None,
        });
        let request = request.unwrap();
        assert!(request.tool_calls.as_ref().is_none());
        assert!(request.tools.is_none());
    }

    #[test]
    fn queued_tool_events_follow_the_current_subagent_setting() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/wire/valid/detail-contract-events.json"
        ))
        .unwrap();
        let record: Record = serde_json::from_value(fixture["records"][11].clone()).unwrap();
        let Record::ToolEvent(event) = &record else { panic!("fixture must be a tool event") };
        let invocation_key = event.invocation_key.as_str().to_owned();
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        save_record(&state, &record, "2026-09-02T04:01:00.000Z");
        state
            .upsert_tool_event(
                event.binding_id.as_str(),
                &crate::state::ToolEventRow {
                    id: invocation_key.clone(),
                    timestamp: event.observed_at.to_string(),
                    event_kind: "invocation".into(),
                    invocation_key,
                    session_hash: None,
                    caller_request_key: None,
                    caller_agent_key: Some("9".repeat(64)),
                    caller_is_subagent: true,
                    parent_invocation_key: None,
                    class: "builtin".into(),
                    name: Some("Read".into()),
                    name_hash: None,
                    namespace: None,
                    namespace_hash: None,
                    outcome: "unknown".into(),
                    name_truncated: false,
                },
            )
            .unwrap();

        let pending = |include_subagents| {
            pending_records_for_agent_setting(
                &state,
                DetailLevel::RequestsWithTools,
                include_subagents,
                ProjectAttribution::Off,
                ToolDetail::BuiltinOnly,
            )
            .unwrap()
        };
        assert!(pending(false).is_empty());
        assert_eq!(pending(true).len(), 1);
    }

    /// The two `resource.access` fixture records (one invocation, two
    /// resources) re-stamped with this state's current token for their keys.
    fn queued_resource_accesses(state: &State, configuration: &ResourceConfiguration) -> Vec<Record> {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/usage-v2/wire/valid/detail-contract-events.json"
        ))
        .unwrap();
        let mut records = Vec::new();
        for index in [15, 16] {
            let mut value = fixture["records"][index].clone();
            let key = value["resource_key"].as_str().unwrap();
            if let Some(digest) = configuration.resource_version(key) {
                let token = state.resource_config_token(&digest).unwrap();
                value["configuration_version"] = json!(format!("cfg:{token}"));
            }
            let record: Record = serde_json::from_value(value).unwrap();
            save_record(state, &record, "2026-09-02T04:01:00.000Z");
            records.push(record);
        }
        records
    }

    fn resource_configuration(keys: &[&str]) -> ResourceConfiguration {
        let resources: Vec<_> = keys
            .iter()
            .map(|key| crate::config::LocalResource {
                key: (*key).to_owned(),
                label: None,
                roots: vec![PathBuf::from(format!("/synthetic/{key}"))],
                connectors: Vec::new(),
                source: None,
            })
            .collect();
        ResourceConfiguration::from_local(&resources, Some("/synthetic/home"))
    }

    fn resource_keys(records: &[Record]) -> Vec<String> {
        let mut keys: Vec<String> = records
            .iter()
            .filter_map(|record| match record {
                Record::ResourceAccess(access) => Some(access.resource_key.as_str().to_owned()),
                _ => None,
            })
            .collect();
        keys.sort();
        keys
    }

    #[test]
    fn queued_resource_accesses_upload_only_under_their_current_configuration() {
        let mut settings = CollectionSettings::defaults();
        settings.execution.detail_level = DetailLevel::RequestsWithTools;
        settings.execution.include_subagents = true;
        let both = resource_configuration(&["obsidian.primary", "obsidian.reference"]);

        // Both keys configured with matching tokens: both upload.
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        queued_resource_accesses(&state, &both);
        let uploaded = pending_records_for_current_settings(&state, &settings, &[], &both).unwrap();
        assert_eq!(resource_keys(&uploaded), vec!["obsidian.primary", "obsidian.reference"]);
        assert_eq!(state.record_counts().unwrap(), (2, 2, 0));
        assert!(pending_records_for_current_settings(&state, &settings, &[], &both).unwrap().iter().all(
            |record| {
                match record {
                    Record::ResourceAccess(access) => access
                        .configuration_version
                        .as_ref()
                        .is_some_and(|code| code.as_str().starts_with("cfg:")),
                    _ => false,
                }
            }
        ));

        // A key that is no longer configured is superseded and stays rejected.
        let primary_only = resource_configuration(&["obsidian.primary"]);
        let uploaded = pending_records_for_current_settings(&state, &settings, &[], &primary_only).unwrap();
        assert_eq!(resource_keys(&uploaded), vec!["obsidian.primary"]);
        assert_eq!(state.record_counts().unwrap(), (2, 1, 1));
        let uploaded = pending_records_for_current_settings(&state, &settings, &[], &both).unwrap();
        assert_eq!(
            resource_keys(&uploaded),
            vec!["obsidian.primary"],
            "a rejected record does not return by itself"
        );

        // A changed root set gives the key a new token; the stale row is superseded.
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        queued_resource_accesses(&state, &both);
        let moved = ResourceConfiguration::from_local(
            &[
                crate::config::LocalResource {
                    key: "obsidian.primary".into(),
                    label: None,
                    roots: vec![PathBuf::from("/synthetic/moved")],
                    connectors: Vec::new(),
                    source: None,
                },
                crate::config::LocalResource {
                    key: "obsidian.reference".into(),
                    label: None,
                    roots: vec![PathBuf::from("/synthetic/obsidian.reference")],
                    connectors: Vec::new(),
                    source: None,
                },
            ],
            Some("/synthetic/home"),
        );
        let uploaded = pending_records_for_current_settings(&state, &settings, &[], &moved).unwrap();
        assert_eq!(resource_keys(&uploaded), vec!["obsidian.reference"]);
        assert_eq!(
            state.record_counts().unwrap(),
            (2, 1, 1),
            "the stale primary row is marked superseded_configuration"
        );

        // Nothing configured: every queued row is superseded.
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        queued_resource_accesses(&state, &both);
        let uploaded =
            pending_records_for_current_settings(&state, &settings, &[], &ResourceConfiguration::default())
                .unwrap();
        assert!(resource_keys(&uploaded).is_empty());
        assert_eq!(state.record_counts().unwrap(), (2, 0, 2));

        // Below requests_with_tools nothing leaves either, but nothing is marked.
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        queued_resource_accesses(&state, &both);
        let mut requests_only = settings.clone();
        requests_only.execution.detail_level = DetailLevel::Requests;
        assert!(pending_records_for_current_settings(&state, &requests_only, &[], &both).unwrap().is_empty());
        assert_eq!(state.record_counts().unwrap(), (2, 2, 0));
    }

    #[test]
    fn queued_resource_accesses_stay_local_under_the_deny_entry_and_subagent_rule() {
        let mut settings = CollectionSettings::defaults();
        settings.execution.detail_level = DetailLevel::RequestsWithTools;
        settings.execution.include_subagents = true;
        let both = resource_configuration(&["obsidian.primary", "obsidian.reference"]);
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let records = queued_resource_accesses(&state, &both);

        // The deny entry keeps rows pending on this machine; lifting it uploads them.
        for entry in ["execution", "execution.resource_attribution"] {
            assert!(
                resource_keys(
                    &pending_records_for_current_settings(&state, &settings, &[entry.into()], &both).unwrap()
                )
                .is_empty(),
                "{entry} must keep queued resource rows local"
            );
            assert_eq!(state.record_counts().unwrap(), (2, 2, 0), "{entry} rejects nothing");
        }
        assert_eq!(
            resource_keys(
                &pending_records_for_current_settings(
                    &state,
                    &settings,
                    &["execution.project_attribution".into()],
                    &both
                )
                .unwrap()
            )
            .len(),
            2
        );

        // Rows from a subagent invocation follow the include_subagents setting.
        let Record::ResourceAccess(access) = &records[0] else { panic!("fixture must be a resource access") };
        state
            .upsert_tool_event(
                access.binding_id.as_str(),
                &crate::state::ToolEventRow {
                    id: access.invocation_key.as_str().to_owned(),
                    timestamp: access.observed_at.to_string(),
                    event_kind: "invocation".into(),
                    invocation_key: access.invocation_key.as_str().to_owned(),
                    session_hash: None,
                    caller_request_key: None,
                    caller_agent_key: Some("9".repeat(64)),
                    caller_is_subagent: true,
                    parent_invocation_key: None,
                    class: "builtin".into(),
                    name: Some("Read".into()),
                    name_hash: None,
                    namespace: None,
                    namespace_hash: None,
                    outcome: "unknown".into(),
                    name_truncated: false,
                },
            )
            .unwrap();
        settings.execution.include_subagents = false;
        assert!(
            resource_keys(&pending_records_for_current_settings(&state, &settings, &[], &both).unwrap())
                .is_empty()
        );
        settings.execution.include_subagents = true;
        assert_eq!(
            resource_keys(&pending_records_for_current_settings(&state, &settings, &[], &both).unwrap())
                .len(),
            2
        );
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
    fn scratch_config(dir: &Path) -> CompanionConfig {
        let root = dir.join("PRIVATE-ROOT-SENTINEL");
        std::fs::create_dir_all(&root).unwrap();
        let config = CompanionConfig {
            schema_version: Lit,
            url: "https://example.test".into(),
            install_id: Uuid::v4(),
            key: crate::config::Secret::new("k".repeat(43)),
            machine_label: "scratch".into(),
            since: Some("2026-09-01".into()),
            bindings: vec![crate::config::LocalBinding {
                binding_id: Uuid::v4(),
                account_id: observatory_contract::AccountId::from_str("claude-scratch").unwrap(),
                provider: Provider::Claude,
                roots: Some(vec![root]),
                codex_home: None,
                cursor_state_db: None,
                detailed_report: None,
            }],
            deny: vec![
                "allowance.claude_reader.oauth_usage".into(),
                "/Users/private/vault".into(),
                "providers.cursor".into(),
            ],
            resources: vec![],
            claude_statusline_inbox: None,
        };
        config.save(dir).unwrap();
        config
    }

    /// An adapter whose collect thread panics, standing in for the transcript scanner.
    struct Panicking;

    impl Adapter for Panicking {
        fn id(&self) -> AdapterId {
            AdapterId::ClaudeExecution
        }
        fn parser_version(&self) -> &'static str {
            "test"
        }
        fn preflight(&self, _ctx: &RunContext) -> Preflight {
            Preflight::Ready
        }
        fn collect(
            &self,
            _ctx: &RunContext,
            _cursor: Option<Cursor>,
            _sink: &mut dyn crate::adapter::Sink,
        ) -> Result<Outcome, crate::adapter::AdapterError> {
            panic!("synthetic adapter panic")
        }
    }

    #[test]
    fn the_capability_document_names_codes_and_ids_only_and_skips_an_unchanged_post() {
        let dir = tempfile::tempdir().unwrap();
        let config = scratch_config(dir.path());
        let options = RunOptions { dry_run: true, fetch_config: false, ..RunOptions::default() };
        let prepared = prepare(dir.path(), &options, false).unwrap();
        assert!(prepared.offline);
        let state = State::open(&prepared.ctx.state_path).unwrap();
        let schedule = schedule_summary(dir.path(), &config.install_id, None);
        let adapters: Vec<Box<dyn Adapter>> = vec![Box::new(Panicking)];
        let document = capabilities_document(
            &prepared.config,
            &prepared.ctx,
            &state,
            prepared.config_source,
            &adapters,
            &schedule,
        );
        document.validate().unwrap();
        let text = serde_json::to_string(&document).unwrap();
        let escaped_dir = dir.path().to_string_lossy().replace('\\', "\\\\");
        assert!(!text.contains("PRIVATE-ROOT-SENTINEL"), "{text}");
        assert!(!text.contains(&escaped_dir) && !text.contains("/Users/private"), "{text}");
        assert_eq!(document.deny.len(), 2, "only recognized deny entries travel");
        assert_eq!(document.deny_unrecognized.get(), 1);
        assert_eq!(document.bindings.len(), 1);
        assert_eq!(document.bindings[0].roots_present.get(), 1);
        assert_eq!(document.effective.config_source, ConfigSourceKind::Defaults);
        assert_eq!(
            document.backfill.since.clone().into_inner().map(|date| date.as_str().to_owned()),
            Some("2026-09-01".to_owned())
        );
        assert!(document.adapters[0].implemented, "a parser version other than 0 is implemented");
        assert_eq!(document.schedule.state, ScheduleState::NotInstalled);
        // Unchanged since an acknowledged post within the day: skipped without contacting anyone.
        let change = capabilities_change_digest(&document);
        state.set_meta(CAPABILITIES_DIGEST_KEY, &change).unwrap();
        state.set_meta(CAPABILITIES_POSTED_KEY, &prepared.ctx.now_seconds.to_string()).unwrap();
        let outcome = report_capabilities(
            &prepared.config,
            &prepared.ctx,
            &state,
            prepared.config_source,
            &adapters,
            &schedule,
            false,
        );
        assert_eq!((outcome.posted, outcome.skipped), (false, Some("unchanged")));
        // Queue counters move every run and never change the digest.
        let mut moved = document.clone();
        moved.queue.records_pending = Counter::saturating(99);
        assert_eq!(capabilities_change_digest(&moved), change);
    }

    #[test]
    fn a_panicking_adapter_reports_a_failed_coverage_row_and_a_dry_run_skips_the_post() {
        let dir = tempfile::tempdir().unwrap();
        scratch_config(dir.path());
        let options = RunOptions { dry_run: true, fetch_config: false, ..RunOptions::default() };
        let prepared = prepare(dir.path(), &options, true).unwrap();
        let adapters: Vec<Box<dyn Adapter>> = vec![Box::new(Panicking)];
        let summary = execute(prepared, &adapters).unwrap();
        let row = summary.adapters.iter().find(|row| row.adapter == AdapterId::ClaudeExecution).unwrap();
        assert_eq!((row.state, row.detail), (CoverageState::Failed, Some(DetailCode::AdapterPanicked)));
        let capabilities = summary.capabilities.as_ref().unwrap();
        assert_eq!((capabilities.posted, capabilities.skipped), (false, Some("dry_run")));
        assert_eq!(summary.schedule.as_ref().unwrap().desired_interval_minutes, None);
    }
}
