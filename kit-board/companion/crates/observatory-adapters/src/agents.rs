//! Privacy-safe agent attribution and lifecycle records shared by local
//! execution adapters. Provider identifiers are hashed before they leave the
//! parser; raw custom role names remain local and are gated at record build.

use std::str::FromStr;

use observatory_contract::settings::ToolDetail;
use observatory_contract::{
    Adapter, AgentAttribution, AgentClass, AgentEvent, AgentEventKind, Basis, Channel, Counter, EventOutcome,
    IdentityBasis, Nullable, ParentIdentityBasis, Provider, Record, Sha256Hex, Stamp, Text, ToolName, Uuid,
};
use observatory_core::adapter::record_id;
use observatory_core::pyjson::digest;
use observatory_core::state::{AgentEventRow, AgentProfileRow, State, StateError};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentEvidence {
    pub key: Option<String>,
    pub identity_basis: String,
    pub parent_key: Option<String>,
    pub parent_identity_basis: String,
    #[serde(default = "unknown_parent_evidence")]
    pub parent_evidence: String,
    pub class: String,
    pub name: Option<String>,
    pub depth: Option<i64>,
    #[serde(default = "unknown_depth_evidence")]
    pub depth_evidence: String,
    pub model_requested: Option<String>,
    pub tool_invocation_key: Option<String>,
}

impl AgentEvidence {
    pub fn unknown() -> Self {
        Self {
            key: None,
            identity_basis: "unknown".into(),
            parent_key: None,
            parent_identity_basis: "unknown".into(),
            parent_evidence: "unknown".into(),
            class: "unknown".into(),
            name: None,
            depth: None,
            depth_evidence: "unknown".into(),
            model_requested: None,
            tool_invocation_key: None,
        }
    }

    pub fn main(provider: Provider, account: &str, provider_id: &str) -> Self {
        Self {
            key: Some(agent_key(provider, account, provider_id)),
            identity_basis: "provider".into(),
            parent_key: None,
            parent_identity_basis: "none".into(),
            parent_evidence: "none".into(),
            class: "main".into(),
            name: None,
            depth: Some(0),
            depth_evidence: "explicit".into(),
            model_requested: None,
            tool_invocation_key: None,
        }
    }

    pub fn profile(&self) -> Option<AgentProfileRow> {
        Some(AgentProfileRow {
            key: self.key.clone()?,
            identity_basis: self.identity_basis.clone(),
            parent_key: self.parent_key.clone(),
            parent_identity_basis: self.parent_identity_basis.clone(),
            parent_evidence: self.parent_evidence.clone(),
            class: self.class.clone(),
            name: self.name.clone(),
            depth: self.depth,
            depth_evidence: self.depth_evidence.clone(),
            model_requested: self.model_requested.clone(),
        })
    }

    pub fn apply_profile(&mut self, profile: AgentProfileRow) {
        if self.identity_basis == "unknown" {
            self.identity_basis = profile.identity_basis.clone();
        }
        let profile_parent_rank = parent_evidence_rank(&profile.parent_evidence);
        let current_parent_rank = parent_evidence_rank(&self.parent_evidence);
        let profile_depth_rank = depth_evidence_rank(&profile.depth_evidence);
        let current_depth_rank = depth_evidence_rank(&self.depth_evidence);
        let profile_replaces_parent = profile_parent_rank > current_parent_rank;
        let parent_changed = profile_replaces_parent && self.parent_key != profile.parent_key;
        let profile_depth_matches_parent = profile_depth_rank >= depth_evidence_rank("explicit")
            || self.parent_key.is_none()
            || self.parent_key == profile.parent_key
            || current_parent_rank <= profile_parent_rank;
        if (parent_changed && current_depth_rank < depth_evidence_rank("explicit"))
            || (profile_depth_matches_parent && profile_depth_rank > current_depth_rank)
        {
            self.depth = profile.depth;
            self.depth_evidence = profile.depth_evidence.clone();
        } else if profile_depth_matches_parent && profile_depth_rank == current_depth_rank {
            self.depth = self.depth.or(profile.depth);
        }
        if profile_replaces_parent {
            self.parent_key = profile.parent_key.clone();
            self.parent_identity_basis = profile.parent_identity_basis.clone();
            self.parent_evidence = profile.parent_evidence.clone();
        } else {
            self.parent_key = self.parent_key.take().or(profile.parent_key.clone());
            if self.parent_identity_basis == "unknown" {
                self.parent_identity_basis = profile.parent_identity_basis.clone();
            }
        }
        if self.class == "unknown" || (self.class != "main" && self.name.is_none() && profile.name.is_some())
        {
            self.class = profile.class.clone();
        }
        self.name = self.name.take().or(profile.name.clone());
        self.model_requested = self.model_requested.take().or(profile.model_requested);
    }
}

fn unknown_parent_evidence() -> String {
    "unknown".into()
}

fn unknown_depth_evidence() -> String {
    "unknown".into()
}

fn parent_evidence_rank(value: &str) -> u8 {
    match value {
        "none" => 4,
        "explicit" => 3,
        "structural" => 2,
        "fallback" => 1,
        _ => 0,
    }
}

fn depth_evidence_rank(value: &str) -> u8 {
    match value {
        "explicit" => 3,
        "invalidated" => 2,
        "inferred" => 1,
        _ => 0,
    }
}

/// True only when the evidence positively identifies a child. A completely
/// unknown request remains part of the main usage total when child collection
/// is disabled.
pub fn is_known_child(evidence: &AgentEvidence) -> bool {
    is_known_child_fields(
        &evidence.class,
        evidence.key.as_deref(),
        evidence.parent_key.as_deref(),
        evidence.depth,
    )
}

pub fn is_known_child_fields(
    class: &str,
    key: Option<&str>,
    parent_key: Option<&str>,
    depth: Option<i64>,
) -> bool {
    class != "main" && (key.is_some() || parent_key.is_some() || depth.is_some())
}

pub fn agent_key(provider: Provider, account: &str, provider_id: &str) -> String {
    digest(&json!(["agent", provider.as_str(), account, provider_id])).as_str().to_owned()
}

pub fn invocation_key(provider: Provider, account: &str, provider_id: &str) -> String {
    digest(&json!(["tool", provider.as_str(), account, provider_id])).as_str().to_owned()
}

pub fn classify_claude(name: Option<&str>) -> &'static str {
    match name {
        Some(
            "general-purpose" | "Explore" | "Plan" | "claude-code-guide" | "statusline-setup" | "claude",
        ) => "builtin",
        Some(_) => "custom",
        None => "unknown",
    }
}

pub fn classify_codex(role: Option<&str>) -> &'static str {
    match role {
        Some("codex-auto-review") => "builtin",
        Some(_) => "custom",
        None => "builtin",
    }
}

fn display_name(raw: Option<&str>, class: AgentClass, detail: ToolDetail) -> Option<ToolName> {
    let raw = raw?.trim();
    if raw.is_empty() || detail == ToolDetail::Off {
        return None;
    }
    match class {
        AgentClass::Builtin => ToolName::from_str(raw).ok(),
        AgentClass::Custom if detail == ToolDetail::HashedCustom => {
            let hash = digest(&json!(["agent-name", raw]));
            ToolName::from_str(&format!("h:{}", &hash.as_str()[..16])).ok()
        }
        AgentClass::Main | AgentClass::Custom | AgentClass::Unknown => None,
    }
}

#[allow(clippy::too_many_arguments)]
pub fn attribution(
    key: Option<&str>,
    identity_basis: &str,
    parent_key: Option<&str>,
    parent_identity_basis: &str,
    class: &str,
    name: Option<&str>,
    depth: Option<i64>,
    detail: ToolDetail,
) -> Option<AgentAttribution> {
    let identity_basis = IdentityBasis::from_str(identity_basis).ok()?;
    let parent_identity_basis = ParentIdentityBasis::from_str(parent_identity_basis).ok()?;
    let class = AgentClass::from_str(class).ok()?;
    let key = key.and_then(|value| Sha256Hex::try_from(value.to_owned()).ok());
    let parent_key = parent_key.and_then(|value| Sha256Hex::try_from(value.to_owned()).ok());
    let depth = depth.and_then(|value| u64::try_from(value).ok()).and_then(|value| Counter::new(value).ok());
    Some(AgentAttribution {
        key: Nullable(key),
        identity_basis,
        parent_key: Nullable(parent_key),
        parent_identity_basis,
        class,
        name: Nullable(display_name(name, class, detail)),
        depth: Nullable(depth),
    })
}

pub fn save_profile(state: &State, binding: &str, evidence: &AgentEvidence) -> Result<(), StateError> {
    if let Some(profile) = evidence.profile() {
        state.upsert_agent_profile(binding, &profile)?;
    }
    Ok(())
}

pub fn enrich_profile(state: &State, binding: &str, evidence: &mut AgentEvidence) -> Result<(), StateError> {
    if let Some(key) = evidence.key.as_deref()
        && let Some(profile) = state.agent_profile(binding, key)?
    {
        evidence.apply_profile(profile);
    }
    Ok(())
}

pub fn save_observed_start(
    state: &State,
    binding: &str,
    provider: Provider,
    account: &str,
    timestamp: &str,
    session_hash: &str,
    evidence: &AgentEvidence,
) -> Result<(), StateError> {
    save_profile(state, binding, evidence)?;
    let Some(key) = evidence.key.as_deref() else { return Ok(()) };
    if evidence.class == "main" {
        return Ok(());
    }
    let id = digest(&json!(["agent-start", provider.as_str(), account, key]));
    state.insert_agent_event(
        binding,
        &AgentEventRow {
            id: id.as_str().to_owned(),
            timestamp: timestamp.to_owned(),
            event_kind: "start".into(),
            session_hash: Some(session_hash.to_owned()),
            agent_key: Some(key.to_owned()),
            identity_basis: evidence.identity_basis.clone(),
            parent_key: evidence.parent_key.clone(),
            parent_identity_basis: evidence.parent_identity_basis.clone(),
            class: evidence.class.clone(),
            name: evidence.name.clone(),
            depth: evidence.depth,
            model_requested: evidence.model_requested.clone(),
            tool_invocation_key: None,
            outcome: "succeeded".into(),
        },
    )?;
    if let Some(invocation) = evidence.tool_invocation_key.as_deref() {
        complete_spawn(
            state,
            binding,
            provider,
            account,
            invocation,
            timestamp,
            Some(session_hash),
            evidence,
            "succeeded",
        )?;
    }
    Ok(())
}

pub fn save_observed_spawn(
    state: &State,
    binding: &str,
    provider: Provider,
    account: &str,
    timestamp: &str,
    session_hash: &str,
    evidence: &AgentEvidence,
) -> Result<(), StateError> {
    let Some(key) = evidence.key.as_deref() else { return Ok(()) };
    let id = digest(&json!(["agent-spawn-observed", provider.as_str(), account, key, evidence.parent_key]));
    save_profile(state, binding, evidence)?;
    state.insert_agent_event(
        binding,
        &AgentEventRow {
            id: id.as_str().to_owned(),
            timestamp: timestamp.to_owned(),
            event_kind: "spawn".into(),
            session_hash: Some(session_hash.to_owned()),
            agent_key: Some(key.to_owned()),
            identity_basis: evidence.identity_basis.clone(),
            parent_key: evidence.parent_key.clone(),
            parent_identity_basis: evidence.parent_identity_basis.clone(),
            class: evidence.class.clone(),
            name: evidence.name.clone(),
            depth: evidence.depth,
            model_requested: evidence.model_requested.clone(),
            tool_invocation_key: None,
            outcome: "succeeded".into(),
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn save_spawn_attempt(
    state: &State,
    binding: &str,
    provider: Provider,
    account: &str,
    invocation: &str,
    timestamp: &str,
    session_hash: Option<&str>,
    parent: &AgentEvidence,
    role: Option<&str>,
    requested_model: Option<&str>,
) -> Result<(), StateError> {
    let id = digest(&json!(["agent-spawn", provider.as_str(), account, invocation]));
    state.insert_agent_event(
        binding,
        &AgentEventRow {
            id: id.as_str().to_owned(),
            timestamp: timestamp.to_owned(),
            event_kind: "spawn".into(),
            session_hash: session_hash.map(str::to_owned),
            agent_key: None,
            identity_basis: "unknown".into(),
            parent_key: parent.key.clone(),
            parent_identity_basis: parent.identity_basis.clone(),
            class: classify_claude(role).into(),
            name: role.map(str::to_owned),
            depth: parent.depth.and_then(|depth| depth.checked_add(1)),
            model_requested: requested_model.map(str::to_owned),
            tool_invocation_key: Some(invocation.to_owned()),
            outcome: "unknown".into(),
        },
    )?;
    if let Some(row) = state.agent_spawn_for_invocation(binding, invocation)?
        && let Some(key) = row.agent_key.clone()
    {
        let has_parent = row.parent_key.is_some();
        save_profile(
            state,
            binding,
            &AgentEvidence {
                key: Some(key),
                identity_basis: row.identity_basis,
                parent_key: row.parent_key,
                parent_identity_basis: row.parent_identity_basis,
                parent_evidence: if has_parent { "explicit".into() } else { "unknown".into() },
                class: row.class,
                name: row.name,
                depth: row.depth,
                depth_evidence: if row.depth.is_some() { "inferred" } else { "unknown" }.into(),
                model_requested: row.model_requested,
                tool_invocation_key: row.tool_invocation_key,
            },
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn complete_spawn(
    state: &State,
    binding: &str,
    provider: Provider,
    account: &str,
    invocation: &str,
    timestamp: &str,
    session_hash: Option<&str>,
    evidence: &AgentEvidence,
    outcome: &str,
) -> Result<(), StateError> {
    let existing = state.agent_spawn_for_invocation(binding, invocation)?;
    let id = digest(&json!(["agent-spawn", provider.as_str(), account, invocation]));
    let role = existing.as_ref().and_then(|row| row.name.clone()).or_else(|| evidence.name.clone());
    let requested_model = existing
        .as_ref()
        .and_then(|row| row.model_requested.clone())
        .or_else(|| evidence.model_requested.clone());
    let mut completed = evidence.clone();
    if let Some(existing) = existing.as_ref()
        && existing.parent_key.is_some()
    {
        completed.parent_key = existing.parent_key.clone();
        completed.parent_identity_basis = existing.parent_identity_basis.clone();
        completed.parent_evidence = "explicit".into();
        if completed.depth.is_none() {
            completed.depth = existing.depth;
            if completed.depth.is_some() {
                completed.depth_evidence = "inferred".into();
            }
        }
    }
    if completed.depth.is_none()
        && let Some(parent_key) = completed.parent_key.as_deref()
        && let Some(parent) = state.agent_profile(binding, parent_key)?
        && let Some(depth) = parent.depth.and_then(|depth| depth.checked_add(1))
    {
        completed.depth = Some(depth);
        completed.depth_evidence = "inferred".into();
    }
    completed.name = completed.name.or(role.clone());
    completed.model_requested = completed.model_requested.or(requested_model.clone());
    save_profile(state, binding, &completed)?;
    state.insert_agent_event(
        binding,
        &AgentEventRow {
            id: existing.as_ref().map_or_else(|| id.as_str().to_owned(), |row| row.id.clone()),
            timestamp: existing.as_ref().map_or_else(|| timestamp.to_owned(), |row| row.timestamp.clone()),
            event_kind: "spawn".into(),
            session_hash: existing
                .as_ref()
                .and_then(|row| row.session_hash.clone())
                .or_else(|| session_hash.map(str::to_owned)),
            agent_key: completed.key.clone(),
            identity_basis: completed.identity_basis.clone(),
            parent_key: completed.parent_key.clone(),
            parent_identity_basis: completed.parent_identity_basis.clone(),
            class: if completed.class == "unknown" {
                existing.as_ref().map_or_else(|| "unknown".into(), |row| row.class.clone())
            } else {
                completed.class.clone()
            },
            name: role,
            depth: completed.depth.or_else(|| existing.as_ref().and_then(|row| row.depth)),
            model_requested: requested_model,
            tool_invocation_key: Some(invocation.to_owned()),
            outcome: outcome.to_owned(),
        },
    )
}

pub fn record_from_event(
    binding: &Uuid,
    adapter: Adapter,
    parser_version: &str,
    detail: ToolDetail,
    row: &AgentEventRow,
) -> Option<Record> {
    let observed_at = Stamp::parse(&row.timestamp).ok()?;
    let agent = attribution(
        row.agent_key.as_deref(),
        &row.identity_basis,
        row.parent_key.as_deref(),
        &row.parent_identity_basis,
        &row.class,
        row.name.as_deref(),
        row.depth,
        detail,
    )?;
    Some(Record::AgentEvent(AgentEvent {
        record_id: record_id(binding, Channel::LocalFile, &format!("agent:{}", row.id)),
        binding_id: binding.clone(),
        adapter,
        channel: Channel::LocalFile,
        observed_at,
        basis: Basis::Exact,
        parser_version: Text::truncated(parser_version).ok()?,
        semantic_key: Sha256Hex::try_from(row.id.clone()).ok()?,
        event_kind: AgentEventKind::from_str(&row.event_kind).ok()?,
        session_hash: Nullable(row.session_hash.clone().and_then(|value| Sha256Hex::try_from(value).ok())),
        agent,
        tool_invocation_key: Nullable(
            row.tool_invocation_key.clone().and_then(|value| Sha256Hex::try_from(value).ok()),
        ),
        outcome: EventOutcome::from_str(&row.outcome).ok()?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(
        parent: &str,
        parent_evidence: &str,
        depth: Option<i64>,
        depth_evidence: &str,
    ) -> AgentProfileRow {
        AgentProfileRow {
            key: "1".repeat(64),
            identity_basis: "provider".into(),
            parent_key: Some(parent.repeat(64)),
            parent_identity_basis: "provider".into(),
            parent_evidence: parent_evidence.into(),
            class: "builtin".into(),
            name: None,
            depth,
            depth_evidence: depth_evidence.into(),
            model_requested: None,
        }
    }

    #[test]
    fn stronger_profile_parent_replaces_depth_derived_from_an_old_parent() {
        let mut evidence = AgentEvidence {
            key: Some("1".repeat(64)),
            identity_basis: "provider".into(),
            parent_key: Some("2".repeat(64)),
            parent_identity_basis: "provider".into(),
            parent_evidence: "structural".into(),
            class: "builtin".into(),
            name: None,
            depth: Some(1),
            depth_evidence: "inferred".into(),
            model_requested: None,
            tool_invocation_key: None,
        };

        evidence.apply_profile(profile("3", "explicit", Some(2), "inferred"));

        assert_eq!(
            evidence.parent_key.as_deref(),
            Some("3333333333333333333333333333333333333333333333333333333333333333")
        );
        assert_eq!(evidence.depth, Some(2));
        assert_eq!(evidence.depth_evidence, "inferred");
    }

    #[test]
    fn direct_depth_survives_a_stronger_profile_parent() {
        let mut evidence =
            AgentEvidence { depth: Some(3), depth_evidence: "explicit".into(), ..AgentEvidence::unknown() };
        evidence.parent_key = Some("2".repeat(64));
        evidence.parent_identity_basis = "provider".into();
        evidence.parent_evidence = "structural".into();

        evidence.apply_profile(profile("3", "explicit", Some(2), "inferred"));

        assert_eq!(evidence.depth, Some(3));
        assert_eq!(evidence.depth_evidence, "explicit");
    }

    #[test]
    fn invalidated_profile_depth_clears_stale_same_parent_inference() {
        let mut evidence = AgentEvidence {
            key: Some("1".repeat(64)),
            identity_basis: "provider".into(),
            parent_key: Some("2".repeat(64)),
            parent_identity_basis: "provider".into(),
            parent_evidence: "structural".into(),
            class: "builtin".into(),
            name: None,
            depth: Some(2),
            depth_evidence: "inferred".into(),
            model_requested: None,
            tool_invocation_key: None,
        };

        evidence.apply_profile(profile("2", "structural", None, "invalidated"));

        assert_eq!(evidence.depth, None);
        assert_eq!(evidence.depth_evidence, "invalidated");
    }
}
