//! The shared wire corpus (`kit-board/tests/fixtures/usage-v2/wire/`) enforced
//! three ways: every valid fixture deserializes into the types and re-serializes
//! stably; every envelope validates against the vendored schema; every invalid
//! fixture is rejected by the types and, where JSON Schema can express the
//! rule, by the schema too.

use std::fs;
use std::path::PathBuf;
use std::str::FromStr;

use jiff::Timestamp;
use observatory_contract::{Code, DetailCode, Envelope, SCHEMA_JSON};
use serde_json::Value;

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
