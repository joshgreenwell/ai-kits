//! `name.label` side records (spec sections 1.3 and 2.2): a readable name
//! beside each hashed key the ledger already holds. Names never enter a
//! ledger record; the hash stays the identity and the label rides beside it.
//!
//! Every run rebuilds the whole set from this install's state: the raw tool
//! and namespace names kept beside their hashes, the raw custom agent names,
//! the agent labels the Codex resolver stored, and the Cursor composer labels.
//! The run stores them through `upsert_record`, so only a new or changed label
//! is pending; the upload gate in `run` applies `execution.tool_detail`.

use std::collections::BTreeMap;

use observatory_contract::{
    AgentRole, LabelKey, LabelKind, LabelText, NameLabel, Nullable, Record, RecordType, Sha256Hex,
};

use crate::privacy::{PrivacyKey, agent_name_hash};
use crate::projects::{Carrier, SessionAgentLabel};
use crate::state::{State, StateError};

/// The prefix Codex gives a connector app's namespace in nested calls.
pub const CODEX_APPS_PREFIX: &str = "codex_apps:";

/// What one label build produced.
#[derive(Clone, Debug, Default)]
pub struct LabelBuild {
    pub records: Vec<Record>,
    /// Labels cut to 200 characters.
    pub truncated: u64,
    /// Names that normalized to nothing and so produced no label.
    pub dropped: u64,
}

struct Candidate {
    label: String,
    role: Option<AgentRole>,
    parent_key: Option<Sha256Hex>,
}

/// The label a namespace shows: the namespace text exactly, prefix included. A Codex app connector's
/// namespace is `codex_apps:<app>`, and the server reads it as "<app> (connector)" by that prefix. Its
/// hash is keyed like any MCP namespace's, so the prefix in the label is the only thing that tells a
/// connector from an MCP server of the same name. Stripping it here left every connector unmarked.
pub fn namespace_label(namespace: &str) -> &str {
    namespace
}

/// Builds every label this install can produce now, on the carrier.
pub fn build(
    state: &State,
    carrier: &Carrier,
    key: &PrivacyKey,
    session_agents: &[SessionAgentLabel],
) -> Result<LabelBuild, StateError> {
    let mut candidates: BTreeMap<(LabelKind, String), Candidate> = BTreeMap::new();
    let mut offer = |kind: LabelKind, key: String, candidate: Candidate| {
        use std::collections::btree_map::Entry;
        match candidates.entry((kind, key)) {
            Entry::Vacant(slot) => {
                slot.insert(candidate);
            }
            // A deterministic winner when two raw values share a key: the smaller label.
            Entry::Occupied(mut slot) if candidate.label < slot.get().label => {
                slot.insert(candidate);
            }
            Entry::Occupied(_) => {}
        }
    };
    for row in state.hashed_tool_names()? {
        if let (Some(name), Some(hash)) = (row.name, row.name_hash) {
            offer(LabelKind::Tool, hash, Candidate { label: name, role: None, parent_key: None });
        }
        if let (Some(namespace), Some(hash)) = (row.namespace, row.namespace_hash) {
            let label = namespace_label(&namespace).to_owned();
            offer(LabelKind::ToolNamespace, hash, Candidate { label, role: None, parent_key: None });
        }
    }
    for name in state.custom_agent_names()? {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        offer(
            LabelKind::AgentName,
            agent_name_hash(key, trimmed),
            Candidate { label: trimmed.to_owned(), role: None, parent_key: None },
        );
    }
    for (_, row) in state.agent_labels()? {
        let role = match row.role.as_deref() {
            Some("main") => Some(AgentRole::Main),
            Some("subagent") => Some(AgentRole::Subagent),
            _ => None,
        };
        offer(LabelKind::Agent, row.agent_key, Candidate { label: row.label, role, parent_key: None });
    }
    for label in session_agents {
        let candidate = Candidate {
            label: label.label.clone(),
            role: Some(label.role),
            parent_key: label.parent_key.clone(),
        };
        offer(LabelKind::SessionAgent, label.session_hash.as_str().to_owned(), candidate);
    }

    let mut out = LabelBuild::default();
    for ((kind, key), candidate) in candidates {
        let Ok(label_key) = LabelKey::try_from(key) else { continue };
        if kind.is_hashed_name() != label_key.is_hashed_name() {
            continue;
        }
        let (label, truncated) = LabelText::normalize(&candidate.label);
        let Some(label) = label else {
            out.dropped += 1;
            continue;
        };
        if truncated {
            out.truncated += 1;
        }
        out.records.push(Record::NameLabel(NameLabel {
            record_id: carrier.record_id(RecordType::NameLabel, kind.as_str(), label_key.as_str()),
            binding_id: carrier.binding_id.clone(),
            adapter: carrier.adapter,
            observed_at: carrier.observed_at.clone(),
            parser_version: carrier.parser_version.clone(),
            kind,
            key: label_key,
            label,
            role: Nullable(if kind.allows_role() { candidate.role } else { None }),
            parent_key: Nullable(if kind.allows_parent_key() { candidate.parent_key } else { None }),
        }));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use observatory_contract::{Adapter, Stamp, Text, Uuid};

    use super::*;
    use crate::privacy::{tool_name_hash, tool_namespace_hash};
    use crate::state::{AgentLabelRow, ORIGIN_DIRECT, ORIGIN_NESTED_MCP, ToolEventRow};

    const BINDING: &str = "11111111-1111-4111-8111-111111111111";

    fn carrier() -> Carrier {
        Carrier {
            binding_id: Uuid::from_str(BINDING).unwrap(),
            adapter: Adapter::ClaudeExecution,
            observed_at: Stamp::parse("2026-09-12T00:00:00.000Z").unwrap(),
            parser_version: Text::truncated("2.2.0+sides1").unwrap(),
        }
    }

    const APP: &str = "codex_apps:SyntheticApp";

    fn tool(
        state: &State,
        key: &PrivacyKey,
        id: &str,
        class: &str,
        namespace: Option<&str>,
        name: &str,
        origin: &str,
    ) {
        state
            .upsert_tool_event(
                BINDING,
                &ToolEventRow {
                    id: id.into(),
                    timestamp: "2026-09-10T00:00:00Z".into(),
                    event_kind: "invocation".into(),
                    invocation_key: id.into(),
                    session_hash: None,
                    caller_request_key: None,
                    caller_agent_key: None,
                    caller_is_subagent: false,
                    parent_invocation_key: None,
                    class: class.into(),
                    name: Some(name.into()),
                    name_hash: Some(tool_name_hash(key, namespace, name)),
                    namespace: namespace.map(str::to_owned),
                    namespace_hash: namespace.map(|namespace| tool_namespace_hash(key, namespace)),
                    outcome: "unknown".into(),
                    name_truncated: false,
                    origin: origin.into(),
                },
            )
            .unwrap();
    }

    fn labels(build: &LabelBuild) -> Vec<(LabelKind, String, String, Option<AgentRole>)> {
        build
            .records
            .iter()
            .map(|record| match record {
                Record::NameLabel(label) => (
                    label.kind,
                    label.key.as_str().to_owned(),
                    label.label.as_str().to_owned(),
                    label.role.as_ref().copied(),
                ),
                other => panic!("not a label: {other:?}"),
            })
            .collect()
    }

    #[test]
    fn every_hashed_key_gets_the_readable_name_the_ledger_hid() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let key = PrivacyKey::fixed_for_tests();
        tool(&state, &key, "t1", "mcp", Some(APP), "synthetic_action", ORIGIN_NESTED_MCP);
        tool(&state, &key, "t2", "custom", None, "SyntheticTool", ORIGIN_DIRECT);
        tool(&state, &key, "t3", "builtin", None, "Read", ORIGIN_DIRECT);
        state
            .replace_agent_labels(
                BINDING,
                &[AgentLabelRow {
                    agent_key: "a".repeat(64),
                    label: "worker".into(),
                    role: Some("subagent".into()),
                    source: "codex_thread".into(),
                }],
            )
            .unwrap();
        let sessions = [SessionAgentLabel {
            session_hash: Sha256Hex::try_from("b".repeat(64)).unwrap(),
            label: "explore".into(),
            role: AgentRole::Subagent,
            parent_key: Some(Sha256Hex::try_from("c".repeat(64)).unwrap()),
        }];
        let built = build(&state, &carrier(), &key, &sessions).unwrap();
        let found = labels(&built);
        let has = |kind: LabelKind, wanted: &str, label: &str| {
            found.iter().any(|(k, id, text, _)| *k == kind && id == wanted && text == label)
        };
        let action = tool_name_hash(&key, Some(APP), "synthetic_action");
        assert!(has(LabelKind::Tool, &action, "synthetic_action"));
        assert!(
            has(LabelKind::ToolNamespace, &tool_namespace_hash(&key, APP), "codex_apps:SyntheticApp"),
            "a connector namespace keeps its prefix, which is how the server marks it a connector"
        );
        assert!(has(LabelKind::Tool, &tool_name_hash(&key, None, "SyntheticTool"), "SyntheticTool"));
        assert!(!found.iter().any(|(_, _, label, _)| label == "Read"), "a builtin travels readable already");
        assert!(has(LabelKind::Agent, &"a".repeat(64), "worker"));
        assert!(has(LabelKind::SessionAgent, &"b".repeat(64), "explore"));
        let now = jiff::Timestamp::from_str("2026-09-12T00:00:00Z").unwrap();
        for record in &built.records {
            let mut violations = Vec::new();
            record.validate(now, "record", &mut violations);
            assert!(violations.is_empty(), "{violations:?}");
        }
        let session = built.records.iter().find_map(|record| match record {
            Record::NameLabel(label) if label.kind == LabelKind::SessionAgent => Some(label),
            _ => None,
        });
        let parent = session.unwrap().parent_key.as_ref().map(|key| key.as_str().to_owned());
        assert_eq!(parent, Some("c".repeat(64)));
    }

    #[test]
    fn custom_agent_names_are_keyed_exactly_as_the_ledger_hashes_them() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let key = PrivacyKey::fixed_for_tests();
        state
            .upsert_agent_profile(
                BINDING,
                &crate::state::AgentProfileRow {
                    key: "d".repeat(64),
                    identity_basis: "provider".into(),
                    parent_key: None,
                    parent_identity_basis: "unknown".into(),
                    parent_evidence: "unknown".into(),
                    class: "custom".into(),
                    name: Some("  synthetic-reviewer ".into()),
                    depth: None,
                    depth_evidence: "unknown".into(),
                    model_requested: None,
                },
            )
            .unwrap();
        let built = build(&state, &carrier(), &key, &[]).unwrap();
        let found = labels(&built);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, LabelKind::AgentName);
        assert_eq!(found[0].1, agent_name_hash(&key, "synthetic-reviewer"));
        assert_eq!((found[0].2.as_str(), found[0].3), ("synthetic-reviewer", None));
        assert_eq!(namespace_label("codex_apps:"), "codex_apps:");
        assert_eq!(namespace_label("codex_apps:Supabase"), "codex_apps:Supabase");
        assert_eq!(namespace_label("server"), "server");
    }

    #[test]
    fn long_names_are_truncated_and_empty_ones_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let state = State::open(&dir.path().join("state.sqlite3")).unwrap();
        let key = PrivacyKey::fixed_for_tests();
        tool(&state, &key, "t1", "custom", None, &"x".repeat(250), ORIGIN_DIRECT);
        tool(&state, &key, "t2", "custom", None, "\u{200B}\u{FEFF}", ORIGIN_DIRECT);
        let built = build(&state, &carrier(), &key, &[]).unwrap();
        assert_eq!((built.truncated, built.dropped, built.records.len()), (1, 1, 1));
        assert_eq!(labels(&built)[0].2.chars().count(), 200);
    }
}
