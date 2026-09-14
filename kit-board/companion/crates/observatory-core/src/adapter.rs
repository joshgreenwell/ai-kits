//! The `Adapter` trait (section 2.2), the run context every adapter receives,
//! the sink records flow into, and the coverage outcome an adapter returns.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use jiff::Timestamp;
use observatory_contract::settings::ProjectAttribution;
use observatory_contract::{
    AccountId, CapabilityCoverage, CollectionSettings, ConfigDocument, CoverageState, CursorState,
    DetailCode, Provider, Record, Sha256Hex, Uuid,
};
use serde_json::Value;
use thiserror::Error;

use crate::resources::{ResourceConfiguration, resource_attribution_denied};
use crate::state::{State, StateError};

/// The contract's adapter identifier.
pub type AdapterId = observatory_contract::Adapter;

/// Whether the provider identity evidence still matches what the user confirmed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IdentityState {
    /// The server holds a hash and local evidence matches it (or none is readable).
    Confirmed,
    /// The server holds no hash; the binding was created without evidence.
    Unconfirmed,
    /// The server hash is null after having been set, or local evidence differs.
    Changed,
}

/// One binding as this run sees it: the server's view plus this machine's store paths.
#[derive(Clone, Debug)]
pub struct BindingContext {
    pub binding_id: Uuid,
    pub account_id: AccountId,
    pub provider: Provider,
    pub enabled: bool,
    pub identity_hash: Option<Sha256Hex>,
    pub identity: IdentityState,
    /// Claude transcript roots or Codex session roots, resolved.
    pub roots: Vec<PathBuf>,
    pub codex_home: Option<PathBuf>,
    pub cursor_state_db: Option<PathBuf>,
}

impl BindingContext {
    pub fn runnable(&self) -> bool {
        self.enabled && self.identity != IdentityState::Changed
    }
}

/// Everything an adapter may read during one run. Adapters never see the install key.
#[derive(Debug)]
pub struct RunContext {
    /// The run's clock reading.
    pub now: Timestamp,
    /// `now` as float seconds, for the v1 arithmetic.
    pub now_seconds: f64,
    /// Pinned backfill start as `YYYY-MM-DD` and as epoch seconds.
    pub since_text: String,
    pub since: f64,
    /// Effective settings (server document with this install's override applied).
    pub settings: CollectionSettings,
    pub settings_version: u64,
    /// The cached or freshly fetched config document, when one exists.
    pub document: Option<ConfigDocument>,
    pub bindings: Vec<BindingContext>,
    pub deny: Vec<String>,
    /// The knowledge sources this run classifies tool arguments against; empty
    /// unless `companion.json` names some. Roots stay in here, on this machine.
    pub resources: ResourceConfiguration,
    pub config_dir: PathBuf,
    pub state_path: PathBuf,
    /// Where the Claude Code statusline hook writes allowance samples.
    pub statusline_inbox: PathBuf,
    /// Where tool hook receivers append their snapshots.
    pub hook_inbox: PathBuf,
    pub dry_run: bool,
    pub deadline: Instant,
    cancel: Arc<AtomicBool>,
}

impl RunContext {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        now: Timestamp,
        since_text: String,
        since: f64,
        settings: CollectionSettings,
        settings_version: u64,
        document: Option<ConfigDocument>,
        bindings: Vec<BindingContext>,
        deny: Vec<String>,
        config_dir: PathBuf,
        state_path: PathBuf,
        statusline_inbox: PathBuf,
        dry_run: bool,
        budget: Duration,
    ) -> Self {
        let hook_inbox = config_dir.join("inbox").join("hooks");
        RunContext {
            now,
            now_seconds: now.as_microsecond() as f64 / 1e6,
            since_text,
            since,
            settings,
            settings_version,
            document,
            bindings,
            deny,
            resources: ResourceConfiguration::default(),
            config_dir,
            state_path,
            statusline_inbox,
            hook_inbox,
            dry_run,
            deadline: Instant::now() + budget,
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// The knowledge sources to classify against; `run::prepare` attaches
    /// the validated `companion.json` entries here.
    pub fn with_resources(mut self, resources: ResourceConfiguration) -> Self {
        self.resources = resources;
        self
    }

    /// Opens this thread's own connection to the state database.
    pub fn open_state(&self) -> Result<State, StateError> {
        State::open(&self.state_path)
    }

    pub fn bindings_for(&self, provider: Provider) -> impl Iterator<Item = &BindingContext> {
        self.bindings.iter().filter(move |binding| binding.provider == provider)
    }

    /// The server preference after the machine-local privacy deny list. The
    /// local rule always wins and is also applied to records queued offline.
    pub fn effective_project_attribution(&self) -> ProjectAttribution {
        restrict_project_attribution(self.settings.execution.project_attribution, &self.deny)
    }

    /// Whether `resource.access` rows may leave this machine: some source is
    /// configured and the local deny list does not keep the rows home. Gates
    /// emission and the upload-time filter only; classification itself runs
    /// whenever sources are configured, so lifting the deny needs no rescan.
    pub fn effective_resource_attribution(&self) -> bool {
        !self.resources.is_empty() && !resource_attribution_denied(&self.deny)
    }

    /// Set by the runner when the run's deadline passes; adapters check it between files.
    pub fn should_stop(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) || Instant::now() >= self.deadline
    }

    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    pub fn secrets_dir(&self) -> &Path {
        &self.config_dir
    }
}

pub fn restrict_project_attribution(setting: ProjectAttribution, deny: &[String]) -> ProjectAttribution {
    let mode_path = "execution.project_attribution.hashed";
    if setting == ProjectAttribution::Hashed
        && deny.iter().any(|entry| {
            mode_path == entry || mode_path.strip_prefix(entry).is_some_and(|rest| rest.starts_with('.'))
        })
    {
        ProjectAttribution::Off
    } else {
        setting
    }
}

/// Where adapters put normalized records. The raw observation, when given, is
/// stored locally for reparsing and never uploaded.
pub trait Sink {
    fn emit(&mut self, record: Record, raw: Option<Value>);
}

#[derive(Clone, Debug)]
pub struct Emitted {
    pub record: Record,
    pub raw: Option<Value>,
}

#[derive(Debug, Default)]
pub struct MemorySink {
    pub records: Vec<Emitted>,
}

impl Sink for MemorySink {
    fn emit(&mut self, record: Record, raw: Option<Value>) {
        self.records.push(Emitted { record, raw });
    }
}

/// An opaque per-adapter resume position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cursor(pub String);

/// What `preflight` found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Preflight {
    Ready,
    Blocked { state: CoverageState, detail: DetailCode },
}

/// The coverage an adapter reports after collecting.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outcome {
    pub state: CoverageState,
    pub detail: Option<DetailCode>,
    pub stores_discovered: u64,
    pub files: u64,
    pub bytes_read: u64,
    pub records_emitted: u64,
    pub malformed: u64,
    pub cursor_state: CursorState,
    pub probe_requests: u64,
    pub next_cursor: Option<Cursor>,
    pub capabilities: Option<Vec<CapabilityCoverage>>,
}

impl Outcome {
    pub fn ok() -> Self {
        Outcome {
            state: CoverageState::Ok,
            detail: None,
            stores_discovered: 0,
            files: 0,
            bytes_read: 0,
            records_emitted: 0,
            malformed: 0,
            cursor_state: CursorState::Complete,
            probe_requests: 0,
            next_cursor: None,
            capabilities: None,
        }
    }

    pub fn failed(detail: DetailCode) -> Self {
        Outcome {
            state: CoverageState::Failed,
            detail: Some(detail),
            cursor_state: CursorState::Unknown,
            ..Outcome::ok()
        }
    }
}

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error(transparent)]
    State(#[from] StateError),
    #[error("local read failed")]
    Io,
    #[error("adapter deadline passed")]
    Timeout,
    #[error("provider interface failed: {0}")]
    Http(DetailCode),
    #[error("credential unavailable: {0}")]
    Credential(DetailCode),
    #[error("subprocess failed")]
    Subprocess,
    #[error("payload not recognized")]
    Unrecognized,
}

impl AdapterError {
    /// The coverage state and code this error becomes.
    pub fn coverage(&self) -> (CoverageState, DetailCode) {
        match self {
            AdapterError::State(_) => (CoverageState::Failed, DetailCode::StateError),
            AdapterError::Io => (CoverageState::Failed, DetailCode::IoError),
            AdapterError::Timeout => (CoverageState::Partial, DetailCode::Timeout),
            AdapterError::Http(code) => match code {
                DetailCode::HttpRateLimited => (CoverageState::RateLimited, *code),
                DetailCode::HttpUnauthorized => (CoverageState::CredentialUnavailable, *code),
                other => (CoverageState::Failed, *other),
            },
            AdapterError::Credential(code) => (CoverageState::CredentialUnavailable, *code),
            AdapterError::Subprocess => (CoverageState::Failed, DetailCode::SubprocessFailed),
            AdapterError::Unrecognized => (CoverageState::Failed, DetailCode::UnrecognizedPayload),
        }
    }
}

pub trait Adapter: Send + Sync {
    fn id(&self) -> AdapterId;

    /// Reported in every record and coverage entry; `0` until a fixture exists.
    fn parser_version(&self) -> &'static str;

    /// Prerequisites and credentials, reported as a coverage state; never performs collection.
    fn preflight(&self, ctx: &RunContext) -> Preflight;

    /// Emits normalized records into the sink and returns coverage plus the next cursor.
    fn collect(
        &self,
        ctx: &RunContext,
        cursor: Option<Cursor>,
        sink: &mut dyn Sink,
    ) -> Result<Outcome, AdapterError>;
}

/// The UUID v5 namespace for `record_id`s: `(binding_id, channel, source record locator)`.
pub const RECORD_NAMESPACE: uuid::Uuid = uuid::Uuid::from_bytes([
    0x6f, 0x3a, 0x1c, 0x2e, 0x9b, 0x54, 0x4a, 0x7d, 0x8e, 0x21, 0xc0, 0x5d, 0xa7, 0x0b, 0x93, 0x11,
]);

/// A stable record id: UUID v5 over binding, channel, and the source locator.
/// Stable across re-runs, distinct per channel.
pub fn record_id(binding_id: &Uuid, channel: observatory_contract::Channel, locator: &str) -> Uuid {
    let name = format!("{}\n{}\n{}", binding_id, channel.as_str(), locator);
    Uuid::v5(&RECORD_NAMESPACE, name.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use observatory_contract::Channel;

    #[test]
    fn record_ids_are_stable_and_channel_specific() {
        let binding = Uuid::v4();
        let a = record_id(&binding, Channel::LocalFile, "claude:msg_1");
        let b = record_id(&binding, Channel::LocalFile, "claude:msg_1");
        let c = record_id(&binding, Channel::HookSnapshot, "claude:msg_1");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert!(a.as_str().chars().nth(14) == Some('5'));
    }

    #[test]
    fn project_attribution_deny_uses_mode_path_prefixes() {
        for entry in ["execution", "execution.project_attribution", "execution.project_attribution.hashed"] {
            assert_eq!(
                restrict_project_attribution(ProjectAttribution::Hashed, &[entry.into()]),
                ProjectAttribution::Off
            );
        }
        assert_eq!(
            restrict_project_attribution(ProjectAttribution::Hashed, &["execution.tools".into()]),
            ProjectAttribution::Hashed
        );
    }

    #[test]
    fn resource_attribution_needs_a_configuration_and_no_local_deny() {
        use std::path::PathBuf;

        use observatory_contract::CollectionSettings;

        let context = |deny: Vec<String>| {
            RunContext::new(
                Timestamp::UNIX_EPOCH,
                "2026-09-01".into(),
                0.0,
                CollectionSettings::defaults(),
                0,
                None,
                Vec::new(),
                deny,
                PathBuf::from("config"),
                PathBuf::from("state.sqlite3"),
                PathBuf::from("statusline"),
                true,
                Duration::from_secs(1),
            )
        };
        assert!(!context(Vec::new()).effective_resource_attribution());
        let configured = ResourceConfiguration::from_local(
            &[crate::config::LocalResource {
                key: "alpha-src".into(),
                label: None,
                roots: vec![PathBuf::from("/synthetic/vault-alpha")],
                connectors: Vec::new(),
                source: None,
            }],
            None,
        );
        assert!(context(Vec::new()).with_resources(configured.clone()).effective_resource_attribution());
        for entry in ["execution", "execution.resource_attribution"] {
            assert!(
                !context(vec![entry.into()])
                    .with_resources(configured.clone())
                    .effective_resource_attribution(),
                "{entry} keeps resource rows local"
            );
        }
        assert!(
            context(vec!["execution.project_attribution".into()])
                .with_resources(configured)
                .effective_resource_attribution()
        );
    }
}
