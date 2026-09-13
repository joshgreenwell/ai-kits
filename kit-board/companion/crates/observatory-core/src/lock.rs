//! The single-run lock: SQLite `BEGIN IMMEDIATE` on `<install-id>.lock`, held
//! for the run. The operating system releases it on a crash. This is the v1
//! behavior, kept so a v1 collector and the companion never scan concurrently
//! against the same lock file either.

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, ErrorCode};

use crate::state::StateError;

/// Holds the lock until dropped.
#[derive(Debug)]
pub struct RunLock {
    _connection: Connection,
}

/// Tries to take the lock. `Ok(None)` means another run holds it.
pub fn acquire(path: &Path) -> Result<Option<RunLock>, StateError> {
    if let Some(parent) = path.parent() {
        crate::paths::ensure_private_dir(parent)?;
    }
    let connection = Connection::open(path)?;
    connection.busy_timeout(Duration::from_secs(1))?;
    crate::state::restrict_file(path)?;
    match connection.execute_batch("BEGIN IMMEDIATE") {
        Ok(()) => Ok(Some(RunLock { _connection: connection })),
        Err(rusqlite::Error::SqliteFailure(error, _))
            if matches!(error.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) =>
        {
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_holder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.lock");
        let first = acquire(&path).unwrap();
        assert!(first.is_some());
        assert!(acquire(&path).unwrap().is_none());
        drop(first);
        assert!(acquire(&path).unwrap().is_some());
    }
}
