//! The companion config document (`GET /api/v1/companion/config`, section 1.2).

use serde::{Deserialize, Serialize};

use crate::enums::{InstallKind, Provider};
use crate::newtypes::{AccountId, Counter, Lit, Nullable, Sha256Hex, Text, Uuid};
use crate::settings::CollectionSettings;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InstallInfo {
    pub id: Uuid,
    pub kind: InstallKind,
    pub machine_label: Text<1, 100>,
    pub paused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindingInfo {
    pub binding_id: Uuid,
    pub account_id: AccountId,
    pub provider: Provider,
    pub enabled: bool,
    /// Null after `identity_changed` until the UI approves a new hash.
    pub identity_hash: Nullable<Sha256Hex>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompanionInfo {
    /// Null until the daily release check has run.
    pub latest_version: Nullable<Text<0, 30>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigDocument {
    pub schema_version: Lit<2>,
    pub settings_version: Counter,
    pub install: InstallInfo,
    pub bindings: Vec<BindingInfo>,
    /// The effective settings for this install: global defaults with the install override applied.
    pub settings: CollectionSettings,
    pub companion: CompanionInfo,
}

impl ConfigDocument {
    pub fn binding(&self, binding_id: &Uuid) -> Option<&BindingInfo> {
        self.bindings.iter().find(|binding| &binding.binding_id == binding_id)
    }

    pub fn bindings_for(&self, provider: Provider) -> impl Iterator<Item = &BindingInfo> {
        self.bindings.iter().filter(move |binding| binding.provider == provider)
    }
}
