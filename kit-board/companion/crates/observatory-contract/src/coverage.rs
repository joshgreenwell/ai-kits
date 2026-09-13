//! Per-adapter coverage for one run. Codes only; never free text.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::enums::{Adapter, CapabilityDimension, CapabilityState, CoverageState, CursorState, DetailCode};
use crate::envelope::Violation;
use crate::newtypes::{Code, Counter, Nullable, Text};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityCoverage {
    pub dimension: CapabilityDimension,
    pub state: CapabilityState,
    pub detail_code: Nullable<Code>,
}

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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::newtypes::deserialize_optional_non_null"
    )]
    pub capabilities: Option<Vec<CapabilityCoverage>>,
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
            capabilities: None,
        }
    }

    pub fn validate(&self, path: &str, out: &mut Vec<Violation>) {
        let Some(capabilities) = &self.capabilities else {
            return;
        };
        if capabilities.len() > 7 {
            out.push(Violation { path: format!("{path}.capabilities"), rule: "at most 7 capabilities" });
        }
        let mut dimensions = HashSet::new();
        if capabilities.iter().any(|capability| !dimensions.insert(capability.dimension)) {
            out.push(Violation {
                path: format!("{path}.capabilities"),
                rule: "capability dimensions must be unique",
            });
        }
    }
}
