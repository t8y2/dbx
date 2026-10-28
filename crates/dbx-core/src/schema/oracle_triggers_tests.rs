use super::*;
use std::sync::Mutex;

fn result(columns: &[&str], rows: Value) -> db::QueryResult {
    serde_json::from_value(json!({ "columns": columns, "rows": rows, "affected_rows": 0, "execution_time_ms": 0 }))
        .unwrap()
}

fn summary(id: &str, scope: &str) -> db::QueryResult {
    result(
        &[
            "OWNER",
            "TRIGGER_NAME",
            "TRIGGERING_EVENT",
            "TRIGGER_TYPE",
            "ENABLED_STATUS",
            "TABLE_OWNER",
            "TABLE_NAME",
            "BASE_OBJECT_TYPE",
            "OBJECT_ID",
            "LAST_DDL_TIME",
            "VALIDITY",
            "BODY",
        ],
        json!([[
            " Owner ",
            " Trigger ",
            "UPDATE",
            "BEFORE EACH ROW",
            "DISABLED",
            " Parent Owner ",
            if scope == "SCHEMA" { None } else { Some(" Parent ") },
            scope,
            id,
            "2026-10-21 08:00:00",
            "INVALID",
            "BEGIN NULL; END;"
        ]]),
    )
}

fn reader(mut boundary: impl FnMut(&str) -> Result<db::QueryResult, String> + Send + 'static) -> LegacyReader {
    LegacyReader::new(
        "oceanbase-oracle",
        Some("4.2.5.7".to_string()),
        Box::new(move |sql| {
            let response = boundary(&sql);
            Box::pin(async move { response })
        }),
    )
}

fn source_contract(text: &str, origin: &str) -> db::ObjectSource {
    serde_json::from_value(json!({
        "name":" Trigger ","schema":" Owner ","object_type":"TRIGGER","source":text,
        "trigger":{"name":" Trigger ","event":"UPDATE","timing":"BEFORE EACH ROW","enabled":false,"valid":false,
            "oracle_metadata":{"contractVersion":1,"identityMode":"exact","engine":"oceanbase-oracle","owner":" Owner ","name":" Trigger ","scope":"TABLE",
                "parent":{"owner":" Parent Owner ","name":" Parent ","objectType":"TABLE"},"objectId":"9007199254740993",
                "definition":{"origin":origin,"format":if origin == "DBMS_METADATA" {"ddl"} else {"declaration"},"complete":true},
                "reads":{"identity":{"state":"available"},"definition":{"state":"available"}},"errors":[{"sequence":1,"line":4,"position":7,"text":"Missing procedure"}]}}
    })).unwrap()
}

#[test]
fn complete_source_contract_is_clamped_at_the_core_boundary_without_discarding_raw_text_or_diagnostics() {
    let full = "TRIGGER \" Owner \".\" Trigger \" BEFORE INSERT ON \" Parent Owner \".\" Parent \" BEGIN NULL; END";
    for text in [
        full.replace("END", ""),
        full.replace("\" Trigger \"", "\"trigger\""),
        full.replace("\" Parent Owner \"", "\" Owner \""),
        format!("{full}; DROP TABLE \" Parent Owner \".\" Parent \";"),
    ] {
        let mut source = source_contract(&text, "ALL_SOURCE");
        validate_source_definition(&mut source, " Owner ", " Trigger ");
        let metadata = source.trigger.unwrap().oracle_metadata.unwrap();
        assert!(!metadata.definition.unwrap().complete, "{text}");
        assert_eq!(metadata.reads["definition"].state, "incomplete");
        assert_eq!(metadata.errors.unwrap()[0].text, "Missing procedure");
        assert_eq!(source.source, text);
    }
    let mut source = source_contract(full, "ALL_SOURCE");
    validate_source_definition(&mut source, " Owner ", " Trigger ");
    assert!(source.trigger.unwrap().oracle_metadata.unwrap().definition.unwrap().complete);
    assert_eq!(source.source, full);
    for scope in ["DATABASE", "TIMER"] {
        let mut source = source_contract(full, "ALL_SOURCE");
        let metadata = source.trigger.as_mut().unwrap().oracle_metadata.as_mut().unwrap();
        metadata.scope = scope.to_string();
        metadata.parent = None;
        validate_source_definition(&mut source, " Owner ", " Trigger ");
        assert!(!source.trigger.unwrap().oracle_metadata.unwrap().definition.unwrap().complete);
    }
}

#[test]
fn only_trusted_same_target_get_ddl_state_appendices_remain_complete() {
    let text = "CREATE TRIGGER \" Owner \".\" Trigger \" BEFORE INSERT ON \" Parent Owner \".\" Parent \" BEGIN NULL; END;\nALTER TRIGGER \" Owner \".\" Trigger \" DISABLE;";
    for (origin, complete) in [("DBMS_METADATA", true), ("ALL_SOURCE", false)] {
        let mut source = source_contract(text, origin);
        validate_source_definition(&mut source, " Owner ", " Trigger ");
        assert_eq!(source.trigger.unwrap().oracle_metadata.unwrap().definition.unwrap().complete, complete);
        assert_eq!(source.source, text);
    }
    let mut source = source_contract(text, "DBMS_METADATA");
    validate_source_definition(&mut source, " Owner ", "Trigger");
    let metadata = source.trigger.unwrap().oracle_metadata.unwrap();
    assert!(!metadata.definition.unwrap().complete);
    assert_eq!(metadata.reads["identity"].state, "incomplete");
}

#[tokio::test]
async fn visible_empty_identity_is_explicit_and_read_errors_do_not_claim_absence() {
    let mut empty = reader(|_| Ok(result(&["OWNER", "TRIGGER_NAME"], json!([]))));
    let source = empty.source(" Owner ", " Trigger ").await.unwrap();
    let metadata = source.trigger.unwrap().oracle_metadata.unwrap();
    assert_eq!(metadata.reads["identity"].state, "empty");
    assert_eq!(metadata.owner, " Owner ");
    assert_eq!(metadata.name, " Trigger ");
    assert!(metadata.object_id.is_none());
    assert!(metadata.definition.is_none());
    let mut denied = reader(|_| Err("ORA-01031".to_string()));
    assert!(denied.source(" Owner ", " Trigger ").await.unwrap_err().contains("ORA-01031"));
}

#[tokio::test]
async fn legacy_schema_discovery_filters_then_pages_and_enriches_only_the_page() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let recorded = calls.clone();
    let mut reader = reader(move |sql| {
        recorded.lock().unwrap().push(sql.to_string());
        if sql.contains("FROM ALL_OBJECTS o LEFT JOIN ALL_TAB_COMMENTS") {
            return Ok(result(
                &["OBJECT_NAME", "OBJECT_TYPE", "OWNER", "COMMENTS"],
                json!([[" Trigger ", "TRIGGER", " Owner ", null]]),
            ));
        }
        assert!(sql.contains("t.OWNER=' Owner ' AND t.TRIGGER_NAME IN (' Trigger ')"), "{sql}");
        Ok(summary("9007199254740993", "VIEW"))
    });
    let objects =
        reader.list_objects(" Owner ", Some("tri%"), Some(1), Some(2), Some(&["TRIGGER".to_string()])).await.unwrap();
    assert_eq!(objects.len(), 1);
    assert_eq!(objects[0].name, " Trigger ");
    assert_eq!(objects[0].parent_schema.as_deref(), Some(" Parent Owner "));
    let trigger = objects[0].trigger.as_ref().unwrap();
    assert_eq!((trigger.enabled, trigger.valid), (Some(false), Some(false)));
    assert_eq!(trigger.oracle_metadata.as_ref().unwrap().object_id.as_deref(), Some("9007199254740993"));
    let calls = calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    let query = &calls[0];
    assert!(query.contains("o.OWNER=' Owner '"));
    assert!(query.contains("'%T%R%I%~%%'"));
    assert!(query.find("LIKE").unwrap() < query.find("ORDER BY").unwrap());
    assert!(query.contains("ROWNUM <= 3") && query.contains("DBX_RN > 2"));
    assert!(!calls.iter().any(|query| query.contains("ALL_SOURCE")));
}

#[tokio::test]
async fn mixed_and_default_exact_lists_keep_type_specs_and_bodies_in_the_same_page() {
    for requested in [Some(vec!["TRIGGER".to_string(), "TYPE".to_string(), "TYPE_BODY".to_string()]), None] {
        let mut reader = reader(|sql| {
            if sql.contains("FROM ALL_OBJECTS o LEFT JOIN ALL_TAB_COMMENTS") {
                assert!(sql.contains("o.OWNER=' Owner '"), "{sql}");
                assert!(sql.contains("'TYPE'") && sql.contains("'TYPE BODY'") && sql.contains("'TRIGGER'"), "{sql}");
                assert!(sql.contains("ROWNUM <= 5") && sql.contains("DBX_RN > 2"), "{sql}");
                return Ok(result(
                    &["OBJECT_NAME", "OBJECT_TYPE", "OWNER", "COMMENTS"],
                    json!([
                        [" Trigger ", "TRIGGER", " Owner ", null],
                        [" Type ", "TYPE", " Owner ", null],
                        [" Type ", "TYPE_BODY", " Owner ", null]
                    ]),
                ));
            }
            assert!(sql.contains("t.TRIGGER_NAME IN (' Trigger ')"), "{sql}");
            Ok(summary("42", "VIEW"))
        });
        let objects = reader.list_objects(" Owner ", None, Some(3), Some(2), requested.as_deref()).await.unwrap();
        assert_eq!(
            objects.iter().map(|object| object.object_type.as_str()).collect::<Vec<_>>(),
            ["TRIGGER", "TYPE", "TYPE_BODY"]
        );
        assert_eq!(
            objects[0].trigger.as_ref().unwrap().oracle_metadata.as_ref().unwrap().object_id.as_deref(),
            Some("42")
        );
        for object in &objects[1..] {
            assert_eq!(object.name, " Type ");
            assert_eq!(object.schema.as_deref(), Some(" Owner "));
            assert!(object.trigger.is_none());
        }
    }
}

#[tokio::test]
async fn legacy_exact_lists_preserve_indexes_and_parent_identity_before_paging() {
    for requested in [Some(vec!["INDEX".to_string()]), Some(vec!["TRIGGER".to_string(), "INDEX".to_string()]), None] {
        let mut reader = reader(|sql| {
            assert!(sql.contains("'INDEX'"), "{sql}");
            assert!(sql.contains("i.OWNER=o.OWNER AND i.INDEX_NAME=o.OBJECT_NAME"), "{sql}");
            assert!(sql.contains("i.GENERATED='N' OR i.GENERATED IS NULL"), "{sql}");
            assert!(
                sql.starts_with("SELECT OBJECT_NAME,OBJECT_TYPE,OWNER,COMMENTS,PARENT_SCHEMA,PARENT_NAME"),
                "{sql}"
            );
            assert!(sql.find("LIKE").unwrap() < sql.find("ORDER BY").unwrap(), "{sql}");
            assert!(sql.contains("ROWNUM <= 3") && sql.contains("DBX_RN > 2"), "{sql}");
            Ok(result(
                &["OBJECT_NAME", "OBJECT_TYPE", "OWNER", "COMMENTS", "PARENT_SCHEMA", "PARENT_NAME"],
                json!([[" Index ", "INDEX", " Owner ", null, " Parent Owner ", " Parent "]]),
            ))
        });
        let objects =
            reader.list_objects(" Owner ", Some("index"), Some(1), Some(2), requested.as_deref()).await.unwrap();
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].name, " Index ");
        assert_eq!(objects[0].schema.as_deref(), Some(" Owner "));
        assert_eq!(objects[0].parent_schema.as_deref(), Some(" Parent Owner "));
        assert_eq!(objects[0].parent_name.as_deref(), Some(" Parent "));
        assert!(objects[0].trigger.is_none());
    }
}

#[tokio::test]
async fn legacy_parent_list_uses_parent_owner_instead_of_trigger_owner() {
    let mut reader = reader(|sql| {
        assert!(sql.contains("t.TABLE_OWNER=' Parent Owner ' AND t.TABLE_NAME=' Parent '"), "{sql}");
        Ok(summary("1", "VIEW"))
    });
    let triggers = reader.list_triggers(" Parent Owner ", " Parent ").await.unwrap();
    let metadata = triggers[0].oracle_metadata.as_ref().unwrap();
    assert_eq!(metadata.owner, " Owner ");
    assert_eq!(metadata.parent.as_ref().unwrap().owner, " Parent Owner ");
    assert_eq!(metadata.parent.as_ref().unwrap().object_type, "VIEW");
}

#[tokio::test]
async fn legacy_schema_source_has_no_fabricated_table_parent() {
    let mut reader = reader(|sql| {
        if sql.contains("ALL_TRIGGERS") {
            return Ok(summary("1", "SCHEMA"));
        }
        if sql.contains("ALL_SOURCE") {
            return Ok(result(&["LINE", "TEXT"], json!([[1, "TRIGGER t AFTER CREATE ON SCHEMA BEGIN NULL; END;"]])));
        }
        Ok(result(&["SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE"], json!([])))
    });
    let source = reader.source(" Owner ", " Trigger ").await.unwrap();
    let metadata = source.trigger.unwrap().oracle_metadata.unwrap();
    assert_eq!(metadata.scope_owner.as_deref(), Some(" Parent Owner "));
    assert!(metadata.parent.is_none());
}

#[tokio::test]
async fn exact_getddl_fallback_never_substitutes_current_schema_for_a_whitespace_owner() {
    let mut reader = reader(|sql| {
        if sql.contains("ALL_TRIGGERS") {
            let mut response = summary("1", "TABLE");
            response.rows[0][0] = json!(" ");
            return Ok(response);
        }
        if sql.contains("ALL_SOURCE") {
            return Ok(result(&["LINE", "TEXT"], json!([])));
        }
        if sql.contains("GET_DDL") {
            assert!(sql.contains("GET_DDL('TRIGGER',' Trigger ', ' ')"), "{sql}");
            return Ok(result(
                &["DDL"],
                json!([["CREATE TRIGGER \" \".\" Trigger \" BEFORE INSERT ON T BEGIN NULL; END;"]]),
            ));
        }
        Ok(result(&["SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE"], json!([])))
    });
    let source = reader.source(" ", " Trigger ").await.unwrap();
    assert!(source.source.contains("\" \".\" Trigger \""));
}

#[tokio::test]
async fn legacy_source_keeps_long_definition_and_reads_validity_separately_from_errors() {
    let text = format!(
        "TRIGGER \" Trigger \" BEFORE UPDATE ON \" Parent Owner \".\" Parent \" BEGIN /* {} */ NULL; END;",
        "中文😀".repeat(12_000)
    );
    let expected = text.clone();
    let mut reader = reader(move |sql| {
        assert!(!sql.contains("SHOW CREATE"));
        if sql.contains("ALL_TRIGGERS") {
            return Ok(summary("9007199254740993", "TABLE"));
        }
        if sql.contains("ALL_SOURCE") {
            return Ok(result(&["LINE", "TEXT"], json!([[1, text]])));
        }
        assert!(sql.contains("ALL_ERRORS"), "{sql}");
        Ok(result(
            &["SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE"],
            json!([[1, 7, 4, "Missing procedure", "ERROR"]]),
        ))
    });
    let source = reader.source(" Owner ", " Trigger ").await.unwrap();
    assert_eq!(source.source, expected);
    let trigger = source.trigger.unwrap();
    let metadata = trigger.oracle_metadata.unwrap();
    assert!(metadata.definition.unwrap().complete);
    assert_eq!(metadata.errors.unwrap()[0].text, "Missing procedure");
    assert_eq!((trigger.enabled, trigger.valid), (Some(false), Some(false)));
}

#[tokio::test]
async fn legacy_export_appendix_survives_reading_but_concurrent_replacement_invalidates_baseline() {
    let mut reads = 0;
    let export = "CREATE TRIGGER \" Owner \".\" Trigger \" BEFORE INSERT ON T BEGIN NULL; END;\nALTER TRIGGER \" Owner \".\" Trigger \" DISABLE;";
    let mut reader = reader(move |sql| {
        if sql.contains("ALL_TRIGGERS") {
            reads += 1;
            return Ok(summary(if reads == 1 { "1" } else { "2" }, "TABLE"));
        }
        if sql.contains("ALL_SOURCE") {
            return Ok(result(&["LINE", "TEXT"], json!([])));
        }
        if sql.contains("GET_DDL") {
            return Ok(result(&["DDL"], json!([[export]])));
        }
        Ok(result(&["SEQUENCE", "LINE", "POSITION", "TEXT", "ATTRIBUTE"], json!([])))
    });
    let source = reader.source(" Owner ", " Trigger ").await.unwrap();
    assert_eq!(source.source, export);
    let metadata = source.trigger.unwrap().oracle_metadata.unwrap();
    assert!(!metadata.definition.unwrap().complete);
    assert_eq!(metadata.reads["identity"].state, "incomplete");
}

#[tokio::test]
async fn legacy_truncated_or_gapped_source_and_denied_errors_do_not_become_complete_or_empty() {
    for truncated in [true, false] {
        let mut reader = reader(move |sql| {
            if sql.contains("ALL_TRIGGERS") {
                return Ok(summary("1", "TABLE"));
            }
            if sql.contains("ALL_SOURCE") {
                let mut response = result(&["LINE", "TEXT"], json!([[2, "TRIGGER partial BEGIN NULL; END;"]]));
                response.truncated = truncated;
                return Ok(response);
            }
            if sql.contains("GET_DDL") {
                return Err("ORA-01031".to_string());
            }
            Err("ORA-01031".to_string())
        });
        let source = reader.source(" Owner ", " Trigger ").await.unwrap();
        assert_eq!(source.source, "BEGIN NULL; END;");
        let metadata = source.trigger.unwrap().oracle_metadata.unwrap();
        assert!(!metadata.definition.unwrap().complete);
        assert!(metadata.errors.is_none());
        assert_eq!(metadata.reads["errors"].state, "denied");
    }
}
