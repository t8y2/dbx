use dbx_sql_schema::native_job_changes::native_job_scheduler_reference_target;
use dbx_types::native_jobs::NativeJobReferenceKind;
use serde_json::json;

#[test]
fn structured_references_preserve_components_and_choose_only_compatible_categories() {
    for (attribute, category, expected) in [
        ("PROGRAM_NAME", "program", NativeJobReferenceKind::Program),
        ("SCHEDULE_NAME", "schedule", NativeJobReferenceKind::Schedule),
        ("SCHEDULE_NAME", "window", NativeJobReferenceKind::Window),
        ("SCHEDULE_NAME", "window-group", NativeJobReferenceKind::WindowGroup),
        ("CREDENTIAL_NAME", "credential", NativeJobReferenceKind::Credential),
        ("CONNECT_CREDENTIAL_NAME", "credential", NativeJobReferenceKind::Credential),
        ("DESTINATION_NAME", "destination", NativeJobReferenceKind::Destination),
        ("DESTINATION_NAME", "destination-group", NativeJobReferenceKind::DestinationGroup),
        ("JOB_ACTION", "chain", NativeJobReferenceKind::Chain),
    ] {
        let target = native_job_scheduler_reference_target(
            attribute,
            &json!({"owner":" Own.er\" ","name":" A,B.C\" ","kind":category}),
            "JobOwner",
            "CHAIN",
        )
        .unwrap()
        .unwrap();
        assert_eq!(target.kind, expected);
        assert_eq!(target.reference.owner, " Own.er\" ");
        assert_eq!(target.reference.name, " A,B.C\" ");
        assert!(native_job_scheduler_reference_target(
            attribute,
            &json!({"owner":"Owner","name":"Name","kind":"file-watcher"}),
            "JobOwner",
            "CHAIN"
        )
        .is_err());
    }
}

#[test]
fn legacy_name_strings_use_sql_identifier_parsing_not_dot_or_comma_splitting() {
    for (value, owner, name) in [
        ("program", "Exact Job Owner", "PROGRAM"),
        ("own.program", "OWN", "PROGRAM"),
        ("\"Own.er\".\"A,B.C\"\"D\"", "Own.er", "A,B.C\"D"),
        ("\" Leading trailing \"", "Exact Job Owner", " Leading trailing "),
    ] {
        let target =
            native_job_scheduler_reference_target("PROGRAM_NAME", &json!(value), "Exact Job Owner", "STORED_PROCEDURE")
                .unwrap()
                .unwrap();
        assert_eq!(target.reference.owner, owner);
        assert_eq!(target.reference.name, name);
    }
    for value in
        ["", "A,B", "A.B.C", "a; commit", "'not an identifier'", "\"\"", "a -- comment", "a/*comment*/", "\"unclosed"]
    {
        assert!(
            native_job_scheduler_reference_target("PROGRAM_NAME", &json!(value), "Owner", "STORED_PROCEDURE").is_err(),
            "{value}"
        );
    }
}

#[test]
fn ordinary_action_bodies_are_not_parsed_as_references_and_clearing_has_no_new_target() {
    assert!(native_job_scheduler_reference_target(
        "JOB_ACTION",
        &json!("BEGIN p('a.b'); END;"),
        "Owner",
        "PLSQL_BLOCK"
    )
    .unwrap()
    .is_none());
    assert!(native_job_scheduler_reference_target("COMMENTS", &json!("A.B"), "Owner", "CHAIN").unwrap().is_none());
    assert!(native_job_scheduler_reference_target("PROGRAM_NAME", &json!(null), "Owner", "CHAIN").unwrap().is_none());
    for value in [
        json!({"owner":"", "name":"Name"}),
        json!({"owner":"Owner", "name":""}),
        json!({"owner":"Owner", "name":"a\u{0}b"}),
        json!(42),
    ] {
        assert!(native_job_scheduler_reference_target("PROGRAM_NAME", &value, "Owner", "CHAIN").is_err());
    }
}
