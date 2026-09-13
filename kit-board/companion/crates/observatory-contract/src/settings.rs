//! The collection settings document (`lib/companion-settings.ts`, section 1.4).
//!
//! A setting can only turn a mode on or off within this schema. It can never
//! name a path, an endpoint, or a command; the install treats the document as
//! data.

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::enums::{Adapter, Provider};
use crate::newtypes::{Lit, ValueError};

macro_rules! int_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $value:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(try_from = "u64", into = "u64")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            pub const fn get(self) -> u64 {
                match self {
                    $($name::$variant => $value),+
                }
            }
        }

        impl TryFrom<u64> for $name {
            type Error = ValueError;
            fn try_from(value: u64) -> Result<Self, ValueError> {
                match value {
                    $($value => Ok($name::$variant),)+
                    _ => Err(ValueError::Literal(value)),
                }
            }
        }

        impl From<$name> for u64 {
            fn from(value: $name) -> u64 {
                value.get()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.get())
            }
        }
    };
}

int_enum! {
    /// Minutes between scheduled runs.
    Cadence { Fifteen = 15, Thirty = 30, Sixty = 60 }
}

int_enum! {
    /// Days the bounded raw observation store keeps a payload; 0 keeps none.
    Retention { Zero = 0, Seven = 7, Fourteen = 14, Thirty = 30 }
}

/// `lookback_days`: 1 through 90.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct LookbackDays(u64);

impl LookbackDays {
    pub fn new(days: u64) -> Result<Self, ValueError> {
        if (1..=90).contains(&days) { Ok(LookbackDays(days)) } else { Err(ValueError::Literal(days)) }
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl TryFrom<u64> for LookbackDays {
    type Error = ValueError;
    fn try_from(days: u64) -> Result<Self, ValueError> {
        LookbackDays::new(days)
    }
}

impl From<LookbackDays> for u64 {
    fn from(value: LookbackDays) -> u64 {
        value.0
    }
}

macro_rules! choice {
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

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

choice! { DetailLevel { BucketsOnly = "buckets_only", Requests = "requests", RequestsWithTools = "requests_with_tools" } }
choice! { ToolDetail { Off = "off", BuiltinOnly = "builtin_only", HashedCustom = "hashed_custom" } }
choice! { ProjectAttribution { Off = "off", Hashed = "hashed" } }
choice! {
    /// `oauth_usage` keeps the statusline as a passive fallback.
    ClaudeReader { Off = "off", Statusline = "statusline", OauthUsage = "oauth_usage" }
}
choice! { CodexReader { Off = "off", Embedded = "embedded", AppServer = "app_server", WebBackend = "web_backend" } }
choice! { CursorReader { Off = "off", UsageSummary = "usage_summary", DashboardRpc = "dashboard_rpc" } }
choice! {
    /// Never `auto`: the companion has no self-update code.
    UpdateNotice { Off = "off", Notify = "notify" }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderSwitches {
    pub claude: bool,
    pub codex: bool,
    pub cursor: bool,
    pub anthropic_api: bool,
    pub openai_api: bool,
}

impl ProviderSwitches {
    pub const fn get(&self, provider: Provider) -> bool {
        match provider {
            Provider::Claude => self.claude,
            Provider::Codex => self.codex,
            Provider::Cursor => self.cursor,
            Provider::AnthropicApi => self.anthropic_api,
            Provider::OpenaiApi => self.openai_api,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionSettings {
    pub claude_local_logs: bool,
    pub codex_local_history: bool,
    pub cursor_local_state: bool,
    pub include_subagents: bool,
    pub detail_level: DetailLevel,
    pub tool_detail: ToolDetail,
    pub project_attribution: ProjectAttribution,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AllowanceSettings {
    pub claude_reader: ClaudeReader,
    pub codex_reader: CodexReader,
    pub cursor_reader: CursorReader,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountHistorySettings {
    pub cursor_usage_events: bool,
    pub lookback_days: LookbackDays,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BillingSettings {
    pub anthropic_admin_api: bool,
    pub openai_admin_api: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HookSettings {
    pub claude_statusline: bool,
    pub cursor_project_hooks: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserSettings {
    pub claude_web: bool,
    pub chatgpt_web: bool,
    pub cursor_web: bool,
}

/// The complete settings document.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionSettings {
    pub schema_version: Lit<1>,
    /// Global kill switch.
    pub paused: bool,
    pub cadence_minutes: Cadence,
    pub providers: ProviderSwitches,
    pub execution: ExecutionSettings,
    pub allowance: AllowanceSettings,
    pub account_history: AccountHistorySettings,
    pub billing: BillingSettings,
    pub hooks: HookSettings,
    pub browser: BrowserSettings,
    /// The existing analyzer adapter, per install.
    pub detailed_monthly_report: bool,
    /// The `serve` subcommand; a later phase.
    pub live_mode: bool,
    pub local_raw_retention_days: Retention,
    pub update_notice: UpdateNotice,
}

/// A per-install override: the same keys, all optional. A present group
/// replaces the whole group.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<Lit<1>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cadence_minutes: Option<Cadence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<ProviderSwitches>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowance: Option<AllowanceSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_history: Option<AccountHistorySettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub billing: Option<BillingSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hooks: Option<HookSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<BrowserSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detailed_monthly_report: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_mode: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_raw_retention_days: Option<Retention>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_notice: Option<UpdateNotice>,
}

/// The server-side value of one adapter's mode, before local denies,
/// binding state, and prerequisites are applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gate {
    /// True when the provider switch and the adapter's own mode are both on.
    pub enabled: bool,
    /// Whether the provider switch alone is on; distinguishes `provider_disabled` from `mode_off`.
    pub provider_enabled: bool,
    /// The dotted setting path a local deny list entry matches, e.g. `allowance.claude_reader.oauth_usage`.
    pub mode_path: String,
}

impl Default for CollectionSettings {
    fn default() -> Self {
        CollectionSettings::defaults()
    }
}

impl CollectionSettings {
    /// The documented defaults. `providers.cursor` is on only when discovered and
    /// confirmed at setup; `browser.*` only when confirmed at pairing.
    pub fn defaults() -> Self {
        CollectionSettings {
            schema_version: Lit,
            paused: false,
            cadence_minutes: Cadence::Sixty,
            providers: ProviderSwitches {
                claude: true,
                codex: true,
                cursor: false,
                anthropic_api: false,
                openai_api: false,
            },
            execution: ExecutionSettings {
                claude_local_logs: true,
                codex_local_history: true,
                cursor_local_state: true,
                include_subagents: true,
                detail_level: DetailLevel::BucketsOnly,
                tool_detail: ToolDetail::BuiltinOnly,
                project_attribution: ProjectAttribution::Off,
            },
            allowance: AllowanceSettings {
                claude_reader: ClaudeReader::Statusline,
                codex_reader: CodexReader::AppServer,
                cursor_reader: CursorReader::Off,
            },
            account_history: AccountHistorySettings {
                cursor_usage_events: false,
                lookback_days: LookbackDays(30),
            },
            billing: BillingSettings { anthropic_admin_api: false, openai_admin_api: false },
            hooks: HookSettings { claude_statusline: true, cursor_project_hooks: false },
            browser: BrowserSettings { claude_web: false, chatgpt_web: false, cursor_web: false },
            detailed_monthly_report: false,
            live_mode: false,
            local_raw_retention_days: Retention::Fourteen,
            update_notice: UpdateNotice::Notify,
        }
    }

    /// Applies an install override on top of this document.
    pub fn merged(&self, over: &InstallOverride) -> CollectionSettings {
        CollectionSettings {
            schema_version: Lit,
            paused: over.paused.unwrap_or(self.paused),
            cadence_minutes: over.cadence_minutes.unwrap_or(self.cadence_minutes),
            providers: over.providers.clone().unwrap_or_else(|| self.providers.clone()),
            execution: over.execution.clone().unwrap_or_else(|| self.execution.clone()),
            allowance: over.allowance.clone().unwrap_or_else(|| self.allowance.clone()),
            account_history: over.account_history.clone().unwrap_or_else(|| self.account_history.clone()),
            billing: over.billing.clone().unwrap_or_else(|| self.billing.clone()),
            hooks: over.hooks.clone().unwrap_or_else(|| self.hooks.clone()),
            browser: over.browser.clone().unwrap_or_else(|| self.browser.clone()),
            detailed_monthly_report: over.detailed_monthly_report.unwrap_or(self.detailed_monthly_report),
            live_mode: over.live_mode.unwrap_or(self.live_mode),
            local_raw_retention_days: over.local_raw_retention_days.unwrap_or(self.local_raw_retention_days),
            update_notice: over.update_notice.unwrap_or(self.update_notice),
        }
    }

    /// The server-side gate for an adapter: provider switch AND the adapter's mode.
    pub fn gate(&self, adapter: Adapter) -> Gate {
        let provider_enabled = self.providers.get(adapter.provider());
        let (mode_on, mode_path) = match adapter {
            Adapter::ClaudeExecution => {
                (self.execution.claude_local_logs, "execution.claude_local_logs".to_owned())
            }
            Adapter::CodexExecution => {
                (self.execution.codex_local_history, "execution.codex_local_history".to_owned())
            }
            Adapter::CursorExecution => {
                (self.execution.cursor_local_state, "execution.cursor_local_state".to_owned())
            }
            Adapter::ClaudeAccount => (
                self.allowance.claude_reader == ClaudeReader::OauthUsage,
                format!("allowance.claude_reader.{}", self.allowance.claude_reader),
            ),
            Adapter::CodexAccount => (
                matches!(self.allowance.codex_reader, CodexReader::AppServer | CodexReader::WebBackend),
                format!("allowance.codex_reader.{}", self.allowance.codex_reader),
            ),
            Adapter::CursorAccount => (
                self.allowance.cursor_reader != CursorReader::Off || self.account_history.cursor_usage_events,
                format!("allowance.cursor_reader.{}", self.allowance.cursor_reader),
            ),
            Adapter::AnthropicApi => {
                (self.billing.anthropic_admin_api, "billing.anthropic_admin_api".to_owned())
            }
            Adapter::OpenaiApi => (self.billing.openai_admin_api, "billing.openai_admin_api".to_owned()),
            Adapter::ClaudeBrowser => (self.browser.claude_web, "browser.claude_web".to_owned()),
            Adapter::CodexBrowser => (self.browser.chatgpt_web, "browser.chatgpt_web".to_owned()),
            Adapter::CursorBrowser => (self.browser.cursor_web, "browser.cursor_web".to_owned()),
        };
        Gate { enabled: provider_enabled && mode_on && !self.paused, provider_enabled, mode_path }
    }
}

/// True when a local deny-list entry removes an adapter. An entry matches the
/// adapter id, its provider switch (`providers.<provider>`), its exact mode path,
/// or any dotted prefix of that path (`allowance.codex_reader` denies every
/// Codex reader). The deny list can only remove.
pub fn denied(entry: &str, adapter: Adapter, gate: &Gate) -> bool {
    if entry == adapter.as_str() || entry == format!("providers.{}", adapter.provider()) {
        return true;
    }
    gate.mode_path == entry || gate.mode_path.strip_prefix(entry).is_some_and(|rest| rest.starts_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_round_trip_and_reject_unknown_keys() {
        let text = serde_json::to_string(&CollectionSettings::defaults()).unwrap();
        let back: CollectionSettings = serde_json::from_str(&text).unwrap();
        assert_eq!(back, CollectionSettings::defaults());
        assert!(
            serde_json::from_str::<CollectionSettings>(&text.replace("\"paused\"", "\"pause\"")).is_err()
        );
        assert!(serde_json::from_str::<InstallOverride>(r#"{"roots":["/x"]}"#).is_err());
        assert!(serde_json::from_str::<InstallOverride>(r#"{"cadence_minutes":45}"#).is_err());
    }

    #[test]
    fn override_replaces_whole_groups() {
        let over: InstallOverride =
            serde_json::from_str(r#"{"paused":true,"allowance":{"claude_reader":"oauth_usage","codex_reader":"off","cursor_reader":"off"}}"#)
                .unwrap();
        let merged = CollectionSettings::defaults().merged(&over);
        assert!(merged.paused);
        assert_eq!(merged.allowance.claude_reader, ClaudeReader::OauthUsage);
        assert_eq!(merged.allowance.codex_reader, CodexReader::Off);
        assert_eq!(merged.cadence_minutes, Cadence::Sixty);
    }

    #[test]
    fn gates_and_denies() {
        let settings = CollectionSettings::defaults();
        assert!(settings.gate(Adapter::ClaudeExecution).enabled);
        assert!(!settings.gate(Adapter::ClaudeAccount).enabled);
        assert!(settings.gate(Adapter::CodexAccount).enabled);
        assert!(!settings.gate(Adapter::CursorExecution).enabled);
        assert!(!settings.gate(Adapter::CursorExecution).provider_enabled);
        let gate = settings.gate(Adapter::CodexAccount);
        assert_eq!(gate.mode_path, "allowance.codex_reader.app_server");
        assert!(denied("allowance.codex_reader.app_server", Adapter::CodexAccount, &gate));
        assert!(denied("allowance.codex_reader", Adapter::CodexAccount, &gate));
        assert!(denied("providers.codex", Adapter::CodexAccount, &gate));
        assert!(denied("codex_account", Adapter::CodexAccount, &gate));
        assert!(!denied("allowance.codex_reader.web_backend", Adapter::CodexAccount, &gate));
        assert!(
            !denied("allowance", Adapter::CodexAccount, &gate) || gate.mode_path.starts_with("allowance.")
        );
        let mut paused = CollectionSettings::defaults();
        paused.paused = true;
        assert!(!paused.gate(Adapter::ClaudeExecution).enabled);
    }
}
