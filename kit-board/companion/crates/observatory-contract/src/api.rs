//! Request and response bodies for the install-key endpoints (section 1.3).

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::enums::{Arch, InstallKind, Platform, Provider, RejectionReason};
use crate::newtypes::{AccountId, Counter, Lit, Nullable, Sha256Hex, Text, Uuid};

/// `POST /api/v1/companion/pair` body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairRequest {
    /// The one-time eight-character code, as the user typed it (dashes allowed).
    pub code: String,
    pub machine_label: Text<1, 100>,
    pub kind: InstallKind,
    pub platform: Platform,
    pub arch: Arch,
}

/// `POST /api/v1/companion/pair` response. The key is shown to nobody and written
/// only to the install's config file; `Debug` redacts it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PairResponse {
    pub install_id: Uuid,
    pub key: String,
}

impl fmt::Debug for PairResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairResponse")
            .field("install_id", &self.install_id)
            .field("key", &"<redacted>")
            .finish()
    }
}

/// `POST /api/v1/companion/bindings` body. Idempotent on `(install_id, account_id)`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindingRequest {
    pub account_id: AccountId,
    pub provider: Provider,
    pub account_label: Text<1, 80>,
    pub identity_hash: Nullable<Sha256Hex>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindingResponse {
    pub binding_id: Uuid,
    pub account_id: AccountId,
    pub provider: Provider,
    pub enabled: bool,
    pub identity_hash: Nullable<Sha256Hex>,
}

/// `PUT /api/v1/companion/settings` response.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsResponse {
    pub ok: bool,
    pub settings_version: Counter,
}

/// `POST /api/v1/companion/bindings/<id>/identity` body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityRequest {
    pub identity_hash: Sha256Hex,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityResponse {
    pub ok: bool,
    pub binding_id: Uuid,
    pub identity_hash: Nullable<Sha256Hex>,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Accepted {
    pub buckets: Counter,
    pub records: Counter,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rejection {
    pub record_id: Uuid,
    pub reason: RejectionReason,
}

/// `POST /api/v1/usage` response. Validation is per record: an envelope whose
/// `run` block and shape are valid is accepted even when some records are
/// rejected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageResponse {
    pub ok: bool,
    pub schema_version: Lit<2>,
    pub run_id: Uuid,
    pub accepted: Accepted,
    pub duplicates: Counter,
    pub rejected: Vec<Rejection>,
}
