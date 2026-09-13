//! Local state (section 2.7): SQLite `<install-id>.sqlite3`, `0600`.
//!
//! `CREATE TABLE IF NOT EXISTS` with `meta.schema_version` for forward
//! migrations. A companion state database is a new file; no v1 state is
//! migrated in place. Every table holds counters, hashes, checkpoints, and
//! bounded raw observations; never conversation text.

use std::io;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use thiserror::Error;

pub const SCHEMA_VERSION: &str = "2";

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
CREATE TABLE IF NOT EXISTS events (binding_id TEXT NOT NULL, id TEXT NOT NULL, session TEXT NOT NULL,
  hour TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, session_identity TEXT NOT NULL,
  timestamp TEXT NOT NULL, product TEXT NOT NULL, client_version TEXT, parent_session TEXT,
  project_hash TEXT, surface TEXT,
  PRIMARY KEY (binding_id, id));
CREATE INDEX IF NOT EXISTS event_hours ON events(binding_id, hour, session, model);
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

/// One counted provider event (a Codex `token_count` or a Claude assistant
/// message), keyed by its v1 event digest.
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

    /// Forward migrations. Version 1 predates project attribution: its `events`
    /// table lacks `project_hash` and `surface`, which `CREATE TABLE IF NOT EXISTS`
    /// cannot add. Every step is idempotent, so an interrupted upgrade resumes.
    fn migrate(&self) -> Result<(), StateError> {
        if self.meta("schema_version")?.as_deref() == Some("1") {
            for column in ["project_hash", "surface"] {
                if !self.has_column("events", column)? {
                    self.conn.execute(&format!("ALTER TABLE events ADD COLUMN {column} TEXT"), [])?;
                }
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

    // --- events -------------------------------------------------------------

    pub fn event(&self, binding: &str, id: &str) -> Result<Option<EventRow>, StateError> {
        Ok(self
            .conn
            .query_row(
                "SELECT id, session, hour, model, input_tokens, cached_tokens, cache_write_tokens, output_tokens,
                        session_identity, timestamp, product, client_version, parent_session, project_hash, surface
                   FROM events WHERE binding_id = ?1 AND id = ?2",
                params![binding, id],
                event_from_row,
            )
            .optional()?)
    }

    pub fn insert_event(&self, binding: &str, row: &EventRow) -> Result<(), StateError> {
        self.conn.execute(
            "INSERT INTO events (binding_id, id, session, hour, model, input_tokens, cached_tokens, cache_write_tokens,
                                 output_tokens, session_identity, timestamp, product, client_version, parent_session,
                                 project_hash, surface)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                row.surface
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
        let mut statement = self.conn.prepare(
            "SELECT session, hour, model, sum(input_tokens), sum(cached_tokens), sum(cache_write_tokens),
                    sum(output_tokens), count(*)
               FROM events WHERE binding_id = ?1 GROUP BY session, hour, model ORDER BY hour, session, model",
        )?;
        let rows = statement.query_map(params![binding], |row| {
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
                    session_identity, timestamp, product, client_version, parent_session, project_hash, surface
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
        let mut statement = self.conn.prepare(
            "SELECT record_id, binding_id, adapter, record_type, semantic_key, content_hash, published_hash,
                    rejected_reason, record, updated_at
               FROM records
              WHERE rejected_reason IS NULL AND (published_hash IS NULL OR published_hash <> content_hash)
              ORDER BY updated_at, record_id LIMIT ?1",
        )?;
        let rows = statement.query_map(params![limit as i64], record_from_row)?;
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
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("2"));
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
        assert_eq!(state.meta("schema_version").unwrap().as_deref(), Some("2"));
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
