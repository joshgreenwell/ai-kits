//! Read-only access to Cursor's `state.vscdb`. Item values that can hold a
//! token are read only through the dedicated token helper; conversation bodies
//! are never loaded — token fields are extracted in SQLite.

use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;

use jiff::Timestamp;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use thiserror::Error;

use crate::config::Secret;
use crate::credentials::CredentialPresence;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CursorStoreError {
    #[error("the Cursor state database could not be opened")]
    Open,
    #[error("the Cursor state database could not be read")]
    Read,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CursorAuthIdentity {
    pub user_id: Option<String>,
    pub label: Option<String>,
}

/// One bubble's counters plus the timestamps the store keeps for it. Every
/// time here comes from the store itself (the bubble's `createdAt`, written as
/// an ISO-8601 string or epoch milliseconds, and the owning composer's
/// integer-millisecond `createdAt` / `lastUpdatedAt`), never from the clock of
/// the run that read it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CursorComposerUsage {
    pub composer_id: String,
    pub bubble_id: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    /// The bubble's own `createdAt`, as epoch milliseconds.
    pub created_at_ms: Option<i64>,
    /// The owning composer's `createdAt` (`composerData:<composer_id>`).
    pub composer_created_at_ms: Option<i64>,
    /// The owning composer's `lastUpdatedAt`, when the build stores one.
    pub composer_updated_at_ms: Option<i64>,
    pub model: Option<String>,
}

impl CursorComposerUsage {
    /// The stable observation time of this bubble: its own `createdAt`, else
    /// the composer's `createdAt`. `None` means the store holds no time for
    /// it at all; a caller must then skip it rather than substitute a clock.
    pub fn observed_at_ms(&self) -> Option<i64> {
        self.created_at_ms.or(self.composer_created_at_ms)
    }

    /// Whether any counter is a positive number. Current Cursor builds write
    /// `tokenCount` with every field zero for most bubbles; those rows prove a
    /// bubble exists and nothing about its usage.
    pub fn has_token_evidence(&self) -> bool {
        [self.input_tokens, self.output_tokens, self.cache_read_tokens, self.cache_write_tokens]
            .into_iter()
            .flatten()
            .any(|count| count > 0)
    }
}

/// A composer's own timestamps, read from `composerData:<composer_id>`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ComposerTimes {
    created_at_ms: Option<i64>,
    updated_at_ms: Option<i64>,
}

fn open_read_only(path: &Path) -> Result<Connection, CursorStoreError> {
    let flags =
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI;
    let conn = Connection::open_with_flags(path, flags).map_err(|_| CursorStoreError::Open)?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|_| CursorStoreError::Open)?;
    Ok(conn)
}

fn item_extract(conn: &Connection, key: &str, path: &str) -> Result<Option<String>, CursorStoreError> {
    let mut statement = conn
        .prepare("SELECT json_extract(value, ?2) FROM ItemTable WHERE key = ?1")
        .map_err(|_| CursorStoreError::Read)?;
    let mut rows = statement.query(rusqlite::params![key, path]).map_err(|_| CursorStoreError::Read)?;
    match rows.next().map_err(|_| CursorStoreError::Read)? {
        Some(row) => nonempty_text(cell_text(row, 0)?),
        None => Ok(None),
    }
}

/// Current Cursor builds store `cursorAuth/<field>` as a raw scalar, not a JSON object.
fn item_scalar(conn: &Connection, key: &str) -> Result<Option<String>, CursorStoreError> {
    let mut statement = conn
        .prepare(
            "SELECT CASE
                WHEN json_valid(value) AND json_type(value) IN ('text', 'integer')
                    THEN CAST(json_extract(value, '$') AS TEXT)
                WHEN json_valid(value) THEN NULL
                ELSE CAST(value AS TEXT)
             END
             FROM ItemTable WHERE key = ?1",
        )
        .map_err(|_| CursorStoreError::Read)?;
    let mut rows = statement.query([key]).map_err(|_| CursorStoreError::Read)?;
    match rows.next().map_err(|_| CursorStoreError::Read)? {
        Some(row) => nonempty_text(cell_text(row, 0)?),
        None => Ok(None),
    }
}

fn first_scalar(conn: &Connection, keys: &[&str]) -> Result<Option<String>, CursorStoreError> {
    for key in keys {
        if let Some(value) = item_scalar(conn, key)? {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

fn nonempty_text(value: Option<String>) -> Result<Option<String>, CursorStoreError> {
    Ok(value.filter(|text| !text.is_empty()))
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, CursorStoreError> {
    let mut statement = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1")
        .map_err(|_| CursorStoreError::Read)?;
    statement.exists([name]).map_err(|_| CursorStoreError::Read)
}

/// Non-secret Cursor sign-in fields used for identity display and hashing.
pub fn cursor_auth_identity(path: &Path) -> Result<CursorAuthIdentity, CursorStoreError> {
    let conn = open_read_only(path)?;
    if !table_exists(&conn, "ItemTable")? {
        return Ok(CursorAuthIdentity::default());
    }
    let user_id = item_extract(&conn, "cursorAuth", "$.userId")?
        .or(item_extract(&conn, "cursorAuth", "$.cachedUserId")?)
        .or(first_scalar(
            &conn,
            &[
                "cursorAuth/cachedUserId",
                "cursorAuth/userId",
                "adminSettings.cachedAuthId",
                "glass.lastSignedInAuthId",
                "cursorAuth/stripeMembershipAuthId",
            ],
        )?);
    let label = item_extract(&conn, "cursorAuth", "$.cachedEmail")?
        .or(first_scalar(&conn, &["cursorAuth/cachedEmail"])?);
    Ok(CursorAuthIdentity { user_id, label })
}

pub fn cursor_credential_presence(path: &Path) -> CredentialPresence {
    match cursor_auth_identity(path) {
        Ok(identity) if identity.user_id.is_some() => CredentialPresence::Present { expires_at: None },
        Ok(_) => CredentialPresence::Missing,
        Err(CursorStoreError::Open) => CredentialPresence::Missing,
        Err(_) => CredentialPresence::Unknown,
    }
}

/// Cursor's session access token, used for one hosted request and then dropped.
pub fn cursor_access_token(path: &Path) -> Result<Option<Secret>, CursorStoreError> {
    let conn = open_read_only(path)?;
    if !table_exists(&conn, "ItemTable")? {
        return Ok(None);
    }
    let token = item_extract(&conn, "cursorAuth", "$.accessToken")?
        .or(first_scalar(&conn, &["cursorAuth/accessToken"])?);
    Ok(token.map(Secret::new))
}

/// Per-composer and per-bubble token counters. Message bodies are not loaded.
pub fn cursor_local_usage(path: &Path) -> Result<(u64, Vec<CursorComposerUsage>), CursorStoreError> {
    let conn = open_read_only(path)?;
    if !table_exists(&conn, "cursorDiskKV")? {
        return Ok((0, Vec::new()));
    }
    let bytes = conn
        .query_row("SELECT coalesce(sum(length(value)), 0) FROM cursorDiskKV WHERE key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0);
    let composers = composer_times(&conn)?;
    let mut rows = Vec::new();
    let mut statement = conn
        .prepare(
            "SELECT key,
                    json_extract(value, '$.tokenCount.inputTokens'),
                    json_extract(value, '$.tokenCount.outputTokens'),
                    json_extract(value, '$.tokenCount.cacheReadTokens'),
                    json_extract(value, '$.tokenCount.cacheWriteTokens'),
                    json_extract(value, '$.createdAt'),
                    json_extract(value, '$.modelInfo.modelName')
             FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'",
        )
        .map_err(|_| CursorStoreError::Read)?;
    let mut query = statement.query([]).map_err(|_| CursorStoreError::Read)?;
    while let Some(row) = query.next().map_err(|_| CursorStoreError::Read)? {
        let key: String = row.get(0).map_err(|_| CursorStoreError::Read)?;
        let Some((composer_id, bubble_id)) = bubble_parts(&key) else { continue };
        let input = cell_i64(row, 1)?;
        let output = cell_i64(row, 2)?;
        let cache_read = cell_i64(row, 3)?;
        let cache_write = cell_i64(row, 4)?;
        if input.is_none() && output.is_none() && cache_read.is_none() && cache_write.is_none() {
            continue;
        }
        let composer = composers.get(&composer_id).copied().unwrap_or_default();
        rows.push(CursorComposerUsage {
            composer_id,
            bubble_id: Some(bubble_id),
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            created_at_ms: cell_timestamp_ms(row, 5)?,
            composer_created_at_ms: composer.created_at_ms,
            composer_updated_at_ms: composer.updated_at_ms,
            model: cell_text(row, 6)?,
        });
    }
    Ok((u64::try_from(bytes.max(0)).unwrap_or(0), rows))
}

/// Each composer's `createdAt` and `lastUpdatedAt`, extracted in SQLite so the
/// conversation body under the same key is never loaded.
fn composer_times(conn: &Connection) -> Result<HashMap<String, ComposerTimes>, CursorStoreError> {
    let mut statement = conn
        .prepare(
            "SELECT key, json_extract(value, '$.createdAt'), json_extract(value, '$.lastUpdatedAt')
             FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
        )
        .map_err(|_| CursorStoreError::Read)?;
    let mut query = statement.query([]).map_err(|_| CursorStoreError::Read)?;
    let mut composers = HashMap::new();
    while let Some(row) = query.next().map_err(|_| CursorStoreError::Read)? {
        let key: String = row.get(0).map_err(|_| CursorStoreError::Read)?;
        let Some(composer_id) = key.strip_prefix("composerData:").filter(|id| !id.is_empty()) else {
            continue;
        };
        let times = ComposerTimes {
            created_at_ms: cell_timestamp_ms(row, 1)?,
            updated_at_ms: cell_timestamp_ms(row, 2)?,
        };
        if times != ComposerTimes::default() {
            composers.insert(composer_id.to_owned(), times);
        }
    }
    Ok(composers)
}

fn bubble_parts(key: &str) -> Option<(String, String)> {
    let rest = key.strip_prefix("bubbleId:")?;
    let (composer, bubble) = rest.split_once(':')?;
    if composer.is_empty() || bubble.is_empty() {
        return None;
    }
    Some((composer.to_owned(), bubble.to_owned()))
}

fn cell_i64(row: &rusqlite::Row<'_>, idx: usize) -> Result<Option<i64>, CursorStoreError> {
    match row.get_ref(idx).map_err(|_| CursorStoreError::Read)? {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(n) => Ok(Some(n)),
        ValueRef::Real(n) if n.is_finite() => Ok(Some(n.trunc() as i64)),
        ValueRef::Text(bytes) => Ok(std::str::from_utf8(bytes).ok().and_then(|text| text.parse().ok())),
        _ => Ok(None),
    }
}

/// A store timestamp as epoch milliseconds. Cursor writes a bubble's
/// `createdAt` as an ISO-8601 string in current builds and as epoch
/// milliseconds in older ones; composer times are integer milliseconds. Text
/// that is neither an integer nor a parseable timestamp reads as absent.
fn cell_timestamp_ms(row: &rusqlite::Row<'_>, idx: usize) -> Result<Option<i64>, CursorStoreError> {
    match row.get_ref(idx).map_err(|_| CursorStoreError::Read)? {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(n) => Ok(Some(n)),
        ValueRef::Real(n) if n.is_finite() => Ok(Some(n.trunc() as i64)),
        ValueRef::Text(bytes) => Ok(std::str::from_utf8(bytes).ok().and_then(timestamp_text_ms)),
        _ => Ok(None),
    }
}

fn timestamp_text_ms(text: &str) -> Option<i64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(millis) = trimmed.parse::<i64>() {
        return Some(millis);
    }
    Timestamp::from_str(trimmed).ok().map(|at| at.as_millisecond())
}

fn cell_text(row: &rusqlite::Row<'_>, idx: usize) -> Result<Option<String>, CursorStoreError> {
    match row.get_ref(idx).map_err(|_| CursorStoreError::Read)? {
        ValueRef::Null => Ok(None),
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes);
            Ok((!text.is_empty()).then(|| text.into_owned()))
        }
        ValueRef::Integer(n) => Ok(Some(n.to_string())),
        ValueRef::Real(n) => Ok(Some(n.to_string())),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);
             CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ItemTable(key, value) VALUES ('cursorAuth', ?1)",
            [json!({"userId":"user-1","cachedEmail":"synthetic@example.test","accessToken":"SECRET-CURSOR"})
                .to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cursorDiskKV(key, value) VALUES ('bubbleId:comp-1:bubble-1', ?1)",
            [json!({
                "type": 2,
                "text": "SECRET-PROMPT",
                "tokenCount": {"inputTokens": 12, "outputTokens": 4, "cacheReadTokens": 3},
                "createdAt": 1_725_000_000_000i64
            })
            .to_string()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cursorDiskKV(key, value) VALUES ('composerData:comp-2', ?1)",
            [json!({"usageData":{"gemini-2.5-pro":{"amount": 9, "costInCents": 2}}}).to_string()],
        )
        .unwrap();
        (dir, path)
    }

    /// The shape current Cursor builds write: bubble `createdAt` as an ISO-8601
    /// string or absent, `tokenCount` present with zero fields, and the
    /// composer's own integer-millisecond `createdAt` / `lastUpdatedAt`.
    fn current_build_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);
             CREATE TABLE cursorDiskKV (key TEXT UNIQUE, value BLOB);",
        )
        .unwrap();
        let rows = [
            (
                "composerData:comp-1",
                json!({"composerId": "comp-1", "text": "SECRET-COMPOSER", "createdAt": 1_735_600_170_253i64,
                       "lastUpdatedAt": 1_735_600_999_000i64, "usageData": {"auto": {"amount": 2, "costInCents": 0}}}),
            ),
            (
                "bubbleId:comp-1:iso",
                json!({"type": 2, "text": "SECRET-PROMPT", "createdAt": "2025-12-31T00:10:00.500Z",
                       "tokenCount": {"inputTokens": 5728, "outputTokens": 191}}),
            ),
            (
                "bubbleId:comp-1:no-created-at",
                json!({"type": 2, "text": "SECRET-PROMPT", "tokenCount": {"inputTokens": 15124, "outputTokens": 2436}}),
            ),
            (
                "bubbleId:comp-1:zero",
                json!({"type": 2, "text": "SECRET-PROMPT", "createdAt": "2025-12-31T00:11:00.000Z",
                       "tokenCount": {"inputTokens": 0, "outputTokens": 0}}),
            ),
            (
                "bubbleId:comp-1:no-token-count",
                json!({"type": 1, "text": "SECRET-PROMPT", "createdAt": "2025-12-31T00:12:00.000Z"}),
            ),
            (
                "bubbleId:comp-orphan:no-time",
                json!({"type": 2, "text": "SECRET-PROMPT", "tokenCount": {"inputTokens": 7, "outputTokens": 1}}),
            ),
            (
                "bubbleId:comp-orphan:epoch",
                json!({"type": 2, "text": "SECRET-PROMPT", "createdAt": 1_725_000_000_000i64,
                       "tokenCount": {"inputTokens": 3, "outputTokens": 1}}),
            ),
        ];
        for (key, value) in rows {
            conn.execute("INSERT INTO cursorDiskKV(key, value) VALUES (?1, ?2)", [key, &value.to_string()])
                .unwrap();
        }
        (dir, path)
    }

    fn split_key_fixture() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.vscdb");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB);").unwrap();
        for (key, value) in [
            ("cursorAuth/accessToken", "SECRET-CURSOR-SPLIT"),
            ("cursorAuth/cachedEmail", "synthetic@example.test"),
            ("adminSettings.cachedAuthId", "auth_01SYNTHETICUSERIDVALUE"),
        ] {
            conn.execute("INSERT INTO ItemTable(key, value) VALUES (?1, ?2)", [key, value]).unwrap();
        }
        (dir, path)
    }

    #[test]
    fn identity_and_token_are_separate_and_bodies_are_not_retained() {
        let (_dir, path) = fixture();
        let identity = cursor_auth_identity(&path).unwrap();
        assert_eq!(identity.user_id.as_deref(), Some("user-1"));
        assert_eq!(identity.label.as_deref(), Some("synthetic@example.test"));
        let token = cursor_access_token(&path).unwrap().unwrap();
        assert_eq!(token.expose(), "SECRET-CURSOR");
        assert!(!format!("{token:?}").contains("SECRET"));
        let (bytes, usage) = cursor_local_usage(&path).unwrap();
        assert!(bytes > 0);
        assert_eq!(usage.len(), 1, "composer usageData cost amounts are not tokens");
        let bubble = usage.iter().find(|row| row.bubble_id.as_deref() == Some("bubble-1")).unwrap();
        assert_eq!(bubble.input_tokens, Some(12));
        assert_eq!(bubble.output_tokens, Some(4));
        assert_eq!(bubble.cache_read_tokens, Some(3));
        assert!(format!("{usage:?}").contains("comp-1"));
        assert!(!format!("{usage:?}").contains("SECRET-PROMPT"));
    }

    #[test]
    fn bubble_times_come_from_the_store_and_fall_back_to_the_composer() {
        let (_dir, path) = current_build_fixture();
        let (_bytes, usage) = cursor_local_usage(&path).unwrap();
        let row = |bubble: &str| usage.iter().find(|row| row.bubble_id.as_deref() == Some(bubble)).unwrap();
        assert!(!format!("{usage:?}").contains("SECRET"), "no body or composer text is retained");
        assert!(
            usage.iter().all(|row| row.bubble_id.as_deref() != Some("no-token-count")),
            "a bubble without any counter is not a usage row"
        );

        // An ISO-8601 bubble `createdAt` is the observation time.
        let iso = row("iso");
        assert_eq!(iso.created_at_ms, Some(1_767_139_800_500));
        assert_eq!(iso.composer_created_at_ms, Some(1_735_600_170_253));
        assert_eq!(iso.composer_updated_at_ms, Some(1_735_600_999_000));
        assert_eq!(iso.observed_at_ms(), Some(1_767_139_800_500));
        assert!(iso.has_token_evidence());

        // Without a bubble time the composer's own `createdAt` stands in.
        let composer_time = row("no-created-at");
        assert_eq!(composer_time.created_at_ms, None);
        assert_eq!(composer_time.observed_at_ms(), Some(1_735_600_170_253));

        // All-zero counters are a bubble without usage evidence.
        let zero = row("zero");
        assert_eq!(zero.observed_at_ms(), Some(1_767_139_860_000));
        assert!(!zero.has_token_evidence());

        // Neither time: the store holds nothing to observe it at.
        let orphan = row("no-time");
        assert_eq!(orphan.composer_created_at_ms, None);
        assert_eq!(orphan.observed_at_ms(), None);

        // Older builds wrote epoch milliseconds.
        assert_eq!(row("epoch").observed_at_ms(), Some(1_725_000_000_000));
    }

    #[test]
    fn timestamp_text_accepts_millis_and_rfc3339_only() {
        assert_eq!(timestamp_text_ms("1725000000000"), Some(1_725_000_000_000));
        assert_eq!(timestamp_text_ms(" 2024-08-30T07:06:40Z "), Some(1_725_001_600_000));
        assert_eq!(timestamp_text_ms("2024-08-30T07:06:40.250+00:00"), Some(1_725_001_600_250));
        assert_eq!(timestamp_text_ms(""), None);
        assert_eq!(timestamp_text_ms("yesterday"), None);
        assert_eq!(timestamp_text_ms("2024-08-30"), None, "a bare date has no instant");
    }

    #[test]
    fn split_cursor_auth_keys_are_read_as_raw_scalars() {
        let (_dir, path) = split_key_fixture();
        let identity = cursor_auth_identity(&path).unwrap();
        assert_eq!(identity.user_id.as_deref(), Some("auth_01SYNTHETICUSERIDVALUE"));
        assert_eq!(identity.label.as_deref(), Some("synthetic@example.test"));
        let token = cursor_access_token(&path).unwrap().unwrap();
        assert_eq!(token.expose(), "SECRET-CURSOR-SPLIT");
        assert!(!format!("{token:?}").contains("SECRET"));
    }

    #[test]
    fn live_cursor_db_when_requested() {
        if std::env::var("OBSERVATORY_LIVE_SOURCES").ok().as_deref() != Some("1") {
            return;
        }
        let path = crate::paths::cursor_state_db().expect("cursor state path");
        assert!(path.is_file(), "missing {}", path.display());
        let identity = cursor_auth_identity(&path).unwrap();
        let user_id = identity.user_id.as_deref().expect("split-key or blob user id");
        assert!(user_id.len() >= 8);
        let token = cursor_access_token(&path).unwrap().expect("access token");
        assert!(token.expose().len() > 20);
        assert!(!format!("{token:?}").contains(token.expose()));
        let (bytes, usage) = cursor_local_usage(&path).unwrap();
        let with_input = usage.iter().filter(|row| row.input_tokens.unwrap_or(0) > 0).count();
        eprintln!(
            "live_cursor_store user_id_len={} email_present={} token_len={} bytes={} usage_rows={} with_input={}",
            user_id.len(),
            identity.label.as_deref().is_some_and(|label| label.contains('@')),
            token.expose().len(),
            bytes,
            usage.len(),
            with_input
        );
        assert!(bytes > 0);
        assert!(with_input > 0, "bubble tokenCount.inputTokens rows");
    }
}
