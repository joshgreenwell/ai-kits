//! `allowance.reading` records from the local allowance slots: the embedded
//! Codex rate limits (reader `embedded`) and the Claude Code statusline inbox
//! (reader `statusline`). Meter keys equal the v1 `window_key`; model-scoped
//! weekly windows (`seven_day_<model>`) are accepted beside the pooled ones.
//!
//! Statusline samples are bound by identity: the hook stamps each sample with
//! the hash of the account signed in when it observed the reading, and the run
//! matches the stamp against the bindings' confirmed hashes. A sample that
//! cannot be bound safely is quarantined, never emitted, and re-evaluated on
//! every run. The `allowance` capability row reports the reader's health from
//! that evidence first and from the hook installation only when there is none.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use observatory_contract::records::WindowMinutes;
use observatory_contract::settings::{ClaudeReader, CodexReader};
use observatory_contract::{
    Adapter, AllowanceKind, AllowanceReading, AllowanceUnit, Basis, CapabilityCoverage, CapabilityDimension,
    CapabilityState, Channel, Code, MeterKey, Nullable, Reader, Real, Record, Stamp, Text, Uuid,
};
use observatory_core::adapter::{BindingContext, IdentityState, RunContext, Sink, record_id};
use observatory_core::inbox::{SidecarStatus, read_statusline_files, stale_after_minutes, window_minutes};
use observatory_core::pyjson::{digest, epoch, epoch_text};
use observatory_core::state::State;
use serde_json::{Value, json};

/// Builds a reading from a stored slot payload (the v1 quota item plus `raw_window_id`).
pub fn reading_from_slot(
    binding: &Uuid,
    adapter: Adapter,
    channel: Channel,
    reader: Reader,
    parser_version: &str,
    payload: &Value,
) -> Option<Record> {
    let window_key = payload.get("window_key")?.as_str()?;
    let label = payload.get("label")?.as_str()?;
    let observed_at = Stamp::parse(payload.get("observed_at")?.as_str()?).ok()?;
    let resets_at = Stamp::parse(payload.get("resets_at")?.as_str()?).ok()?;
    let used = payload.get("used_percent")?.as_number()?.clone();
    let minutes = payload.get("window_minutes")?.as_u64()?;
    let raw_window_id = payload.get("raw_window_id").and_then(Value::as_str).unwrap_or(window_key);
    let locator = format!("{}:{}:{}", reader.as_str(), window_key, observed_at.as_str());
    Some(Record::AllowanceReading(AllowanceReading {
        record_id: record_id(binding, channel, &locator),
        binding_id: binding.clone(),
        adapter,
        channel,
        observed_at,
        basis: Basis::Reported,
        parser_version: Text::truncated(parser_version).ok()?,
        meter_key: MeterKey::try_from(window_key.to_owned()).ok()?,
        label: Text::truncated(label).ok()?,
        kind: AllowanceKind::PercentUsed,
        value: Nullable::some(Real::try_from(used).ok()?),
        unit: Nullable::some(AllowanceUnit::Percent),
        capacity: Nullable::NULL,
        window_minutes: Nullable::some(WindowMinutes::new(minutes).ok()?),
        window_started_at: Nullable::NULL,
        resets_at: Nullable::some(resets_at),
        reader,
        raw_window_id: Nullable::some(Text::truncated(raw_window_id).ok()?),
    }))
}

/// Emits every dirty slot of a binding as a reading and clears the mark.
/// Returns the number emitted.
pub fn emit_dirty_slots(
    state: &State,
    binding: &BindingContext,
    adapter: Adapter,
    channel: Channel,
    reader: Reader,
    parser_version: &str,
    sink: &mut dyn Sink,
) -> Result<u64, observatory_core::adapter::AdapterError> {
    let mut emitted = 0;
    for (slot, payload) in state.dirty_allowance_slots(binding.binding_id.as_str())? {
        let value: Value = match serde_json::from_str(&payload) {
            Ok(value) => value,
            Err(_) => {
                state.clear_allowance_dirty(binding.binding_id.as_str(), &slot)?;
                continue;
            }
        };
        if let Some(record) =
            reading_from_slot(&binding.binding_id, adapter, channel, reader, parser_version, &value)
        {
            sink.emit(record, Some(value));
            emitted += 1;
        }
        state.clear_allowance_dirty(binding.binding_id.as_str(), &slot)?;
    }
    Ok(emitted)
}

/// Why a statusline sample is held rather than bound, in the order the
/// capability row reports them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum QuarantineReason {
    /// Several enabled bindings could take it (or an unstamped sample met several).
    IdentityAmbiguous,
    /// An unstamped sample met the install's only binding, which is not confirmed.
    IdentityUnconfirmed,
    /// The stamp matches no enabled binding that is free of conflict.
    UnpairedIdentity,
}

impl QuarantineReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            QuarantineReason::IdentityAmbiguous => "identity_ambiguous",
            QuarantineReason::IdentityUnconfirmed => "identity_unconfirmed",
            QuarantineReason::UnpairedIdentity => "unpaired_identity",
        }
    }
}

/// Why a sample is held, plus the lone binding an unstamped sample met while
/// that binding was not yet confirmed: the only binding such a row may ever be
/// released to, since nothing else can tell whose reading it was.
#[derive(Clone, Copy, Debug)]
pub struct Held<'a> {
    pub reason: QuarantineReason,
    pub candidate: Option<&'a BindingContext>,
}

impl Held<'_> {
    const fn new(reason: QuarantineReason) -> Self {
        Held { reason, candidate: None }
    }
}

/// The binding rule. A stamped sample binds to the enabled binding whose
/// confirmed hash equals the stamp and that is free of conflict, whichever
/// account is signed in now. An unstamped sample (an older hook, an unreadable
/// config) binds only to a lone, confirmed binding.
pub fn bind_sample<'a>(
    stamp: Option<&str>,
    bindings: &[&'a BindingContext],
) -> Result<&'a BindingContext, Held<'a>> {
    let enabled: Vec<&BindingContext> = bindings.iter().copied().filter(|binding| binding.enabled).collect();
    match stamp {
        Some(stamp) => {
            let mut candidates = enabled.iter().filter(|binding| {
                !binding.identity_conflict
                    && binding.identity_hash.as_ref().is_some_and(|hash| hash.as_str() == stamp)
            });
            match (candidates.next(), candidates.next()) {
                (Some(binding), None) => Ok(binding),
                (Some(_), Some(_)) => Err(Held::new(QuarantineReason::IdentityAmbiguous)),
                (None, _) => Err(Held::new(QuarantineReason::UnpairedIdentity)),
            }
        }
        None => match enabled.as_slice() {
            [binding] if binding.identity == IdentityState::Confirmed => Ok(binding),
            [binding] => {
                Err(Held { reason: QuarantineReason::IdentityUnconfirmed, candidate: Some(binding) })
            }
            [] => Err(Held::new(QuarantineReason::UnpairedIdentity)),
            _ => Err(Held::new(QuarantineReason::IdentityAmbiguous)),
        },
    }
}

/// Whether a held unstamped row may leave quarantine: only a row held as
/// `identity_unconfirmed` for a binding that is now enabled, confirmed, and free
/// of conflict, and only to that binding. An unstamped row held as ambiguous
/// stays until retention prunes it: no later change of bindings can say whose
/// reading it was.
fn candidate_release<'a>(
    row: &observatory_core::state::QuarantinedSample,
    bindings: &[&'a BindingContext],
) -> Option<&'a BindingContext> {
    if row.reason != QuarantineReason::IdentityUnconfirmed.as_str() {
        return None;
    }
    let candidate = row.candidate_binding_id.as_deref()?;
    bindings.iter().copied().find(|binding| {
        binding.binding_id.as_str() == candidate
            && binding.enabled
            && binding.identity == IdentityState::Confirmed
            && !binding.identity_conflict
    })
}

/// What one pass over the statusline inbox did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InboxSummary {
    pub files: u64,
    pub bytes_read: u64,
    pub malformed: u64,
    /// Samples bound to a binding this run.
    pub bound: u64,
    /// Samples whose digest was already stored or held (a replay).
    pub skipped_existing: u64,
    /// Samples held this run, by reason.
    pub quarantined: BTreeMap<QuarantineReason, u64>,
    /// Samples that carried no stamp (bound or held).
    pub unstamped: u64,
    /// The newest `observed_at` bound this run.
    pub newest_bound_observed_at: Option<String>,
}

impl InboxSummary {
    pub fn quarantined_total(&self) -> u64 {
        self.quarantined.values().sum()
    }
}

/// Reads the Claude Code statusline inbox as `collect.py` does, extended to the
/// model-scoped weekly windows and to identity binding: accepts samples whose
/// key is a recognized window, in range and inside the backfill window, keyed
/// by the digest of the six whitelisted fields plus the local identity stamp
/// when present. The stamp never enters the stored payload or emitted record,
/// but it keeps identical readings from two accounts from suppressing one
/// another. The sample is stored under the binding the stamp names or held in
/// quarantine.
pub fn ingest_statusline_inbox(
    state: &State,
    ctx: &RunContext,
    bindings: &[&BindingContext],
) -> Result<InboxSummary, observatory_core::adapter::AdapterError> {
    let mut summary = InboxSummary::default();
    let stored_at = Stamp::from_timestamp(ctx.now);
    for (bytes, file) in read_statusline_files(&ctx.statusline_inbox) {
        summary.files += 1;
        summary.bytes_read += bytes;
        let Ok(Value::Array(samples)) = file else {
            summary.malformed += 1;
            continue;
        };
        for sample in samples {
            let Some(q) = sample.as_object() else {
                summary.malformed += 1;
                break;
            };
            let window_key = q.get("window_key").and_then(Value::as_str);
            if window_key.is_none_or(|key| window_minutes(key).is_none()) {
                continue;
            }
            let Some(used) = q.get("used_percent").and_then(|v| match v {
                Value::Number(n) => n.as_f64(),
                _ => None,
            }) else {
                continue;
            };
            if !(0.0..=100.0).contains(&used) {
                continue;
            }
            let observed = epoch(q.get("observed_at"));
            let reset = epoch(q.get("resets_at"));
            let (Some(observed), Some(reset)) = (observed, reset) else { continue };
            if observed < ctx.since || observed > ctx.now_seconds + 300.0 || reset <= observed {
                continue;
            }
            let keys = ["window_key", "label", "observed_at", "used_percent", "resets_at", "window_minutes"];
            let mut safe = serde_json::Map::new();
            let mut complete = true;
            for key in keys {
                match q.get(key) {
                    Some(value) => {
                        safe.insert(key.to_owned(), value.clone());
                    }
                    None => complete = false,
                }
            }
            if !complete {
                summary.malformed += 1;
                break;
            }
            let stamp = q.get("identity_hash").and_then(Value::as_str);
            let safe = Value::Object(safe);
            // Preserve the legacy content-only key for unstamped samples. A stamped
            // sample needs the account evidence in its local replay key so two accounts
            // with the same value and reset instant remain two observations.
            let slot = match stamp {
                Some(stamp) => digest(&json!({ "sample": &safe, "identity_hash": stamp })),
                None => digest(&safe),
            };
            let mut stored = safe;
            if let Value::Object(map) = &mut stored {
                map.insert("raw_window_id".to_owned(), Value::String(window_key.unwrap_or("").to_owned()));
            }
            if state.allowance_slot_exists_anywhere(slot.as_str())? {
                summary.skipped_existing += 1;
                continue;
            }
            if stamp.is_none() {
                summary.unstamped += 1;
            }
            match bind_sample(stamp, bindings) {
                Ok(binding) => {
                    state.insert_allowance_slot_if_absent(
                        binding.binding_id.as_str(),
                        slot.as_str(),
                        &stored.to_string(),
                    )?;
                    summary.bound += 1;
                    let observed_text = q.get("observed_at").and_then(Value::as_str).unwrap_or("");
                    if summary
                        .newest_bound_observed_at
                        .as_deref()
                        .is_none_or(|newest| epoch_text(newest).unwrap_or(f64::MIN) < observed)
                    {
                        summary.newest_bound_observed_at = Some(observed_text.to_owned());
                    }
                }
                Err(held) => {
                    state.quarantine_sample(
                        slot.as_str(),
                        &stored.to_string(),
                        stamp,
                        held.reason.as_str(),
                        stored_at.as_str(),
                        held.candidate.map(|binding| binding.binding_id.as_str()),
                    )?;
                    *summary.quarantined.entry(held.reason).or_insert(0) += 1;
                }
            }
        }
    }
    Ok(summary)
}

/// Re-evaluates every held sample against the current bindings. A stamped row
/// that now binds by its hash is released into that binding's slots, and one
/// whose reason changed is re-labelled. An unstamped row is released only to
/// the binding it was held for (`identity_unconfirmed`) once that binding is
/// confirmed; an unstamped ambiguous row is never released. Returns the number
/// released.
pub fn release_quarantined(
    state: &State,
    bindings: &[&BindingContext],
) -> Result<u64, observatory_core::adapter::AdapterError> {
    let mut released = 0;
    for row in state.quarantined_samples()? {
        let target = match row.identity_hash.as_deref() {
            Some(stamp) => match bind_sample(Some(stamp), bindings) {
                Ok(binding) => Some(binding),
                Err(held) => {
                    state.requarantine(&row.slot, held.reason.as_str())?;
                    None
                }
            },
            None => candidate_release(&row, bindings),
        };
        if let Some(binding) = target {
            state.release_quarantined(&row.slot, binding.binding_id.as_str())?;
            released += 1;
        }
    }
    Ok(released)
}

/// Drops held rows older than the retention (never under seven days) unless
/// their stamp still pairs with an enabled binding's hash: a binding in
/// conflict keeps its readings until the conflict clears.
pub fn prune_quarantine(
    state: &State,
    ctx: &RunContext,
    bindings: &[&BindingContext],
) -> Result<usize, observatory_core::adapter::AdapterError> {
    let keep_days = ctx.settings.local_raw_retention_days.get().max(7) as i64;
    let cutoff = jiff::Timestamp::from_second(ctx.now.as_second() - keep_days * 86_400).unwrap_or(ctx.now);
    let pairable: Vec<String> = bindings
        .iter()
        .filter(|binding| binding.enabled)
        .filter_map(|binding| binding.identity_hash.as_ref().map(|hash| hash.as_str().to_owned()))
        .collect();
    Ok(state.prune_quarantine(Stamp::from_timestamp(cutoff).as_str(), &pairable)?)
}

/// What the Claude settings file says about the statusline hook.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HookStatus {
    /// No `statusLine.command` runs the `statusline` subcommand with a `--config-dir`.
    NotInstalled,
    /// The command names this run's configuration directory.
    Installed,
    /// The command names another configuration directory, so its samples land
    /// where this run never reads.
    ConfigDirMismatch { config_dir: String },
}

impl HookStatus {
    pub const fn as_str(&self) -> &'static str {
        match self {
            HookStatus::NotInstalled => "not_installed",
            HookStatus::Installed => "installed",
            HookStatus::ConfigDirMismatch { .. } => "config_dir_mismatch",
        }
    }
}

/// Splits a command line the way a shell would for our own installer's output:
/// whitespace-separated, with double or single quotes grouping a token.
fn command_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut pending = false;
    for ch in command.chars() {
        match quote {
            Some(open) if ch == open => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => {
                quote = Some(ch);
                pending = true;
            }
            None if ch.is_whitespace() => {
                if pending || !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                    pending = false;
                }
            }
            None => current.push(ch),
        }
    }
    if pending || !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// The `--config-dir` a statusline hook command names, when the command runs
/// the `statusline` subcommand at all. The executable path is never matched.
pub fn hook_command_config_dir(command: &str) -> Option<String> {
    let tokens = command_tokens(command);
    if !tokens.iter().any(|token| token == "statusline") {
        return None;
    }
    let mut config_dir = None;
    let mut tokens = tokens.into_iter();
    while let Some(token) = tokens.next() {
        if token == "--config-dir" {
            config_dir = tokens.next();
        } else if let Some(value) = token.strip_prefix("--config-dir=") {
            config_dir = Some(value.to_owned());
        }
    }
    config_dir.filter(|dir| !dir.is_empty())
}

fn same_config_dir(hook: &str, run: &Path) -> bool {
    let normalize = |text: &str| {
        let trimmed = text.trim_end_matches(['/', '\\']);
        if cfg!(windows) { trimmed.replace('\\', "/").to_ascii_lowercase() } else { trimmed.to_owned() }
    };
    normalize(hook) == normalize(&run.to_string_lossy())
}

/// Reads the Claude settings file for the installed statusline hook.
pub fn hook_status(settings_path: &Path, config_dir: &Path) -> HookStatus {
    let Ok(bytes) = fs::read(settings_path) else { return HookStatus::NotInstalled };
    let Ok(settings) = serde_json::from_slice::<Value>(&bytes) else { return HookStatus::NotInstalled };
    let command = settings.get("statusLine").and_then(|line| line.get("command")).and_then(Value::as_str);
    match command.and_then(hook_command_config_dir) {
        Some(dir) if same_config_dir(&dir, config_dir) => HookStatus::Installed,
        Some(dir) => HookStatus::ConfigDirMismatch { config_dir: dir },
        None => HookStatus::NotInstalled,
    }
}

fn capability(state: CapabilityState, detail: Option<&str>) -> CapabilityCoverage {
    CapabilityCoverage {
        dimension: CapabilityDimension::Allowance,
        state,
        detail_code: Nullable(detail.and_then(|value| Code::try_from(value.to_owned()).ok())),
    }
}

/// Whether an ISO timestamp lies within the freshness threshold of `now`.
fn within_threshold(at: Option<&str>, now_seconds: f64, cadence_minutes: u64) -> bool {
    at.and_then(epoch_text)
        .is_some_and(|seconds| now_seconds - seconds <= (stale_after_minutes(cadence_minutes) * 60) as f64)
}

/// The evidence the Claude `allowance` row is built from.
#[derive(Clone, Debug)]
pub struct ClaudeAllowanceEvidence<'a> {
    pub reader: ClaudeReader,
    pub ingest: &'a InboxSummary,
    /// Held rows released to a binding this run.
    pub released: u64,
    /// Rows still held after this run's release and prune, by reason.
    pub held: &'a BTreeMap<String, u64>,
    /// The newest bound sample across the install's Claude bindings, ever.
    pub newest_bound: Option<&'a str>,
    pub sidecar: Option<&'a SidecarStatus>,
    pub hook: &'a HookStatus,
    pub now_seconds: f64,
    pub cadence_minutes: u64,
}

/// The Claude `allowance` row, evidence first: samples bound, released, or held
/// this run, or a hook invocation inside the freshness threshold, describe the
/// reader; only with no evidence at all does the hook installation speak.
pub fn claude_allowance_capability(evidence: &ClaudeAllowanceEvidence<'_>) -> CapabilityCoverage {
    if evidence.reader == ClaudeReader::Off {
        return capability(CapabilityState::DisabledBySetting, Some("reader_off"));
    }
    let hook_ran = evidence.sidecar.is_some_and(|sidecar| {
        within_threshold(
            sidecar.last_invocation_at.as_deref(),
            evidence.now_seconds,
            evidence.cadence_minutes,
        )
    });
    let ingest = evidence.ingest;
    if ingest.bound > 0 || evidence.released > 0 || ingest.quarantined_total() > 0 || hook_ran {
        for reason in [
            QuarantineReason::IdentityAmbiguous,
            QuarantineReason::IdentityUnconfirmed,
            QuarantineReason::UnpairedIdentity,
        ] {
            if ingest.quarantined.get(&reason).is_some_and(|count| *count > 0) {
                return capability(CapabilityState::Partial, Some(reason.as_str()));
            }
        }
        if evidence.held.values().any(|count| *count > 0) {
            return capability(CapabilityState::Partial, Some("quarantined_samples"));
        }
        if evidence
            .sidecar
            .is_some_and(|sidecar| sidecar.offered_windows_ever.as_ref().is_some_and(Vec::is_empty))
        {
            return capability(CapabilityState::Partial, Some("no_samples_offered"));
        }
        if evidence.reader == ClaudeReader::OauthUsage {
            return capability(CapabilityState::Partial, Some("reader_fallback_statusline"));
        }
        if let HookStatus::ConfigDirMismatch { .. } = evidence.hook {
            return capability(CapabilityState::Partial, Some("hook_config_dir_mismatch"));
        }
        let fresh = within_threshold(evidence.newest_bound, evidence.now_seconds, evidence.cadence_minutes);
        return capability(CapabilityState::Complete, (!fresh).then_some("no_recent_samples"));
    }
    match evidence.hook {
        HookStatus::NotInstalled => capability(CapabilityState::Unsupported, Some("hook_not_installed")),
        HookStatus::ConfigDirMismatch { .. } => {
            capability(CapabilityState::Partial, Some("hook_config_dir_mismatch"))
        }
        HookStatus::Installed => capability(CapabilityState::Unknown, Some("hook_not_executing")),
    }
}

/// The Claude `allowance` row when the local deny list removes the statusline
/// reader while the server selects `oauth_usage`: the same code the execution
/// adapters report for a locally denied dimension.
pub fn denied_allowance_capability() -> CapabilityCoverage {
    capability(CapabilityState::DisabledBySetting, Some("denied_locally"))
}

/// The Codex `allowance` row for the embedded reader: complete while the
/// selected reader is `embedded`, a fallback while a stub is selected, and
/// `no_recent_samples` when the newest embedded reading is older than the
/// freshness threshold.
pub fn codex_allowance_capability(
    reader: CodexReader,
    newest_observed_at: Option<&str>,
    now_seconds: f64,
    cadence_minutes: u64,
) -> CapabilityCoverage {
    match reader {
        CodexReader::Off => capability(CapabilityState::DisabledBySetting, Some("reader_off")),
        CodexReader::AppServer | CodexReader::WebBackend => {
            capability(CapabilityState::Partial, Some("reader_fallback_embedded"))
        }
        CodexReader::Embedded => {
            let fresh = within_threshold(newest_observed_at, now_seconds, cadence_minutes);
            capability(CapabilityState::Complete, (!fresh).then_some("no_recent_samples"))
        }
    }
}

/// The v1 quota item shape, for tests and snapshots.
pub fn slot_item(
    window_key: &str,
    label: &str,
    observed_at: &str,
    used: f64,
    resets_at: &str,
    minutes: u64,
) -> Value {
    json!({"window_key": window_key, "label": label, "observed_at": observed_at, "used_percent": used,
        "resets_at": resets_at, "window_minutes": minutes})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hook_commands_are_recognized_by_subcommand_and_config_dir_only() {
        let quoted = r#""C:\Users\synthetic\observatory.exe" --config-dir "C:\Users\synthetic\.config\personal-hub\companion" statusline"#;
        assert_eq!(
            hook_command_config_dir(quoted).as_deref(),
            Some(r"C:\Users\synthetic\.config\personal-hub\companion")
        );
        assert_eq!(
            hook_command_config_dir("/opt/observatory --config-dir=/home/synthetic/companion statusline")
                .as_deref(),
            Some("/home/synthetic/companion")
        );
        assert_eq!(
            hook_command_config_dir("'/opt/some tool/observatory' --config-dir '/home/s y/c' statusline")
                .as_deref(),
            Some("/home/s y/c")
        );
        assert_eq!(hook_command_config_dir("observatory statusline"), None, "no config dir");
        assert_eq!(hook_command_config_dir("observatory --config-dir /x run"), None, "not the hook");
        assert_eq!(hook_command_config_dir("python3 statusline.py"), None);
        assert_eq!(hook_command_config_dir(""), None);
    }

    #[test]
    fn hook_status_reads_a_synthetic_settings_file() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("companion");
        let settings = dir.path().join("settings.json");
        assert_eq!(hook_status(&settings, &config_dir), HookStatus::NotInstalled, "missing file");
        fs::write(&settings, b"{not json").unwrap();
        assert_eq!(hook_status(&settings, &config_dir), HookStatus::NotInstalled);
        fs::write(&settings, br#"{"statusLine":{"type":"command","command":"python3 statusline.py"}}"#)
            .unwrap();
        assert_eq!(hook_status(&settings, &config_dir), HookStatus::NotInstalled);
        let ours = json!({"statusLine": {"type": "command",
            "command": format!("\"{}\" --config-dir \"{}\" statusline", dir.path().join("observatory").display(), config_dir.display())}});
        fs::write(&settings, ours.to_string()).unwrap();
        assert_eq!(hook_status(&settings, &config_dir), HookStatus::Installed);
        let other = dir.path().join("elsewhere");
        let theirs = json!({"statusLine": {"type": "command",
            "command": format!("observatory --config-dir \"{}\" statusline", other.display())}});
        fs::write(&settings, theirs.to_string()).unwrap();
        assert_eq!(
            hook_status(&settings, &config_dir),
            HookStatus::ConfigDirMismatch { config_dir: other.to_string_lossy().into_owned() }
        );
        assert_eq!(hook_status(&settings, &other).as_str(), "installed");
    }

    #[test]
    fn codex_allowance_row_follows_the_selected_reader_and_freshness() {
        let now = epoch_text("2026-09-12T00:00:00Z").unwrap();
        let row = codex_allowance_capability(CodexReader::Embedded, Some("2026-09-11T22:00:00Z"), now, 60);
        assert_eq!((row.state, row.detail_code.as_ref()), (CapabilityState::Complete, None));
        let row = codex_allowance_capability(CodexReader::Embedded, Some("2026-09-11T21:44:00Z"), now, 60);
        assert_eq!(row.detail_code.as_ref().unwrap().as_str(), "no_recent_samples");
        let row = codex_allowance_capability(CodexReader::Embedded, Some("2026-09-11T22:01:00Z"), now, 15);
        assert_eq!((row.state, row.detail_code.as_ref()), (CapabilityState::Complete, None), "floor");
        let row = codex_allowance_capability(CodexReader::Embedded, None, now, 60);
        assert_eq!(row.detail_code.as_ref().unwrap().as_str(), "no_recent_samples");
        let row = codex_allowance_capability(CodexReader::AppServer, Some("2026-09-11T23:59:00Z"), now, 60);
        assert_eq!(row.state, CapabilityState::Partial);
        assert_eq!(row.detail_code.as_ref().unwrap().as_str(), "reader_fallback_embedded");
        let row = codex_allowance_capability(CodexReader::Off, None, now, 60);
        assert_eq!(row.state, CapabilityState::DisabledBySetting);
        assert_eq!(row.detail_code.as_ref().unwrap().as_str(), "reader_off");
        assert_eq!(row.dimension, CapabilityDimension::Allowance);
    }
}
