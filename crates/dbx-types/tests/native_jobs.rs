use dbx_types::native_jobs::{
    NativeJobLegacyReceipt, NativeJobMutation, NativeJobOperationStatus, NativeJobPreparedPlan, NativeJobRef,
    NativeJobRequest, NativeJobSnapshot,
};
use serde_json::json;

#[test]
fn legacy_ids_remain_exact_strings_across_the_transport() {
    let wire = json!({
        "scope": {"connectionId": "connection-a", "database": "", "contextId": "context-1"},
        "kind": "legacy",
        "jobId": "9007199254740993"
    });
    let target: NativeJobRef = serde_json::from_value(wire.clone()).unwrap();
    target.validate().unwrap();
    assert_eq!(serde_json::to_value(target).unwrap(), wire);
    assert!(serde_json::from_value::<NativeJobRef>(json!({
        "scope": {"connectionId": "connection-a", "database": "", "contextId": "context-1"},
        "kind": "legacy",
        "jobId": 9007199254740993_u64
    }))
    .is_err());
}

#[test]
fn snapshot_transport_preserves_parameter_states_and_complex_definitions() {
    let wire = json!({
        "ref": {
            "scope": {"connectionId": "a", "database": "tenant", "contextId": "context"},
            "kind": "scheduler", "owner": "Owner.With.Dot", "name": " Job,\"One "
        },
        "revision": "server-revision",
        "definition": {"status": "available", "value": {
            "comments": null, "auto_drop": false, "advanced": {"native": ["unchanged", 7]}
        }},
        "arguments": {"status": "available", "value": [
            {"position": 1, "dataType": "VARCHAR2", "value": {"kind": "unset"}, "editable": true},
            {"position": 2, "dataType": "VARCHAR2", "value": {"kind": "inherit"}, "editable": true},
            {"position": 3, "dataType": "VARCHAR2", "value": {"kind": "null"}, "editable": true},
            {"position": 4, "dataType": "VARCHAR2", "value": {"kind": "value", "value": ""}, "editable": true},
            {"position": 5, "dataType": "ANYDATA", "value": {"kind": "opaque", "value": {"raw": "preserved"}}, "editable": false, "reason": "unparsed"}
        ]}
    });
    let snapshot: NativeJobSnapshot = serde_json::from_value(wire.clone()).unwrap();
    snapshot.job_ref.validate().unwrap();
    assert_eq!(serde_json::to_value(snapshot).unwrap(), wire);
}

#[test]
fn noncanonical_numeric_ids_are_rejected_before_native_calls() {
    for id in ["0", "01", "-1", "1e3", "1.5", "1 OR 1=1", "١"] {
        let target: NativeJobRef = serde_json::from_value(json!({
            "scope": {"connectionId": "a", "database": "", "contextId": "context"},
            "kind": "legacy", "jobId": id
        }))
        .unwrap();
        assert_eq!(target.validate(), Err("native_job_id_invalid"), "id={id}");
    }
}

#[test]
fn empty_execution_database_remains_valid_but_missing_scope_identity_does_not() {
    let wire = json!({
        "scope": {"connectionId": "a", "database": "", "contextId": "context"},
        "kind": "dameng-native", "jobId": "42", "name": " exact name "
    });
    let target: NativeJobRef = serde_json::from_value(wire.clone()).unwrap();
    target.validate().unwrap();
    assert_eq!(serde_json::to_value(target).unwrap(), wire);
    for missing in ["connectionId", "contextId"] {
        let mut invalid = wire.clone();
        invalid["scope"][missing] = json!("");
        let target: NativeJobRef = serde_json::from_value(invalid).unwrap();
        assert_eq!(target.validate(), Err("native_job_identity_invalid"));
    }
}

#[test]
fn mutation_preview_and_partial_result_share_the_frontend_wire_contract() {
    let target = json!({"scope":{"connectionId":"c","database":"","contextId":"ctx"},"kind":"legacy","jobId":"9007199254740993"});
    let wire = json!({"target":target,"baseline":"revision","action":"update","attributes":[{"name":"WHAT","change":{"kind":"set","value":"BEGIN a('x'); END;"}}],"arguments":[]});
    let mutation: NativeJobMutation = serde_json::from_value(wire.clone()).unwrap();
    mutation.target.validate().unwrap();
    assert_eq!(serde_json::to_value(mutation).unwrap(), wire);
    let wire = json!({"planId":"opaque-plan","operationId":"opaque-operation","scope":target["scope"],"target":target,"steps":[{"id":"definition","label":"native_job_step_definition","sql":"BEGIN NULL; END;"}]});
    let plan: NativeJobPreparedPlan = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(plan).unwrap(), wire);
    let wire = json!({"operationId":"opaque-operation","target":target,"state":"finished","outcome":"partial","cancelRequested":true,"steps":[{"id":"definition","state":"applied","reason":null,"vendorCode":null},{"id":"argument:1","state":"skipped","reason":null,"vendorCode":null}],"reason":"native_job_canceled_after_dispatch"});
    let status: NativeJobOperationStatus = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(status).unwrap(), wire);
}

#[test]
fn creation_has_no_invented_native_id_and_existing_requests_keep_their_wire_shape() {
    let scope = json!({"connectionId":"c","database":"","contextId":"ctx"});
    let wire = json!({"action":"create","scope":scope,"definition":{"kind":"legacy","what":"private_call();","nextDate":"2026-10-21 10:20:30","interval":"NULL","enabled":false,"schema":"Exact Owner","instance":0}});
    let request: NativeJobRequest = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), wire);
    let wire = json!({"action":"enable","target":{"scope":scope,"kind":"legacy","jobId":"9007199254740993"},"baseline":"baseline"});
    let request: NativeJobRequest = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), wire);
    let wire = json!({"planId":"plan","operationId":"operation","scope":scope,"target":null,"steps":[]});
    let preview: NativeJobPreparedPlan = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(preview).unwrap(), wire);
    assert!(serde_json::from_value::<NativeJobRequest>(json!({"action":"create","scope":scope,"definition":{"kind":"legacy","what":"call();","nextDate":"2026-10-21 10:20:30","interval":"NULL","enabled":"false"}})).is_err());
}

#[test]
fn ob_disposal_fact_is_explicit_without_changing_old_oracle_receipts() {
    let mut wire = json!({"operationId":"op","phase":"committed","jobId":"9007199254740993"});
    let receipt: NativeJobLegacyReceipt = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(receipt.disposal_confirmed, None);
    assert!(serde_json::to_value(receipt).unwrap().get("disposalConfirmed").is_none());
    for confirmed in [false, true] {
        wire["disposalConfirmed"] = json!(confirmed);
        let receipt: NativeJobLegacyReceipt = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(receipt.disposal_confirmed, Some(confirmed));
        assert_eq!(serde_json::to_value(receipt).unwrap()["disposalConfirmed"], json!(confirmed));
    }
}

#[test]
fn scheduler_reference_changes_keep_explicit_components_and_the_final_enabled_intent() {
    let target = json!({"scope":{"connectionId":"c","database":"","contextId":"ctx"},"kind":"scheduler","owner":"Owner","name":"Job"});
    for enabled in [false, true] {
        let wire = json!({"action":"update","target":target,"baseline":"revision","finalEnabled":enabled,
            "attributes":[{"name":"PROGRAM_NAME","change":{"kind":"set","value":{"owner":"Own.er","name":"A,B\"C","kind":"program"}}}],"arguments":[]});
        let request: NativeJobRequest = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
    }
    let wire = json!({"action":"update","target":target,"baseline":"revision","attributes":[],"arguments":[]});
    let request: NativeJobRequest = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), wire);
}

#[test]
fn a_conversion_retains_its_complete_target_arguments_after_a_partial_apply() {
    let target = json!({"scope":{"connectionId":"c","database":"","contextId":"ctx"},"kind":"scheduler","owner":"Owner","name":"Job"});
    for program in [json!({"owner":"Own.er","name":"New,Program"}), serde_json::Value::Null] {
        let wire = json!({"action":"update","target":target,"baseline":"fresh-revision","finalEnabled":true,
        "attributes":[],"arguments":[],"argumentTarget":{"program":program,"arguments":[
            {"position":1,"dataType":"VARCHAR2","value":{"kind":"inherit"}},
            {"position":2,"dataType":"NUMBER","value":{"kind":"null"}}
        ]}});
        let request: NativeJobRequest = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
    }
}

#[test]
fn scheduler_creation_preserves_reference_identity_and_observed_native_generations() {
    let wire = json!({"action":"create","scope":{"connectionId":"c","database":"","contextId":"ctx"},"definition":{
        "kind":"scheduler","owner":" Exact.Owner ","name":" A,B ","program":{"owner":"ProgramOwner","name":"Program.Name"},
        "schedule":{"owner":"ScheduleOwner","name":"Calendar"},"numberOfArguments":0,"enabled":false,"autoDrop":false,
        "arguments":[{"position":1,"dataType":"VARCHAR2","value":{"kind":"inherit"}}]
    }});
    let request: NativeJobRequest = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), wire);
    let wire = json!({"operationId":"op","target":null,"observedIdentity":{"DBX_JOB_ID":"900719925474099312345","DBX_CREATED_AT":"exact generation"},
        "state":"finished","outcome":"unknown","cancelRequested":false,"steps":[],"reason":"native_job_creation_outcome_unknown"});
    let status: NativeJobOperationStatus = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(status).unwrap(), wire);
}

#[test]
fn dameng_child_configuration_preserves_native_input_names_and_null_semantics() {
    let wire = json!({"action":"configure-dameng","target":{"kind":"dameng-native","scope":{"connectionId":"c","database":"","contextId":"ctx"},"jobId":"900719925474099312345","name":"Job_1"},"baseline":"native-baseline",
    "configuration":{
        "attributes":[{"name":"ENABLE","change":{"kind":"set","value":false}}],
        "steps":[{"kind":"update","name":"backup","attributes":[{"name":"COMMAND_INPUT","change":{"kind":"set","value":"01000000E:\\backups"}},{"name":"SUCC_NEXT_STEP","change":{"kind":"clear"}}]},{"kind":"add","name":"next_step","attributes":[]}],
        "schedules":[{"kind":"drop","name":"old_schedule"}]
    }});
    let request: NativeJobRequest = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), wire);
    let request: NativeJobRequest = serde_json::from_value(json!({"action":"configure-dameng","target":wire["target"],"baseline":"native-baseline","configuration":{"steps":[{"kind":"add","name":"new_step"}]}})).unwrap();
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["configuration"]["attributes"], json!([]));
    assert_eq!(value["configuration"]["schedules"], json!([]));
    assert_eq!(value["configuration"]["steps"][0]["attributes"], json!([]));
}

#[test]
fn dameng_creation_and_acknowledged_child_ids_round_trip_without_fake_or_numeric_targets() {
    let wire = json!({"action":"create","scope":{"connectionId":"c","database":"","contextId":"ctx"},"definition":{
        "kind":"dameng-native","name":"New_job","enabled":false,"configuration":{"attributes":[],"steps":[{"kind":"add","name":"sql","attributes":[{"name":"COMMAND_INPUT","change":{"kind":"set","value":"SELECT 1;"}}]}],"schedules":[]}
    }});
    let request: NativeJobRequest = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), wire);
    let wire = json!({"operationId":"op","target":null,"state":"finished","outcome":"partial","cancelRequested":false,"steps":[],"reason":"native_failure","createdChildren":[{"partition":"steps","name":"sql","id":"900719925474099312345"}]});
    let status: NativeJobOperationStatus = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(status).unwrap(), wire);
}
