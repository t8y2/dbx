use dbx_types::types::{ObjectInfo, ObjectSource, TriggerInfo};
use serde_json::{json, Value};

#[test]
fn metadata_options_keep_the_legacy_request_shape_and_forward_exact_catalog_raw() {
    use dbx_types::oracle_trigger::{MetadataIdentityMode, MetadataReadOptions};
    let mut params = json!({"schema":" Owner ", "name":" Trigger "});
    MetadataReadOptions::default().apply_to(&mut params);
    assert_eq!(params, json!({"schema":" Owner ", "name":" Trigger "}));
    let options =
        MetadataReadOptions { identity_mode: Some(MetadataIdentityMode::Exact), catalog: Some(" Catalog ".into()) };
    options.apply_to(&mut params);
    assert_eq!(params, json!({"schema":" Owner ", "name":" Trigger ", "identity_mode":"exact", "catalog":" Catalog "}));
    assert!(serde_json::from_value::<MetadataReadOptions>(json!({"identityMode":"approximate"})).is_err());
}

fn metadata(scope: &str, parent: Value) -> Value {
    json!({
        "contractVersion": 1,
        "identityMode": "exact",
        "engine": "oceanbase-oracle",
        "engineVersion": "4.2.5.7_107",
        "owner": " Trigger Owner ",
        "name": "Mixed\"Trigger",
        "scope": scope,
        "scopeOwner": null,
        "parent": parent,
        "objectId": "9007199254740993",
        "lastDdlTime": "2026-10-21 08:00:00",
        "definition": {"origin": "ALL_SOURCE", "format": "declaration", "complete": true},
        "errors": [{"sequence": 1, "line": 4, "position": 7, "text": "Missing procedure", "severity": "ERROR"}],
        "reads": {"identity": {"state": "available"}, "errors": {"state": "available"}}
    })
}

#[test]
fn exact_trigger_metadata_preserves_raw_identity_and_independent_states() {
    let raw = json!({
        "name": "Mixed\"Trigger", "event": "INSERT", "timing": "BEFORE EACH ROW",
        "enabled": true, "valid": false,
        "oracle_metadata": metadata("VIEW", json!({"owner": " Parent Owner ", "name": " View ", "objectType": "VIEW", "objectId": "42"}))
    });
    let trigger: TriggerInfo = serde_json::from_value(raw.clone()).unwrap();
    let serialized = serde_json::to_value(trigger).unwrap();
    assert_eq!(serialized["enabled"], true);
    assert_eq!(serialized["valid"], false);
    assert_eq!(serialized["oracle_metadata"], raw["oracle_metadata"]);
}

#[test]
fn source_and_summary_transport_the_same_non_table_trigger() {
    let trigger = json!({
        "name": "Mixed\"Trigger", "event": "CREATE", "timing": "AFTER EVENT",
        "enabled": false, "valid": true,
        "oracle_metadata": metadata("SCHEMA", Value::Null)
    });
    let source: ObjectSource = serde_json::from_value(json!({
        "name": "Mixed\"Trigger", "object_type": "TRIGGER", "schema": " Trigger Owner ",
        "source": "TRIGGER definition", "trigger": trigger
    }))
    .unwrap();
    let summary: ObjectInfo = serde_json::from_value(json!({
        "name": "Mixed\"Trigger", "object_type": "TRIGGER", "schema": " Trigger Owner ",
        "trigger": trigger
    }))
    .unwrap();
    let source = serde_json::to_value(source).unwrap();
    let summary = serde_json::to_value(summary).unwrap();
    assert_eq!(source["trigger"]["oracle_metadata"], trigger["oracle_metadata"]);
    assert_eq!(source["trigger"], summary["trigger"]);
    assert!(source["trigger"]["oracle_metadata"]["parent"].is_null());
}

#[test]
fn legacy_trigger_payload_stays_unknown_and_does_not_claim_exact_support() {
    let trigger: TriggerInfo =
        serde_json::from_value(json!({"name":"T", "event":"INSERT", "timing":"BEFORE"})).unwrap();
    let serialized = serde_json::to_value(trigger).unwrap();
    assert_eq!(serialized, json!({"name":"T", "event":"INSERT", "timing":"BEFORE"}));
    let source: ObjectSource =
        serde_json::from_value(json!({"name":"T", "object_type":"TRIGGER", "source":"body"})).unwrap();
    assert!(serde_json::to_value(source).unwrap().get("trigger").is_none());
}
