//! Local state (section 2.7): SQLite `<install-id>.sqlite3`, `0600`.
//!
//! `CREATE TABLE IF NOT EXISTS` with `meta.schema_version` for forward
//! migrations. A companion state database is a new file; no v1 state is
//! migrated in place. Every table holds counters, hashes, checkpoints, and
//! bounded raw observations; never conversation text.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

use crate::privacy::{PrivacyKey, project_key, tool_name_hash, tool_namespace_hash};

pub const SCHEMA_VERSION: &str = "8";

/// The local-only rejection mark on a queued `resource.access` record whose
/// key or configuration token no longer matches this machine's configuration.
/// Lifted again when a replay re-emits the record under the current token.
pub const SUPERSEDED_CONFIGURATION: &str = "superseded_configuration";

#[derive(Debug, Error)]
pub enum StateError {
    #[error("state database error")]
    Sqlite(#[from] rusqlite::Error),
    #[error("state file error")]
    Io(#[from] io::Error),
    #[error("state row is not valid")]
    Corrupt,
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings_cache (id INTEGER PRIMARY KEY CHECK (id = 1), document TEXT NOT NULL,
  settings_version INTEGER NOT NULL, etag TEXT, fetched_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS adapter_state (adapter TEXT PRIMARY KEY, effective TEXT NOT NULL, reason TEXT,
  last_run_at TEXT, last_state TEXT, cursor TEXT);
CREATE TABLE IF NOT EXISTS files (binding_id TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL,
  mtime INTEGER NOT NULL, inode TEXT NOT NULL, offset INTEGER NOT NULL, context TEXT NOT NULL,
  PRIMARY KEY (binding_id, path));
CREATE TABLE IF NOT EXISTS file_parse_gaps (binding_id TEXT NOT NULL, path TEXT NOT NULL,
  PRIMARY KEY (binding_id, path));
CREATE TABLE IF NOT EXISTS events (binding_id TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL,
  hour TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, session_identity TEXT NOT NULL,
  timestamp TEXT NOT NULL, product TEXT NOT NULL, client_version TEXT, parent_session TEXT,
  project_hash TEXT, project_key TEXT, project_basis TEXT NOT NULL DEFAULT 'unknown',
  surface TEXT, detail_observed INTEGER NOT NULL DEFAULT 0,
  bucket_eligible INTEGER NOT NULL DEFAULT 1, detail_input_fresh INTEGER,
  detail_input_cached INTEGER, detail_input_cache_write INTEGER, detail_output INTEGER,
  detail_reasoning INTEGER, reported_total INTEGER, model_requested TEXT,
  reasoning_effort TEXT, service_tier TEXT, speed TEXT, context_window_tokens INTEGER,
  cache_write_ttl TEXT, outcome TEXT, agent_observed INTEGER NOT NULL DEFAULT 0,
  agent_key TEXT, agent_identity_basis TEXT NOT NULL DEFAULT 'unknown', parent_agent_key TEXT,
  parent_agent_identity_basis TEXT NOT NULL DEFAULT 'unknown', agent_class TEXT NOT NULL DEFAULT 'unknown',
  agent_name TEXT, agent_depth INTEGER, change_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (binding_id, id));
CREATE INDEX IF NOT EXISTS event_hours ON events(binding_id, hour, session, model);
CREATE TABLE IF NOT EXISTS agent_profiles (binding_id TEXT NOT NULL, agent_key TEXT NOT NULL,
  identity_basis TEXT NOT NULL, parent_key TEXT, parent_identity_basis TEXT NOT NULL,
  parent_evidence TEXT NOT NULL DEFAULT 'unknown', class TEXT NOT NULL, name TEXT, depth INTEGER,
  depth_evidence TEXT NOT NULL DEFAULT 'unknown', model_requested TEXT,
  PRIMARY KEY (binding_id, agent_key));
CREATE TABLE IF NOT EXISTS local_agent_events (binding_id TEXT NOT NULL, id TEXT NOT NULL,
  timestamp TEXT NOT NULL, event_kind TEXT NOT NULL, session_hash TEXT, agent_key TEXT,
  identity_basis TEXT NOT NULL, parent_key TEXT, parent_identity_basis TEXT NOT NULL,
  class TEXT NOT NULL, name TEXT, depth INTEGER, model_requested TEXT, tool_invocation_key TEXT,
  outcome TEXT NOT NULL, change_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (binding_id, id));
CREATE TABLE IF NOT EXISTS local_tool_events (binding_id TEXT NOT NULL, id TEXT NOT NULL,
  timestamp TEXT NOT NULL, event_kind TEXT NOT NULL, invocation_key TEXT NOT NULL,
  session_hash TEXT, caller_request_key TEXT, caller_agent_key TEXT,
  caller_is_subagent INTEGER NOT NULL DEFAULT 0, parent_invocation_key TEXT,
  class TEXT NOT NULL, name TEXT, name_hash TEXT, namespace TEXT, namespace_hash TEXT,
  outcome TEXT NOT NULL, name_truncated INTEGER NOT NULL DEFAULT 0,
  change_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (binding_id, id));
CREATE INDEX IF NOT EXISTS local_tool_events_invocation
  ON local_tool_events(binding_id, invocation_key, event_kind);
CREATE INDEX IF NOT EXISTS local_tool_events_request
  ON local_tool_events(binding_id, caller_request_key, event_kind);
CREATE TABLE IF NOT EXISTS tool_coverage (binding_id TEXT PRIMARY KEY,
  unmapped_forms INTEGER NOT NULL DEFAULT 0, truncated_names INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS projects (binding_id TEXT NOT NULL, project_hash TEXT NOT NULL, path TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (binding_id, project_hash));
CREATE TABLE IF NOT EXISTS local_resource_accesses (binding_id TEXT NOT NULL, id TEXT NOT NULL,
  timestamp TEXT NOT NULL, invocation_key TEXT NOT NULL, resource_key TEXT NOT NULL,
  configuration_version TEXT NOT NULL, access_kind TEXT NOT NULL, evidence_basis TEXT NOT NULL,
  nested_overlap INTEGER NOT NULL DEFAULT 0, change_generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (binding_id, id));
CREATE INDEX IF NOT EXISTS local_resource_accesses_invocation
  ON local_resource_accesses(binding_id, invocation_key);
CREATE TABLE IF NOT EXISTS local_resource_inspections (binding_id TEXT NOT NULL, invocation_key TEXT NOT NULL,
  class TEXT NOT NULL, overlapping INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (binding_id, invocation_key));
CREATE TABLE IF NOT EXISTS allowance_slots (binding_id TEXT NOT NULL, slot TEXT NOT NULL, payload TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (binding_id, slot));
CREATE INDEX IF NOT EXISTS allowance_slots_slot ON allowance_slots(slot);
CREATE TABLE IF NOT EXISTS allowance_quarantine (slot TEXT PRIMARY KEY, payload TEXT NOT NULL,
  identity_hash TEXT, reason TEXT NOT NULL, stored_at TEXT NOT NULL, candidate_binding_id TEXT);
CREATE TABLE IF NOT EXISTS observations (record_id TEXT PRIMARY KEY, adapter TEXT NOT NULL,
  observed_at TEXT NOT NULL, payload TEXT NOT NULL, stored_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (record_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, adapter TEXT NOT NULL,
  record_type TEXT NOT NULL, semantic_key TEXT NOT NULL, content_hash TEXT NOT NULL, published_hash TEXT,
  rejected_reason TEXT, record TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_pending ON records(rejected_reason, published_hash);
CREATE TABLE IF NOT EXISTS cursor_emitted (binding_id TEXT NOT NULL, record_id TEXT NOT NULL,
  content_digest TEXT NOT NULL, emitted_at TEXT NOT NULL, PRIMARY KEY (binding_id, record_id));
CREATE TABLE IF NOT EXISTS published (key TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (hash TEXT PRIMARY KEY, received_at TEXT NOT NULL, receipt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
  summary TEXT NOT NULL);
";

/// How long a connection waits for the write lock. Adapters run in parallel threads over one
/// state file, and a large re-emission (a parser or emission-shape bump) can hold the lock for
/// minutes, so a short wait made the other adapters fail with `state_error` instead of queueing.
const STATE_BUSY_TIMEOUT: Duration = Duration::from_secs(240);

/// The meta key holding the current change generation; see `advance_change_generation`.
const CHANGE_GENERATION_KEY: &str = "change_generation";

/// The meta key holding this install's privacy key as hex; see `privacy_key`.
const PRIVACY_SALT_KEY: &str = "privacy_salt";

/// Stamps every inserted or updated row of the four local event tables with
/// the current change generation, whichever statement wrote it, so the
/// execution adapters can emit only what changed since they last emitted.
/// Created after migration because an older file gains the column there.
/// The update trigger's own write changes the column, so it cannot re-fire.
const CHANGE_TRIGGERS: &str = "
CREATE TRIGGER IF NOT EXISTS events_change_insert AFTER INSERT ON events BEGIN
  UPDATE events SET change_generation = coalesce((SELECT value FROM meta WHERE key = 'change_generation'), 0)
   WHERE rowid = NEW.rowid; END;
CREATE TRIGGER IF NOT EXISTS events_change_update AFTER UPDATE ON events
  WHEN NEW.change_generation IS OLD.change_generation BEGIN
  UPDATE events SET change_generation = coalesce((SELECT value FROM meta WHERE key = 'change_generation'), 0)
   WHERE rowid = NEW.rowid; END;
CREATE TRIGGER IF NOT EXISTS local_agent_events_change_insert AFTER INSERT ON local_agent_events BEGIN
  UPDATE local_agent_events
     SET change_generation = coalesce((SELECT value FROM meta WHERE key = 'change_generation'), 0)
   WHERE rowid = NEW.rowid; END;
CREATE TRIGGER IF NOT EXISTS local_agent_events_change_update AFTER UPDATE ON local_agent_events
  WHEN NEW.change_generation IS OLD.change_generation BEGIN
  UPDATE local_agent_events
     SET change_generation = coalesce((SELECT value FROM meta WHERE key = 'change_generation'), 0)
   WHERE rowid = NEW.rowid; END;
CREATE TRIGGER IF NOT EXISTS local_tool_events_change_insert AFTER INSERT ON local_tool_events BEGIN
  UPDATE local_tool_events
     SET change_generation = coalesce((SELECT value FROM meta WHERE key = 'change_generation'), 0)
   WHERE rowid = NEW.rowid; END;
CREATE TRIGGER IF NOT EXISTS local_tool_events_change_update AFTER UPDATE ON local_tool_events
  WHEN NEW.change_generation IS OLD.change_generation BEGIN
  UPDATE local_tool_events
     SET change_generation = coalesce((SELECT value FROM meta WHERE key = 'change_generation'), 0)
   WHERE rowid = NEW.rowid; END;
CREATE TRIGGER IF NOT EXISTS local_resource_accesses_change_insert AFTER INSERT ON local_resource_accesses BEGIN
  UPDATE local_resource_accesses
     SET change_generation = coalesce((SELECT value FROM meta WHERE key = 'change_generation'), 0)
   WHERE rowid = NEW.rowid; END;
CREATE TRIGGER IF NOT EXISTS local_resource_accesses_change_update AFTER UPDATE ON local_resource_accesses
  WHEN NEW.change_generation IS OLD.change_generation BEGIN
  UPDATE local_resource_accesses
     SET change_generation = coalesce((SELECT value FROM meta WHERE key = 'change_generation'), 0)
   WHERE rowid = NEW.rowid; END;
";

/// The tables `CHANGE_TRIGGERS` stamp.
const CHANGE_STAMPED_TABLES: [&str; 4] =
    ["events", "local_agent_events", "local_tool_events", "local_resource_accesses"];

/// A tool event row that changed since a generation, with the keys the
/// request and resource records derived from it join on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangedToolEvent {
    pub id: String,
    pub invocation_key: String,
    pub caller_request_key: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CachedConfig {
    pub document: String,
    pub settings_version: u64,
    pub etag: Option<String>,
    pub fetched_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterStateRow {
    pub adapter: String,
    pub effective: String,
    pub reason: Option<String>,
    pub last_run_at: Option<String>,
    pub last_state: Option<String>,
    pub cursor: Option<String>,
}

/// A statusline sample held back from binding, with the stamp it carried and
/// why it is held (`identity_ambiguous`, `identity_unconfirmed`, `unpaired_identity`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QuarantinedSample {
    pub slot: String,
    pub payload: String,
    pub identity_hash: Option<String>,
    pub reason: String,
    pub stored_at: String,
    /// The lone binding an unstamped sample met while it was not yet confirmed
    /// (`identity_unconfirmed`): the only binding the row may ever be released to.
    pub candidate_binding_id: Option<String>,
}

/// The v1 per-file checkpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileCheckpoint {
    pub path: String,
    pub size: i64,
    pub mtime_ns: i64,
    pub inode: String,
    pub offset: i64,
    pub context: String,
}

/// One provider request event (a Codex `token_count` or a Claude assistant
/// message), keyed by its stable event digest. The non-null counters preserve
/// v1 hourly parity; nullable detail fields preserve what the source actually
/// reported for request records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventRow {
    pub id: String,
    pub session: String,
    pub hour: String,
    pub model: String,
    pub input_tokens: i64,
    pub cached_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    pub session_identity: String,
    pub timestamp: String,
    pub product: String,
    pub client_version: Option<String>,
    pub parent_session: Option<String>,
    /// Legacy alias for a working-directory project key.
    pub project_hash: Option<String>,
    /// v6: privacy-preserving project identity when the attribution basis has one.
    pub project_key: Option<String>,
    /// v6: `native`, `working_directory`, `none`, or `unknown`.
    pub project_basis: String,
    /// v2 only: the contract surface the provider's entrypoint or originator maps to.
    pub surface: Option<String>,
    /// v3: true when nullable request evidence was parsed from retained source.
    pub detail_observed: bool,
    /// v3: false for explicit zero-usage calls, which v1 omitted from hourly buckets.
    pub bucket_eligible: bool,
    pub detail_input_fresh: Option<i64>,
    pub detail_input_cached: Option<i64>,
    pub detail_input_cache_write: Option<i64>,
    pub detail_output: Option<i64>,
    /// A subset of `detail_output` when the provider reports it.
    pub detail_reasoning: Option<i64>,
    pub reported_total: Option<i64>,
    pub model_requested: Option<String>,
    pub reasoning_effort: Option<String>,
    pub service_tier: Option<String>,
    pub speed: Option<String>,
    pub context_window_tokens: Option<i64>,
    pub cache_write_ttl: Option<String>,
    pub outcome: Option<String>,
    /// v4: true when this producer observed agent attribution for the request,
    /// including an explicit unknown attribution.
    pub agent_observed: bool,
    pub agent_key: Option<String>,
    pub agent_identity_basis: String,
    pub parent_agent_key: Option<String>,
    pub parent_agent_identity_basis: String,
    pub agent_class: String,
    /// Raw bounded provider role/name retained locally. Upload policy is
    /// applied when a record is built.
    pub agent_name: Option<String>,
    pub agent_depth: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentProfileRow {
    pub key: String,
    pub identity_basis: String,
    pub parent_key: Option<String>,
    pub parent_identity_basis: String,
    /// Local precedence marker: none, fallback, structural, explicit, or unknown.
    pub parent_evidence: String,
    pub class: String,
    pub name: Option<String>,
    pub depth: Option<i64>,
    /// Local precedence marker: explicit, invalidated, inferred, or unknown.
    pub depth_evidence: String,
    pub model_requested: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentEventRow {
    pub id: String,
    pub timestamp: String,
    pub event_kind: String,
    pub session_hash: Option<String>,
    pub agent_key: Option<String>,
    pub identity_basis: String,
    pub parent_key: Option<String>,
    pub parent_identity_basis: String,
    pub class: String,
    pub name: Option<String>,
    pub depth: Option<i64>,
    pub model_requested: Option<String>,
    pub tool_invocation_key: Option<String>,
    pub outcome: String,
}

/// One locally retained tool invocation or result. Raw names are bounded and
/// never leave the machine; their full-value hashes support later privacy-policy
/// changes without retaining arguments or result content.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolEventRow {
    pub id: String,
    pub timestamp: String,
    pub event_kind: String,
    pub invocation_key: String,
    pub session_hash: Option<String>,
    pub caller_request_key: Option<String>,
    pub caller_agent_key: Option<String>,
    pub caller_is_subagent: bool,
    pub parent_invocation_key: Option<String>,
    pub class: String,
    pub name: Option<String>,
    pub name_hash: Option<String>,
    pub namespace: Option<String>,
    pub namespace_hash: Option<String>,
    pub outcome: String,
    pub name_truncated: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ToolCoverageRow {
    pub unmapped_forms: bool,
    pub truncated_names: bool,
}

/// One working directory this binding has seen, kept locally so a hash can be
/// labeled. Never uploaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRow {
    pub project_hash: String,
    pub path: String,
    pub first_seen: String,
    pub last_seen: String,
}

/// One (invocation, resource) classification kept locally: the resource key,
/// the opaque configuration token, and typed evidence only. No path, argument,
/// or matched file name is stored here, ever. Rows are a pure function of
/// transcript, parser, and configuration, so a new scan generation drops them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceAccessRow {
    pub id: String,
    pub timestamp: String,
    pub invocation_key: String,
    pub resource_key: String,
    /// `cfg:<token>` as uploaded; see `resource_config_token`.
    pub configuration_version: String,
    pub access_kind: String,
    pub evidence_basis: String,
    /// The invocation also matched another resource or a nested root.
    pub nested_overlap: bool,
}

/// One access-count bucket for `observatory resources`: rows per
/// resource key, access kind, and evidence basis.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceAccessCount {
    pub resource_key: String,
    pub access_kind: String,
    pub evidence_basis: String,
    pub rows: u64,
}

/// Inspection totals per class for one binding, read with `GROUP BY` at query
/// time so a file rescan cannot inflate them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResourceInspectionCounts {
    pub matched: u64,
    pub unmatched: u64,
    pub no_evidence: u64,
    pub unresolved: u64,
    pub unsupported: u64,
    pub ambiguous: u64,
    /// Inspections whose evidence matched several resources or nested roots.
    pub overlapping: u64,
}

impl ResourceInspectionCounts {
    /// Every invocation inspected, whatever its class.
    pub fn inspected(&self) -> u64 {
        self.matched + self.unmatched + self.no_evidence + self.unresolved + self.unsupported + self.ambiguous
    }

    pub fn add(&mut self, other: ResourceInspectionCounts) {
        self.matched += other.matched;
        self.unmatched += other.unmatched;
        self.no_evidence += other.no_evidence;
        self.unresolved += other.unresolved;
        self.unsupported += other.unsupported;
        self.ambiguous += other.ambiguous;
        self.overlapping += other.overlapping;
    }
}

/// One v1 bucket row as `bucket_rows` in `collect.py` yields it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BucketRow {
    pub session_hash: String,
    pub hour: String,
    pub model: String,
    pub input_tokens: i64,
    pub cached_tokens: i64,
    pub cache_write_tokens: i64,
    pub output_tokens: i64,
    pub calls: i64,
    pub total_tokens: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecordRow {
    pub record_id: String,
    pub binding_id: String,
    pub adapter: String,
    pub record_type: String,
    pub semantic_key: String,
    pub content_hash: String,
    pub published_hash: Option<String>,
    pub rejected_reason: Option<String>,
    pub record: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboxRow {
    pub hash: String,
    pub payload: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunRow {
    pub run_id: String,
    pub started_at: String,
    pub finished_at: String,
    pub summary: String,
}

pub(crate) fn restrict_file(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[derive(Debug)]
pub struct State {
    conn: Connection,
}

impl State {
    pub fn open(path: &Path) -> Result<State, StateError> {
        if let Some(parent) = path.parent() {
            crate::paths::ensure_private_dir(parent)?;
        }
        let conn = Connection::open(path)?;
        restrict_file(path)?;
        conn.busy_timeout(STATE_BUSY_TIMEOUT)?;
        let _mode: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        let state = State { conn };
        state.migrate()?;
        state.conn.execute_batch(CHANGE_TRIGGERS)?;
        Ok(state)
    }

    /// A read-only connection for local listings: no schema creation, no
    /// migration, no write lock, so a listing never races a running
    /// collection. Fails when the file does not exist yet.
    pub fn open_read_only(path: &Path) -> Result<State, StateError> {
        let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
            | rusqlite::OpenFlags::SQLITE_OPEN_URI;
        let conn = Connection::open_with_flags(path, flags)?;
        conn.busy_timeout(STATE_BUSY_TIMEOUT)?;
        Ok(State { conn })
    }

    /// Forward migrations. Version 1 predates project attribution, version 2
    /// predates nullable request and pricing evidence, and version 3 predates
    /// agent attribution, version 4 predates tool evidence, version 5
    /// predates explicit project identity states, version 6 predates
    /// knowledge-source access evidence, and version 7 predates the allowance
    /// quarantine (both new tables only, created above). A version 8 file
    /// written before the quarantine's candidate column existed gains it here
    /// (version 8 is unreleased, so the number does not move). Every step is
    /// idempotent, so an interrupted upgrade resumes.
    fn migrate(&self) -> Result<(), StateError> {
        let version = self.meta("schema_version")?;
        if version.as_deref() == Some("8")
            && !self.has_column("allowance_quarantine", "candidate_binding_id")?
        {
            self.conn.execute("ALTER TABLE allowance_quarantine ADD COLUMN candidate_binding_id TEXT", [])?;
        }
        if version.as_deref() == Some("1") {
            for column in ["project_hash", "surface"] {
                if !self.has_column("events", column)? {
                    self.conn.execute(&format!("ALTER TABLE events ADD COLUMN {column} TEXT"), [])?;
                }
            }
        }
        if matches!(version.as_deref(), Some("1" | "2")) {
            let columns = [
                ("detail_observed", "INTEGER NOT NULL DEFAULT 0"),
                ("bucket_eligible", "INTEGER NOT NULL DEFAULT 1"),
                ("detail_input_fresh", "INTEGER"),
                ("detail_input_cached", "INTEGER"),
                ("detail_input_cache_write", "INTEGER"),
                ("detail_output", "INTEGER"),
                ("detail_reasoning", "INTEGER"),
                ("reported_total", "INTEGER"),
                ("model_requested", "TEXT"),
                ("reasoning_effort", "TEXT"),
                ("service_tier", "TEXT"),
                ("speed", "TEXT"),
                ("context_window_tokens", "INTEGER"),
                ("cache_write_ttl", "TEXT"),
                ("outcome", "TEXT"),
            ];
            for (column, definition) in columns {
                if !self.has_column("events", column)? {
                    self.conn.execute(&format!("ALTER TABLE events ADD COLUMN {column} {definition}"), [])?;
                }
            }
        }
        if matches!(version.as_deref(), Some("1" | "2" | "3")) {
            let columns = [
                ("agent_observed", "INTEGER NOT NULL DEFAULT 0"),
                ("agent_key", "TEXT"),
                ("agent_identity_basis", "TEXT NOT NULL DEFAULT 'unknown'"),
                ("parent_agent_key", "TEXT"),
                ("parent_agent_identity_basis", "TEXT NOT NULL DEFAULT 'unknown'"),
                ("agent_class", "TEXT NOT NULL DEFAULT 'unknown'"),
                ("agent_name", "TEXT"),
                ("agent_depth", "INTEGER"),
            ];
            for (column, definition) in columns {
                if !self.has_column("events", column)? {
                    self.conn.execute(&format!("ALTER TABLE events ADD COLUMN {column} {definition}"), [])?;
                }
            }
        }
        if matches!(version.as_deref(), Some("1" | "2" | "3"))
            && !self.has_column("agent_profiles", "parent_evidence")?
        {
            self.conn.execute(
                "ALTER TABLE agent_profiles ADD COLUMN parent_evidence TEXT NOT NULL DEFAULT 'unknown'",
                [],
            )?;
        }
        if matches!(version.as_deref(), Some("1" | "2" | "3"))
            && !self.has_column("agent_profiles", "depth_evidence")?
        {
            self.conn.execute(
                "ALTER TABLE agent_profiles ADD COLUMN depth_evidence TEXT NOT NULL DEFAULT 'unknown'",
                [],
            )?;
        }
        if matches!(version.as_deref(), Some("1" | "2" | "3" | "4" | "5")) {
            for (column, definition) in
                [("project_key", "TEXT"), ("project_basis", "TEXT NOT NULL DEFAULT 'unknown'")]
            {
                if !self.has_column("events", column)? {
                    self.conn.execute(&format!("ALTER TABLE events ADD COLUMN {column} {definition}"), [])?;
                }
            }
            self.conn.execute(
                "UPDATE events
                    SET project_key = coalesce(project_key, project_hash),
                        project_basis = CASE
                          WHEN project_hash IS NOT NULL THEN 'working_directory'
                          ELSE coalesce(project_basis, 'unknown')
                        END",
                [],
            )?;
        }
        // Any earlier file gains the change stamp; existing rows read as generation 0,
        // and an adapter with no emission mark emits everything once regardless.
        for table in CHANGE_STAMPED_TABLES {
            if !self.has_column(table, "change_generation")? {
                self.conn.execute(
                    &format!("ALTER TABLE {table} ADD COLUMN change_generation INTEGER NOT NULL DEFAULT 0"),
                    [],
                )?;
            }
        }
        self.set_meta("schema_version", SCHEMA_VERSION)
    }

    fn has_column(&self, table: &str, column: &str) -> Result<bool, StateError> {
        let mut statement = self.conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = statement.query_map([], |row| row.get::<_, String>(1))?;
        for name in names {
            if name? == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Every transaction here writes. `IMMEDIATE` takes the write lock at once so a
    /// second adapter thread waits on the busy timeout instead of failing with
    /// `SQLITE_BUSY` when a deferred read transaction tries to upgrade under WAL.
    pub fn begin(&self) -> Result<(), StateError> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        Ok(())
    }

    pub fn commit(&self) -> Result<(), StateError> {
        self.conn.execute_batch("COMMIT")?;
        Ok(())
    }

    pub fn rollback(&self) -> Result<(), StateError> {
        self.conn.execute_batch("ROLLBACK")?;
        Ok(())
    }

    // --- meta ---------------------------------------------------------------

    pub fn meta(&self, key: &str) -> Result<Option<String>, StateError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", params![key], |row| row.get(0))
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), StateError> {
        self.conn.execute("INSERT OR REPLACE INTO meta VALUES (?1, ?2)", params![key, value])?;
        Ok(())
    }

    pub fn set_meta_if_absent(&self, key: &str, value: &str) -> Result<(), StateError> {
        self.conn.execute("INSERT OR IGNORE INTO meta VALUES (?1, ?2)", params![key, value])?;
        Ok(())
    }

    // --- change tracking ----------------------------------------------------

    /// Moves to the next change generation and returns it. A run advances it
    /// once before its adapters write and once after their records are
    /// persisted, so rows written between runs carry a generation later than
    /// any emission mark and the next run emits them.
    pub fn advance_change_generation(&self) -> Result<i64, StateError> {
        let next = self.change_generation()?.unwrap_or(0) + 1;
        self.set_meta(CHANGE_GENERATION_KEY, &next.to_string())?;
        Ok(next)
    }

    /// The generation rows written now are stamped with; `None` before a run
    /// has ever advanced it, when every write reads as generation 0.
    pub fn change_generation(&self) -> Result<Option<i64>, StateError> {
        Ok(self.meta(CHANGE_GENERATION_KEY)?.and_then(|value| value.parse().ok()))
    }

    fn changed_ids(&self, table: &str, binding: &str, after: i64) -> Result<HashSet<String>, StateError> {
        let mut statement = self
            .conn
            .prepare(&format!("SELECT id FROM {table} WHERE binding_id = ?1 AND change_generation > ?2"))?;
        let rows = statement.query_map(params![binding, after], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<HashSet<_>, _>>()?)
    }

    /// Request event ids written after `after`.
    pub fn changed_event_ids(&self, binding: &str, after: i64) -> Result<HashSet<String>, StateError> {
        self.changed_ids("events", binding, after)
    }

    /// Agent event ids written after `after`.
    pub fn changed_agent_event_ids(&self, binding: &str, after: i64) -> Result<HashSet<String>, StateError> {
        self.changed_ids("local_agent_events", binding, after)
    }

    /// Resource access ids written after `after`.
    pub fn changed_resource_access_ids(
        &self,
        binding: &str,
        after: i64,
    ) -> Result<HashSet<String>, StateError> {
        self.changed_ids("local_resource_accesses", binding, after)
    }

    /// Tool events written after `after`, with the keys dependent records join on.
    pub fn changed_tool_events(
        &self,
        binding: &str,
        after: i64,
    ) -> Result<Vec<ChangedToolEvent>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT id, invocation_key, caller_request_key FROM local_tool_events
              WHERE binding_id = ?1 AND change_generation > ?2",
        )?;
        let rows = statement.query_map(params![binding, after], |row| {
            Ok(ChangedToolEvent {
                id: row.get(0)?,
                invocation_key: row.get(1)?,
                caller_request_key: row.get(2)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The semantic keys of every stored record of one type an adapter produced
    /// for a binding, so an emitter can tell which source rows have no record yet.
    pub fn record_semantic_keys(
        &self,
        binding: &str,
        adapter: &str,
        record_type: &str,
    ) -> Result<HashSet<String>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT semantic_key FROM records WHERE binding_id = ?1 AND adapter = ?2 AND record_type = ?3",
        )?;
        let rows =
            statement.query_map(params![binding, adapter, record_type], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<Result<HashSet<_>, _>>()?)
    }

    // --- cursor emission marks ----------------------------------------------

    /// The content digest each Cursor request record of one binding was last
    /// emitted with, keyed by record id. The Cursor reader has no event table
    /// to stamp, so it remembers what it emitted per record instead and skips
    /// a bubble whose record digests the same as last time.
    pub fn cursor_emitted(&self, binding: &str) -> Result<HashMap<String, String>, StateError> {
        let mut statement = self
            .conn
            .prepare("SELECT record_id, content_digest FROM cursor_emitted WHERE binding_id = ?1")?;
        let rows = statement
            .query_map(params![binding], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
    }

    /// Records that one record was emitted at the given digest; the run calls
    /// this only once the record itself is persisted.
    pub fn mark_cursor_emitted(
        &self,
        binding: &str,
        record_id: &str,
        content_digest: &str,
        emitted_at: &str,
    ) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT INTO cursor_emitted (binding_id, record_id, content_digest, emitted_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(binding_id, record_id) DO UPDATE SET content_digest = excluded.content_digest,
                 emitted_at = excluded.emitted_at",
            params![binding, record_id, content_digest, emitted_at],
        )?;
        Ok(())
    }

    // --- settings cache -----------------------------------------------------

    pub fn cached_config(&self) -> Result<Option<CachedConfig>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT document, settings_version, etag, fetched_at FROM settings_cache WHERE id = 1",
                [],
                |row| {
                    Ok(CachedConfig {
                        document: row.get(0)?,
                        settings_version: row.get::<_, i64>(1)?.max(0) as u64,
                        etag: row.get(2)?,
                        fetched_at: row.get(3)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn save_cached_config(&self, cached: &CachedConfig) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO settings_cache (id, document, settings_version, etag, fetched_at) VALUES (1, ?1, ?2, ?3, ?4)",
            params![cached.document, cached.settings_version as i64, cached.etag, cached.fetched_at],
        )?;
        Ok(())
    }

    /// Caches a config document as if it had been fetched, so an offline run
    /// (`--offline`) sees its bindings and identity hashes. A test and
    /// local-verification seam; production runs cache what the server sends.
    pub fn seed_cached_config(
        &self,
        document: &observatory_contract::ConfigDocument,
        fetched_at: &str,
    ) -> Result<(), StateError> {
        let text = serde_json::to_string(document).map_err(|_| StateError::Corrupt)?;
        self.save_cached_config(&CachedConfig {
            document: text,
            settings_version: document.settings_version.get(),
            etag: None,
            fetched_at: fetched_at.to_owned(),
        })
    }

    // --- adapter state ------------------------------------------------------

    pub fn adapter_state(&self, adapter: &str) -> Result<Option<AdapterStateRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT adapter, effective, reason, last_run_at, last_state, cursor FROM adapter_state WHERE adapter = ?1",
                params![adapter],
                |row| {
                    Ok(AdapterStateRow {
                        adapter: row.get(0)?,
                        effective: row.get(1)?,
                        reason: row.get(2)?,
                        last_run_at: row.get(3)?,
                        last_state: row.get(4)?,
                        cursor: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn all_adapter_states(&self) -> Result<Vec<AdapterStateRow>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT adapter, effective, reason, last_run_at, last_state, cursor FROM adapter_state ORDER BY adapter",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(AdapterStateRow {
                adapter: row.get(0)?,
                effective: row.get(1)?,
                reason: row.get(2)?,
                last_run_at: row.get(3)?,
                last_state: row.get(4)?,
                cursor: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn save_adapter_state(&self, row: &AdapterStateRow) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO adapter_state (adapter, effective, reason, last_run_at, last_state, cursor) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![row.adapter, row.effective, row.reason, row.last_run_at, row.last_state, row.cursor],
        )?;
        Ok(())
    }

    // --- files --------------------------------------------------------------

    pub fn file_checkpoint(&self, binding: &str, path: &str) -> Result<Option<FileCheckpoint>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT path, size, mtime, inode, offset, context FROM files WHERE binding_id = ?1 AND path = ?2",
                params![binding, path],
                |row| {
                    Ok(FileCheckpoint {
                        path: row.get(0)?,
                        size: row.get(1)?,
                        mtime_ns: row.get(2)?,
                        inode: row.get(3)?,
                        offset: row.get(4)?,
                        context: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn save_file_checkpoint(&self, binding: &str, checkpoint: &FileCheckpoint) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO files (binding_id, path, size, mtime, inode, offset, context) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                binding,
                checkpoint.path,
                checkpoint.size,
                checkpoint.mtime_ns,
                checkpoint.inode,
                checkpoint.offset,
                checkpoint.context
            ],
        )?;
        Ok(())
    }

    pub fn file_count(&self, binding: &str) -> Result<u64, StateError> {
        let count: i64 = self.conn.query_row(
            "SELECT count(*) FROM files WHERE binding_id = ?1",
            params![binding],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u64)
    }

    pub fn mark_file_parse_gap(&self, binding: &str, path: &str) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT OR IGNORE INTO file_parse_gaps (binding_id, path) VALUES (?1, ?2)",
            params![binding, path],
        )?;
        Ok(())
    }

    pub fn clear_file_parse_gap(&self, binding: &str, path: &str) -> Result<(), StateError> {
        self.conn.execute(
            "DELETE FROM file_parse_gaps WHERE binding_id = ?1 AND path = ?2",
            params![binding, path],
        )?;
        Ok(())
    }

    pub fn file_parse_gap_count(&self, binding: &str) -> Result<u64, StateError> {
        let count: i64 = self.conn.query_row(
            "SELECT count(*) FROM file_parse_gaps WHERE binding_id = ?1",
            params![binding],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u64)
    }

    /// Invalidates file offsets once for a new parser generation so retained
    /// histories are replayed and newly supported fields can be backfilled.
    /// The generation marker and checkpoint deletion are one transaction; an
    /// interrupted later scan resumes from the new checkpoints it completed.
    pub fn prepare_file_scan(&self, binding: &str, generation: &str) -> Result<bool, StateError> {
        self.reset_file_scan(binding, generation, false)
    }

    /// `prepare_file_scan` for scans that classify resource access: a new
    /// generation (parser, subagent setting, or resource configuration) also
    /// drops every local resource-access and inspection row for the binding in
    /// the same transaction. Those rows are a pure function of transcript,
    /// parser, and configuration, so the replay rebuilds them from empty
    /// tables and the precedence merge only reconciles one generation.
    pub fn prepare_file_scan_with_purge(&self, binding: &str, generation: &str) -> Result<bool, StateError> {
        self.reset_file_scan(binding, generation, true)
    }

    fn reset_file_scan(
        &self,
        binding: &str,
        generation: &str,
        purge_resources: bool,
    ) -> Result<bool, StateError> {
        let key = format!("file_parser:{binding}");
        if self.meta(&key)?.as_deref() == Some(generation) {
            return Ok(false);
        }
        self.begin()?;
        let result = (|| {
            self.conn.execute("DELETE FROM files WHERE binding_id = ?1", params![binding])?;
            if purge_resources {
                self.conn
                    .execute("DELETE FROM local_resource_accesses WHERE binding_id = ?1", params![binding])?;
                self.conn.execute(
                    "DELETE FROM local_resource_inspections WHERE binding_id = ?1",
                    params![binding],
                )?;
                // Queued resource records belong to the generation being replaced; the replay
                // re-emits every access it still recognizes, which lifts this mark again.
                self.conn.execute(
                    "UPDATE records SET rejected_reason = ?2
                     WHERE binding_id = ?1 AND record_type = 'resource.access' AND rejected_reason IS NULL",
                    params![binding, SUPERSEDED_CONFIGURATION],
                )?;
            }
            self.set_meta(&key, generation)?;
            Ok::<(), StateError>(())
        })();
        match result {
            Ok(()) => {
                self.commit()?;
                Ok(true)
            }
            Err(error) => {
                self.rollback()?;
                Err(error)
            }
        }
    }

    // --- events -------------------------------------------------------------

    pub fn event(&self, binding: &str, id: &str) -> Result<Option<EventRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, session, hour, model, input_tokens, cached_tokens, cache_write_tokens, output_tokens,
                        session_identity, timestamp, product, client_version, parent_session,
                        project_hash, project_key, project_basis, surface,
                        detail_observed, bucket_eligible, detail_input_fresh, detail_input_cached,
                        detail_input_cache_write, detail_output, detail_reasoning, reported_total, model_requested,
                        reasoning_effort, service_tier, speed, context_window_tokens, cache_write_ttl, outcome,
                        agent_observed, agent_key, agent_identity_basis, parent_agent_key,
                        parent_agent_identity_basis, agent_class, agent_name, agent_depth
                   FROM events WHERE binding_id = ?1 AND id = ?2",
                params![binding, id],
                event_from_row,
            )
            .optional()?)
    }

    pub fn insert_event(&self, binding: &str, row: &EventRow) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO events (binding_id, id, session, hour, model, input_tokens, cached_tokens, cache_write_tokens,
                                 output_tokens, session_identity, timestamp, product, client_version, parent_session,
                                 project_hash, project_key, project_basis, surface, detail_observed, bucket_eligible, detail_input_fresh,
                                 detail_input_cached, detail_input_cache_write, detail_output, detail_reasoning,
                                 reported_total, model_requested, reasoning_effort, service_tier, speed,
                                 context_window_tokens, cache_write_ttl, outcome, agent_observed, agent_key,
                                 agent_identity_basis, parent_agent_key, parent_agent_identity_basis,
                                 agent_class, agent_name, agent_depth)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                     ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31,
                     ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39, ?40, ?41)",
            params![
                binding,
                row.id,
                row.session,
                row.hour,
                row.model,
                row.input_tokens,
                row.cached_tokens,
                row.cache_write_tokens,
                row.output_tokens,
                row.session_identity,
                row.timestamp,
                row.product,
                row.client_version,
                row.parent_session,
                row.project_hash,
                row.project_key,
                row.project_basis,
                row.surface,
                row.detail_observed,
                row.bucket_eligible,
                row.detail_input_fresh,
                row.detail_input_cached,
                row.detail_input_cache_write,
                row.detail_output,
                row.detail_reasoning,
                row.reported_total,
                row.model_requested,
                row.reasoning_effort,
                row.service_tier,
                row.speed,
                row.context_window_tokens,
                row.cache_write_ttl,
                row.outcome,
                row.agent_observed,
                row.agent_key,
                row.agent_identity_basis,
                row.parent_agent_key,
                row.parent_agent_identity_basis,
                row.agent_class,
                row.agent_name,
                row.agent_depth
            ],
        )?;
        Ok(())
    }

    /// Fills attribution a first sighting lacked; never overwrites a stored value.
    pub fn fill_event_attribution(
        &self,
        binding: &str,
        id: &str,
        project_hash: Option<&str>,
        project_key: Option<&str>,
        project_basis: Option<&str>,
        surface: Option<&str>,
    ) -> Result<(), StateError> {
        self.conn.execute(
            "UPDATE events SET project_hash = CASE WHEN project_basis = 'unknown' THEN coalesce(project_hash, ?3) ELSE project_hash END,
                               project_key = CASE WHEN project_basis = 'unknown' THEN coalesce(project_key, ?4) ELSE project_key END,
                               project_basis = CASE WHEN project_basis = 'unknown' THEN coalesce(?5, project_basis) ELSE project_basis END,
                               surface = coalesce(surface, ?6)
              WHERE binding_id = ?1 AND id = ?2",
            params![binding, id, project_hash, project_key, project_basis, surface],
        )?;
        Ok(())
    }

    /// v1 semantics: a repeated event id updates the components only.
    pub fn update_event_tokens(&self, binding: &str, id: &str, tokens: [i64; 4]) -> Result<(), StateError> {
        self.conn.execute(
            "UPDATE events SET input_tokens = ?3, cached_tokens = ?4, cache_write_tokens = ?5, output_tokens = ?6
              WHERE binding_id = ?1 AND id = ?2",
            params![binding, id, tokens[0], tokens[1], tokens[2], tokens[3]],
        )?;
        Ok(())
    }

    /// `bucket_rows` from `collect.py`: grouped by session, hour, model; ordered by hour, session, model.
    pub fn bucket_rows(&self, binding: &str) -> Result<Vec<BucketRow>, StateError> {
        self.bucket_rows_for_agent_setting(binding, true)
    }

    /// Legacy bucket rows under the current subagent collection policy. Fully
    /// unknown attribution remains included because it is not evidence of a
    /// child request.
    pub fn bucket_rows_for_agent_setting(
        &self,
        binding: &str,
        include_subagents: bool,
    ) -> Result<Vec<BucketRow>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT session, hour, model, sum(input_tokens), sum(cached_tokens), sum(cache_write_tokens),
                    sum(output_tokens), count(*)
               FROM events WHERE binding_id = ?1 AND bucket_eligible = 1
                 AND (?2 OR (parent_session IS NULL AND (agent_observed = 0 OR agent_class = 'main'
                      OR (agent_key IS NULL AND parent_agent_key IS NULL AND agent_depth IS NULL))))
               GROUP BY session, hour, model ORDER BY hour, session, model",
        )?;
        let rows = statement.query_map(params![binding, include_subagents], |row| {
            let input: i64 = row.get(3)?;
            let cached: i64 = row.get(4)?;
            let written: i64 = row.get(5)?;
            let output: i64 = row.get(6)?;
            Ok(BucketRow {
                session_hash: row.get(0)?,
                hour: row.get(1)?,
                model: row.get(2)?,
                input_tokens: input,
                cached_tokens: cached,
                cache_write_tokens: written,
                output_tokens: output,
                calls: row.get(7)?,
                total_tokens: input + cached + written + output,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn events(&self, binding: &str) -> Result<Vec<EventRow>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT id, session, hour, model, input_tokens, cached_tokens, cache_write_tokens, output_tokens,
                    session_identity, timestamp, product, client_version, parent_session,
                    project_hash, project_key, project_basis, surface,
                    detail_observed, bucket_eligible, detail_input_fresh, detail_input_cached,
                    detail_input_cache_write, detail_output, detail_reasoning, reported_total, model_requested,
                    reasoning_effort, service_tier, speed, context_window_tokens, cache_write_ttl, outcome,
                    agent_observed, agent_key, agent_identity_basis, parent_agent_key,
                    parent_agent_identity_basis, agent_class, agent_name, agent_depth
               FROM events WHERE binding_id = ?1 AND bucket_eligible = 1 ORDER BY hour, session, id",
        )?;
        let rows = statement.query_map(params![binding], event_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every request event, including explicit zero-usage calls excluded from
    /// the legacy hourly bucket ledger.
    pub fn request_events(&self, binding: &str) -> Result<Vec<EventRow>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT id, session, hour, model, input_tokens, cached_tokens, cache_write_tokens, output_tokens,
                    session_identity, timestamp, product, client_version, parent_session,
                    project_hash, project_key, project_basis, surface,
                    detail_observed, bucket_eligible, detail_input_fresh, detail_input_cached,
                    detail_input_cache_write, detail_output, detail_reasoning, reported_total, model_requested,
                    reasoning_effort, service_tier, speed, context_window_tokens, cache_write_ttl, outcome,
                    agent_observed, agent_key, agent_identity_basis, parent_agent_key,
                    parent_agent_identity_basis, agent_class, agent_name, agent_depth
               FROM events WHERE binding_id = ?1 ORDER BY hour, session, id",
        )?;
        let rows = statement.query_map(params![binding], event_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn event_count(&self, binding: &str) -> Result<u64, StateError> {
        let count: i64 = self.conn.query_row(
            "SELECT count(*) FROM events WHERE binding_id = ?1",
            params![binding],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u64)
    }

    // --- agent evidence -----------------------------------------------------

    pub fn agent_profile(&self, binding: &str, key: &str) -> Result<Option<AgentProfileRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT agent_key, identity_basis, parent_key, parent_identity_basis, parent_evidence,
                        class, name, depth, depth_evidence, model_requested
                   FROM agent_profiles WHERE binding_id = ?1 AND agent_key = ?2",
                params![binding, key],
                agent_profile_from_row,
            )
            .optional()?)
    }

    /// Retains the strongest known facts for one hashed agent identity and
    /// enriches request/lifecycle rows that were observed before the parent
    /// spawn result or sidecar metadata became available.
    pub fn upsert_agent_profile(&self, binding: &str, incoming: &AgentProfileRow) -> Result<(), StateError> {
        let existing = self.agent_profile(binding, &incoming.key)?;
        let previous_depth = existing.as_ref().and_then(|profile| profile.depth);
        let merged = match existing {
            Some(old) => {
                let replace_parent = parent_evidence_rank(&incoming.parent_evidence)
                    > parent_evidence_rank(&old.parent_evidence);
                let incoming_depth_rank = depth_evidence_rank(&incoming.depth_evidence);
                let old_depth_rank = depth_evidence_rank(&old.depth_evidence);
                let parent_changed = replace_parent && incoming.parent_key != old.parent_key;
                let invalidate_depth = parent_changed
                    && incoming.depth.is_none()
                    && old_depth_rank < depth_evidence_rank("explicit");
                let replace_depth = incoming_depth_rank > old_depth_rank
                    || (replace_parent
                        && incoming.depth.is_some()
                        && incoming_depth_rank >= old_depth_rank
                        && old_depth_rank < depth_evidence_rank("explicit"))
                    || invalidate_depth;
                let replace_named_class =
                    old.class != "main" && old.name.is_none() && incoming.name.is_some();
                AgentProfileRow {
                    key: old.key,
                    identity_basis: prefer_code(&old.identity_basis, &incoming.identity_basis, "unknown"),
                    parent_key: if replace_parent {
                        incoming.parent_key.clone()
                    } else {
                        old.parent_key.or_else(|| incoming.parent_key.clone())
                    },
                    parent_identity_basis: if replace_parent {
                        incoming.parent_identity_basis.clone()
                    } else {
                        prefer_code(&old.parent_identity_basis, &incoming.parent_identity_basis, "unknown")
                    },
                    parent_evidence: if replace_parent {
                        incoming.parent_evidence.clone()
                    } else {
                        prefer_parent_evidence(&old.parent_evidence, &incoming.parent_evidence)
                    },
                    class: if replace_named_class {
                        incoming.class.clone()
                    } else {
                        prefer_code(&old.class, &incoming.class, "unknown")
                    },
                    name: old.name.or_else(|| incoming.name.clone()),
                    depth: if replace_depth { incoming.depth } else { old.depth },
                    depth_evidence: if replace_depth {
                        if invalidate_depth { "invalidated".into() } else { incoming.depth_evidence.clone() }
                    } else {
                        prefer_depth_evidence(&old.depth_evidence, &incoming.depth_evidence)
                    },
                    model_requested: old.model_requested.or_else(|| incoming.model_requested.clone()),
                }
            }
            None => incoming.clone(),
        };
        self.conn.execute(
            "INSERT OR REPLACE INTO agent_profiles
             (binding_id, agent_key, identity_basis, parent_key, parent_identity_basis, parent_evidence,
              class, name, depth, depth_evidence, model_requested)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                binding,
                merged.key,
                merged.identity_basis,
                merged.parent_key,
                merged.parent_identity_basis,
                merged.parent_evidence,
                merged.class,
                merged.name,
                merged.depth,
                merged.depth_evidence,
                merged.model_requested
            ],
        )?;
        self.conn.execute(
            "UPDATE events SET
                 agent_identity_basis = ?3, parent_agent_key = ?4,
                 parent_agent_identity_basis = ?5, agent_class = ?6,
                 agent_name = ?7, agent_depth = ?8, model_requested = coalesce(model_requested, ?9)
               WHERE binding_id = ?1 AND agent_key = ?2",
            params![
                binding,
                merged.key,
                merged.identity_basis,
                merged.parent_key,
                merged.parent_identity_basis,
                merged.class,
                merged.name,
                merged.depth,
                merged.model_requested
            ],
        )?;
        self.conn.execute(
            "UPDATE local_agent_events SET
                 identity_basis = ?3, parent_key = ?4, parent_identity_basis = ?5,
                 class = ?6, name = ?7, depth = ?8, model_requested = coalesce(model_requested, ?9)
               WHERE binding_id = ?1 AND agent_key = ?2",
            params![
                binding,
                merged.key,
                merged.identity_basis,
                merged.parent_key,
                merged.parent_identity_basis,
                merged.class,
                merged.name,
                merged.depth,
                merged.model_requested
            ],
        )?;
        if previous_depth != merged.depth {
            self.propagate_agent_depths(binding, &merged.key, merged.depth)?;
        }
        Ok(())
    }

    fn propagate_agent_depths(
        &self,
        binding: &str,
        root_key: &str,
        root_depth: Option<i64>,
    ) -> Result<(), StateError> {
        let mut seen = HashSet::from([root_key.to_owned()]);
        let mut pending = vec![(root_key.to_owned(), root_depth)];
        while let Some((parent_key, parent_depth)) = pending.pop() {
            let child_depth = parent_depth.and_then(|depth| depth.checked_add(1));
            let new_depth_evidence = if child_depth.is_some() { "inferred" } else { "invalidated" };
            let children = {
                let mut statement = self.conn.prepare(
                    "SELECT agent_key, depth_evidence FROM agent_profiles
                      WHERE binding_id = ?1 AND parent_key = ?2 ORDER BY agent_key",
                )?;
                let rows = statement.query_map(params![binding, parent_key], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for (child_key, stored_depth_evidence) in children {
                if !seen.insert(child_key.clone()) {
                    continue;
                }
                if depth_evidence_rank(&stored_depth_evidence) >= depth_evidence_rank("explicit") {
                    continue;
                }
                self.conn.execute(
                    "UPDATE agent_profiles SET depth = ?3, depth_evidence = ?4
                      WHERE binding_id = ?1 AND agent_key = ?2",
                    params![binding, child_key, child_depth, new_depth_evidence],
                )?;
                self.conn.execute(
                    "UPDATE events SET agent_depth = ?3 WHERE binding_id = ?1 AND agent_key = ?2",
                    params![binding, child_key, child_depth],
                )?;
                self.conn.execute(
                    "UPDATE local_agent_events SET depth = ?3 WHERE binding_id = ?1 AND agent_key = ?2",
                    params![binding, child_key, child_depth],
                )?;
                pending.push((child_key, child_depth));
            }
        }
        Ok(())
    }

    pub fn agent_event(&self, binding: &str, id: &str) -> Result<Option<AgentEventRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, timestamp, event_kind, session_hash, agent_key, identity_basis, parent_key,
                        parent_identity_basis, class, name, depth, model_requested, tool_invocation_key, outcome
                   FROM local_agent_events WHERE binding_id = ?1 AND id = ?2",
                params![binding, id],
                agent_event_from_row,
            )
            .optional()?)
    }

    pub fn insert_agent_event(&self, binding: &str, incoming: &AgentEventRow) -> Result<(), StateError> {
        let merged = match self.agent_event(binding, &incoming.id)? {
            Some(old) => {
                let parent_changed = incoming.parent_key.is_some() && incoming.parent_key != old.parent_key;
                AgentEventRow {
                    id: old.id,
                    timestamp: old.timestamp,
                    event_kind: old.event_kind,
                    session_hash: old.session_hash.or_else(|| incoming.session_hash.clone()),
                    agent_key: old.agent_key.or_else(|| incoming.agent_key.clone()),
                    identity_basis: prefer_code(&old.identity_basis, &incoming.identity_basis, "unknown"),
                    parent_key: incoming.parent_key.clone().or(old.parent_key),
                    parent_identity_basis: if incoming.parent_key.is_some() {
                        incoming.parent_identity_basis.clone()
                    } else {
                        prefer_code(&old.parent_identity_basis, &incoming.parent_identity_basis, "unknown")
                    },
                    class: prefer_code(&old.class, &incoming.class, "unknown"),
                    name: old.name.or_else(|| incoming.name.clone()),
                    depth: if parent_changed { incoming.depth } else { old.depth.or(incoming.depth) },
                    model_requested: old.model_requested.or_else(|| incoming.model_requested.clone()),
                    tool_invocation_key: old
                        .tool_invocation_key
                        .or_else(|| incoming.tool_invocation_key.clone()),
                    outcome: prefer_code(&old.outcome, &incoming.outcome, "unknown"),
                }
            }
            None => incoming.clone(),
        };
        self.conn.execute(
            "INSERT OR REPLACE INTO local_agent_events
             (binding_id, id, timestamp, event_kind, session_hash, agent_key, identity_basis, parent_key,
              parent_identity_basis, class, name, depth, model_requested, tool_invocation_key, outcome)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                binding,
                merged.id,
                merged.timestamp,
                merged.event_kind,
                merged.session_hash,
                merged.agent_key,
                merged.identity_basis,
                merged.parent_key,
                merged.parent_identity_basis,
                merged.class,
                merged.name,
                merged.depth,
                merged.model_requested,
                merged.tool_invocation_key,
                merged.outcome
            ],
        )?;
        Ok(())
    }

    pub fn agent_events(&self, binding: &str) -> Result<Vec<AgentEventRow>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT id, timestamp, event_kind, session_hash, agent_key, identity_basis, parent_key,
                    parent_identity_basis, class, name, depth, model_requested, tool_invocation_key, outcome
               FROM local_agent_events WHERE binding_id = ?1 ORDER BY timestamp, id",
        )?;
        let rows = statement.query_map(params![binding], agent_event_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn agent_spawn_for_invocation(
        &self,
        binding: &str,
        invocation_key: &str,
    ) -> Result<Option<AgentEventRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, timestamp, event_kind, session_hash, agent_key, identity_basis, parent_key,
                        parent_identity_basis, class, name, depth, model_requested, tool_invocation_key, outcome
                   FROM local_agent_events
                  WHERE binding_id = ?1 AND event_kind = 'spawn' AND tool_invocation_key = ?2
                  ORDER BY timestamp LIMIT 1",
                params![binding, invocation_key],
                agent_event_from_row,
            )
            .optional()?)
    }

    // --- tool evidence ------------------------------------------------------

    pub fn tool_event(&self, binding: &str, id: &str) -> Result<Option<ToolEventRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, timestamp, event_kind, invocation_key, session_hash, caller_request_key,
                        caller_agent_key, caller_is_subagent, parent_invocation_key, class, name,
                        name_hash, namespace, namespace_hash, outcome, name_truncated
                   FROM local_tool_events WHERE binding_id = ?1 AND id = ?2",
                params![binding, id],
                tool_event_from_row,
            )
            .optional()?)
    }

    pub fn tool_invocation(
        &self,
        binding: &str,
        invocation_key: &str,
    ) -> Result<Option<ToolEventRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, timestamp, event_kind, invocation_key, session_hash, caller_request_key,
                        caller_agent_key, caller_is_subagent, parent_invocation_key, class, name,
                        name_hash, namespace, namespace_hash, outcome, name_truncated
                   FROM local_tool_events
                  WHERE binding_id = ?1 AND invocation_key = ?2 AND event_kind = 'invocation'",
                params![binding, invocation_key],
                tool_event_from_row,
            )
            .optional()?)
    }

    /// Upserts a provider event by stable semantic identity. Repeated result or
    /// status rows can enrich the same event, but never create another headline
    /// invocation. Invocation facts are copied onto an earlier orphan result.
    pub fn upsert_tool_event(&self, binding: &str, row: &ToolEventRow) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT INTO local_tool_events
             (binding_id, id, timestamp, event_kind, invocation_key, session_hash,
              caller_request_key, caller_agent_key, caller_is_subagent, parent_invocation_key,
              class, name, name_hash, namespace, namespace_hash, outcome, name_truncated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
             ON CONFLICT(binding_id, id) DO UPDATE SET
               timestamp = min(local_tool_events.timestamp, excluded.timestamp),
               session_hash = coalesce(local_tool_events.session_hash, excluded.session_hash),
               caller_request_key = coalesce(local_tool_events.caller_request_key, excluded.caller_request_key),
               caller_agent_key = coalesce(local_tool_events.caller_agent_key, excluded.caller_agent_key),
               caller_is_subagent = max(local_tool_events.caller_is_subagent, excluded.caller_is_subagent),
               parent_invocation_key = coalesce(local_tool_events.parent_invocation_key, excluded.parent_invocation_key),
               class = CASE WHEN local_tool_events.class = 'unknown' THEN excluded.class ELSE local_tool_events.class END,
               name = coalesce(local_tool_events.name, excluded.name),
               name_hash = coalesce(local_tool_events.name_hash, excluded.name_hash),
               namespace = coalesce(local_tool_events.namespace, excluded.namespace),
               namespace_hash = coalesce(local_tool_events.namespace_hash, excluded.namespace_hash),
               outcome = CASE
                 WHEN local_tool_events.outcome = 'unknown'
                   OR (local_tool_events.outcome = 'succeeded'
                       AND excluded.outcome IN ('failed', 'denied', 'cancelled'))
                 THEN excluded.outcome ELSE local_tool_events.outcome END,
               name_truncated = max(local_tool_events.name_truncated, excluded.name_truncated)",
            params![
                binding,
                row.id,
                row.timestamp,
                row.event_kind,
                row.invocation_key,
                row.session_hash,
                row.caller_request_key,
                row.caller_agent_key,
                row.caller_is_subagent,
                row.parent_invocation_key,
                row.class,
                row.name,
                row.name_hash,
                row.namespace,
                row.namespace_hash,
                row.outcome,
                row.name_truncated,
            ],
        )?;
        if row.event_kind == "invocation" {
            self.conn.execute(
                "UPDATE local_tool_events SET
                   session_hash = coalesce(session_hash, ?3),
                   caller_request_key = coalesce(caller_request_key, ?4),
                   caller_agent_key = coalesce(caller_agent_key, ?5),
                   caller_is_subagent = max(caller_is_subagent, ?6),
                   parent_invocation_key = coalesce(parent_invocation_key, ?7),
                   class = CASE WHEN class = 'unknown' THEN ?8 ELSE class END,
                   name = coalesce(name, ?9), name_hash = coalesce(name_hash, ?10),
                   namespace = coalesce(namespace, ?11), namespace_hash = coalesce(namespace_hash, ?12),
                   name_truncated = max(name_truncated, ?13)
                 WHERE binding_id = ?1 AND invocation_key = ?2 AND event_kind = 'result'",
                params![
                    binding,
                    row.invocation_key,
                    row.session_hash,
                    row.caller_request_key,
                    row.caller_agent_key,
                    row.caller_is_subagent,
                    row.parent_invocation_key,
                    row.class,
                    row.name,
                    row.name_hash,
                    row.namespace,
                    row.namespace_hash,
                    row.name_truncated,
                ],
            )?;
            self.conn.execute(
                "UPDATE local_tool_events SET outcome = (
                   SELECT result.outcome FROM local_tool_events AS result
                    WHERE result.binding_id = ?1 AND result.invocation_key = ?2
                      AND result.event_kind = 'result' AND result.outcome != 'unknown'
                    ORDER BY CASE result.outcome WHEN 'succeeded' THEN 1 ELSE 2 END DESC,
                             result.timestamp DESC, result.id DESC LIMIT 1)
                 WHERE binding_id = ?1 AND id = ?3 AND event_kind = 'invocation'
                   AND (outcome = 'unknown' OR outcome = 'succeeded')
                   AND EXISTS (
                     SELECT 1 FROM local_tool_events AS result
                      WHERE result.binding_id = ?1 AND result.invocation_key = ?2
                        AND result.event_kind = 'result' AND result.outcome != 'unknown')",
                params![binding, row.invocation_key, row.id],
            )?;
        } else if row.outcome != "unknown" {
            self.conn.execute(
                "UPDATE local_tool_events SET outcome = ?3
                  WHERE binding_id = ?1 AND invocation_key = ?2 AND event_kind = 'invocation'
                    AND (outcome = 'unknown'
                         OR (outcome = 'succeeded' AND ?3 IN ('failed', 'denied', 'cancelled')))",
                params![binding, row.invocation_key, row.outcome],
            )?;
        }
        Ok(())
    }

    pub fn tool_events(&self, binding: &str) -> Result<Vec<ToolEventRow>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT id, timestamp, event_kind, invocation_key, session_hash, caller_request_key,
                    caller_agent_key, caller_is_subagent, parent_invocation_key, class, name,
                    name_hash, namespace, namespace_hash, outcome, name_truncated
               FROM local_tool_events WHERE binding_id = ?1 ORDER BY timestamp, id",
        )?;
        let rows = statement.query_map(params![binding], tool_event_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Associates all calls awaiting the same Codex request accounting event.
    pub fn assign_tool_caller_request(
        &self,
        binding: &str,
        invocation_keys: &[String],
        request_key: &str,
    ) -> Result<(), StateError> {
        for invocation_key in invocation_keys {
            self.conn.execute(
                "UPDATE local_tool_events SET caller_request_key = coalesce(caller_request_key, ?3)
                  WHERE binding_id = ?1 AND invocation_key = ?2",
                params![binding, invocation_key, request_key],
            )?;
        }
        Ok(())
    }

    pub fn tool_invocation_is_subagent(
        &self,
        binding: &str,
        invocation_key: &str,
    ) -> Result<bool, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT max(caller_is_subagent) FROM local_tool_events
                  WHERE binding_id = ?1 AND invocation_key = ?2",
                params![binding, invocation_key],
                |row| row.get(0),
            )
            .optional()?
            .flatten()
            .unwrap_or(false))
    }

    pub fn mark_tool_coverage(
        &self,
        binding: &str,
        unmapped_form: bool,
        truncated_name: bool,
    ) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT INTO tool_coverage (binding_id, unmapped_forms, truncated_names) VALUES (?1, ?2, ?3)
             ON CONFLICT(binding_id) DO UPDATE SET
               unmapped_forms = max(tool_coverage.unmapped_forms, excluded.unmapped_forms),
               truncated_names = max(tool_coverage.truncated_names, excluded.truncated_names)",
            params![binding, unmapped_form, truncated_name],
        )?;
        Ok(())
    }

    pub fn tool_coverage(&self, binding: &str) -> Result<ToolCoverageRow, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT unmapped_forms, truncated_names FROM tool_coverage WHERE binding_id = ?1",
                params![binding],
                |row| Ok(ToolCoverageRow { unmapped_forms: row.get(0)?, truncated_names: row.get(1)? }),
            )
            .optional()?
            .unwrap_or_default())
    }

    // --- projects -----------------------------------------------------------

    /// Records a working directory sighting; `first_seen` and `last_seen` widen, never shrink.
    pub fn upsert_project(
        &self,
        binding: &str,
        hash: &str,
        path: &str,
        seen_at: &str,
    ) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT INTO projects (binding_id, project_hash, path, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(binding_id, project_hash) DO UPDATE SET
                 first_seen = min(projects.first_seen, excluded.first_seen),
                 last_seen = max(projects.last_seen, excluded.last_seen)",
            params![binding, hash, path, seen_at],
        )?;
        Ok(())
    }

    pub fn projects(&self, binding: &str) -> Result<Vec<ProjectRow>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT project_hash, path, first_seen, last_seen FROM projects WHERE binding_id = ?1
              ORDER BY last_seen DESC, path",
        )?;
        let rows = statement.query_map(params![binding], |row| {
            Ok(ProjectRow {
                project_hash: row.get(0)?,
                path: row.get(1)?,
                first_seen: row.get(2)?,
                last_seen: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    // --- resource evidence --------------------------------------------------

    /// The opaque token uploaded as `configuration_version` for one
    /// per-resource configuration digest: sixteen random hex digits chosen on
    /// first sight and stable afterwards, so nothing derived from a root ever
    /// leaves the machine. Two adapter threads seeing a digest at once agree on
    /// the first insert.
    pub fn resource_config_token(&self, digest: &str) -> Result<String, StateError> {
        let key = resource_config_token_key(digest);
        self.set_meta_if_absent(&key, &random_token())?;
        self.meta(&key)?.ok_or(StateError::Corrupt)
    }

    /// The token already assigned to a digest, without assigning one; for
    /// read-only listings.
    pub fn assigned_resource_config_token(&self, digest: &str) -> Result<Option<String>, StateError> {
        self.meta(&resource_config_token_key(digest))
    }

    // --- privacy key ---------------------------------------------------------

    /// This install's privacy key (`crate::privacy`): 32 random bytes chosen on
    /// first use and kept in `meta` as `privacy_salt`, so it survives
    /// re-pairing and changes only with a new state file. Never uploaded or
    /// printed. Creating it re-keys every stored project key and tool hash
    /// from the raw values this database keeps beside them, in the same
    /// transaction, so a file written by a build without a key carries no
    /// unkeyed hash afterwards.
    pub fn privacy_key(&self) -> Result<PrivacyKey, StateError> {
        if let Some(stored) = self.meta(PRIVACY_SALT_KEY)? {
            return PrivacyKey::from_hex(&stored).ok_or(StateError::Corrupt);
        }
        self.begin()?;
        let result = (|| {
            // Another connection may have won the write lock first.
            if let Some(stored) = self.meta(PRIVACY_SALT_KEY)? {
                return PrivacyKey::from_hex(&stored).ok_or(StateError::Corrupt);
            }
            let key = PrivacyKey::generate();
            self.rekey_privacy_hashes(&key)?;
            self.set_meta(PRIVACY_SALT_KEY, &key.to_hex())?;
            Ok(key)
        })();
        match result {
            Ok(key) => {
                self.commit()?;
                Ok(key)
            }
            Err(error) => {
                self.rollback()?;
                Err(error)
            }
        }
    }

    /// Whether a privacy key has been created; for read-only listings.
    pub fn has_privacy_key(&self) -> Result<bool, StateError> {
        Ok(self.meta(PRIVACY_SALT_KEY)?.is_some())
    }

    /// Recomputes every stored project key (from the `projects` path beside
    /// it) and tool name and namespace hash (from the raw name and namespace
    /// beside them) under `key`. A working-directory key with no path on
    /// record and a hash with no raw value cannot be re-keyed and become
    /// unknown rather than leaving the machine unkeyed. Runs inside the
    /// caller's transaction.
    fn rekey_privacy_hashes(&self, key: &PrivacyKey) -> Result<(), StateError> {
        let projects: Vec<(String, String, String)> = {
            let mut statement = self.conn.prepare("SELECT binding_id, project_hash, path FROM projects")?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for (binding, old, path) in projects {
            let new = project_key(key, &path);
            if new.as_str() == old {
                continue;
            }
            self.conn.execute(
                "UPDATE projects SET project_hash = ?3 WHERE binding_id = ?1 AND project_hash = ?2",
                params![binding, old, new.as_str()],
            )?;
            self.conn.execute(
                "UPDATE events
                    SET project_key = CASE WHEN project_key = ?2 THEN ?3 ELSE project_key END,
                        project_hash = CASE WHEN project_hash = ?2 THEN ?3 ELSE project_hash END
                  WHERE binding_id = ?1 AND (project_key = ?2 OR project_hash = ?2)",
                params![binding, old, new.as_str()],
            )?;
        }
        self.conn.execute(
            "UPDATE events SET project_key = NULL, project_hash = NULL, project_basis = 'unknown'
              WHERE project_basis = 'working_directory' AND project_key IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM projects
                                 WHERE projects.binding_id = events.binding_id
                                   AND projects.project_hash = events.project_key)",
            [],
        )?;
        let tools: Vec<(String, String, Option<String>, Option<String>)> = {
            let mut statement = self.conn.prepare(
                "SELECT binding_id, id, namespace, name FROM local_tool_events
                  WHERE name_hash IS NOT NULL OR namespace_hash IS NOT NULL",
            )?;
            let rows =
                statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for (binding, id, namespace, name) in tools {
            let name_hash = name.as_deref().map(|name| tool_name_hash(key, namespace.as_deref(), name));
            let namespace_hash = namespace.as_deref().map(|namespace| tool_namespace_hash(key, namespace));
            self.conn.execute(
                "UPDATE local_tool_events SET name_hash = ?3, namespace_hash = ?4
                  WHERE binding_id = ?1 AND id = ?2",
                params![binding, id, name_hash, namespace_hash],
            )?;
        }
        Ok(())
    }

    /// Upserts one (invocation, resource) row. A replay within one generation
    /// reconciles candidates: the earliest timestamp, the strongest access kind
    /// (write > read > search > unknown) and evidence basis (explicit_argument >
    /// connector > indirect_shell > unknown), any overlap flag, and the newest
    /// configuration token.
    pub fn upsert_resource_access(&self, binding: &str, row: &ResourceAccessRow) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT INTO local_resource_accesses
             (binding_id, id, timestamp, invocation_key, resource_key, configuration_version,
              access_kind, evidence_basis, nested_overlap)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(binding_id, id) DO UPDATE SET
               timestamp = min(local_resource_accesses.timestamp, excluded.timestamp),
               configuration_version = excluded.configuration_version,
               access_kind = CASE
                 WHEN (CASE excluded.access_kind
                         WHEN 'write' THEN 3 WHEN 'read' THEN 2 WHEN 'search' THEN 1 ELSE 0 END)
                    > (CASE local_resource_accesses.access_kind
                         WHEN 'write' THEN 3 WHEN 'read' THEN 2 WHEN 'search' THEN 1 ELSE 0 END)
                 THEN excluded.access_kind ELSE local_resource_accesses.access_kind END,
               evidence_basis = CASE
                 WHEN (CASE excluded.evidence_basis
                         WHEN 'explicit_argument' THEN 3 WHEN 'connector' THEN 2
                         WHEN 'indirect_shell' THEN 1 ELSE 0 END)
                    > (CASE local_resource_accesses.evidence_basis
                         WHEN 'explicit_argument' THEN 3 WHEN 'connector' THEN 2
                         WHEN 'indirect_shell' THEN 1 ELSE 0 END)
                 THEN excluded.evidence_basis ELSE local_resource_accesses.evidence_basis END,
               nested_overlap = max(local_resource_accesses.nested_overlap, excluded.nested_overlap)",
            params![
                binding,
                row.id,
                row.timestamp,
                row.invocation_key,
                row.resource_key,
                row.configuration_version,
                row.access_kind,
                row.evidence_basis,
                row.nested_overlap,
            ],
        )?;
        Ok(())
    }

    /// Records that one invocation was inspected. On conflict the class keeps
    /// the most informative outcome (matched > ambiguous > unsupported >
    /// unresolved > unmatched > no_evidence) and the overlap flag never clears,
    /// so a replay changes nothing.
    pub fn upsert_resource_inspection(
        &self,
        binding: &str,
        invocation_key: &str,
        class: &str,
        overlapping: bool,
    ) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT INTO local_resource_inspections (binding_id, invocation_key, class, overlapping)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(binding_id, invocation_key) DO UPDATE SET
               class = CASE
                 WHEN (CASE excluded.class
                         WHEN 'matched' THEN 5 WHEN 'ambiguous' THEN 4 WHEN 'unsupported' THEN 3
                         WHEN 'unresolved' THEN 2 WHEN 'unmatched' THEN 1 ELSE 0 END)
                    > (CASE local_resource_inspections.class
                         WHEN 'matched' THEN 5 WHEN 'ambiguous' THEN 4 WHEN 'unsupported' THEN 3
                         WHEN 'unresolved' THEN 2 WHEN 'unmatched' THEN 1 ELSE 0 END)
                 THEN excluded.class ELSE local_resource_inspections.class END,
               overlapping = max(local_resource_inspections.overlapping, excluded.overlapping)",
            params![binding, invocation_key, class, overlapping],
        )?;
        Ok(())
    }

    pub fn resource_accesses(&self, binding: &str) -> Result<Vec<ResourceAccessRow>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT id, timestamp, invocation_key, resource_key, configuration_version, access_kind,
                    evidence_basis, nested_overlap
               FROM local_resource_accesses WHERE binding_id = ?1 ORDER BY timestamp, id",
        )?;
        let rows = statement.query_map(params![binding], |row| {
            Ok(ResourceAccessRow {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                invocation_key: row.get(2)?,
                resource_key: row.get(3)?,
                configuration_version: row.get(4)?,
                access_kind: row.get(5)?,
                evidence_basis: row.get(6)?,
                nested_overlap: row.get(7)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Rows per resource key, access kind, and evidence basis, for the local listing.
    pub fn resource_access_counts(&self, binding: &str) -> Result<Vec<ResourceAccessCount>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT resource_key, access_kind, evidence_basis, count(*)
               FROM local_resource_accesses WHERE binding_id = ?1
              GROUP BY resource_key, access_kind, evidence_basis
              ORDER BY resource_key, access_kind, evidence_basis",
        )?;
        let rows = statement.query_map(params![binding], |row| {
            Ok(ResourceAccessCount {
                resource_key: row.get(0)?,
                access_kind: row.get(1)?,
                evidence_basis: row.get(2)?,
                rows: row.get::<_, i64>(3)?.max(0) as u64,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn resource_inspection_counts(&self, binding: &str) -> Result<ResourceInspectionCounts, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT class, count(*), sum(overlapping) FROM local_resource_inspections
              WHERE binding_id = ?1 GROUP BY class",
        )?;
        let rows = statement.query_map(params![binding], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?))
        })?;
        let mut counts = ResourceInspectionCounts::default();
        for row in rows {
            let (class, total, overlapping) = row?;
            let total = total.max(0) as u64;
            match class.as_str() {
                "matched" => counts.matched += total,
                "unmatched" => counts.unmatched += total,
                "no_evidence" => counts.no_evidence += total,
                "unresolved" => counts.unresolved += total,
                "unsupported" => counts.unsupported += total,
                "ambiguous" => counts.ambiguous += total,
                _ => {}
            }
            counts.overlapping += overlapping.unwrap_or(0).max(0) as u64;
        }
        Ok(counts)
    }

    // --- allowance slots ----------------------------------------------------

    pub fn allowance_slot(&self, binding: &str, slot: &str) -> Result<Option<String>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT payload FROM allowance_slots WHERE binding_id = ?1 AND slot = ?2",
                params![binding, slot],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn upsert_allowance_slot(&self, binding: &str, slot: &str, payload: &str) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT INTO allowance_slots (binding_id, slot, payload, dirty) VALUES (?1, ?2, ?3, 1)
             ON CONFLICT(binding_id, slot) DO UPDATE SET payload = excluded.payload, dirty = 1",
            params![binding, slot, payload],
        )?;
        Ok(())
    }

    /// `INSERT OR IGNORE` semantics: a slot keyed by content is written once.
    pub fn insert_allowance_slot_if_absent(
        &self,
        binding: &str,
        slot: &str,
        payload: &str,
    ) -> Result<bool, StateError> {
        let changed = self.conn.execute(
            "INSERT OR IGNORE INTO allowance_slots (binding_id, slot, payload, dirty) VALUES (?1, ?2, ?3, 1)",
            params![binding, slot, payload],
        )?;
        Ok(changed > 0)
    }

    pub fn dirty_allowance_slots(&self, binding: &str) -> Result<Vec<(String, String)>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT slot, payload FROM allowance_slots WHERE binding_id = ?1 AND dirty = 1 ORDER BY slot",
        )?;
        let rows = statement.query_map(params![binding], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn clear_allowance_dirty(&self, binding: &str, slot: &str) -> Result<(), StateError> {
        self.conn.execute(
            "UPDATE allowance_slots SET dirty = 0 WHERE binding_id = ?1 AND slot = ?2",
            params![binding, slot],
        )?;
        Ok(())
    }

    /// Whether a content-keyed slot is already stored under any binding or held
    /// in quarantine: a replayed sample is skipped before any binding decision.
    /// Both probes are index lookups (`allowance_slots_slot`, the quarantine
    /// key), so the replay check on a retained inbox does not grow with history.
    pub fn allowance_slot_exists_anywhere(&self, slot: &str) -> Result<bool, StateError> {
        Ok(self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM allowance_slots WHERE slot = ?1)
                 OR EXISTS(SELECT 1 FROM allowance_quarantine WHERE slot = ?1)",
            params![slot],
            |row| row.get(0),
        )?)
    }

    /// The newest `observed_at` among a binding's slots, for the freshness rule.
    pub fn newest_allowance_observed_at(&self, binding: &str) -> Result<Option<String>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT max(json_extract(payload, '$.observed_at')) FROM allowance_slots WHERE binding_id = ?1",
                params![binding],
                |row| row.get(0),
            )
            .optional()?
            .flatten())
    }

    // --- allowance quarantine -----------------------------------------------

    /// Holds a sample that could not be bound safely. Never emitted; every run
    /// re-evaluates the rows against the current bindings. An unstamped sample
    /// held as `identity_unconfirmed` records the lone binding it met, the only
    /// one it may be released to. Returns false when the slot was already held.
    pub fn quarantine_sample(
        &self,
        slot: &str,
        payload: &str,
        identity_hash: Option<&str>,
        reason: &str,
        stored_at: &str,
        candidate_binding_id: Option<&str>,
    ) -> Result<bool, StateError> {
        let changed = self.conn.execute(
            "INSERT OR IGNORE INTO allowance_quarantine
                 (slot, payload, identity_hash, reason, stored_at, candidate_binding_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![slot, payload, identity_hash, reason, stored_at, candidate_binding_id],
        )?;
        Ok(changed > 0)
    }

    pub fn quarantined_samples(&self) -> Result<Vec<QuarantinedSample>, StateError> {
        let mut statement = self.conn.prepare(
            "SELECT slot, payload, identity_hash, reason, stored_at, candidate_binding_id
             FROM allowance_quarantine ORDER BY slot",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(QuarantinedSample {
                slot: row.get(0)?,
                payload: row.get(1)?,
                identity_hash: row.get(2)?,
                reason: row.get(3)?,
                stored_at: row.get(4)?,
                candidate_binding_id: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Held rows by reason.
    pub fn quarantine_counts(&self) -> Result<BTreeMap<String, u64>, StateError> {
        let mut statement =
            self.conn.prepare("SELECT reason, count(*) FROM allowance_quarantine GROUP BY reason")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))?;
        let mut counts = BTreeMap::new();
        for row in rows {
            let (reason, count) = row?;
            counts.insert(reason, count.max(0) as u64);
        }
        Ok(counts)
    }

    /// Re-labels a held row whose reason changed under the current bindings.
    pub fn requarantine(&self, slot: &str, reason: &str) -> Result<(), StateError> {
        self.conn.execute(
            "UPDATE allowance_quarantine SET reason = ?2 WHERE slot = ?1 AND reason <> ?2",
            params![slot, reason],
        )?;
        Ok(())
    }

    /// Moves a held row into a binding's slots (written once, dirty) and drops it.
    pub fn release_quarantined(&self, slot: &str, binding: &str) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT OR IGNORE INTO allowance_slots (binding_id, slot, payload, dirty)
             SELECT ?2, slot, payload, 1 FROM allowance_quarantine WHERE slot = ?1",
            params![slot, binding],
        )?;
        self.conn.execute("DELETE FROM allowance_quarantine WHERE slot = ?1", params![slot])?;
        Ok(())
    }

    /// Drops held rows stored before the cutoff, except those whose stamp still
    /// pairs with one of the given hashes (a binding waiting for its conflict to
    /// clear). Unstamped rows are never pairable. Returns the number removed.
    pub fn prune_quarantine(&self, cutoff: &str, pairable_hashes: &[String]) -> Result<usize, StateError> {
        let mut removed = 0;
        let mut statement =
            self.conn.prepare("SELECT slot, identity_hash FROM allowance_quarantine WHERE stored_at < ?1")?;
        let rows = statement.query_map(params![cutoff], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?;
        let stale: Vec<(String, Option<String>)> = rows.collect::<Result<Vec<_>, _>>()?;
        for (slot, hash) in stale {
            if hash.as_ref().is_some_and(|hash| pairable_hashes.contains(hash)) {
                continue;
            }
            removed +=
                self.conn.execute("DELETE FROM allowance_quarantine WHERE slot = ?1", params![slot])?;
        }
        Ok(removed)
    }

    // --- records ------------------------------------------------------------

    /// Inserts or revises a record. Returns true when the stored row changed.
    /// Publication and rejection marks survive a revision, except the local
    /// `superseded_configuration` mark: a producer re-emitting the record
    /// proves it is classified under the current configuration again.
    pub fn upsert_record(&self, row: &RecordRow) -> Result<bool, StateError> {
        let changed = self.conn.execute(
            "INSERT INTO records (record_id, binding_id, adapter, record_type, semantic_key, content_hash,
                                  published_hash, rejected_reason, record, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8)
             ON CONFLICT(record_id) DO UPDATE SET content_hash = excluded.content_hash, record = excluded.record,
                 semantic_key = excluded.semantic_key, updated_at = excluded.updated_at,
                 rejected_reason = CASE WHEN records.rejected_reason = ?9 THEN NULL ELSE records.rejected_reason END
             WHERE records.content_hash <> excluded.content_hash OR records.rejected_reason = ?9",
            params![
                row.record_id,
                row.binding_id,
                row.adapter,
                row.record_type,
                row.semantic_key,
                row.content_hash,
                row.record,
                row.updated_at,
                SUPERSEDED_CONFIGURATION,
            ],
        )?;
        Ok(changed > 0)
    }

    pub fn record(&self, record_id: &str) -> Result<Option<RecordRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT record_id, binding_id, adapter, record_type, semantic_key, content_hash, published_hash,
                        rejected_reason, record, updated_at FROM records WHERE record_id = ?1",
                params![record_id],
                record_from_row,
            )
            .optional()?)
    }

    /// Records whose content has not been acknowledged and that were never rejected.
    pub fn pending_records(&self, limit: usize) -> Result<Vec<RecordRow>, StateError> {
        self.pending_records_after(limit, None)
    }

    /// One stable page of pending records after an `(updated_at, record_id)`
    /// cursor. Callers that apply policy filters can continue past excluded
    /// rows without allowing them to starve newer eligible records.
    pub fn pending_records_after(
        &self,
        limit: usize,
        after: Option<(&str, &str)>,
    ) -> Result<Vec<RecordRow>, StateError> {
        let (after_updated, after_id) = after.unwrap_or(("", ""));
        let mut statement = self.conn.prepare(
            "SELECT record_id, binding_id, adapter, record_type, semantic_key, content_hash, published_hash,
                    rejected_reason, record, updated_at
               FROM records
              WHERE rejected_reason IS NULL AND (published_hash IS NULL OR published_hash <> content_hash)
                AND (updated_at > ?2 OR (updated_at = ?2 AND record_id > ?3))
               ORDER BY updated_at, record_id LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64, after_updated, after_id], record_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn mark_record_published(&self, record_id: &str, content_hash: &str) -> Result<(), StateError> {
        self.conn.execute(
            "UPDATE records SET published_hash = ?2 WHERE record_id = ?1",
            params![record_id, content_hash],
        )?;
        Ok(())
    }

    pub fn mark_record_rejected(&self, record_id: &str, reason: &str) -> Result<(), StateError> {
        self.conn.execute(
            "UPDATE records SET rejected_reason = ?2 WHERE record_id = ?1",
            params![record_id, reason],
        )?;
        Ok(())
    }

    pub fn record_counts(&self) -> Result<(u64, u64, u64), StateError> {
        self.conn
            .query_row(
                "SELECT count(*),
                        sum(CASE WHEN rejected_reason IS NULL AND (published_hash IS NULL OR published_hash <> content_hash) THEN 1 ELSE 0 END),
                        sum(CASE WHEN rejected_reason IS NOT NULL THEN 1 ELSE 0 END)
                   FROM records",
                [],
                |row| {
                    let total: i64 = row.get(0)?;
                    let pending: Option<i64> = row.get(1)?;
                    let rejected: Option<i64> = row.get(2)?;
                    Ok((
                        total.max(0) as u64,
                        pending.unwrap_or(0).max(0) as u64,
                        rejected.unwrap_or(0).max(0) as u64,
                    ))
                },
            )
            .map_err(StateError::from)
    }

    // --- observations -------------------------------------------------------

    pub fn save_observation(
        &self,
        record_id: &str,
        adapter: &str,
        observed_at: &str,
        payload: &str,
        stored_at: &str,
    ) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO observations (record_id, adapter, observed_at, payload, stored_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![record_id, adapter, observed_at, payload, stored_at],
        )?;
        Ok(())
    }

    /// Removes observations stored before `cutoff` (an RFC 3339 text compared lexically).
    pub fn prune_observations(&self, cutoff: &str) -> Result<usize, StateError> {
        Ok(self.conn.execute("DELETE FROM observations WHERE stored_at < ?1", params![cutoff])?)
    }

    pub fn clear_observations(&self) -> Result<usize, StateError> {
        Ok(self.conn.execute("DELETE FROM observations", [])?)
    }

    // --- published buckets --------------------------------------------------

    pub fn published_hash(&self, key: &str) -> Result<Option<String>, StateError> {
        Ok(self
            .conn
            .query_row("SELECT hash FROM published WHERE key = ?1", params![key], |row| row.get(0))
            .optional()?)
    }

    /// Every published bucket digest of one binding, keyed as `bucket_key`
    /// forms them (`<binding_id>:<digest>`), in one query.
    pub fn published_hashes(&self, binding: &str) -> Result<HashMap<String, String>, StateError> {
        // A key range on the primary key: ';' is the byte after ':'.
        let mut statement =
            self.conn.prepare("SELECT key, hash FROM published WHERE key >= ?1 AND key < ?2")?;
        let rows = statement.query_map(params![format!("{binding}:"), format!("{binding};")], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
    }

    pub fn set_published(&self, key: &str, hash: &str) -> Result<(), StateError> {
        self.conn.execute("INSERT OR REPLACE INTO published VALUES (?1, ?2)", params![key, hash])?;
        Ok(())
    }

    // --- outbox and receipts ------------------------------------------------

    pub fn enqueue_outbox(&self, hash: &str, payload: &str, created_at: &str) -> Result<bool, StateError> {
        let changed = self.conn.execute(
            "INSERT OR IGNORE INTO outbox (hash, payload, created_at) VALUES (?1, ?2, ?3)",
            params![hash, payload, created_at],
        )?;
        Ok(changed > 0)
    }

    pub fn outbox(&self) -> Result<Vec<OutboxRow>, StateError> {
        let mut statement =
            self.conn.prepare("SELECT hash, payload, created_at FROM outbox ORDER BY rowid")?;
        let rows = statement.query_map([], |row| {
            Ok(OutboxRow { hash: row.get(0)?, payload: row.get(1)?, created_at: row.get(2)? })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn outbox_len(&self) -> Result<u64, StateError> {
        let count: i64 = self.conn.query_row("SELECT count(*) FROM outbox", [], |row| row.get(0))?;
        Ok(count.max(0) as u64)
    }

    pub fn delete_outbox(&self, hash: &str) -> Result<(), StateError> {
        self.conn.execute("DELETE FROM outbox WHERE hash = ?1", params![hash])?;
        Ok(())
    }

    /// Discards queued envelopes before rebuilding them under the current
    /// settings. Their source records and buckets remain pending locally.
    pub fn clear_outbox(&self) -> Result<usize, StateError> {
        Ok(self.conn.execute("DELETE FROM outbox", [])?)
    }

    pub fn save_receipt(&self, hash: &str, received_at: &str, receipt: &str) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO receipts (hash, received_at, receipt) VALUES (?1, ?2, ?3)",
            params![hash, received_at, receipt],
        )?;
        Ok(())
    }

    pub fn last_receipt_at(&self) -> Result<Option<String>, StateError> {
        Ok(self
            .conn
            .query_row("SELECT max(received_at) FROM receipts", [], |row| row.get(0))
            .optional()?
            .flatten())
    }

    // --- runs ---------------------------------------------------------------

    pub fn save_run(&self, row: &RunRow) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT OR REPLACE INTO runs (run_id, started_at, finished_at, summary) VALUES (?1, ?2, ?3, ?4)",
            params![row.run_id, row.started_at, row.finished_at, row.summary],
        )?;
        self.conn.execute(
            "DELETE FROM runs WHERE run_id NOT IN (SELECT run_id FROM runs ORDER BY finished_at DESC LIMIT 200)",
            [],
        )?;
        Ok(())
    }

    pub fn last_run(&self) -> Result<Option<RunRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT run_id, started_at, finished_at, summary FROM runs ORDER BY finished_at DESC LIMIT 1",
                [],
                |row| {
                    Ok(RunRow {
                        run_id: row.get(0)?,
                        started_at: row.get(1)?,
                        finished_at: row.get(2)?,
                        summary: row.get(3)?,
                    })
                },
            )
            .optional()?)
    }
}

fn resource_config_token_key(digest: &str) -> String {
    format!("resource_config_token:{digest}")
}

/// Sixteen lowercase hex digits from the UUID v4 random source, skipping the
/// bytes that carry the version and variant so every digit is random.
fn random_token() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    [0usize, 1, 2, 3, 4, 5, 9, 10].iter().map(|index| format!("{:02x}", bytes[*index])).collect()
}

fn prefer_code(old: &str, new: &str, unknown: &str) -> String {
    if old == unknown && new != unknown { new.to_owned() } else { old.to_owned() }
}

fn parent_evidence_rank(value: &str) -> u8 {
    match value {
        "none" => 4,
        "explicit" => 3,
        "structural" => 2,
        "fallback" => 1,
        _ => 0,
    }
}

fn prefer_parent_evidence(old: &str, new: &str) -> String {
    if parent_evidence_rank(new) > parent_evidence_rank(old) { new.to_owned() } else { old.to_owned() }
}

fn depth_evidence_rank(value: &str) -> u8 {
    match value {
        "explicit" => 3,
        "invalidated" => 2,
        "inferred" => 1,
        _ => 0,
    }
}

fn prefer_depth_evidence(old: &str, new: &str) -> String {
    if depth_evidence_rank(new) > depth_evidence_rank(old) { new.to_owned() } else { old.to_owned() }
}

fn agent_profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentProfileRow> {
    Ok(AgentProfileRow {
        key: row.get(0)?,
        identity_basis: row.get(1)?,
        parent_key: row.get(2)?,
        parent_identity_basis: row.get(3)?,
        parent_evidence: row.get(4)?,
        class: row.get(5)?,
        name: row.get(6)?,
        depth: row.get(7)?,
        depth_evidence: row.get(8)?,
        model_requested: row.get(9)?,
    })
}

fn agent_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentEventRow> {
    Ok(AgentEventRow {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        event_kind: row.get(2)?,
        session_hash: row.get(3)?,
        agent_key: row.get(4)?,
        identity_basis: row.get(5)?,
        parent_key: row.get(6)?,
        parent_identity_basis: row.get(7)?,
        class: row.get(8)?,
        name: row.get(9)?,
        depth: row.get(10)?,
        model_requested: row.get(11)?,
        tool_invocation_key: row.get(12)?,
        outcome: row.get(13)?,
    })
}

fn tool_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ToolEventRow> {
    Ok(ToolEventRow {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        event_kind: row.get(2)?,
        invocation_key: row.get(3)?,
        session_hash: row.get(4)?,
        caller_request_key: row.get(5)?,
        caller_agent_key: row.get(6)?,
        caller_is_subagent: row.get(7)?,
        parent_invocation_key: row.get(8)?,
        class: row.get(9)?,
        name: row.get(10)?,
        name_hash: row.get(11)?,
        namespace: row.get(12)?,
        namespace_hash: row.get(13)?,
        outcome: row.get(14)?,
        name_truncated: row.get(15)?,
    })
}

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    Ok(EventRow {
        id: row.get(0)?,
        session: row.get(1)?,
        hour: row.get(2)?,
        model: row.get(3)?,
        input_tokens: row.get(4)?,
        cached_tokens: row.get(5)?,
        cache_write_tokens: row.get(6)?,
        output_tokens: row.get(7)?,
        session_identity: row.get(8)?,
        timestamp: row.get(9)?,
        product: row.get(10)?,
        client_version: row.get(11)?,
        parent_session: row.get(12)?,
        project_hash: row.get(13)?,
        project_key: row.get(14)?,
        project_basis: row.get(15)?,
        surface: row.get(16)?,
        detail_observed: row.get(17)?,
        bucket_eligible: row.get(18)?,
        detail_input_fresh: row.get(19)?,
        detail_input_cached: row.get(20)?,
        detail_input_cache_write: row.get(21)?,
        detail_output: row.get(22)?,
        detail_reasoning: row.get(23)?,
        reported_total: row.get(24)?,
        model_requested: row.get(25)?,
        reasoning_effort: row.get(26)?,
        service_tier: row.get(27)?,
        speed: row.get(28)?,
        context_window_tokens: row.get(29)?,
        cache_write_ttl: row.get(30)?,
        outcome: row.get(31)?,
        agent_observed: row.get(32)?,
        agent_key: row.get(33)?,
        agent_identity_basis: row.get(34)?,
        parent_agent_key: row.get(35)?,
        parent_agent_identity_basis: row.get(36)?,
        agent_class: row.get(37)?,
        agent_name: row.get(38)?,
        agent_depth: row.get(39)?,
    })
}

fn record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RecordRow> {
    Ok(RecordRow {
        record_id: row.get(0)?,
        binding_id: row.get(1)?,
        adapter: row.get(2)?,
        record_type: row.get(3)?,
        semantic_key: row.get(4)?,
        content_hash: row.get(5)?,
        published_hash: row.get(6)?,
        rejected_reason: row.get(7)?,
        record: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, output: i64) -> EventRow {
        EventRow {
            id: id.into(),
            session: "s".into(),
            hour: "2026-09-02T02:00:00.000Z".into(),
            model: "m".into(),
            input_tokens: 2,
            cached_tokens: 20,
            cache_write_tokens: 8,
            output_tokens: output,
            session_identity: "provider".into(),
            timestamp: "2026-09-02T02:00:00Z".into(),
            product: "claude_code".into(),
            client_version: None,
            parent_session: None,
            project_hash: None,
            project_key: None,
            project_basis: "unknown".into(),
            surface: None,
            detail_observed: true,
            bucket_eligible: true,
            detail_input_fresh: Some(2),
            detail_input_cached: Some(20),
            detail_input_cache_write: Some(8),
            detail_output: Some(output),
            detail_reasoning: None,
            reported_total: None,
            model_requested: None,
            reasoning_effort: None,
            service_tier: None,
            speed: None,
            context_window_tokens: None,
            cache_write_ttl: None,
            outcome: Some("completed".into()),
            agent_observed: true,
            agent_key: Some("2".repeat(64)),
            agent_identity_basis: "provider".into(),
            parent_agent_key: None,
            parent_agent_identity_basis: "none".into(),
            agent_class: "main".into(),
            agent_name: None,
            agent_depth: Some(0),
        }
    }

    #[test]
    fn events_and_buckets() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        state.insert_event("b", &event("a", 10)).unwrap();
        state.insert_event("b", &event("b", 5)).unwrap();
        state.update_event_tokens("b", "a", [2, 20, 8, 20]).unwrap();
        let rows = state.bucket_rows("b").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].calls, 2);
        assert_eq!(rows[0].total_tokens, 2 * 30 + 25);
        assert!(state.bucket_rows("other").unwrap().is_empty());
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("8"));
    }

    #[test]
    fn zero_usage_requests_do_not_change_legacy_buckets() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let mut zero = event("zero", 0);
        zero.input_tokens = 0;
        zero.cached_tokens = 0;
        zero.cache_write_tokens = 0;
        zero.detail_input_fresh = Some(0);
        zero.detail_input_cached = Some(0);
        zero.detail_input_cache_write = Some(0);
        zero.detail_output = Some(0);
        zero.bucket_eligible = false;
        state.insert_event("b", &zero).unwrap();
        assert!(state.events("b").unwrap().is_empty());
        assert!(state.bucket_rows("b").unwrap().is_empty());
        assert_eq!(state.request_events("b").unwrap(), vec![zero]);
    }

    #[test]
    fn bucket_rows_follow_the_current_subagent_setting() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let main = event("main", 10);
        let mut child = event("child", 20);
        child.session = "child-session".into();
        child.agent_key = Some("4".repeat(64));
        child.parent_agent_key = Some("2".repeat(64));
        child.parent_agent_identity_basis = "provider".into();
        child.agent_class = "builtin".into();
        child.agent_depth = Some(1);
        let mut unknown = event("unknown", 30);
        unknown.session = "unknown-session".into();
        unknown.agent_key = None;
        unknown.agent_identity_basis = "unknown".into();
        unknown.parent_agent_key = None;
        unknown.parent_agent_identity_basis = "unknown".into();
        unknown.agent_class = "unknown".into();
        unknown.agent_depth = None;
        let mut legacy_child = event("legacy-child", 40);
        legacy_child.session = "legacy-child-session".into();
        legacy_child.parent_session = Some("7".repeat(64));
        legacy_child.agent_observed = false;
        legacy_child.agent_key = None;
        legacy_child.agent_identity_basis = "unknown".into();
        legacy_child.parent_agent_key = None;
        legacy_child.parent_agent_identity_basis = "unknown".into();
        legacy_child.agent_class = "unknown".into();
        legacy_child.agent_depth = None;
        for row in [&main, &child, &unknown, &legacy_child] {
            state.insert_event("b", row).unwrap();
        }

        let calls = |include| {
            state
                .bucket_rows_for_agent_setting("b", include)
                .unwrap()
                .into_iter()
                .map(|row| row.calls)
                .sum::<i64>()
        };
        assert_eq!(calls(true), 4);
        assert_eq!(calls(false), 2);
    }

    #[test]
    fn parser_generation_replays_checkpoints_once() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let checkpoint = FileCheckpoint {
            path: "history.jsonl".into(),
            size: 10,
            mtime_ns: 20,
            inode: "file-1".into(),
            offset: 10,
            context: "{}".into(),
        };
        state.save_file_checkpoint("b", &checkpoint).unwrap();
        state.mark_file_parse_gap("b", "history.jsonl").unwrap();
        assert!(state.prepare_file_scan("b", "parser-1").unwrap());
        assert_eq!(state.file_count("b").unwrap(), 0);
        assert_eq!(state.file_parse_gap_count("b").unwrap(), 1);
        state.save_file_checkpoint("b", &checkpoint).unwrap();
        assert!(!state.prepare_file_scan("b", "parser-1").unwrap());
        assert_eq!(state.file_count("b").unwrap(), 1);
        assert!(state.prepare_file_scan("b", "parser-2").unwrap());
        assert_eq!(state.file_count("b").unwrap(), 0);
    }

    #[test]
    fn version_one_state_gains_attribution_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO meta VALUES ('schema_version', '1');
                 CREATE TABLE events (binding_id TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL,
                   hour TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
                   cache_write_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, session_identity TEXT NOT NULL,
                   timestamp TEXT NOT NULL, product TEXT NOT NULL, client_version TEXT, parent_session TEXT,
                   PRIMARY KEY (binding_id, id));",
            )
            .unwrap();
        }
        let state = State::open(&path).unwrap();
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("8"));
        let mut row = event("a", 10);
        row.project_hash = Some("h".repeat(64));
        row.project_key = row.project_hash.clone();
        row.project_basis = "working_directory".into();
        row.surface = Some("desktop".into());
        state.insert_event("b", &row).unwrap();
        assert_eq!(state.event("b", "a").unwrap().unwrap(), row);
        // Reopening runs the idempotent step again without error.
        drop(state);
        State::open(&path).unwrap();
    }

    #[test]
    fn version_five_project_hashes_gain_explicit_working_directory_basis() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite3");
        drop(State::open(&path).unwrap());
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "ALTER TABLE events DROP COLUMN project_key;
                 ALTER TABLE events DROP COLUMN project_basis;
                 UPDATE meta SET value = '5' WHERE key = 'schema_version';",
            )
            .unwrap();
            let mut columns = event("legacy", 1);
            columns.project_hash = Some("a".repeat(64));
            conn.execute(
                "INSERT INTO events
                  (binding_id, id, session, hour, model, input_tokens, cached_tokens,
                   cache_write_tokens, output_tokens, session_identity, timestamp, product,
                   project_hash, detail_observed, bucket_eligible, agent_observed,
                   agent_identity_basis, parent_agent_identity_basis, agent_class)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1, 1, 0,
                         'unknown', 'unknown', 'unknown')",
                params![
                    "b",
                    columns.id,
                    columns.session,
                    columns.hour,
                    columns.model,
                    columns.input_tokens,
                    columns.cached_tokens,
                    columns.cache_write_tokens,
                    columns.output_tokens,
                    columns.session_identity,
                    columns.timestamp,
                    columns.product,
                    columns.project_hash,
                ],
            )
            .unwrap();
        }
        let state = State::open(&path).unwrap();
        let migrated = state.event("b", "legacy").unwrap().unwrap();
        assert_eq!(migrated.project_key, migrated.project_hash);
        assert_eq!(migrated.project_basis, "working_directory");
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("8"));
    }

    #[test]
    fn version_three_state_gains_agent_storage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO meta VALUES ('schema_version', '3');
                 CREATE TABLE events (binding_id TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL,
                   hour TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
                   cache_write_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, session_identity TEXT NOT NULL,
                   timestamp TEXT NOT NULL, product TEXT NOT NULL, client_version TEXT, parent_session TEXT,
                   project_hash TEXT, surface TEXT, detail_observed INTEGER NOT NULL DEFAULT 0,
                   bucket_eligible INTEGER NOT NULL DEFAULT 1, detail_input_fresh INTEGER,
                   detail_input_cached INTEGER, detail_input_cache_write INTEGER, detail_output INTEGER,
                   detail_reasoning INTEGER, reported_total INTEGER, model_requested TEXT,
                   reasoning_effort TEXT, service_tier TEXT, speed TEXT, context_window_tokens INTEGER,
                   cache_write_ttl TEXT, outcome TEXT, PRIMARY KEY (binding_id, id));
                 INSERT INTO events
                   (binding_id, id, session, hour, model, input_tokens, cached_tokens,
                    cache_write_tokens, output_tokens, session_identity, timestamp, product, parent_session)
                 VALUES
                   ('b', 'legacy-child', 'child-session', '2026-09-02T01:00:00.000Z', 'legacy-model',
                    1, 0, 0, 1, 'provider', '2026-09-02T01:00:01.000Z', 'claude_code',
                    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');",
            )
            .unwrap();
        }
        let state = State::open(&path).unwrap();
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("8"));
        let legacy = state.event("b", "legacy-child").unwrap().unwrap();
        assert!(!legacy.agent_observed);
        assert!(legacy.parent_session.is_some());
        assert_eq!(state.bucket_rows_for_agent_setting("b", true).unwrap().len(), 1);
        assert!(state.bucket_rows_for_agent_setting("b", false).unwrap().is_empty());
        let row = event("agent-request", 10);
        state.insert_event("b", &row).unwrap();
        assert_eq!(state.event("b", "agent-request").unwrap().unwrap(), row);
        let profile = AgentProfileRow {
            key: "2".repeat(64),
            identity_basis: "provider".into(),
            parent_key: Some("3".repeat(64)),
            parent_identity_basis: "provider".into(),
            parent_evidence: "explicit".into(),
            class: "builtin".into(),
            name: Some("Explore".into()),
            depth: Some(1),
            depth_evidence: "explicit".into(),
            model_requested: Some("requested-model".into()),
        };
        state.upsert_agent_profile("b", &profile).unwrap();
        assert_eq!(state.agent_profile("b", &profile.key).unwrap(), Some(profile));
        drop(state);
        State::open(&path).unwrap();
    }

    #[test]
    fn corrected_agent_depth_propagates_to_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let ancestor_key = "1".repeat(64);
        let parent_key = "2".repeat(64);
        let child_key = "3".repeat(64);

        state
            .upsert_agent_profile(
                "b",
                &AgentProfileRow {
                    key: parent_key.clone(),
                    identity_basis: "provider".into(),
                    parent_key: Some(ancestor_key.clone()),
                    parent_identity_basis: "provider".into(),
                    parent_evidence: "fallback".into(),
                    class: "builtin".into(),
                    name: Some("Explore".into()),
                    depth: Some(1),
                    depth_evidence: "inferred".into(),
                    model_requested: None,
                },
            )
            .unwrap();
        state
            .upsert_agent_profile(
                "b",
                &AgentProfileRow {
                    key: child_key.clone(),
                    identity_basis: "provider".into(),
                    parent_key: Some(parent_key.clone()),
                    parent_identity_basis: "provider".into(),
                    parent_evidence: "structural".into(),
                    class: "builtin".into(),
                    name: Some("Plan".into()),
                    depth: Some(2),
                    depth_evidence: "inferred".into(),
                    model_requested: None,
                },
            )
            .unwrap();

        let mut request = event("child-request", 10);
        request.agent_key = Some(child_key.clone());
        request.parent_agent_key = Some(parent_key.clone());
        request.parent_agent_identity_basis = "provider".into();
        request.agent_class = "builtin".into();
        request.agent_name = Some("Plan".into());
        request.agent_depth = Some(2);
        state.insert_event("b", &request).unwrap();
        state
            .insert_agent_event(
                "b",
                &AgentEventRow {
                    id: "child-start".into(),
                    timestamp: "2026-09-02T02:00:00Z".into(),
                    event_kind: "start".into(),
                    session_hash: Some("4".repeat(64)),
                    agent_key: Some(child_key.clone()),
                    identity_basis: "provider".into(),
                    parent_key: Some(parent_key.clone()),
                    parent_identity_basis: "provider".into(),
                    class: "builtin".into(),
                    name: Some("Plan".into()),
                    depth: Some(2),
                    model_requested: None,
                    tool_invocation_key: None,
                    outcome: "unknown".into(),
                },
            )
            .unwrap();

        state
            .upsert_agent_profile(
                "b",
                &AgentProfileRow {
                    key: parent_key.clone(),
                    identity_basis: "provider".into(),
                    parent_key: Some(ancestor_key),
                    parent_identity_basis: "provider".into(),
                    parent_evidence: "explicit".into(),
                    class: "builtin".into(),
                    name: Some("Explore".into()),
                    depth: Some(2),
                    depth_evidence: "explicit".into(),
                    model_requested: None,
                },
            )
            .unwrap();

        assert_eq!(state.agent_profile("b", &parent_key).unwrap().unwrap().depth, Some(2));
        assert_eq!(state.agent_profile("b", &child_key).unwrap().unwrap().depth, Some(3));
        assert_eq!(state.event("b", "child-request").unwrap().unwrap().agent_depth, Some(3));
        assert_eq!(state.agent_event("b", "child-start").unwrap().unwrap().depth, Some(3));
    }

    #[test]
    fn parent_replay_preserves_an_independently_recorded_child_depth() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let parent = AgentProfileRow {
            key: "1".repeat(64),
            identity_basis: "provider".into(),
            parent_key: Some("2".repeat(64)),
            parent_identity_basis: "provider".into(),
            parent_evidence: "fallback".into(),
            class: "builtin".into(),
            name: None,
            depth: Some(1),
            depth_evidence: "inferred".into(),
            model_requested: None,
        };
        let child = AgentProfileRow {
            key: "3".repeat(64),
            identity_basis: "provider".into(),
            parent_key: Some(parent.key.clone()),
            parent_identity_basis: "provider".into(),
            parent_evidence: "explicit".into(),
            class: "builtin".into(),
            name: None,
            depth: Some(3),
            depth_evidence: "explicit".into(),
            model_requested: None,
        };
        state.upsert_agent_profile("b", &parent).unwrap();
        state.upsert_agent_profile("b", &child).unwrap();

        state.upsert_agent_profile("b", &parent).unwrap();

        assert_eq!(state.agent_profile("b", &child.key).unwrap().unwrap().depth, Some(3));
    }

    #[test]
    fn stronger_parent_evidence_replaces_an_inferred_depth() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let key = "1".repeat(64);
        state
            .upsert_agent_profile(
                "b",
                &AgentProfileRow {
                    key: key.clone(),
                    identity_basis: "provider".into(),
                    parent_key: Some("2".repeat(64)),
                    parent_identity_basis: "provider".into(),
                    parent_evidence: "structural".into(),
                    class: "builtin".into(),
                    name: None,
                    depth: Some(2),
                    depth_evidence: "inferred".into(),
                    model_requested: None,
                },
            )
            .unwrap();
        state
            .upsert_agent_profile(
                "b",
                &AgentProfileRow {
                    key: key.clone(),
                    identity_basis: "provider".into(),
                    parent_key: Some("3".repeat(64)),
                    parent_identity_basis: "provider".into(),
                    parent_evidence: "explicit".into(),
                    class: "builtin".into(),
                    name: None,
                    depth: Some(3),
                    depth_evidence: "inferred".into(),
                    model_requested: None,
                },
            )
            .unwrap();

        let profile = state.agent_profile("b", &key).unwrap().unwrap();
        assert_eq!(
            profile.parent_key.as_deref(),
            Some("3333333333333333333333333333333333333333333333333333333333333333")
        );
        assert_eq!(profile.depth, Some(3));
        assert_eq!(profile.depth_evidence, "inferred");
    }

    #[test]
    fn clearing_an_inferred_depth_clears_inferred_descendants() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let parent_key = "1".repeat(64);
        let child_key = "2".repeat(64);
        let parent = AgentProfileRow {
            key: parent_key.clone(),
            identity_basis: "provider".into(),
            parent_key: Some("3".repeat(64)),
            parent_identity_basis: "provider".into(),
            parent_evidence: "structural".into(),
            class: "builtin".into(),
            name: None,
            depth: Some(1),
            depth_evidence: "inferred".into(),
            model_requested: None,
        };
        state.upsert_agent_profile("b", &parent).unwrap();
        let stale_child = AgentProfileRow {
            key: child_key.clone(),
            identity_basis: "provider".into(),
            parent_key: Some(parent_key.clone()),
            parent_identity_basis: "provider".into(),
            parent_evidence: "structural".into(),
            class: "builtin".into(),
            name: None,
            depth: Some(2),
            depth_evidence: "inferred".into(),
            model_requested: None,
        };
        state.upsert_agent_profile("b", &stale_child).unwrap();
        let mut request = event("child-request-with-cleared-depth", 1);
        request.agent_key = Some(child_key.clone());
        request.agent_depth = Some(2);
        state.insert_event("b", &request).unwrap();

        state
            .upsert_agent_profile(
                "b",
                &AgentProfileRow {
                    parent_key: Some("4".repeat(64)),
                    parent_evidence: "explicit".into(),
                    depth: None,
                    depth_evidence: "unknown".into(),
                    ..parent
                },
            )
            .unwrap();

        let child = state.agent_profile("b", &child_key).unwrap().unwrap();
        assert_eq!(child.depth, None);
        assert_eq!(child.depth_evidence, "invalidated");
        assert_eq!(state.event("b", "child-request-with-cleared-depth").unwrap().unwrap().agent_depth, None);

        state.upsert_agent_profile("b", &stale_child).unwrap();
        let replayed = state.agent_profile("b", &child_key).unwrap().unwrap();
        assert_eq!(replayed.depth, None);
        assert_eq!(replayed.depth_evidence, "invalidated");
    }

    #[test]
    fn attribution_fills_once_and_projects_keep_first_and_last_sightings() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        state.insert_event("b", &event("a", 10)).unwrap();
        state
            .fill_event_attribution("b", "a", Some("p1"), Some("p1"), Some("working_directory"), Some("cli"))
            .unwrap();
        state.fill_event_attribution("b", "a", Some("p2"), Some("p2"), Some("native"), None).unwrap();
        let row = state.event("b", "a").unwrap().unwrap();
        assert_eq!(
            (
                row.project_hash.as_deref(),
                row.project_key.as_deref(),
                row.project_basis.as_str(),
                row.surface.as_deref()
            ),
            (Some("p1"), Some("p1"), "working_directory", Some("cli"))
        );
        let mut without_project = event("none", 10);
        without_project.project_basis = "none".into();
        state.insert_event("b", &without_project).unwrap();
        state
            .fill_event_attribution(
                "b",
                "none",
                Some("ignored"),
                Some("ignored"),
                Some("working_directory"),
                None,
            )
            .unwrap();
        let without_project = state.event("b", "none").unwrap().unwrap();
        assert_eq!(without_project.project_basis, "none");
        assert_eq!(without_project.project_hash, None);
        assert_eq!(without_project.project_key, None);
        state.upsert_project("b", "p1", "/work/app", "2026-09-02T02:00:00Z").unwrap();
        state.upsert_project("b", "p1", "/work/app", "2026-09-01T00:00:00Z").unwrap();
        state.upsert_project("b", "p1", "/work/app", "2026-09-03T00:00:00Z").unwrap();
        let projects = state.projects("b").unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].first_seen, "2026-09-01T00:00:00Z");
        assert_eq!(projects[0].last_seen, "2026-09-03T00:00:00Z");
        assert!(state.projects("other").unwrap().is_empty());
    }

    #[test]
    fn records_pending_published_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let row = RecordRow {
            record_id: "r1".into(),
            binding_id: "b".into(),
            adapter: "claude_execution".into(),
            record_type: "allowance.reading".into(),
            semantic_key: "k".into(),
            content_hash: "h1".into(),
            published_hash: None,
            rejected_reason: None,
            record: "{}".into(),
            updated_at: "t".into(),
        };
        assert!(state.upsert_record(&row).unwrap());
        assert!(!state.upsert_record(&row).unwrap());
        assert_eq!(state.pending_records(10).unwrap().len(), 1);
        state.mark_record_published("r1", "h1").unwrap();
        assert!(state.pending_records(10).unwrap().is_empty());
        let revised = RecordRow { content_hash: "h2".into(), ..row.clone() };
        assert!(state.upsert_record(&revised).unwrap());
        assert_eq!(state.pending_records(10).unwrap().len(), 1);
        state.mark_record_rejected("r1", "invalid").unwrap();
        assert!(state.pending_records(10).unwrap().is_empty());
        assert_eq!(state.record_counts().unwrap(), (1, 0, 1));
    }

    #[test]
    fn tool_events_merge_replays_and_stronger_outcomes_without_adding_calls() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let invocation = ToolEventRow {
            id: "1".repeat(64),
            timestamp: "2026-09-04T00:00:00Z".into(),
            event_kind: "invocation".into(),
            invocation_key: "1".repeat(64),
            session_hash: Some("2".repeat(64)),
            caller_request_key: None,
            caller_agent_key: Some("3".repeat(64)),
            caller_is_subagent: false,
            parent_invocation_key: None,
            class: "builtin".into(),
            name: Some("Read".into()),
            name_hash: Some("h:1234567890abcdef".into()),
            namespace: None,
            namespace_hash: None,
            outcome: "succeeded".into(),
            name_truncated: false,
        };
        let result = ToolEventRow {
            id: "4".repeat(64),
            timestamp: "2026-09-04T00:00:01Z".into(),
            event_kind: "result".into(),
            class: "unknown".into(),
            name: None,
            name_hash: None,
            outcome: "failed".into(),
            ..invocation.clone()
        };
        state.upsert_tool_event("b", &result).unwrap();
        state.upsert_tool_event("b", &invocation).unwrap();
        state.upsert_tool_event("b", &invocation).unwrap();
        assert_eq!(state.tool_events("b").unwrap().len(), 2);
        assert_eq!(
            state.tool_invocation("b", &invocation.invocation_key).unwrap().unwrap().outcome,
            "failed"
        );
        assert_eq!(state.tool_event("b", &result.id).unwrap().unwrap().name.as_deref(), Some("Read"));
        let request_key = "5".repeat(64);
        state
            .assign_tool_caller_request("b", std::slice::from_ref(&invocation.invocation_key), &request_key)
            .unwrap();
        assert!(
            state
                .tool_events("b")
                .unwrap()
                .iter()
                .all(|row| row.caller_request_key.as_deref() == Some(request_key.as_str()))
        );
        state.mark_tool_coverage("b", true, false).unwrap();
        state.mark_tool_coverage("b", false, true).unwrap();
        assert_eq!(
            state.tool_coverage("b").unwrap(),
            ToolCoverageRow { unmapped_forms: true, truncated_names: true }
        );
    }

    fn access(id: &str, kind: &str, basis: &str) -> ResourceAccessRow {
        ResourceAccessRow {
            id: id.repeat(64),
            timestamp: "2026-09-04T00:00:05Z".into(),
            invocation_key: "1".repeat(64),
            resource_key: "alpha-src".into(),
            configuration_version: "cfg:0123456789abcdef".into(),
            access_kind: kind.into(),
            evidence_basis: basis.into(),
            nested_overlap: false,
        }
    }

    #[test]
    fn resource_accesses_merge_by_precedence_within_one_generation() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        state.upsert_resource_access("b", &access("a", "search", "indirect_shell")).unwrap();
        state
            .upsert_resource_access(
                "b",
                &ResourceAccessRow {
                    timestamp: "2026-09-04T00:00:01Z".into(),
                    nested_overlap: true,
                    ..access("a", "read", "explicit_argument")
                },
            )
            .unwrap();
        // Weaker evidence and a later timestamp never replace stronger, earlier facts.
        state
            .upsert_resource_access(
                "b",
                &ResourceAccessRow {
                    timestamp: "2026-09-04T00:00:09Z".into(),
                    configuration_version: "cfg:fedcba9876543210".into(),
                    ..access("a", "unknown", "unknown")
                },
            )
            .unwrap();
        let rows = state.resource_accesses("b").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (
                rows[0].timestamp.as_str(),
                rows[0].access_kind.as_str(),
                rows[0].evidence_basis.as_str(),
                rows[0].nested_overlap,
                rows[0].configuration_version.as_str()
            ),
            ("2026-09-04T00:00:01Z", "read", "explicit_argument", true, "cfg:fedcba9876543210")
        );
        state.upsert_resource_access("b", &access("a", "write", "indirect_shell")).unwrap();
        assert_eq!(state.resource_accesses("b").unwrap()[0].access_kind, "write");
        assert_eq!(state.resource_accesses("b").unwrap()[0].evidence_basis, "explicit_argument");
        assert!(state.resource_accesses("other").unwrap().is_empty());

        state.upsert_resource_access("b", &access("c", "read", "connector")).unwrap();
        state
            .upsert_resource_access(
                "b",
                &ResourceAccessRow { resource_key: "beta-src".into(), ..access("d", "read", "connector") },
            )
            .unwrap();
        let counts = state.resource_access_counts("b").unwrap();
        assert_eq!(
            counts
                .iter()
                .map(|count| (
                    count.resource_key.as_str(),
                    count.access_kind.as_str(),
                    count.evidence_basis.as_str(),
                    count.rows
                ))
                .collect::<Vec<_>>(),
            vec![
                ("alpha-src", "read", "connector", 1),
                ("alpha-src", "write", "explicit_argument", 1),
                ("beta-src", "read", "connector", 1)
            ]
        );
    }

    #[test]
    fn resource_inspections_keep_the_most_informative_class_and_count_by_class() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "no_evidence", false).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "unmatched", false).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "unresolved", false).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "unsupported", false).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "ambiguous", false).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "matched", true).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "no_evidence", false).unwrap();
        state.upsert_resource_inspection("b", "inv-2", "unmatched", false).unwrap();
        state.upsert_resource_inspection("b", "inv-2", "no_evidence", false).unwrap();
        state.upsert_resource_inspection("b", "inv-3", "unsupported", false).unwrap();
        state.upsert_resource_inspection("b", "inv-3", "unsupported", false).unwrap();
        state.upsert_resource_inspection("b", "inv-4", "matched", false).unwrap();
        let counts = state.resource_inspection_counts("b").unwrap();
        assert_eq!(
            counts,
            ResourceInspectionCounts {
                matched: 2,
                unmatched: 1,
                no_evidence: 0,
                unresolved: 0,
                unsupported: 1,
                ambiguous: 0,
                overlapping: 1,
            }
        );
        assert_eq!(counts.inspected(), 4);
        assert_eq!(state.resource_inspection_counts("other").unwrap(), ResourceInspectionCounts::default());
    }

    #[test]
    fn a_new_scan_generation_purges_resource_rows_with_the_checkpoints() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let checkpoint = FileCheckpoint {
            path: "history.jsonl".into(),
            size: 10,
            mtime_ns: 20,
            inode: "file-1".into(),
            offset: 10,
            context: "{}".into(),
        };
        state.save_file_checkpoint("b", &checkpoint).unwrap();
        state.upsert_resource_access("b", &access("a", "read", "explicit_argument")).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "matched", false).unwrap();
        state.save_file_checkpoint("other", &checkpoint).unwrap();
        state.upsert_resource_access("other", &access("a", "read", "explicit_argument")).unwrap();
        state.upsert_resource_inspection("other", "inv-1", "matched", false).unwrap();

        assert!(state.prepare_file_scan_with_purge("b", "parser-1:resources=x").unwrap());
        assert_eq!(state.file_count("b").unwrap(), 0);
        assert!(state.resource_accesses("b").unwrap().is_empty());
        assert_eq!(state.resource_inspection_counts("b").unwrap().inspected(), 0);
        // Another binding's rows and checkpoints are untouched.
        assert_eq!(state.file_count("other").unwrap(), 1);
        assert_eq!(state.resource_accesses("other").unwrap().len(), 1);

        // The same generation keeps what the replay has rebuilt so far.
        state.save_file_checkpoint("b", &checkpoint).unwrap();
        state.upsert_resource_access("b", &access("a", "read", "explicit_argument")).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "matched", false).unwrap();
        assert!(!state.prepare_file_scan_with_purge("b", "parser-1:resources=x").unwrap());
        assert_eq!(state.file_count("b").unwrap(), 1);
        assert_eq!(state.resource_accesses("b").unwrap().len(), 1);
        assert_eq!(state.resource_inspection_counts("b").unwrap().matched, 1);

        // The plain form leaves resource rows alone for callers that own none.
        assert!(state.prepare_file_scan("b", "parser-2").unwrap());
        assert_eq!(state.file_count("b").unwrap(), 0);
        assert_eq!(state.resource_accesses("b").unwrap().len(), 1);
    }

    #[test]
    fn a_new_scan_generation_supersedes_queued_resource_records_until_re_emitted() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let row = |record_id: &str, record_type: &str, binding: &str| RecordRow {
            record_id: record_id.into(),
            binding_id: binding.into(),
            adapter: "claude_execution".into(),
            record_type: record_type.into(),
            semantic_key: record_id.into(),
            content_hash: "h1".into(),
            published_hash: None,
            rejected_reason: None,
            record: "{}".into(),
            updated_at: "t".into(),
        };
        state.upsert_record(&row("res-1", "resource.access", "b")).unwrap();
        state.upsert_record(&row("res-2", "resource.access", "b")).unwrap();
        state.upsert_record(&row("tool-1", "tool.event", "b")).unwrap();
        state.upsert_record(&row("res-other", "resource.access", "other")).unwrap();

        // A parser bump replays the binding: queued resource records are held back until the
        // replay proves the access still exists; other record types and bindings are untouched.
        assert!(state.prepare_file_scan_with_purge("b", "parser-2:resources=x").unwrap());
        let reason = |id: &str| state.record(id).unwrap().unwrap().rejected_reason;
        assert_eq!(reason("res-1").as_deref(), Some(SUPERSEDED_CONFIGURATION));
        assert_eq!(reason("res-2").as_deref(), Some(SUPERSEDED_CONFIGURATION));
        assert_eq!(reason("tool-1"), None);
        assert_eq!(reason("res-other"), None);
        let pending: Vec<String> =
            state.pending_records(100).unwrap().into_iter().map(|r| r.record_id).collect();
        assert_eq!(pending, vec!["res-other", "tool-1"]);

        // The replay re-emits one access unchanged: it uploads again; the other stays held.
        assert!(state.upsert_record(&row("res-1", "resource.access", "b")).unwrap());
        assert_eq!(reason("res-1"), None);
        assert_eq!(reason("res-2").as_deref(), Some(SUPERSEDED_CONFIGURATION));
    }

    #[test]
    fn resource_config_tokens_are_random_hex_and_stable_per_digest() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let digest = "a".repeat(64);
        let token = state.resource_config_token(&digest).unwrap();
        assert_eq!(token.len(), 16);
        assert!(token.chars().all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch)));
        assert_eq!(state.resource_config_token(&digest).unwrap(), token);
        assert_eq!(state.assigned_resource_config_token(&digest).unwrap().as_deref(), Some(token.as_str()));
        assert_ne!(state.resource_config_token(&"b".repeat(64)).unwrap(), token);
        assert_eq!(state.assigned_resource_config_token(&"c".repeat(64)).unwrap(), None);
        // Another install seeing the same digest gets its own token: nothing is derived from the digest.
        let other = State::open(&dir.path().join("other.sqlite3")).unwrap();
        assert_ne!(other.resource_config_token(&digest).unwrap(), token);
        drop(other);

        let listing = State::open_read_only(&dir.path().join("s.sqlite3")).unwrap();
        assert_eq!(listing.assigned_resource_config_token(&digest).unwrap().as_deref(), Some(token.as_str()));
        assert!(listing.upsert_resource_inspection("b", "inv", "matched", false).is_err());
        assert!(State::open_read_only(&dir.path().join("missing.sqlite3")).is_err());
    }

    #[test]
    fn privacy_key_is_random_per_state_file_and_stable_across_opens() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        assert!(!state.has_privacy_key().unwrap());
        let key = state.privacy_key().unwrap();
        assert!(state.has_privacy_key().unwrap());
        assert_eq!(state.privacy_key().unwrap(), key);
        assert_eq!(state.meta("privacy_salt").unwrap().as_deref(), Some(key.to_hex().as_str()));
        drop(state);
        assert_eq!(State::open(&dir.path().join("s.sqlite3")).unwrap().privacy_key().unwrap(), key);
        let other = State::open(&dir.path().join("other.sqlite3")).unwrap();
        assert_ne!(other.privacy_key().unwrap(), key);
        let listing = State::open_read_only(&dir.path().join("s.sqlite3")).unwrap();
        assert!(listing.has_privacy_key().unwrap());
    }

    #[test]
    fn creating_the_privacy_key_rekeys_stored_project_keys_and_tool_hashes() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        // Rows as a build without a key stored them: plain digests of the path and name.
        let old_project = crate::pyjson::digest(&serde_json::json!(["project", "/work/app"]));
        state.upsert_project("b", old_project.as_str(), "/work/app", "2026-09-02T02:00:00Z").unwrap();
        let mut keyed = event("keyed", 1);
        keyed.project_hash = Some(old_project.as_str().to_owned());
        keyed.project_key = keyed.project_hash.clone();
        keyed.project_basis = "working_directory".into();
        state.insert_event("b", &keyed).unwrap();
        let mut orphan = event("orphan", 1);
        orphan.project_hash = Some("9".repeat(64));
        orphan.project_key = orphan.project_hash.clone();
        orphan.project_basis = "working_directory".into();
        state.insert_event("b", &orphan).unwrap();
        state.insert_event("b", &event("none", 1)).unwrap();
        let tool = ToolEventRow {
            id: "1".repeat(64),
            timestamp: "2026-09-04T00:00:00Z".into(),
            event_kind: "invocation".into(),
            invocation_key: "1".repeat(64),
            session_hash: None,
            caller_request_key: None,
            caller_agent_key: None,
            caller_is_subagent: false,
            parent_invocation_key: None,
            class: "mcp".into(),
            name: Some("search".into()),
            name_hash: Some("h:1234567890abcdef".into()),
            namespace: Some("vault".into()),
            namespace_hash: Some("h:abcdef1234567890".into()),
            outcome: "succeeded".into(),
            name_truncated: false,
        };
        state.upsert_tool_event("b", &tool).unwrap();
        let nameless = ToolEventRow {
            id: "2".repeat(64),
            invocation_key: "2".repeat(64),
            class: "unknown".into(),
            name: None,
            namespace: None,
            namespace_hash: None,
            ..tool.clone()
        };
        state.upsert_tool_event("b", &nameless).unwrap();

        let key = state.privacy_key().unwrap();
        let expected = project_key(&key, "/work/app");
        let projects = state.projects("b").unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(
            (projects[0].project_hash.as_str(), projects[0].path.as_str()),
            (expected.as_str(), "/work/app")
        );
        let keyed = state.event("b", "keyed").unwrap().unwrap();
        assert_eq!(keyed.project_key.as_deref(), Some(expected.as_str()));
        assert_eq!(keyed.project_hash.as_deref(), Some(expected.as_str()));
        assert_eq!(keyed.project_basis, "working_directory");
        let orphan = state.event("b", "orphan").unwrap().unwrap();
        assert_eq!(
            (orphan.project_key, orphan.project_hash, orphan.project_basis.as_str()),
            (None, None, "unknown")
        );
        let none = state.event("b", "none").unwrap().unwrap();
        assert_eq!((none.project_key, none.project_basis.as_str()), (None, "unknown"));
        let tools = state.tool_events("b").unwrap();
        let rekeyed = tools.iter().find(|row| row.id == tool.id).unwrap();
        assert_eq!(
            rekeyed.name_hash.as_deref(),
            Some(tool_name_hash(&key, Some("vault"), "search").as_str())
        );
        assert_eq!(rekeyed.namespace_hash.as_deref(), Some(tool_namespace_hash(&key, "vault").as_str()));
        let nameless = tools.iter().find(|row| row.id == nameless.id).unwrap();
        assert_eq!((nameless.name_hash.as_deref(), nameless.namespace_hash.as_deref()), (None, None));
        // A second call changes nothing.
        assert_eq!(state.privacy_key().unwrap(), key);
        assert_eq!(state.projects("b").unwrap()[0].project_hash, expected.as_str());
    }

    #[test]
    fn superseded_resource_records_return_when_re_emitted() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let row = RecordRow {
            record_id: "r1".into(),
            binding_id: "b".into(),
            adapter: "claude_execution".into(),
            record_type: "resource.access".into(),
            semantic_key: "k".into(),
            content_hash: "h1".into(),
            published_hash: None,
            rejected_reason: None,
            record: "{}".into(),
            updated_at: "t".into(),
        };
        assert!(state.upsert_record(&row).unwrap());
        state.mark_record_rejected("r1", SUPERSEDED_CONFIGURATION).unwrap();
        assert!(state.pending_records(10).unwrap().is_empty());
        // The same content re-emitted (a key re-added with identical roots) lifts the mark.
        assert!(state.upsert_record(&row).unwrap());
        assert_eq!(state.pending_records(10).unwrap().len(), 1);
        assert_eq!(state.record("r1").unwrap().unwrap().rejected_reason, None);
        // A server rejection survives revisions as before.
        state.mark_record_rejected("r1", "invalid").unwrap();
        assert!(state.upsert_record(&RecordRow { content_hash: "h2".into(), ..row.clone() }).unwrap());
        assert_eq!(state.record("r1").unwrap().unwrap().rejected_reason.as_deref(), Some("invalid"));
        assert!(!state.upsert_record(&RecordRow { content_hash: "h2".into(), ..row }).unwrap());
    }

    #[test]
    fn version_six_state_gains_resource_storage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite3");
        drop(State::open(&path).unwrap());
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "DROP TABLE local_resource_accesses;
                 DROP TABLE local_resource_inspections;
                 UPDATE meta SET value = '6' WHERE key = 'schema_version';",
            )
            .unwrap();
        }
        let state = State::open(&path).unwrap();
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("8"));
        state.upsert_resource_access("b", &access("a", "read", "explicit_argument")).unwrap();
        state.upsert_resource_inspection("b", "inv-1", "matched", false).unwrap();
        assert_eq!(state.resource_accesses("b").unwrap().len(), 1);
        assert_eq!(state.resource_inspection_counts("b").unwrap().matched, 1);
        drop(state);
        State::open(&path).unwrap();
    }

    #[test]
    fn version_seven_state_gains_allowance_quarantine() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite3");
        drop(State::open(&path).unwrap());
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "DROP TABLE allowance_quarantine;
                 UPDATE meta SET value = '7' WHERE key = 'schema_version';",
            )
            .unwrap();
        }
        let state = State::open(&path).unwrap();
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("8"));
        assert!(state.has_column("allowance_quarantine", "candidate_binding_id").unwrap());
        assert!(state.quarantine_sample("s1", "{}", Some("h"), "unpaired_identity", "t", None).unwrap());
        assert!(
            state
                .quarantine_sample("s2", "{}", None, "identity_unconfirmed", "t", Some("binding-a"))
                .unwrap()
        );
        let held = state.quarantined_samples().unwrap();
        assert_eq!(held.len(), 2);
        assert_eq!(held[0].candidate_binding_id, None);
        assert_eq!(held[1].candidate_binding_id.as_deref(), Some("binding-a"));
        drop(state);
        State::open(&path).unwrap();

        // An unreleased version 8 file written before the candidate column existed gains it.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "DROP TABLE allowance_quarantine;
                 CREATE TABLE allowance_quarantine (slot TEXT PRIMARY KEY, payload TEXT NOT NULL,
                   identity_hash TEXT, reason TEXT NOT NULL, stored_at TEXT NOT NULL);
                 INSERT INTO allowance_quarantine VALUES ('s3', '{}', NULL, 'identity_ambiguous', 't');",
            )
            .unwrap();
        }
        let state = State::open(&path).unwrap();
        assert!(state.has_column("allowance_quarantine", "candidate_binding_id").unwrap());
        let held = state.quarantined_samples().unwrap();
        assert_eq!(held.len(), 1);
        assert_eq!((held[0].slot.as_str(), held[0].candidate_binding_id.as_deref()), ("s3", None));
        drop(state);
        State::open(&path).unwrap();
    }

    #[test]
    fn the_replay_check_is_an_index_lookup_on_both_tables() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        state.upsert_allowance_slot("binding-a", "slot-1", "{}").unwrap();
        state.quarantine_sample("slot-2", "{}", None, "identity_ambiguous", "t", None).unwrap();
        assert!(state.allowance_slot_exists_anywhere("slot-1").unwrap(), "a stored slot");
        assert!(state.allowance_slot_exists_anywhere("slot-2").unwrap(), "a held slot");
        assert!(!state.allowance_slot_exists_anywhere("slot-3").unwrap());
        let mut statement = state
            .conn
            .prepare(
                "EXPLAIN QUERY PLAN
                 SELECT EXISTS(SELECT 1 FROM allowance_slots WHERE slot = ?1)
                     OR EXISTS(SELECT 1 FROM allowance_quarantine WHERE slot = ?1)",
            )
            .unwrap();
        let plan: Vec<String> = statement
            .query_map(params!["slot-1"], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            plan.iter().any(|step| step.contains("allowance_slots_slot")),
            "the slot probe uses the slot index: {plan:?}"
        );
        assert!(
            plan.iter().any(|step| step.contains("allowance_quarantine") && step.contains("INDEX")),
            "the quarantine probe uses its primary key: {plan:?}"
        );
        // The only scan is the constant outer row; neither table is scanned.
        assert!(
            !plan.iter().any(|step| step.starts_with("SCAN") && step.contains("allowance")),
            "no table scan: {plan:?}"
        );
    }

    #[test]
    fn quarantined_samples_are_held_released_and_pruned_apart_from_slots() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        let payload = |observed: &str| {
            format!(
                r#"{{"window_key":"five_hour","observed_at":"{observed}","used_percent":10,"raw_window_id":"five_hour"}}"#
            )
        };
        let hash_a = "a".repeat(64);
        let hash_b = "b".repeat(64);
        let hold = |slot: &str, observed: &str, hash: Option<&str>, reason: &str, stored: &str| {
            state.quarantine_sample(slot, &payload(observed), hash, reason, stored, None).unwrap()
        };
        assert!(hold(
            "paired",
            "2026-09-01T01:00:00Z",
            Some(&hash_a),
            "unpaired_identity",
            "2026-09-01T01:00:00.000Z"
        ));
        assert!(
            !hold(
                "paired",
                "2026-09-01T01:00:00Z",
                Some(&hash_a),
                "unpaired_identity",
                "2026-09-01T01:00:00.000Z"
            ),
            "a held slot is written once"
        );
        hold(
            "orphan",
            "2026-09-01T02:00:00Z",
            Some(&hash_b),
            "unpaired_identity",
            "2026-09-01T02:00:00.000Z",
        );
        hold("unstamped", "2026-09-01T03:00:00Z", None, "identity_ambiguous", "2026-09-01T03:00:00.000Z");
        hold("recent", "2026-09-10T03:00:00Z", None, "identity_unconfirmed", "2026-09-10T03:00:00.000Z");

        // Held rows are invisible to the emitters and to the slot table.
        assert!(state.dirty_allowance_slots("binding-a").unwrap().is_empty());
        assert!(state.allowance_slot_exists_anywhere("paired").unwrap());
        assert!(!state.allowance_slot_exists_anywhere("elsewhere").unwrap());
        assert_eq!(
            state.quarantine_counts().unwrap(),
            BTreeMap::from([
                ("identity_ambiguous".to_owned(), 1),
                ("identity_unconfirmed".to_owned(), 1),
                ("unpaired_identity".to_owned(), 2)
            ])
        );
        state.requarantine("recent", "identity_ambiguous").unwrap();
        assert_eq!(state.quarantine_counts().unwrap()["identity_ambiguous"], 2);

        // Release moves the row into the binding's slots, dirty, and drops the hold.
        state.release_quarantined("paired", "binding-a").unwrap();
        let dirty = state.dirty_allowance_slots("binding-a").unwrap();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].0, "paired");
        assert_eq!(state.quarantined_samples().unwrap().len(), 3);
        assert!(state.allowance_slot_exists_anywhere("paired").unwrap());
        assert_eq!(
            state.newest_allowance_observed_at("binding-a").unwrap().as_deref(),
            Some("2026-09-01T01:00:00Z")
        );
        assert_eq!(state.newest_allowance_observed_at("binding-b").unwrap(), None);

        // Pruning keeps a stale row whose stamp still pairs with a binding.
        let removed = state.prune_quarantine("2026-09-08T00:00:00.000Z", &[hash_b.clone()]).unwrap();
        assert_eq!(removed, 1, "the unstamped stale row goes; the pairable one and the recent one stay");
        let held: Vec<String> =
            state.quarantined_samples().unwrap().into_iter().map(|row| row.slot).collect();
        assert_eq!(held, vec!["orphan", "recent"]);
        assert_eq!(state.prune_quarantine("2026-09-08T00:00:00.000Z", &[]).unwrap(), 1);
        assert_eq!(state.quarantined_samples().unwrap().len(), 1);
    }

    #[test]
    fn outbox_order_and_receipts() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        assert!(state.enqueue_outbox("h2", "{}", "t").unwrap());
        assert!(state.enqueue_outbox("h1", "{}", "t").unwrap());
        assert!(!state.enqueue_outbox("h1", "{}", "t").unwrap());
        let rows = state.outbox().unwrap();
        assert_eq!(rows.iter().map(|r| r.hash.as_str()).collect::<Vec<_>>(), ["h2", "h1"]);
        state.save_receipt("h2", "now", "{}").unwrap();
        state.delete_outbox("h2").unwrap();
        assert_eq!(state.outbox_len().unwrap(), 1);
        assert_eq!(state.last_receipt_at().unwrap().as_deref(), Some("now"));
    }

    fn tool_row(id: &str, invocation_key: &str, kind: &str, request: Option<&str>) -> ToolEventRow {
        ToolEventRow {
            id: id.repeat(64),
            timestamp: "2026-09-04T00:00:00Z".into(),
            event_kind: kind.into(),
            invocation_key: invocation_key.repeat(64),
            session_hash: None,
            caller_request_key: request.map(str::to_owned),
            caller_agent_key: None,
            caller_is_subagent: false,
            parent_invocation_key: None,
            class: "builtin".into(),
            name: Some("Read".into()),
            name_hash: None,
            namespace: None,
            namespace_hash: None,
            outcome: "unknown".into(),
            name_truncated: false,
        }
    }

    #[test]
    fn every_write_path_stamps_the_current_change_generation() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        assert_eq!(state.change_generation().unwrap(), None);
        // Before a run ever advanced the generation, writes read as generation 0.
        state.insert_event("b", &event("e0", 1)).unwrap();
        assert_eq!(state.advance_change_generation().unwrap(), 1);
        state.insert_event("b", &event("e1", 1)).unwrap();
        state.upsert_tool_event("b", &tool_row("1", "1", "invocation", Some("e1"))).unwrap();
        state.upsert_tool_event("b", &tool_row("2", "2", "invocation", None)).unwrap();
        assert_eq!(state.changed_event_ids("b", 0).unwrap(), HashSet::from(["e1".to_owned()]));
        assert_eq!(state.changed_event_ids("b", 1).unwrap(), HashSet::new());
        assert_eq!(state.changed_tool_events("b", 0).unwrap().len(), 2);

        assert_eq!(state.advance_change_generation().unwrap(), 2);
        // A plain UPDATE, an upsert that touches an existing row, and a cascade
        // through another row all re-stamp what they change.
        state.update_event_tokens("b", "e0", [1, 1, 1, 1]).unwrap();
        state.upsert_tool_event("b", &tool_row("2", "2", "invocation", None)).unwrap();
        // A result for invocation 1 revises the invocation row's outcome as well.
        let mut result = tool_row("3", "1", "result", None);
        result.outcome = "failed".into();
        state.upsert_tool_event("b", &result).unwrap();
        assert_eq!(state.changed_event_ids("b", 1).unwrap(), HashSet::from(["e0".to_owned()]));
        let changed = state.changed_tool_events("b", 1).unwrap();
        let mut ids: Vec<_> = changed.iter().map(|row| row.id.chars().next().unwrap()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ['1', '2', '3']);
        assert_eq!(
            changed.iter().find(|row| row.id.starts_with('1')).unwrap().caller_request_key.as_deref(),
            Some("e1")
        );
        // Assigning a caller request is also an update the trigger sees.
        assert_eq!(state.advance_change_generation().unwrap(), 3);
        state.assign_tool_caller_request("b", &["2".repeat(64)], "e0").unwrap();
        let changed = state.changed_tool_events("b", 2).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].caller_request_key.as_deref(), Some("e0"));
        assert!(state.changed_event_ids("b", 2).unwrap().is_empty());
        assert!(state.changed_event_ids("other", 0).unwrap().is_empty());
    }

    #[test]
    fn an_older_file_gains_the_change_stamp_and_its_rows_read_as_generation_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sqlite3");
        {
            let conn = Connection::open(&path).unwrap();
            let mut schema = SCHEMA.replace(", change_generation INTEGER NOT NULL DEFAULT 0", "");
            schema = schema.replace("\n  change_generation INTEGER NOT NULL DEFAULT 0,", "");
            assert!(!schema.contains("change_generation"));
            conn.execute_batch(&schema).unwrap();
            conn.execute_batch("INSERT INTO meta VALUES ('schema_version', '8')").unwrap();
            conn.execute(
                "INSERT INTO local_tool_events (binding_id, id, timestamp, event_kind, invocation_key, class, outcome)
                 VALUES ('b', 'old', 't', 'invocation', 'k', 'builtin', 'unknown')",
                [],
            )
            .unwrap();
        }
        let state = State::open(&path).unwrap();
        for table in CHANGE_STAMPED_TABLES {
            assert!(state.has_column(table, "change_generation").unwrap(), "{table}");
        }
        assert_eq!(state.changed_tool_events("b", -1).unwrap().len(), 1);
        assert!(state.changed_tool_events("b", 0).unwrap().is_empty());
        assert_eq!(state.advance_change_generation().unwrap(), 1);
        state.upsert_tool_event("b", &tool_row("9", "9", "invocation", None)).unwrap();
        assert_eq!(state.changed_tool_events("b", 0).unwrap().len(), 1);
    }

    #[test]
    fn published_hashes_cover_exactly_one_binding_and_record_keys_one_type() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("s.sqlite3")).unwrap();
        state.set_published("b:one", "h1").unwrap();
        state.set_published("b:two", "h2").unwrap();
        state.set_published("b;three", "h3").unwrap();
        state.set_published("bb:four", "h4").unwrap();
        state.set_published("a:five", "h5").unwrap();
        let hashes = state.published_hashes("b").unwrap();
        assert_eq!(
            hashes,
            HashMap::from([("b:one".to_owned(), "h1".to_owned()), ("b:two".to_owned(), "h2".to_owned())])
        );
        assert_eq!(state.published_hashes("bb").unwrap().len(), 1);
        assert!(state.published_hashes("c").unwrap().is_empty());

        let row = |id: &str, record_type: &str, key: &str| RecordRow {
            record_id: id.into(),
            binding_id: "b".into(),
            adapter: "claude_execution".into(),
            record_type: record_type.into(),
            semantic_key: key.into(),
            content_hash: "c".into(),
            published_hash: None,
            rejected_reason: None,
            record: "{}".into(),
            updated_at: "t".into(),
        };
        state.upsert_record(&row("r1", "activity.request", "k1")).unwrap();
        state.upsert_record(&row("r2", "activity.request", "k2")).unwrap();
        state.upsert_record(&row("r3", "tool.event", "k3")).unwrap();
        assert_eq!(
            state.record_semantic_keys("b", "claude_execution", "activity.request").unwrap(),
            HashSet::from(["k1".to_owned(), "k2".to_owned()])
        );
        assert_eq!(state.record_semantic_keys("b", "codex_execution", "activity.request").unwrap().len(), 0);
        assert_eq!(state.record_semantic_keys("b", "claude_execution", "tool.event").unwrap().len(), 1);
    }
}
