//! Per-adapter coverage for one run. Codes only; never free text.

use serde::{Deserialize, Serialize};

use crate::enums::{Adapter, CoverageState, CursorState, DetailCode};
use crate::newtypes::{Counter, Nullable, Text};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterCoverage {
    pub adapter: Adapter,
    pub state: CoverageState,
    /// Bounded code from the closed list, never free text.
    pub detail_code: Nullable<DetailCode>,
    pub stores_discovered: Counter,
    pub files: Counter,
    pub bytes_read: Counter,
    pub records_emitted: Counter,
    pub malformed: Counter,
    pub rejected_by_server: Counter,
    pub duration_ms: Counter,
    pub cursor_state: CursorState,
    pub probe_requests: Counter,
    pub parser_version: Text<0, 30>,
}

impl AdapterCoverage {
    /// Coverage for an adapter that did not run, with the reason as a state and code.
    pub fn not_running(
        adapter: Adapter,
        state: CoverageState,
        detail: Option<DetailCode>,
        parser_version: Text<0, 30>,
    ) -> Self {
        AdapterCoverage {
            adapter,
            state,
            detail_code: Nullable(detail),
            stores_discovered: Counter::ZERO,
            files: Counter::ZERO,
            bytes_read: Counter::ZERO,
            records_emitted: Counter::ZERO,
            malformed: Counter::ZERO,
            rejected_by_server: Counter::ZERO,
            duration_ms: Counter::ZERO,
            cursor_state: CursorState::Unknown,
            probe_requests: Counter::ZERO,
            parser_version,
        }
    }
}
