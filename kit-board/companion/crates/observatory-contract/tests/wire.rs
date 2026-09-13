//! The shared wire corpus (`kit-board/tests/fixtures/usage-v2/wire/`) enforced
//! three ways: every valid fixture deserializes into the types and re-serializes
//! stably; every envelope validates against the vendored schema; every invalid
//! fixture is rejected by the types and, where JSON Schema can express the
//! rule, by the schema too.

use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

use jiff::Timestamp;
use observatory_contract::stable_json::{content_hash, dimensions_hash};
use observatory_contract::{AdapterCoverage, Code, DetailCode, Dimensions, Envelope, Record, SCHEMA_JSON};
use serde_json::{Value, json};

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/usage-v2/wire")
}

fn json_files(dir: PathBuf) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .unwrap_or_else(|_| panic!("missing corpus directory {}", dir.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

fn validator() -> jsonschema::Validator {
    let schema: Value = serde_json::from_str(SCHEMA_JSON).expect("vendored schema parses");
    jsonschema::validator_for(&schema).expect("vendored schema compiles")
}

fn with_defaults(mut value: Value) -> Value {
    if let Value::Object(map) = &mut value {
        map.entry("buckets").or_insert_with(|| Value::Array(Vec::new()));
        map.entry("records").or_insert_with(|| Value::Array(Vec::new()));
    }
    value
}

#[test]
fn valid_fixtures_parse_validate_and_round_trip() {
    let validator = validator();
    let now = Timestamp::now();
    let files = json_files(corpus().join("valid"));
    assert!(files.len() >= 4, "expected at least four valid fixtures");
    for path in files {
        let name = path.display();
        let text = fs::read_to_string(&path).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        if let Err(error) = validator.validate(&value) {
            panic!("{name}: schema rejects a valid fixture: {error}");
        }
        let envelope = Envelope::parse(&text, now).unwrap_or_else(|error| panic!("{name}: {error}"));
        let first = envelope.to_json().unwrap();
        let again: Envelope = serde_json::from_str(&first).unwrap();
        assert_eq!(first, again.to_json().unwrap(), "{name}: re-serialization is not stable");
        let produced: Value = serde_json::from_str(&first).unwrap();
        assert_eq!(produced, with_defaults(value), "{name}: round trip changed the document");
        assert!(validator.is_valid(&produced), "{name}: schema rejects the re-serialized envelope");
        assert_eq!(
            envelope.records.len() + envelope.buckets.len() + envelope.coverage.len(),
            count(&produced)
        );
    }
}

fn count(value: &Value) -> usize {
    ["records", "buckets", "coverage"].iter().map(|key| value[*key].as_array().map_or(0, Vec::len)).sum()
}

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn header(record_type: &str) -> Value {
    json!({
        "record_type": record_type,
        "record_id": "11111111-1111-4111-8111-111111111111",
        "binding_id": "22222222-2222-4222-8222-222222222222",
        "adapter": "claude_execution",
        "channel": "local_file",
        "observed_at": "2026-09-02T03:20:00.000Z",
        "basis": "exact",
        "parser_version": "2.1.0"
    })
}

fn activity_request() -> Value {
    let mut value = header("activity.request");
    value.as_object_mut().unwrap().extend(
        json!({
            "semantic_key": HASH_A,
            "product": "claude_code",
            "surface": "cli",
            "execution_host": "local",
            "session_hash": HASH_B,
            "session_identity": "provider",
            "parent_session_hash": null,
            "model_requested": null,
            "model_actual": null,
            "started_at": null,
            "ended_at": null,
            "tokens": { "input_fresh": 0, "input_cached": 0, "input_cache_write": 0, "output": 0, "reasoning": 0 },
            "token_accounting": { "reported_total": 0, "unclassified": 0, "composition_state": "complete" },
            "pricing": { "reasoning_effort": null, "service_tier": "priority", "speed": null, "context_window_tokens": null, "cache_write_ttl": null },
            "agent": { "key": HASH_A, "identity_basis": "derived", "parent_key": null, "parent_identity_basis": "none", "class": "main", "name": "planner", "depth": 0 },
            "tool_calls": 0,
            "tools": [],
            "project": { "key": HASH_B, "basis": "working_directory" },
            "project_hash": HASH_B,
            "client_version": null,
            "latency_ms": null,
            "outcome": "completed"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    value
}

fn account_usage_bucket() -> Value {
    let mut value = header("account.usage_bucket");
    value.as_object_mut().unwrap().extend(
        json!({
            "report_source": "anthropic_usage_report",
            "bucket_start": "2026-09-02T03:00:00.000Z",
            "bucket_end": "2026-09-02T04:00:00.000Z",
            "provider_timezone": null,
            "dimensions": {
                "model": null, "product": null, "client": null,
                "user_ref": null, "workspace_ref": null, "api_key_ref": null,
                "pricing": { "reasoning_effort": null, "service_tier": null, "speed": null, "context_window_tokens": null, "cache_write_ttl": null }
            },
            "measures": {
                "requests": 1, "input_tokens": 3, "cached_tokens": 2,
                "cache_write_tokens": 1, "output_tokens": 4,
                "reasoning_tokens": 0, "total_tokens": 12
            },
            "token_accounting": { "reported_total": 12, "unclassified": 2, "composition_state": "complete" },
            "provider_event_id": null,
            "provider_refreshed_at": null
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    value
}

fn violations(value: Value) -> Vec<observatory_contract::Violation> {
    let record: Record = serde_json::from_value(value).expect("record shape");
    let now = Timestamp::from_str("2026-09-03T00:00:00Z").unwrap();
    let mut violations = Vec::new();
    record.validate(now, "record", &mut violations);
    violations
}

#[test]
fn extended_request_accepts_null_model_and_checks_detail_invariants() {
    let value = activity_request();
    let record: Record = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(record.semantic_key(), HASH_A);
    assert!(violations(value.clone()).is_empty());

    let mut bad_accounting = value.clone();
    bad_accounting["token_accounting"]["unclassified"] = json!(1);
    assert!(violations(bad_accounting).iter().any(|v| v.path.ends_with("unclassified")));

    let mut bad_agent = value.clone();
    bad_agent["agent"]["identity_basis"] = json!("unknown");
    assert!(violations(bad_agent).iter().any(|v| v.path.ends_with("agent.key")));

    let mut bad_project = value;
    bad_project["project_hash"] = json!(HASH_A);
    assert!(violations(bad_project).iter().any(|v| v.path.ends_with("project_hash")));
}

#[test]
fn complete_accounting_reconciles_a_reported_unclassified_remainder() {
    let mut value = activity_request();
    value["tokens"] = json!({
        "input_fresh": 3, "input_cached": 2, "input_cache_write": 1,
        "output": 4, "reasoning": 0
    });
    value["token_accounting"] =
        json!({ "reported_total": 12, "unclassified": 2, "composition_state": "complete" });
    assert!(violations(value.clone()).is_empty());

    value["token_accounting"]["unclassified"] = json!(0);
    assert!(violations(value).iter().any(|v| v.path.ends_with("unclassified")));

    let mut derived_total = activity_request();
    derived_total["token_accounting"] =
        json!({ "reported_total": null, "unclassified": null, "composition_state": "complete" });
    assert!(violations(derived_total.clone()).is_empty());
    derived_total["token_accounting"]["unclassified"] = json!(1);
    assert!(violations(derived_total).iter().any(|v| v.path.ends_with("unclassified")));

    let mut partial = activity_request();
    partial["tokens"]["input_cached"] = Value::Null;
    partial["token_accounting"] =
        json!({ "reported_total": 2, "unclassified": 2, "composition_state": "partial" });
    assert!(violations(partial).is_empty());

    assert!(violations(account_usage_bucket()).is_empty());
}

#[test]
fn reasoning_only_evidence_selects_partial_or_inconsistent_accounting() {
    let reasoning_only = json!({
        "input_fresh": null, "input_cached": null, "input_cache_write": null,
        "output": null, "reasoning": 5
    });

    let mut request = activity_request();
    request["tokens"] = reasoning_only;
    request["token_accounting"] =
        json!({ "reported_total": null, "unclassified": null, "composition_state": "partial" });
    assert!(violations(request.clone()).is_empty());

    request["token_accounting"] =
        json!({ "reported_total": null, "unclassified": null, "composition_state": "unknown" });
    assert!(violations(request.clone()).iter().any(|v| v.path.ends_with("composition_state")));

    request["token_accounting"] =
        json!({ "reported_total": 3, "unclassified": 3, "composition_state": "partial" });
    assert!(violations(request.clone()).iter().any(|v| v.path.ends_with("composition_state")));

    request["token_accounting"] =
        json!({ "reported_total": 3, "unclassified": null, "composition_state": "inconsistent" });
    assert!(violations(request).is_empty());

    let mut bucket = account_usage_bucket();
    bucket["measures"] = json!({
        "requests": 1, "input_tokens": null, "cached_tokens": null,
        "cache_write_tokens": null, "output_tokens": null,
        "reasoning_tokens": 5, "total_tokens": 3
    });
    bucket["token_accounting"] =
        json!({ "reported_total": 3, "unclassified": 3, "composition_state": "partial" });
    assert!(violations(bucket.clone()).iter().any(|v| v.path.ends_with("composition_state")));

    bucket["token_accounting"] =
        json!({ "reported_total": 3, "unclassified": null, "composition_state": "inconsistent" });
    assert!(violations(bucket).is_empty());
}

#[test]
fn request_accounting_uses_reasoning_as_the_output_lower_bound() {
    let mut request = activity_request();
    request["tokens"] = json!({
        "input_fresh": 60, "input_cached": 0, "input_cache_write": 0,
        "output": null, "reasoning": 50
    });
    request["token_accounting"] =
        json!({ "reported_total": 100, "unclassified": 40, "composition_state": "partial" });

    let partial_violations = violations(request.clone());
    assert!(
        partial_violations.iter().any(|v| v.path.ends_with("composition_state")),
        "a reported total below known inputs plus reasoning cannot be partial"
    );
    assert!(
        partial_violations.iter().all(|v| !v.path.ends_with("unclassified")),
        "the remainder still excludes reasoning because it is a subset of output"
    );

    request["token_accounting"] =
        json!({ "reported_total": 100, "unclassified": null, "composition_state": "inconsistent" });
    assert!(violations(request).is_empty());
}

#[test]
fn bucket_accounting_uses_reasoning_as_the_output_lower_bound() {
    let mut bucket = account_usage_bucket();
    bucket["measures"] = json!({
        "requests": 1, "input_tokens": 60, "cached_tokens": 0,
        "cache_write_tokens": 0, "output_tokens": null,
        "reasoning_tokens": 50, "total_tokens": 100
    });
    bucket["token_accounting"] =
        json!({ "reported_total": 100, "unclassified": 40, "composition_state": "partial" });

    let partial_violations = violations(bucket.clone());
    assert!(
        partial_violations.iter().any(|v| v.path.ends_with("composition_state")),
        "a reported total below known inputs plus reasoning cannot be partial"
    );
    assert!(
        partial_violations.iter().all(|v| !v.path.ends_with("unclassified")),
        "the remainder still excludes reasoning because it is a subset of output"
    );

    bucket["token_accounting"] =
        json!({ "reported_total": 100, "unclassified": null, "composition_state": "inconsistent" });
    assert!(violations(bucket).is_empty());
}

#[test]
fn optional_extensions_allow_omission_but_reject_explicit_null() {
    let mut legacy_request = activity_request();
    for field in ["token_accounting", "pricing", "agent", "project", "tools"] {
        legacy_request.as_object_mut().unwrap().remove(field);
    }
    assert!(serde_json::from_value::<Record>(legacy_request).is_ok());

    for field in ["token_accounting", "pricing", "agent", "project", "tools"] {
        let mut value = activity_request();
        value[field] = Value::Null;
        assert!(serde_json::from_value::<Record>(value).is_err(), "activity.request.{field}");
    }

    let mut legacy_bucket = account_usage_bucket();
    legacy_bucket.as_object_mut().unwrap().remove("token_accounting");
    legacy_bucket["dimensions"].as_object_mut().unwrap().remove("pricing");
    assert!(serde_json::from_value::<Record>(legacy_bucket).is_ok());

    let mut null_accounting = account_usage_bucket();
    null_accounting["token_accounting"] = Value::Null;
    assert!(serde_json::from_value::<Record>(null_accounting).is_err());

    let mut null_pricing = account_usage_bucket();
    null_pricing["dimensions"]["pricing"] = Value::Null;
    assert!(serde_json::from_value::<Record>(null_pricing).is_err());
}

#[test]
fn event_records_keep_invocation_and_lifecycle_identity_distinct() {
    let mut agent = header("agent.event");
    agent.as_object_mut().unwrap().extend(
        json!({
            "semantic_key": HASH_A,
            "event_kind": "spawn",
            "session_hash": null,
            "agent": { "key": null, "identity_basis": "unknown", "parent_key": null, "parent_identity_basis": "unknown", "class": "unknown", "name": null, "depth": null },
            "tool_invocation_key": null,
            "outcome": "failed"
        })
        .as_object().unwrap().clone(),
    );
    assert!(violations(agent.clone()).is_empty());
    agent["outcome"] = json!("succeeded");
    assert!(violations(agent).iter().any(|v| v.path.ends_with("agent.key")));

    let mut tool = header("tool.event");
    tool.as_object_mut().unwrap().extend(
        json!({
            "semantic_key": HASH_A,
            "invocation_key": HASH_A,
            "event_kind": "invocation",
            "session_hash": HASH_B,
            "caller_request_key": null,
            "caller_agent_key": null,
            "parent_invocation_key": null,
            "tool": { "name": "Read", "namespace": "builtin", "class": "builtin" },
            "outcome": "succeeded"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    assert!(violations(tool.clone()).is_empty());
    tool["event_kind"] = json!("result");
    assert!(violations(tool).iter().any(|v| v.path.ends_with("semantic_key")));

    let mut resource = header("resource.access");
    resource.as_object_mut().unwrap().extend(
        json!({
            "semantic_key": HASH_B,
            "invocation_key": HASH_A,
            "resource_key": "repo_docs",
            "configuration_version": "v1",
            "access_kind": "search",
            "evidence_basis": "explicit_argument",
            "outcome": "succeeded"
        })
        .as_object()
        .unwrap()
        .clone(),
    );
    let resource: Record = serde_json::from_value(resource).unwrap();
    assert_eq!(resource.record_type().as_str(), "resource.access");
    assert_eq!(resource.semantic_key(), HASH_B);
}

#[test]
fn capability_coverage_is_optional_but_unique_when_present() {
    let mut value = json!({
        "adapter": "claude_execution", "state": "ok", "detail_code": null,
        "stores_discovered": 1, "files": 1, "bytes_read": 1, "records_emitted": 1,
        "malformed": 0, "rejected_by_server": 0, "duration_ms": 1,
        "cursor_state": "complete", "probe_requests": 0, "parser_version": "2.1.0"
    });
    let legacy: AdapterCoverage = serde_json::from_value(value.clone()).unwrap();
    assert!(serde_json::to_value(legacy).unwrap().get("capabilities").is_none());

    let mut explicit_null = value.clone();
    explicit_null["capabilities"] = Value::Null;
    assert!(serde_json::from_value::<AdapterCoverage>(explicit_null).is_err());

    value["capabilities"] = json!([
        { "dimension": "requests", "state": "complete", "detail_code": null },
        { "dimension": "requests", "state": "partial", "detail_code": "partial_read" }
    ]);
    let coverage: AdapterCoverage = serde_json::from_value(value).unwrap();
    let mut found = Vec::new();
    coverage.validate("coverage[0]", &mut found);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].path, "coverage[0].capabilities");
}

#[test]
fn detail_blocks_participate_in_hashes_without_changing_legacy_dimension_identity() {
    let legacy: Dimensions = serde_json::from_value(json!({
        "model": "claude-sonnet-4", "product": null, "client": null,
        "user_ref": null, "workspace_ref": null, "api_key_ref": null
    }))
    .unwrap();
    let empty_pricing: Dimensions = serde_json::from_value(json!({
        "model": "claude-sonnet-4", "product": null, "client": null,
        "user_ref": null, "workspace_ref": null, "api_key_ref": null,
        "pricing": { "reasoning_effort": null, "service_tier": null, "speed": null, "context_window_tokens": null, "cache_write_ttl": null }
    })).unwrap();
    let priced: Dimensions = serde_json::from_value(json!({
        "model": "claude-sonnet-4", "product": null, "client": null,
        "user_ref": null, "workspace_ref": null, "api_key_ref": null,
        "pricing": { "reasoning_effort": null, "service_tier": "priority", "speed": null, "context_window_tokens": null, "cache_write_ttl": null }
    })).unwrap();
    assert_eq!(dimensions_hash(&legacy).unwrap(), dimensions_hash(&empty_pricing).unwrap());
    assert_ne!(dimensions_hash(&legacy).unwrap(), dimensions_hash(&priced).unwrap());

    let first: Record = serde_json::from_value(activity_request()).unwrap();
    let mut revised = activity_request();
    revised["record_id"] = json!("33333333-3333-4333-8333-333333333333");
    revised["binding_id"] = json!("44444444-4444-4444-8444-444444444444");
    revised["observed_at"] = json!("2026-09-02T03:21:00.000Z");
    revised["parser_version"] = json!("2.1.1");
    let revised: Record = serde_json::from_value(revised).unwrap();
    assert_eq!(content_hash(&first).unwrap(), content_hash(&revised).unwrap());

    let mut changed = activity_request();
    changed["pricing"]["service_tier"] = json!("standard");
    let changed: Record = serde_json::from_value(changed).unwrap();
    assert_ne!(content_hash(&first).unwrap(), content_hash(&changed).unwrap());
}

#[test]
fn invalid_fixtures_are_rejected_with_their_labeled_reason() {
    let validator = validator();
    let now = Timestamp::now();
    let files = json_files(corpus().join("invalid"));
    assert!(files.len() >= 10, "expected at least ten invalid fixtures");
    for path in files {
        let name = path.display();
        let wrapper: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let reason = wrapper["reason"].as_str().unwrap_or_else(|| panic!("{name}: no reason"));
        let expressible = wrapper.get("schema_expressible").and_then(Value::as_bool).unwrap_or(true);
        let envelope = &wrapper["envelope"];
        let text = envelope.to_string();
        assert!(
            Envelope::parse(&text, now).is_err(),
            "{name} ({reason}): the types accepted an invalid envelope"
        );
        let schema_accepts = validator.is_valid(envelope);
        if expressible {
            assert!(!schema_accepts, "{name} ({reason}): the schema accepted an envelope it should reject");
        } else {
            assert!(
                schema_accepts,
                "{name} ({reason}): labeled as not expressible in JSON Schema, yet the schema rejects it"
            );
        }
    }
}

#[test]
fn vendored_schema_matches_the_generated_copy_when_present() {
    let generated =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../lib/generated/usage-v2.schema.json");
    if generated.exists() {
        assert_eq!(
            fs::read(&generated).unwrap(),
            SCHEMA_JSON.as_bytes(),
            "vendored schema differs from lib/generated"
        );
    }
}

#[test]
fn every_detail_code_is_a_valid_wire_code() {
    for code in DetailCode::ALL {
        assert!(Code::from_str(code.as_str()).is_ok(), "{code}");
    }
}
