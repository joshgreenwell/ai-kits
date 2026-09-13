//! Closed string enumerations from the contract. Every `match` over them is
//! exhaustive by construction: adding a variant fails the build wherever it is
//! not handled.

use std::fmt;
use std::str::FromStr;

use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("unknown {kind} value {value:?}")]
pub struct UnknownVariant {
    pub kind: &'static str,
    pub value: String,
}

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident = $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, serde::Serialize, serde::Deserialize)]
        pub enum $name {
            $($(#[$vmeta])* #[serde(rename = $text)] $variant),+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub const fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $text),+
                }
            }
        }

        impl FromStr for $name {
            type Err = UnknownVariant;
            fn from_str(text: &str) -> Result<Self, UnknownVariant> {
                match text {
                    $($text => Ok($name::$variant),)+
                    _ => Err(UnknownVariant { kind: stringify!($name), value: text.to_owned() }),
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

string_enum! {
    /// Which integration produced a record.
    Adapter {
        ClaudeExecution = "claude_execution",
        ClaudeAccount = "claude_account",
        CodexExecution = "codex_execution",
        CodexAccount = "codex_account",
        CursorAccount = "cursor_account",
        CursorExecution = "cursor_execution",
        AnthropicApi = "anthropic_api",
        OpenaiApi = "openai_api",
        ClaudeBrowser = "claude_browser",
        CodexBrowser = "codex_browser",
        CursorBrowser = "cursor_browser",
    }
}

string_enum! {
    /// How the install reached the data.
    Channel {
        LocalFile = "local_file",
        LocalDb = "local_db",
        AppServer = "app_server",
        ProviderApi = "provider_api",
        HookSnapshot = "hook_snapshot",
        BrowserSession = "browser_session",
    }
}

string_enum! {
    Provider {
        Claude = "claude",
        Codex = "codex",
        Cursor = "cursor",
        AnthropicApi = "anthropic_api",
        OpenaiApi = "openai_api",
    }
}

string_enum! {
    InstallKind {
        Companion = "companion",
        Browser = "browser",
    }
}

string_enum! {
    /// How trustworthy the numbers in a record are.
    Basis {
        Exact = "exact",
        Reported = "reported",
        Estimated = "estimated",
        Unknown = "unknown",
    }
}

string_enum! {
    Surface {
        Cli = "cli",
        Ide = "ide",
        Desktop = "desktop",
        Sdk = "sdk",
        Ci = "ci",
        Cloud = "cloud",
        Unknown = "unknown",
    }
}

string_enum! {
    ExecutionHost {
        Local = "local",
        Cloud = "cloud",
        SelfHosted = "self_hosted",
        Unknown = "unknown",
    }
}

string_enum! {
    /// Where a session id came from. A synthetic session never outranks another.
    SessionIdentity {
        Provider = "provider",
        Derived = "derived",
        Synthetic = "synthetic",
    }
}

string_enum! {
    RequestOutcome {
        Completed = "completed",
        Failed = "failed",
        Cancelled = "cancelled",
        Unknown = "unknown",
    }
}

string_enum! {
    AllowanceKind {
        PercentUsed = "percent_used",
        CountRemaining = "count_remaining",
        CreditsRemaining = "credits_remaining",
        CurrencyAllowance = "currency_allowance",
        Unlimited = "unlimited",
        Unavailable = "unavailable",
    }
}

string_enum! {
    AllowanceUnit {
        Percent = "percent",
        Requests = "requests",
        Credits = "credits",
        Usd = "USD",
    }
}

string_enum! {
    /// The provider interface that produced an allowance number.
    Reader {
        Statusline = "statusline",
        OauthUsage = "oauth_usage",
        AppServer = "app_server",
        Embedded = "embedded",
        WebBackend = "web_backend",
        UsageSummary = "usage_summary",
        DashboardRpc = "dashboard_rpc",
    }
}

string_enum! {
    EntryKind {
        Estimate = "estimate",
        IncludedUsage = "included_usage",
        MeteredCharge = "metered_charge",
        CreditGrant = "credit_grant",
        CreditConsumption = "credit_consumption",
        Adjustment = "adjustment",
        InvoiceLine = "invoice_line",
    }
}

string_enum! {
    MoneyUnit {
        Usd = "USD",
        Credits = "credits",
    }
}

string_enum! {
    ReferenceKind {
        ActivityRequest = "activity_request",
        UsageBucket = "usage_bucket",
        ProviderEvent = "provider_event",
        None = "none",
    }
}

string_enum! {
    /// The effective state of an adapter for one run. "Off" is always
    /// distinguishable from "broken".
    CoverageState {
        Ok = "ok",
        Partial = "partial",
        DisabledBySetting = "disabled_by_setting",
        DeniedLocally = "denied_locally",
        PrerequisiteMissing = "prerequisite_missing",
        CredentialUnavailable = "credential_unavailable",
        IdentityChanged = "identity_changed",
        RateLimited = "rate_limited",
        Failed = "failed",
    }
}

string_enum! {
    CursorState {
        Complete = "complete",
        More = "more",
        Unknown = "unknown",
    }
}

string_enum! {
    Platform {
        Darwin = "darwin",
        Windows = "windows",
        Linux = "linux",
        Unknown = "unknown",
    }
}

string_enum! {
    Arch {
        Arm64 = "arm64",
        Amd64 = "amd64",
        Unknown = "unknown",
    }
}

string_enum! {
    /// Why the server refused one record. A rejected record is never retried.
    RejectionReason {
        BindingNotOwned = "binding_not_owned",
        BindingNotEnabled = "binding_not_enabled",
        IdentityChanged = "identity_changed",
        AdapterNotAllowedForInstall = "adapter_not_allowed_for_install",
        RecordTypeNotAllowedForInstall = "record_type_not_allowed_for_install",
        AdapterProviderMismatch = "adapter_provider_mismatch",
        Invalid = "invalid",
    }
}

string_enum! {
    RecordType {
        ActivityRequest = "activity.request",
        AccountUsageBucket = "account.usage_bucket",
        AllowanceReading = "allowance.reading",
        MoneyEntry = "money.entry",
    }
}

string_enum! {
    /// The closed list of coverage detail codes. No free text, path, or token
    /// fragment ever reaches coverage or logs; only one of these.
    DetailCode {
        /// The provider payload did not match any known shape (parser version 0).
        UnrecognizedPayload = "unrecognized_payload",
        /// No config document is cached and the server could not be reached.
        NoConfig = "no_config",
        /// No open signed-in tab for the site (browser installs).
        NoTab = "no_tab",
        /// The install is paused in the Observatory.
        Paused = "paused",
        /// The provider switch is off.
        ProviderDisabled = "provider_disabled",
        /// The adapter's mode is off in the effective settings.
        ModeOff = "mode_off",
        /// The binding is disabled in the Observatory.
        BindingDisabled = "binding_disabled",
        /// No binding exists for this adapter's provider on this install.
        NoBinding = "no_binding",
        /// The local deny list removed the mode.
        Denied = "denied",
        /// The store (directory, database) is not present.
        StoreMissing = "store_missing",
        /// A required executable is not on the path.
        ExecutableMissing = "executable_missing",
        /// The application sign-in was not found.
        CredentialMissing = "credential_missing",
        /// The application sign-in has expired; the companion never refreshes it.
        CredentialExpired = "credential_expired",
        /// Identity evidence differs from the confirmed identity.
        IdentityChanged = "identity_changed",
        /// The adapter hit its deadline.
        Timeout = "timeout",
        /// A provider interface returned an error status.
        HttpError = "http_error",
        HttpUnauthorized = "http_unauthorized",
        HttpRateLimited = "http_rate_limited",
        /// A local read failed.
        IoError = "io_error",
        /// The local state database failed.
        StateError = "state_error",
        /// A provider record could not be parsed.
        ParseError = "parse_error",
        SubprocessFailed = "subprocess_failed",
        /// The adapter exists in the contract but is not implemented in this version.
        NotImplemented = "not_implemented",
        /// Some roots were unavailable; the run continued with the rest.
        UnavailableRoots = "unavailable_roots",
        /// The run stopped before every file was read.
        PartialRead = "partial_read",
    }
}

impl Adapter {
    /// The provider a binding must have for this adapter's records to be accepted.
    pub const fn provider(self) -> Provider {
        match self {
            Adapter::ClaudeExecution | Adapter::ClaudeAccount | Adapter::ClaudeBrowser => Provider::Claude,
            Adapter::CodexExecution | Adapter::CodexAccount | Adapter::CodexBrowser => Provider::Codex,
            Adapter::CursorAccount | Adapter::CursorExecution | Adapter::CursorBrowser => Provider::Cursor,
            Adapter::AnthropicApi => Provider::AnthropicApi,
            Adapter::OpenaiApi => Provider::OpenaiApi,
        }
    }

    /// Browser adapters may only be submitted by a browser install, and vice versa.
    pub const fn is_browser(self) -> bool {
        match self {
            Adapter::ClaudeBrowser | Adapter::CodexBrowser | Adapter::CursorBrowser => true,
            Adapter::ClaudeExecution
            | Adapter::ClaudeAccount
            | Adapter::CodexExecution
            | Adapter::CodexAccount
            | Adapter::CursorAccount
            | Adapter::CursorExecution
            | Adapter::AnthropicApi
            | Adapter::OpenaiApi => false,
        }
    }

    /// The adapters a companion install runs, in run order.
    pub const COMPANION: &'static [Adapter] = &[
        Adapter::ClaudeExecution,
        Adapter::CodexExecution,
        Adapter::ClaudeAccount,
        Adapter::CodexAccount,
        Adapter::CursorExecution,
        Adapter::CursorAccount,
        Adapter::AnthropicApi,
        Adapter::OpenaiApi,
    ];
}

impl Platform {
    pub const fn current() -> Platform {
        if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "linux") {
            Platform::Linux
        } else {
            Platform::Unknown
        }
    }
}

impl Arch {
    pub const fn current() -> Arch {
        if cfg!(target_arch = "aarch64") {
            Arch::Arm64
        } else if cfg!(target_arch = "x86_64") {
            Arch::Amd64
        } else {
            Arch::Unknown
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_serde_and_from_str() {
        for adapter in Adapter::ALL {
            let json = serde_json::to_string(adapter).unwrap();
            assert_eq!(json, format!("\"{}\"", adapter.as_str()));
            assert_eq!(serde_json::from_str::<Adapter>(&json).unwrap(), *adapter);
            assert_eq!(Adapter::from_str(adapter.as_str()).unwrap(), *adapter);
        }
        assert_eq!(serde_json::to_string(&AllowanceUnit::Usd).unwrap(), "\"USD\"");
        assert!(Adapter::from_str("claude").is_err());
    }

    #[test]
    fn adapters_map_to_providers() {
        assert_eq!(Adapter::ClaudeBrowser.provider(), Provider::Claude);
        assert_eq!(Adapter::OpenaiApi.provider(), Provider::OpenaiApi);
        assert!(Adapter::CodexBrowser.is_browser());
        assert!(!Adapter::CodexAccount.is_browser());
    }
}
