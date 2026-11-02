use dbx_sql_schema::native_job_changes::native_job_dameng_create_plan;
use dbx_types::native_jobs::*;
use serde_json::json;

fn definition(enabled: bool) -> NativeJobDamengCreate {
    serde_json::from_value(json!({
        "name":"Daily_job", "enabled":enabled,
        "configuration":{
            "attributes":[{"name":"DESCRIBE","change":{"kind":"set","value":"owner's job"}}],
            "steps":[
                {"kind":"add","name":"first","attributes":[
                    {"name":"COMMAND_INPUT","change":{"kind":"set","value":"BEGIN work(':dbx_created_job_id'); END;"}},
                    {"name":"SUCC_ACTION","change":{"kind":"set","value":3}},
                    {"name":"SUCC_NEXT_STEP","change":{"kind":"set","value":"last"}}
                ]},
                {"kind":"add","name":"last","attributes":[{"name":"TYPE","change":{"kind":"set","value":3}}]}
            ],
            "schedules":[{"kind":"add","name":"daily","attributes":[
                {"name":"DURING_START_DATE","change":{"kind":"set","value":"2026-10-21"}}
            ]}]
        }
    }))
    .unwrap()
}

#[test]
fn creates_disabled_before_configuration_and_never_invents_a_native_id() {
    let plan = native_job_dameng_create_plan(&definition(true)).unwrap();
    assert_eq!(plan.steps[0].id, "create");
    assert!(plan.steps[0].sql.contains("SP_CREATE_JOB('Daily_job', 0,"));
    assert!(plan.steps[0].sql.contains("'owner''s job'"));
    let ids = plan.steps.iter().map(|step| step.id.as_str()).collect::<Vec<_>>();
    assert_eq!(&ids[1..3], &["pause", "config_start"]);
    assert_eq!(&ids[ids.len() - 2..], &["config_commit", "enable"]);
    assert!(plan.steps.iter().all(|step| !step.sql.contains("WHERE ID = 1")));
    let sql = plan.steps.iter().map(|step| step.sql.as_str()).collect::<Vec<_>>().join("\n");
    assert!(sql.contains("work('':dbx_created_job_id'')"));
    let last_add = plan.steps.iter().rposition(|step| step.sql.contains("SP_ADD_JOB_STEP_EX")).unwrap();
    let link = plan.steps.iter().position(|step| step.sql.contains("SP_JOB_STEP_SET_NEXT_STEP")).unwrap();
    assert!(last_add < link);
}

#[test]
fn disabled_creation_still_ends_configuration_without_activation() {
    let plan = native_job_dameng_create_plan(&definition(false)).unwrap();
    assert_eq!(plan.steps.last().unwrap().id, "config_commit");
    assert!(!plan.steps.iter().any(|step| step.id == "enable"));
}

#[test]
fn validates_complete_children_and_dependencies_before_dispatch() {
    let mut input = definition(true);
    input.configuration.steps.pop();
    assert_eq!(native_job_dameng_create_plan(&input).err(), Some("native_job_step_dependency_requires_correction"));
    input.configuration.steps = vec![NativeJobDamengChildChange::Drop { name: "not_created".into() }];
    assert_eq!(native_job_dameng_create_plan(&input).err(), Some("native_job_creation_children_must_be_new"));
    input.configuration.steps.clear();
    input.name = "bad,name".into();
    assert_eq!(native_job_dameng_create_plan(&input).err(), Some("native_job_name_invalid"));
}

#[test]
fn notification_references_are_resolved_before_create_and_not_defaulted_to_other_operators() {
    let mut input = definition(false);
    input.configuration.attributes.extend(
        serde_json::from_value::<Vec<NativeJobAttributeChange>>(json!([
            {"name":"ENABLE_EMAIL","change":{"kind":"set","value":true}},
            {"name":"EMAIL_OPERATOR_NAME","change":{"kind":"set","value":"OnCall"}},
            {"name":"EMAIL_TYPE","change":{"kind":"set","value":2}}
        ]))
        .unwrap(),
    );
    let plan = native_job_dameng_create_plan(&input).unwrap();
    assert!(plan.configuration.operator_query().unwrap().sql.contains("UPPER('OnCall')"));
    assert!(plan.steps[0].sql.contains("SP_CREATE_JOB('Daily_job', 0, 1, dbx_email_operator, 2"));
    input.configuration.attributes.retain(|attribute| attribute.name != "EMAIL_OPERATOR_NAME");
    assert_eq!(native_job_dameng_create_plan(&input).err(), Some("native_job_notification_operator_required"));
}

#[test]
fn creation_has_one_authoritative_activation_choice() {
    let mut input = definition(true);
    input.configuration.attributes.push(NativeJobAttributeChange {
        name: "ENABLE".into(),
        change: NativeJobFieldChange::Set { value: json!(false) },
    });
    assert_eq!(native_job_dameng_create_plan(&input).err(), Some("native_job_duplicate_attribute"));
}
