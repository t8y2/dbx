//! Cross-language payload contract for custom type management.
//!
//! This test exists because a field-name mismatch between the TypeScript request
//! builders and the Rust `serde` shapes is invisible to every other test in the
//! suite: the Rust tests build native structs, and the frontend tests mock the
//! backend, so nothing ever crossed the wire. A domain draft sent `baseType`
//! while the enum variant expected `base_type`, and the only symptom was
//! `missing field base_type` in the SQL preview at runtime.
//!
//! The fixture is read by this test *and* by
//! `apps/desktop/src/lib/__tests__/database/customTypePayloadContract.spec.ts`,
//! so the two ends are pinned to the same bytes.

use dbx_core::types::{
    ApplyCustomTypeChangeRequest, ApplyCustomTypeDropRequest, CustomTypeChangeRequest, CustomTypeDetails,
    CustomTypeDraft, CustomTypeDraftDefinition, CustomTypeDropRequest, CustomTypeKind,
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("../../../tests/fixtures/custom-type-payload-contract.json"))
        .expect("the shared payload fixture must be valid JSON")
}

/// Assert a serialized object has no snake_case key, so a future field cannot
/// quietly ship a shape the frontend will never read.
fn assert_camel_case_keys(value: &Value, context: &str) {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                assert!(
                    !key.contains('_'),
                    "{context}: key `{key}` is snake_case; the frontend payload contract is camelCase"
                );
                assert_camel_case_keys(nested, context);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| assert_camel_case_keys(item, context)),
        _ => {}
    }
}

#[test]
fn every_draft_case_deserializes_and_re_serializes_identically() {
    let fixture = fixture();
    let cases = fixture["draftCases"].as_array().expect("draftCases");
    assert!(!cases.is_empty());

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        // Preserve the editing baseline across both transport serializers.
        let payload = serde_json::json!({ "target": case["target"], "draft": case["draft"],
            "expectedSnapshotRevision": case["details"]["snapshotRevision"] });
        assert_camel_case_keys(&payload, name);

        let request: CustomTypeChangeRequest = serde_json::from_value(payload.clone())
            .unwrap_or_else(|error| panic!("{name} must deserialize into CustomTypeChangeRequest: {error}"));

        if case.get("details").is_some() {
            assert_eq!(request.expected_snapshot_revision.as_deref(), Some("snapshot-1"));
        }

        // Round-tripping must be idempotent. Byte equality is deliberately not
        // required: `skip_serializing_if` drops an explicit `null`, and the
        // frontend types every optional field as `T | null | undefined`, so absent
        // and null are interchangeable there. Re-parsing is the property that
        // matters.
        let round_tripped = serde_json::to_value(&request).expect("serialize request");
        assert_camel_case_keys(&round_tripped, name);
        let reparsed: CustomTypeChangeRequest = serde_json::from_value(round_tripped)
            .unwrap_or_else(|error| panic!("{name}: a serialized request must deserialize again: {error}"));
        assert_eq!(reparsed, request, "{name}: round-trip must preserve the request");
    }
}

#[test]
fn the_definition_variant_fields_are_camel_case_on_the_wire() {
    let fixture = fixture();
    for case in fixture["draftCases"].as_array().expect("draftCases") {
        let name = case["name"].as_str().expect("case name");
        let definition = &case["draft"]["definition"];
        let wire_tag = definition["kind"].as_str().expect("kind");
        let request: CustomTypeChangeRequest =
            serde_json::from_value(serde_json::json!({ "target": case["target"], "draft": case["draft"] }))
                .unwrap_or_else(|error| panic!("{name}: {error}"));
        // The wire tag selects the serde variant. `None { type_kind: Base }`
        // intentionally reports the managed database kind as `base`, while its
        // serde tag remains `none`, so assert the tag by variant rather than via
        // `definition.kind()`.
        let parsed_tag = match &request.draft.definition {
            CustomTypeDraftDefinition::Enum { .. } => "enum",
            CustomTypeDraftDefinition::Composite { .. } => "composite",
            CustomTypeDraftDefinition::None { .. } => "none",
            CustomTypeDraftDefinition::Domain { .. } => "domain",
            CustomTypeDraftDefinition::Range { .. } => "range",
        };
        assert_eq!(parsed_tag, wire_tag, "{name}");

        // Naming the multi-word fields explicitly is the point of this test: a
        // missing `rename_all_fields` left them snake_case and only these
        // variants broke.
        match &request.draft.definition {
            CustomTypeDraftDefinition::Domain { base_type, not_null, .. } => {
                assert!(!base_type.is_empty(), "{name}: baseType must map to base_type");
                assert!(definition.get("notNull").is_some(), "{name}: fixture uses notNull");
                let _ = not_null;
            }
            CustomTypeDraftDefinition::Range { subtype_opclass, multirange_name, .. } => {
                assert_eq!(
                    subtype_opclass.as_deref(),
                    definition["subtypeOpclass"].as_str(),
                    "{name}: subtypeOpclass must map to subtype_opclass"
                );
                assert_eq!(
                    multirange_name.as_deref(),
                    definition["multirangeName"].as_str(),
                    "{name}: multirangeName must map to multirange_name"
                );
            }
            CustomTypeDraftDefinition::None { type_kind } => {
                assert_eq!(
                    definition["typeKind"].as_str(),
                    Some(type_kind.as_str()),
                    "{name}: typeKind must map to type_kind"
                );
            }
            CustomTypeDraftDefinition::Enum { values } => {
                assert!(!values.is_empty(), "{name}");
            }
            CustomTypeDraftDefinition::Composite { attributes } => {
                assert!(!attributes.is_empty(), "{name}");
            }
        }
    }
}

#[test]
fn every_create_draft_deserializes() {
    let fixture = fixture();
    for entry in fixture["createDrafts"].as_array().expect("createDrafts") {
        let kind = entry["kind"].as_str().expect("kind");
        let draft: CustomTypeDraft = serde_json::from_value(entry["draft"].clone())
            .unwrap_or_else(|error| panic!("create draft {kind} must deserialize: {error}"));
        assert_eq!(draft.definition.kind().as_str(), kind);
    }
}

#[test]
fn the_details_snapshot_deserializes_in_the_frontend_shape() {
    let fixture = fixture();
    for case in fixture["draftCases"].as_array().expect("draftCases") {
        let Some(details) = case.get("details") else {
            continue;
        };
        let name = case["name"].as_str().expect("case name");
        assert_camel_case_keys(details, name);
        let parsed: CustomTypeDetails = serde_json::from_value(details.clone())
            .unwrap_or_else(|error| panic!("{name}: details must deserialize: {error}"));
        assert_eq!(parsed.snapshot_revision.as_deref(), Some("snapshot-1"));
        assert_eq!(parsed.name, details["name"].as_str().unwrap(), "{name}");
        assert_eq!(parsed.kind.as_str(), details["kind"].as_str().unwrap(), "{name}");
    }
}

#[test]
fn apply_and_drop_requests_deserialize() {
    let fixture = fixture();
    for entry in fixture["applyRequests"].as_array().expect("applyRequests") {
        assert_camel_case_keys(&entry["apply"], "apply");
        let apply: ApplyCustomTypeChangeRequest = serde_json::from_value(entry["apply"].clone())
            .unwrap_or_else(|error| panic!("apply must deserialize: {error}"));
        assert_eq!(apply.expected_plan_revision, "rev-1");
    }
    for entry in fixture["dropRequests"].as_array().expect("dropRequests") {
        let request: CustomTypeDropRequest = serde_json::from_value(entry["request"].clone())
            .unwrap_or_else(|error| panic!("drop request must deserialize: {error}"));
        assert!(!request.cascade);
        assert_eq!(request.target.kind, CustomTypeKind::Enum);
        let apply: ApplyCustomTypeDropRequest = serde_json::from_value(entry["apply"].clone())
            .unwrap_or_else(|error| panic!("drop apply must deserialize: {error}"));
        assert_eq!(apply.expected_plan_revision, "drop-rev-1");
    }
}

/// The same drafts must be plannable, so the contract covers the fields the
/// planner reads rather than only the ones `serde` accepts.
#[test]
fn projectable_drafts_plan_without_contract_only_failures() {
    let fixture = fixture();
    let capabilities = dbx_core::types::CustomTypeManagementCapabilities {
        database_type: "postgres".to_string(),
        product_version: None,
        compatibility_mode: None,
        operations: dbx_core::types::CustomTypeOperation::ALL
            .iter()
            .map(|operation| (*operation, dbx_core::types::CustomTypeOperationCapability::supported()))
            .collect(),
        capability_revision: "fixture".to_string(),
    };
    for case in fixture["draftCases"].as_array().expect("draftCases") {
        let name = case["name"].as_str().expect("case name");
        let request: CustomTypeChangeRequest =
            serde_json::from_value(serde_json::json!({ "target": case["target"], "draft": case["draft"] }))
                .unwrap_or_else(|error| panic!("{name}: {error}"));
        let details: Option<CustomTypeDetails> =
            case.get("details").map(|details| serde_json::from_value(details.clone()).expect("details"));
        // This assertion is about unchanged edit drafts. Create payloads are
        // already covered by `every_create_draft_deserializes`; some deliberately
        // contain an empty name because they model the UI's initial form state,
        // which the planner correctly blocks until the user supplies one.
        let Some(details) = details else {
            continue;
        };
        let plan = dbx_sql::custom_type_sql::plan_custom_type_change(
            dbx_sql::custom_type_sql::CustomTypeSqlDialect::Postgres,
            Some(&details),
            &request,
            &capabilities,
        );
        assert!(plan.blocked_changes.is_empty(), "{name}: {:?}", plan.blocked_changes);
        // An unchanged edit draft must not plan anything. That is the proof that
        // the planner read every field the frontend sent and found no spurious
        // difference; a field that deserialized under the wrong key would show
        // up as an ALTER or blocking issue here.
        assert!(
            plan.statements.is_empty(),
            "{name}: an unchanged draft must produce no statements, got {:?}",
            plan.statements
        );
    }
}
