//! The capability corpus (`kit-board/tests/fixtures/usage-v2/capabilities/`): every
//! valid document deserializes into the strict types and re-serializes stably; every
//! invalid one is rejected by the types alone, since the document carries no schema.

use std::fs;
use std::path::PathBuf;

use observatory_contract::CapabilitiesDocument;
use serde_json::Value;

fn corpus() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/usage-v2/capabilities")
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

#[test]
fn valid_documents_parse_validate_and_round_trip() {
    let files = json_files(corpus().join("valid"));
    assert!(files.len() >= 2, "expected at least two valid documents");
    for path in files {
        let name = path.display();
        let text = fs::read_to_string(&path).unwrap();
        let document: CapabilitiesDocument =
            serde_json::from_str(&text).unwrap_or_else(|error| panic!("{name}: {error}"));
        document.validate().unwrap_or_else(|error| panic!("{name}: {error}"));
        let first = serde_json::to_string(&document).unwrap();
        let again: CapabilitiesDocument = serde_json::from_str(&first).unwrap();
        assert_eq!(document, again, "{name}: re-serialization is not stable");
        let produced: Value = serde_json::from_str(&first).unwrap();
        let original: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(produced, original, "{name}: round trip changed the document");
    }
}

#[test]
fn invalid_documents_are_rejected_with_their_labeled_reason() {
    let files = json_files(corpus().join("invalid"));
    assert!(files.len() >= 4, "expected at least four invalid documents");
    for path in files {
        let name = path.display();
        let wrapper: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        let reason = wrapper["reason"].as_str().unwrap_or_default();
        assert!(!reason.is_empty(), "{name}: labeled");
        let document = wrapper["document"].to_string();
        assert!(
            serde_json::from_str::<CapabilitiesDocument>(&document).is_err(),
            "{name} ({reason}) was accepted"
        );
    }
}

#[test]
fn the_labels_feature_is_sent_only_when_true() {
    let path = corpus().join("valid").join("default-build.json");
    let original: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    assert!(original["features"].get("labels").is_none(), "a pre-2.2.0 document has no labels flag");
    let mut document: CapabilitiesDocument = serde_json::from_value(original.clone()).unwrap();
    assert!(!document.features.labels, "absent reads as false");
    assert_eq!(serde_json::to_value(&document).unwrap(), original, "false is not written");

    document.features.labels = true;
    let produced = serde_json::to_value(&document).unwrap();
    assert_eq!(produced["features"]["labels"], Value::Bool(true));
    let again: CapabilitiesDocument = serde_json::from_value(produced).unwrap();
    assert!(again.features.labels);
}
