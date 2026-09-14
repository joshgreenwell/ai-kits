//! What this build can actually do, posted to `POST /api/v1/companion/capabilities`
//! (`lib/companion-capabilities.ts` is the authority). Every field is a closed code,
//! flag, bounded count, id, or date; the document never carries a path, a host, a
//! credential, or a hash of any of them. Both sides check the fixtures under
//! `tests/fixtures/usage-v2/capabilities/`.

use serde::{Deserialize, Serialize};

use crate::enums::{Adapter, Arch, Platform};
use crate::newtypes::{Code, Counter, IsoDate, Lit, MachineId, ModePath, Nullable, Sha256Hex, Text, Uuid};

macro_rules! closed {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text),+
                }
            }
        }
    };
}

closed! { Scheduler { Launchd = "launchd", TaskScheduler = "task_scheduler", Systemd = "systemd" } }
closed! {
    /// The installed schedule as the companion read it back.
    ScheduleState {
        NotInstalled = "not_installed",
        Installed = "installed",
        IntervalMismatch = "interval_mismatch",
        Unreadable = "unreadable",
    }
}
closed! { ConfigSourceKind { Fetched = "fetched", Cached = "cached", Defaults = "defaults" } }
closed! {
    ResourceAttributionState {
        On = "on",
        NoResources = "no_resources",
        DeniedLocally = "denied_locally",
        DetailLevel = "detail_level",
    }
}
closed! { BindingIdentity { Confirmed = "confirmed", Unconfirmed = "unconfirmed", Changed = "changed" } }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildInfo {
    pub platform: Platform,
    pub arch: Arch,
    pub tls_roots: Code,
    pub state_schema_version: Code,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterCapability {
    pub adapter: Adapter,
    pub implemented: bool,
    /// The reader or mode codes this build actually runs for the adapter.
    pub modes: Vec<Code>,
    pub parser_version: Text<0, 30>,
    pub denied: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Features {
    pub detail_levels: Vec<Code>,
    pub tool_detail: Vec<Code>,
    pub project_attribution: Vec<Code>,
    pub resource_attribution: bool,
    pub include_subagents: bool,
    pub hooks: Vec<Code>,
    pub schedulers: Vec<Scheduler>,
    pub live_mode: bool,
    pub detailed_monthly_report: bool,
    pub account_history: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Readers {
    pub claude: Code,
    pub codex: Code,
    pub cursor: Code,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EffectiveSettings {
    pub settings_version_applied: Counter,
    pub config_source: ConfigSourceKind,
    pub paused: bool,
    pub cadence_minutes: Counter,
    pub detail_level: Code,
    pub tool_detail: Code,
    pub project_attribution: Code,
    pub include_subagents: bool,
    pub resource_attribution: ResourceAttributionState,
    pub resources_configured: Counter,
    pub readers: Readers,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Discovered {
    pub claude: bool,
    pub codex: bool,
    pub cursor: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindingCapability {
    pub binding_id: Uuid,
    pub identity: BindingIdentity,
    pub conflict: bool,
    pub roots_present: Counter,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DetailedReportCapability {
    pub binding_id: Uuid,
    pub configured: bool,
    pub machine_id: Nullable<MachineId>,
    pub last_status: Nullable<Code>,
    pub last_error_code: Nullable<Code>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleCapability {
    pub mechanism: Nullable<Scheduler>,
    pub state: ScheduleState,
    pub installed_interval_minutes: Nullable<Counter>,
    /// Whether the installed command pins `--config-dir` (every scheduler entry should).
    pub config_dir_pinned: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueueState {
    pub records_pending: Counter,
    pub records_rejected: Counter,
    pub outbox_envelopes: Counter,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackfillState {
    pub since: Nullable<IsoDate>,
    pub complete: bool,
    pub last_partial_adapter: Nullable<Adapter>,
}

/// The complete capability document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilitiesDocument {
    pub schema_version: Lit<1>,
    pub companion_version: Text<1, 30>,
    /// sha256 of the stable JSON of `adapters` and `features`: the build fingerprint.
    pub capabilities_digest: Sha256Hex,
    pub build: BuildInfo,
    pub adapters: Vec<AdapterCapability>,
    pub features: Features,
    pub effective: EffectiveSettings,
    /// Only entries `denied()` recognizes for some adapter; free text never leaves the machine.
    pub deny: Vec<ModePath>,
    pub deny_unrecognized: Counter,
    pub discovered: Discovered,
    pub bindings: Vec<BindingCapability>,
    pub detailed_report: Vec<DetailedReportCapability>,
    pub schedule: ScheduleCapability,
    pub queue: QueueState,
    pub backfill: BackfillState,
}

/// `POST /api/v1/companion/capabilities` response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilitiesResponse {
    pub ok: bool,
    pub capabilities_digest: Sha256Hex,
    pub reported_at: String,
}

impl CapabilitiesDocument {
    /// The size limits the server enforces beside the schema.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.adapters.len() > 11 {
            return Err("at most one row per adapter");
        }
        if self.deny.len() > 32 {
            return Err("at most 32 deny entries");
        }
        if self.bindings.len() > 50 || self.detailed_report.len() > 50 {
            return Err("at most 50 bindings");
        }
        if self.features.schedulers.len() > 3 {
            return Err("at most three schedulers");
        }
        let lists = [
            &self.features.detail_levels,
            &self.features.tool_detail,
            &self.features.project_attribution,
            &self.features.hooks,
        ];
        if lists.iter().any(|list| list.len() > 8) || self.adapters.iter().any(|row| row.modes.len() > 8) {
            return Err("at most eight codes per list");
        }
        Ok(())
    }
}
