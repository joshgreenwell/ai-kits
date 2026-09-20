//! Read-only access to Cursor's `state.vscdb`. Item values that can hold a
//! token are read only through the dedicated token helper; conversation bodies
//! are never loaded — token fields are extracted in SQLite.

use std::path::Path;

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

#[derive(Clone, Debug, PartialEq)]
pub struct CursorComposerUsage {
    pub composer_id: String,
    pub bubble_id: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub created_at_ms: Option<i64>,
    pub model: Option<String>,
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
        rows.push(CursorComposerUsage {
            composer_id,
            bubble_id: Some(bubble_id),
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            created_at_ms: cell_i64(row, 5)?,
            model: cell_text(row, 6)?,
        });
    }
    Ok((u64::try_from(bytes.max(0)).unwrap_or(0), rows))
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
