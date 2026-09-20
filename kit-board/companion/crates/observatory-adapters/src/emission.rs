//! Detail emission shared by the two local execution adapters: request,
//! agent, tool, and resource records from the rows a scan stored, emitted
//! incrementally.
//!
//! Every stored row carries the change generation the run stamped it with
//! (`State::advance_change_generation`). An adapter remembers, per binding,
//! the generation it last emitted under and a fingerprint of everything the
//! record shape depends on (parser version, detail level, tool detail, subagent
//! setting, effective project and resource attribution, resource
//! configuration). A run then emits the rows written since that generation,
//! the rows that depend on one of them (a request whose tool calls changed, a
//! resource access whose invocation changed), and any row that still has no
//! record, and otherwise leaves the records table as it is. A fingerprint
//! change, a state file without a mark, or the first run after this build
//! emits everything once. The mark is stored by the run only after the
//! records are persisted (`Outcome::after_persist`).

use std::collections::HashSet;

use observatory_contract::settings::DetailLevel;
use observatory_contract::{Adapter as AdapterId, RecordType};
use observatory_core::adapter::{BindingContext, RunContext, Sink};
use observatory_core::pyjson::digest;
use observatory_core::state::{ResourceAccessRow, State, StateError};
use serde_json::json;

use crate::agents::record_from_event as agent_record_from_event;
use crate::requests::{
    EvidenceSummary, ToolEvidenceSummary, request_from_event, request_matches_agent_setting,
};
use crate::resources::{ResourceEvidenceSummary, emit_records as emit_resource_records};
use crate::tools::{
    ToolIndex, matches_agent_setting as tool_matches_agent_setting,
    record_from_event as tool_record_from_event,
};

/// Bumped when the records derived from stored rows change shape without a
/// parser version change, so every row is emitted once more. `2`: project keys
/// and hashed tool and agent names are keyed under the install's privacy key.
pub const EMISSION_SHAPE: &str = "2";

/// What one binding's detail emission produced.
#[derive(Debug, Default)]
pub struct Emission {
    pub records_emitted: u64,
    /// The mark the run stores once these records are persisted.
    pub after_persist: Option<(String, String)>,
}

/// The evidence summaries a run accumulates across bindings; every stored
/// request still counts toward them whether or not its record is re-emitted.
pub struct Evidence<'a> {
    pub requests: &'a mut EvidenceSummary,
    pub tools: &'a mut ToolEvidenceSummary,
    pub resources: &'a mut ResourceEvidenceSummary,
}

/// Which stored rows need a record this run.
struct Changes {
    all: bool,
    requests: HashSet<String>,
    tools: HashSet<String>,
    invocations: HashSet<String>,
    agents: HashSet<String>,
    resources: HashSet<String>,
    existing_requests: HashSet<String>,
    existing_tools: HashSet<String>,
    existing_agents: HashSet<String>,
    existing_resources: HashSet<String>,
}

impl Changes {
    fn everything() -> Self {
        Changes {
            all: true,
            requests: HashSet::new(),
            tools: HashSet::new(),
            invocations: HashSet::new(),
            agents: HashSet::new(),
            resources: HashSet::new(),
            existing_requests: HashSet::new(),
            existing_tools: HashSet::new(),
            existing_agents: HashSet::new(),
            existing_resources: HashSet::new(),
        }
    }

    fn since(state: &State, binding: &str, adapter: &str, after: i64) -> Result<Self, StateError> {
        let mut requests = state.changed_event_ids(binding, after)?;
        let mut tools = HashSet::new();
        let mut invocations = HashSet::new();
        for event in state.changed_tool_events(binding, after)? {
            if let Some(request) = event.caller_request_key {
                requests.insert(request);
            }
            tools.insert(event.id);
            invocations.insert(event.invocation_key);
        }
        let existing =
            |record_type: RecordType| state.record_semantic_keys(binding, adapter, record_type.as_str());
        Ok(Changes {
            all: false,
            requests,
            tools,
            invocations,
            agents: state.changed_agent_event_ids(binding, after)?,
            resources: state.changed_resource_access_ids(binding, after)?,
            existing_requests: existing(RecordType::ActivityRequest)?,
            existing_tools: existing(RecordType::ToolEvent)?,
            existing_agents: existing(RecordType::AgentEvent)?,
            existing_resources: existing(RecordType::ResourceAccess)?,
        })
    }

    fn request(&self, id: &str) -> bool {
        self.all || self.requests.contains(id) || !self.existing_requests.contains(id)
    }

    fn tool(&self, id: &str) -> bool {
        self.all || self.tools.contains(id) || !self.existing_tools.contains(id)
    }

    fn agent(&self, id: &str) -> bool {
        self.all || self.agents.contains(id) || !self.existing_agents.contains(id)
    }

    fn resource(&self, row: &ResourceAccessRow) -> bool {
        self.all
            || self.resources.contains(&row.id)
            || self.invocations.contains(&row.invocation_key)
            || !self.existing_resources.contains(&row.id)
    }
}

/// Everything the record shape and selection depend on, as a digest, for the
/// given emission shape (`EMISSION_SHAPE` for this build).
pub fn fingerprint(ctx: &RunContext, parser_version: &str, shape: &str) -> String {
    let execution = &ctx.settings.execution;
    digest(&json!([
        shape,
        parser_version,
        execution.detail_level.as_str(),
        execution.tool_detail.as_str(),
        execution.include_subagents,
        ctx.effective_project_attribution().as_str(),
        ctx.effective_resource_attribution(),
        ctx.resources.scan_digest,
    ]))
    .as_str()
    .to_owned()
}

fn mark_key(adapter: AdapterId, binding: &str) -> String {
    format!("emitted:{}:{binding}", adapter.as_str())
}

/// Decides what to emit for one binding and the mark to store afterwards.
fn changes(
    state: &State,
    ctx: &RunContext,
    binding: &str,
    adapter: AdapterId,
    parser_version: &str,
) -> Result<(Changes, Option<(String, String)>), StateError> {
    let Some(current) = state.change_generation()? else {
        // Never run through `execute`: nothing stamps rows, so nothing can be skipped.
        return Ok((Changes::everything(), None));
    };
    let fingerprint = fingerprint(ctx, parser_version, EMISSION_SHAPE);
    let key = mark_key(adapter, binding);
    let mark = format!("{current}:{fingerprint}");
    let after = state.meta(&key)?.and_then(|stored| {
        let (generation, stored_fingerprint) = stored.split_once(':')?;
        (stored_fingerprint == fingerprint).then(|| generation.parse::<i64>().ok()).flatten()
    });
    let changes = match after {
        // A mark at or past the current generation is stale state, not evidence.
        Some(after) if after < current => Changes::since(state, binding, adapter.as_str(), after)?,
        _ => Changes::everything(),
    };
    Ok((changes, Some((key, mark))))
}

/// Emits the detail records of one binding that need (re)emitting. The caller
/// has already scanned the binding's transcripts in this run.
#[allow(clippy::too_many_arguments)]
pub fn emit_detail(
    state: &State,
    ctx: &RunContext,
    binding: &BindingContext,
    adapter: AdapterId,
    parser_version: &str,
    evidence: Evidence<'_>,
    sink: &mut dyn Sink,
) -> Result<Emission, StateError> {
    let binding_id = binding.binding_id.as_str();
    let detail_level = ctx.settings.execution.detail_level;
    let tool_detail = ctx.settings.execution.tool_detail;
    let include_subagents = ctx.settings.execution.include_subagents;
    let project_attribution = ctx.effective_project_attribution();
    let mut emission = Emission::default();
    if detail_level == DetailLevel::BucketsOnly {
        return Ok(emission);
    }
    let tool_events = state.tool_events(binding_id)?;
    evidence.tools.observe(&tool_events, state.tool_coverage(binding_id)?);
    evidence.resources.observe(state.resource_inspection_counts(binding_id)?);
    let (changes, after_persist) = changes(state, ctx, binding_id, adapter, parser_version)?;
    let index = ToolIndex::new(&tool_events);
    for event in state.request_events(binding_id)? {
        if !request_matches_agent_setting(&event, include_subagents) {
            continue;
        }
        evidence.requests.observe(&event);
        if !changes.request(&event.id) {
            continue;
        }
        if let Some(record) = request_from_event(
            &binding.binding_id,
            &ctx.privacy_key,
            adapter,
            parser_version,
            detail_level,
            project_attribution,
            tool_detail,
            include_subagents,
            &index,
            &event,
        ) {
            sink.emit(record, None);
            emission.records_emitted += 1;
        }
    }
    if include_subagents {
        for event in state.agent_events(binding_id)? {
            if !changes.agent(&event.id) {
                continue;
            }
            if let Some(record) = agent_record_from_event(
                &binding.binding_id,
                &ctx.privacy_key,
                adapter,
                parser_version,
                tool_detail,
                &event,
            ) {
                sink.emit(record, None);
                emission.records_emitted += 1;
            }
        }
    }
    if detail_level == DetailLevel::RequestsWithTools {
        for event in &tool_events {
            if !tool_matches_agent_setting(event, include_subagents) || !changes.tool(&event.id) {
                continue;
            }
            if let Some(record) =
                tool_record_from_event(&binding.binding_id, adapter, parser_version, tool_detail, event)
            {
                sink.emit(record, None);
                emission.records_emitted += 1;
            }
        }
        if ctx.effective_resource_attribution() {
            emission.records_emitted += emit_resource_records(
                state,
                binding,
                adapter,
                parser_version,
                include_subagents,
                &tool_events,
                &|row| changes.resource(row),
                sink,
            )?;
        }
    }
    emission.after_persist = after_persist;
    Ok(emission)
}
