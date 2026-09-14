//! Local state (section 2.7): SQLite `<install-id>.sqlite3`, `0600`.
//!
//! `CREATE TABLE IF NOT EXISTS` with `meta.schema_version` for forward
//! migrations. A companion state database is a new file; no v1 state is
//! migrated in place. Every table holds counters, hashes, checkpoints, and
//! bounded raw observations; never conversation text.

use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

pub const SCHEMA_VERSION: &str = "4";

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
  project_hash TEXT, surface TEXT, detail_observed INTEGER NOT NULL DEFAULT 0,
  bucket_eligible INTEGER NOT NULL DEFAULT 1, detail_input_fresh INTEGER,
  detail_input_cached INTEGER, detail_input_cache_write INTEGER, detail_output INTEGER,
  detail_reasoning INTEGER, reported_total INTEGER, model_requested TEXT,
  reasoning_effort TEXT, service_tier TEXT, speed TEXT, context_window_tokens INTEGER,
  cache_write_ttl TEXT, outcome TEXT, agent_observed INTEGER NOT NULL DEFAULT 0,
  agent_key TEXT, agent_identity_basis TEXT NOT NULL DEFAULT 'unknown', parent_agent_key TEXT,
  parent_agent_identity_basis TEXT NOT NULL DEFAULT 'unknown', agent_class TEXT NOT NULL DEFAULT 'unknown',
  agent_name TEXT, agent_depth INTEGER,
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
  outcome TEXT NOT NULL,
  PRIMARY KEY (binding_id, id));
CREATE TABLE IF NOT EXISTS projects (binding_id TEXT NOT NULL, project_hash TEXT NOT NULL, path TEXT NOT NULL,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (binding_id, project_hash));
CREATE TABLE IF NOT EXISTS allowance_slots (binding_id TEXT NOT NULL, slot TEXT NOT NULL, payload TEXT NOT NULL,
  dirty INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (binding_id, slot));
CREATE TABLE IF NOT EXISTS observations (record_id TEXT PRIMARY KEY, adapter TEXT NOT NULL,
  observed_at TEXT NOT NULL, payload TEXT NOT NULL, stored_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records (record_id TEXT PRIMARY KEY, binding_id TEXT NOT NULL, adapter TEXT NOT NULL,
  record_type TEXT NOT NULL, semantic_key TEXT NOT NULL, content_hash TEXT NOT NULL, published_hash TEXT,
  rejected_reason TEXT, record TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS records_pending ON records(rejected_reason, published_hash);
CREATE TABLE IF NOT EXISTS published (key TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (hash TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS receipts (hash TEXT PRIMARY KEY, received_at TEXT NOT NULL, receipt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
  summary TEXT NOT NULL);
";

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
    /// v2 only: `sha256(["project", cwd])` of the working directory the provider recorded.
    pub project_hash: Option<String>,
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

/// One working directory this binding has seen, kept locally so a hash can be
/// labeled. Never uploaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectRow {
    pub project_hash: String,
    pub path: String,
    pub first_seen: String,
    pub last_seen: String,
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
        conn.busy_timeout(Duration::from_secs(5))?;
        let _mode: String = conn.pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        let state = State { conn };
        state.migrate()?;
        Ok(state)
    }

    /// Forward migrations. Version 1 predates project attribution, version 2
    /// predates nullable request and pricing evidence, and version 3 predates
    /// agent attribution. Every step is idempotent, so an interrupted upgrade
    /// resumes.
    fn migrate(&self) -> Result<(), StateError> {
        let version = self.meta("schema_version")?;
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
        let key = format!("file_parser:{binding}");
        if self.meta(&key)?.as_deref() == Some(generation) {
            return Ok(false);
        }
        self.begin()?;
        let result = (|| {
            self.conn.execute("DELETE FROM files WHERE binding_id = ?1", params![binding])?;
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
                        session_identity, timestamp, product, client_version, parent_session, project_hash, surface,
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
                                 project_hash, surface, detail_observed, bucket_eligible, detail_input_fresh,
                                 detail_input_cached, detail_input_cache_write, detail_output, detail_reasoning,
                                 reported_total, model_requested, reasoning_effort, service_tier, speed,
                                 context_window_tokens, cache_write_ttl, outcome, agent_observed, agent_key,
                                 agent_identity_basis, parent_agent_key, parent_agent_identity_basis,
                                 agent_class, agent_name, agent_depth)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                     ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31,
                     ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?39)",
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
        surface: Option<&str>,
    ) -> Result<(), StateError> {
        self.conn.execute(
            "UPDATE events SET project_hash = coalesce(project_hash, ?3), surface = coalesce(surface, ?4)
              WHERE binding_id = ?1 AND id = ?2",
            params![binding, id, project_hash, surface],
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
                    session_identity, timestamp, product, client_version, parent_session, project_hash, surface,
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
                    session_identity, timestamp, product, client_version, parent_session, project_hash, surface,
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

    // --- records ------------------------------------------------------------

    /// Inserts or revises a record. Returns true when the stored content changed.
    /// Publication and rejection marks survive a revision.
    pub fn upsert_record(&self, row: &RecordRow) -> Result<bool, StateError> {
        let changed = self.conn.execute(
            "INSERT INTO records (record_id, binding_id, adapter, record_type, semantic_key, content_hash,
                                  published_hash, rejected_reason, record, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8)
             ON CONFLICT(record_id) DO UPDATE SET content_hash = excluded.content_hash, record = excluded.record,
                 semantic_key = excluded.semantic_key, updated_at = excluded.updated_at
             WHERE records.content_hash <> excluded.content_hash",
            params![
                row.record_id,
                row.binding_id,
                row.adapter,
                row.record_type,
                row.semantic_key,
                row.content_hash,
                row.record,
                row.updated_at
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
        surface: row.get(14)?,
        detail_observed: row.get(15)?,
        bucket_eligible: row.get(16)?,
        detail_input_fresh: row.get(17)?,
        detail_input_cached: row.get(18)?,
        detail_input_cache_write: row.get(19)?,
        detail_output: row.get(20)?,
        detail_reasoning: row.get(21)?,
        reported_total: row.get(22)?,
        model_requested: row.get(23)?,
        reasoning_effort: row.get(24)?,
        service_tier: row.get(25)?,
        speed: row.get(26)?,
        context_window_tokens: row.get(27)?,
        cache_write_ttl: row.get(28)?,
        outcome: row.get(29)?,
        agent_observed: row.get(30)?,
        agent_key: row.get(31)?,
        agent_identity_basis: row.get(32)?,
        parent_agent_key: row.get(33)?,
        parent_agent_identity_basis: row.get(34)?,
        agent_class: row.get(35)?,
        agent_name: row.get(36)?,
        agent_depth: row.get(37)?,
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
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("4"));
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
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("4"));
        let mut row = event("a", 10);
        row.project_hash = Some("h".repeat(64));
        row.surface = Some("desktop".into());
        state.insert_event("b", &row).unwrap();
        assert_eq!(state.event("b", "a").unwrap().unwrap(), row);
        // Reopening runs the idempotent step again without error.
        drop(state);
        State::open(&path).unwrap();
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
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("4"));
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
        state.fill_event_attribution("b", "a", Some("p1"), Some("cli")).unwrap();
        state.fill_event_attribution("b", "a", Some("p2"), None).unwrap();
        let row = state.event("b", "a").unwrap().unwrap();
        assert_eq!((row.project_hash.as_deref(), row.surface.as_deref()), (Some("p1"), Some("cli")));
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
}
