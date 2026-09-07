use super::*;
use serde_json::json;

fn policy() -> McpResultProtectionPolicy {
    serde_json::from_value(json!({
        "default": { "enabled": true, "rules": [
            { "id": "phone", "columnPattern": "phone", "action": "partial", "keepPrefix": 3, "keepSuffix": 4 },
            { "id": "secrets", "columnPattern": "password|token", "action": "remove" }
        ] }
    }))
    .unwrap()
}

fn result(columns: &[&str], rows: Value) -> QueryResult {
    serde_json::from_value(json!({
        "columns": columns, "rows": rows, "affected_rows": 0, "execution_time_ms": 1
    }))
    .unwrap()
}

fn protect(
    policy: &McpResultProtectionPolicy,
    sql: &str,
    result: &mut QueryResult,
) -> Result<Vec<ResultProtectionHit>, String> {
    let protector = policy.compile("conn", "db")?.unwrap();
    let projection = protector.projection(sql, DatabaseType::Sqlite, "db", "main")?;
    protector.protect(result, &projection)
}

#[test]
fn protects_aliases_and_removes_all_parallel_metadata() {
    let mut result = result(
        &["remark", "password", "token", "name"],
        json!([["13812345678", "raw-password", "raw-token", "Alice"]]),
    );
    result.messages.push(crate::types::QueryMessage {
        severity: "NOTICE".to_string(),
        message: "raw-password".to_string(),
        code: None,
        detail: Some("raw-token".to_string()),
        hint: None,
    });
    result.elasticsearch_raw_body = Some("raw-password".to_string());
    result.session_id = Some("raw-token".to_string());
    let hits = protect(&policy(), "SELECT phone AS remark, password, token, name FROM users", &mut result).unwrap();
    assert_eq!(result.columns, ["remark", "name"]);
    assert_eq!(result.rows, [vec![json!("138***5678"), json!("Alice")]]);
    let wire = serde_json::to_string(&result).unwrap();
    for secret in ["13812345678", "raw-password", "raw-token"] {
        assert!(!wire.contains(secret));
    }
    assert_eq!(hits.len(), 3);
}

#[test]
fn strict_mode_rejects_untraceable_sources_without_echoing_sql() {
    let protector = policy().compile("conn", "db").unwrap().unwrap();
    for sql in [
        "SELECT concat(phone, '-secret') AS remark FROM users",
        "SELECT phone || 'secret' AS remark FROM users",
        "SELECT json_extract(profile, '$.phone') AS remark FROM users",
        "SELECT remark FROM (SELECT phone AS remark FROM users) u",
        "WITH u AS (SELECT phone AS remark FROM users) SELECT remark FROM u",
        "SELECT name FROM users UNION SELECT phone FROM users",
        "SELECT * FROM users u JOIN secrets s ON u.id = s.id",
        "SELECT name /*! UNION SELECT phone FROM users */ FROM users",
        "SELECT phone FROM users AS u(remark)",
        "SELECT broken 'raw-secret",
        "SHOW PROCESSLIST",
    ] {
        assert_eq!(
            protector.projection(sql, DatabaseType::Sqlite, "db", "main").unwrap_err().to_string(),
            SOURCE_UNRESOLVED
        );
    }
}

#[test]
fn name_only_mode_has_an_explicit_expression_boundary() {
    let mut policy = policy();
    policy.default.mode = ResultProtectionMode::NameOnly;
    let mut data = result(&["remark"], json!([["opaque-text"]]));
    protect(&policy, "SELECT concat(phone, 'suffix') AS remark FROM users", &mut data).unwrap();
    assert_eq!(data.rows[0][0], "opaque-text");
    let mut alias = result(&["remark"], json!([["13812345678"]]));
    protect(&policy, "SELECT phone AS remark FROM users", &mut alias).unwrap();
    assert_eq!(alias.rows[0][0], "138***5678");
}

#[test]
fn nested_json_and_json_text_use_the_same_rules() {
    let mut data = result(
        &["profile", "text"],
        json!([[
            { "phone": "13812345678", "nested": [{ "token": "raw-token", "name": "Alice" }] },
            r#"{"password":"raw-password","phone":"13987654321"}"#
        ]]),
    );
    protect(&policy(), "SELECT profile, text FROM users", &mut data).unwrap();
    assert_eq!(data.rows[0][0]["phone"], "138***5678");
    assert!(data.rows[0][0]["nested"][0].get("token").is_none());
    let wire = serde_json::to_string(&data).unwrap();
    for secret in ["13812345678", "13987654321", "raw-token", "raw-password"] {
        assert!(!wire.contains(secret));
    }
}

#[test]
fn partial_masks_preserve_unicode_and_hide_short_values() {
    let mut policy = policy();
    policy.default.rules[0].keep_prefix = 1;
    policy.default.rules[0].keep_suffix = 1;
    let mut data = result(&["phone"], json!([["1234"], ["12"], ["1"], [null], ["\u{4f60}\u{597d}\u{4e16}\u{754c}"]]));
    protect(&policy, "SELECT phone FROM users", &mut data).unwrap();
    assert_eq!(
        data.rows,
        [
            vec![json!("1***4")],
            vec![json!(MASK)],
            vec![json!(MASK)],
            vec![Value::Null],
            vec![json!("\u{4f60}***\u{754c}")]
        ]
    );
}

#[test]
fn hash_is_stable_and_keyed() {
    let mut policy = policy();
    policy.default.rules[0].action = ResultProtectionAction::Hash;
    policy.hash_key = Some("01234567890123456789012345678901".to_string());
    let mut first = result(&["phone"], json!([["13812345678"], ["13812345678"], ["13987654321"]]));
    protect(&policy, "SELECT phone FROM users", &mut first).unwrap();
    assert_eq!(first.rows[0], first.rows[1]);
    assert_ne!(first.rows[0], first.rows[2]);
    policy.hash_key = Some("different-key-01234567890123456789".to_string());
    let mut second = result(&["phone"], json!([["13812345678"]]));
    protect(&policy, "SELECT phone FROM users", &mut second).unwrap();
    assert_ne!(first.rows[0], second.rows[0]);
}

#[test]
fn denial_and_removal_are_evaluated_before_masking() {
    let mut policy = policy();
    policy.default.rules.insert(
        0,
        serde_json::from_value(json!({ "id": "mask-first", "columnPattern": ".*", "action": "mask" })).unwrap(),
    );
    policy.default.rules.push(
        serde_json::from_value(json!({ "id": "deny-value", "valuePattern": "13812345678", "action": "deny" })).unwrap(),
    );
    let mut data = result(&["phone"], json!([["13812345678"]]));
    assert_eq!(protect(&policy, "SELECT phone FROM users", &mut data).unwrap_err(), RESULT_DENIED);
    let mut nested = result(&["profile"], json!([[{ "phone": "13812345678" }]]));
    assert_eq!(protect(&policy, "SELECT profile FROM users", &mut nested).unwrap_err(), RESULT_DENIED);
}

#[test]
fn invalid_rules_scopes_shapes_and_missing_types_fail_closed() {
    let mut policy = policy();
    policy.default.rules[0].column_pattern = Some("[invalid-sensitive-pattern".to_string());
    assert_eq!(policy.validate().unwrap_err(), POLICY_INVALID);
    policy.default.rules[0].column_pattern = Some("phone".to_string());
    policy.default.rules[0].data_type_pattern = Some("varchar".to_string());
    let mut data = result(&["phone"], json!([["13812345678"]]));
    assert_eq!(protect(&policy, "SELECT phone FROM users", &mut data).unwrap_err(), SOURCE_UNRESOLVED);
    data.column_types = vec!["varchar".to_string()];
    protect(&policy, "SELECT phone FROM users", &mut data).unwrap();
    let mut malformed = result(&["phone"], json!([["13812345678", "raw-token"]]));
    assert_eq!(protect(&policy, "SELECT phone FROM users", &mut malformed).unwrap_err(), SOURCE_UNRESOLVED);
}

#[test]
fn scopes_inherit_global_then_connection_then_database() {
    let mut policy = policy();
    let disabled = ResultProtectionSettings::default();
    policy.overrides.push(ResultProtectionOverride {
        connection_id: "conn".to_string(),
        database: None,
        settings: disabled,
    });
    policy.overrides.push(ResultProtectionOverride {
        connection_id: "conn".to_string(),
        database: Some("private".to_string()),
        settings: policy.default.clone(),
    });
    assert!(policy.compile("other", "db").unwrap().is_some());
    assert!(policy.compile("conn", "db").unwrap().is_none());
    assert!(policy.compile("conn", "private").unwrap().is_some());
    policy.overrides.push(policy.overrides[0].clone());
    assert_eq!(policy.validate().unwrap_err(), POLICY_INVALID);
}

#[test]
fn disabled_default_is_compatible_and_enabled_empty_policy_is_invalid() {
    assert!(McpResultProtectionPolicy::default().compile("conn", "db").unwrap().is_none());
    let mut policy = McpResultProtectionPolicy::default();
    policy.default.enabled = true;
    assert_eq!(policy.validate().unwrap_err(), POLICY_INVALID);
    assert!(serde_json::from_value::<McpResultProtectionPolicy>(
        json!({ "default": { "enabled": true, "mode": "unknown" } })
    )
    .is_err());
}

#[test]
fn preview_reports_deny_rule_hits_without_returning_sample_values() {
    let mut policy = policy();
    policy.default.rules[0].action = ResultProtectionAction::Deny;
    let hits = preview_result_protection(ResultProtectionPreview {
        policy,
        connection_id: "conn".to_string(),
        database: "db".to_string(),
        schema: "main".to_string(),
        table: "users".to_string(),
        column: "phone".to_string(),
        data_type: "varchar".to_string(),
        value: json!("13812345678"),
    })
    .unwrap();
    assert_eq!(
        hits,
        [ResultProtectionHit {
            rule_id: "phone".to_string(),
            column: "phone".to_string(),
            action: ResultProtectionAction::Deny
        }]
    );
    assert!(!serde_json::to_string(&hits).unwrap().contains("13812345678"));
}

#[test]
fn free_text_requires_a_value_rule_and_malformed_json_fails_closed() {
    let mut policy = policy();
    let mut text = result(&["remark"], json!([["Call 13812345678 for assistance"]]));
    protect(&policy, "SELECT remark FROM users", &mut text).unwrap();
    assert_eq!(text.rows[0][0], "Call 13812345678 for assistance");
    policy.default.rules.push(
        serde_json::from_value(json!({
            "id": "phone-value", "valuePattern": "1[3-9][0-9]{9}", "action": "mask"
        }))
        .unwrap(),
    );
    protect(&policy, "SELECT remark FROM users", &mut text).unwrap();
    assert_eq!(text.rows[0][0], MASK);
    let mut malformed = result(&["profile"], json!([["{\"token\":\"raw-token\""]]));
    assert_eq!(protect(&policy, "SELECT profile FROM users", &mut malformed).unwrap_err(), RESULT_DENIED);
}

#[test]
fn partial_container_masks_cannot_expose_nested_secrets() {
    let mut policy = policy();
    policy.default.rules.insert(
        0,
        serde_json::from_value(json!({
            "id": "profile", "columnPattern": "^profile$", "action": "partial", "keepPrefix": 32
        }))
        .unwrap(),
    );
    let object = json!({ "token": "secret-8361", "padding": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    for value in [object.clone(), Value::String(object.to_string())] {
        let mut data = result(&["profile"], json!([[value]]));
        assert_eq!(protect(&policy, "SELECT profile FROM users", &mut data).unwrap_err(), RESULT_DENIED);
    }
}

#[test]
fn ambiguous_case_sensitive_column_metadata_is_rejected() {
    let protector = policy().compile("conn", "db").unwrap().unwrap();
    let mut projection =
        protector.projection("SELECT \"REMARK\" FROM public.users", DatabaseType::Postgres, "db", "public").unwrap();
    let tables = vec![crate::types::TableInfo {
        name: "users".to_string(),
        table_type: "TABLE".to_string(),
        comment: None,
        parent_schema: None,
        parent_name: None,
    }];
    let columns = vec![
        crate::types::ColumnInfo { name: "remark".to_string(), ..Default::default() },
        crate::types::ColumnInfo {
            name: "REMARK".to_string(),
            extra: Some("generated".to_string()),
            ..Default::default()
        },
    ];
    assert_eq!(projection.verify_metadata(&tables, &columns).unwrap_err(), SOURCE_UNRESOLVED);
}

#[test]
fn sqlserver_canonical_sql_rejects_non_roundtripping_identifiers() {
    let protector = policy().compile("conn", "db").unwrap().unwrap();
    for (sql, schema) in [
        ("SELECT phone FROM [dbo]].[users]] --].users", "dbo"),
        ("SELECT phone FROM users", "dbo].[users] --"),
        ("SELECT phone FROM [us]]ers]", "dbo"),
        ("SELECT [pho]]ne] FROM users", "dbo"),
        ("SELECT phone AS [r]]emark] FROM users", "dbo"),
        ("SELECT phone FROM users AS [u]]s]", "dbo"),
        ("SELECT phone FROM users WHERE [i]]d] = 1", "dbo"),
    ] {
        assert_eq!(crate::sql_risk::parse_sql_for_result_protection(sql, DatabaseType::SqlServer).unwrap().len(), 1);
        assert_eq!(
            protector.projection(sql, DatabaseType::SqlServer, "db", schema).unwrap_err(),
            SOURCE_UNRESOLVED,
            "SQL: {sql}; schema: {schema}"
        );
    }
}

#[test]
fn sqlserver_canonical_sql_preserves_safe_identifiers_and_literal_brackets() {
    let protector = policy().compile("conn", "db").unwrap().unwrap();
    for sql in [
        "SELECT phone FROM users",
        "SELECT [phone] AS [remark] FROM [dbo].[users] AS [u] WHERE [u].[id] = 1",
        "SELECT phone FROM users WHERE remark = ']]'",
        "SELECT phone FROM [user table]",
    ] {
        let projection = protector.projection(sql, DatabaseType::SqlServer, "db", "dbo").unwrap();
        assert!(protector.execution_sql(&projection, sql).contains("[dbo]."));
    }
}

#[test]
fn database_overrides_reject_aliases_and_driver_database_redirection() {
    let mut policy = policy();
    policy.overrides.push(ResultProtectionOverride {
        connection_id: "conn".to_string(),
        database: Some("app".to_string()),
        settings: ResultProtectionSettings::default(),
    });
    let mut connection: crate::models::connection::ConnectionConfig = serde_json::from_value(json!({
        "id": "conn", "name": "test", "db_type": "postgres", "host": "localhost", "port": 5432,
        "username": "test", "password": "", "database": "app"
    }))
    .unwrap();
    assert_eq!(resolve_result_database(&policy, &connection, "app").unwrap(), "app");
    assert_eq!(resolve_result_database(&policy, &connection, "APP").unwrap_err(), SOURCE_UNRESOLVED);
    for key in ["dbname", "db%6Eame"] {
        connection.url_params = Some(format!("{key}=app"));
        assert_eq!(resolve_result_database(&policy, &connection, "other").unwrap_err(), SOURCE_UNRESOLVED);
    }
    connection.url_params = Some("sslmode=require&stringtype=unspecified".to_string());
    assert_eq!(resolve_result_database(&policy, &connection, "other").unwrap(), "other");
    connection.url_params = None;
    connection.init_script = Some("SET search_path TO private".to_string());
    assert_eq!(resolve_result_database(&policy, &connection, "app").unwrap_err(), SOURCE_UNRESOLVED);
    connection.init_script = None;
    for db_type in [DatabaseType::Rqlite, DatabaseType::Turso, DatabaseType::MongoDb, DatabaseType::DuckDb] {
        connection.db_type = db_type;
        assert_eq!(resolve_result_database(&policy, &connection, "app").unwrap_err(), SOURCE_UNRESOLVED);
    }
    for db_type in [DatabaseType::Mysql, DatabaseType::SqlServer] {
        connection.db_type = db_type;
        assert_eq!(resolve_result_database(&policy, &connection, "app").unwrap(), "app");
        assert_eq!(resolve_result_database(&policy, &connection, "APP").unwrap_err(), SOURCE_UNRESOLVED);
    }
    connection.db_type = DatabaseType::Sqlite;
    assert_eq!(resolve_result_database(&policy, &connection, "MAIN").unwrap(), "main");
    assert_eq!(resolve_result_database(&policy, &connection, "other").unwrap_err(), SOURCE_UNRESOLVED);
    connection.default_schema = Some("other".to_string());
    assert_eq!(resolve_result_database(&policy, &connection, "main").unwrap_err(), SOURCE_UNRESOLVED);
    let mut duplicate = policy.overrides[0].clone();
    duplicate.database = Some("APP".to_string());
    policy.overrides.push(duplicate);
    assert_eq!(policy.validate().unwrap_err(), POLICY_INVALID);
}

#[test]
fn strict_mysql_rejects_url_setup_before_opening_any_connection() {
    let mut connection: crate::models::connection::ConnectionConfig = serde_json::from_value(json!({
        "id": "conn", "name": "test", "db_type": "mysql", "host": "localhost", "port": 3306,
        "username": "test", "password": "", "database": "app"
    }))
    .unwrap();
    let policy = policy();
    for key in ["sessionVariables", "SESSIONVARIABLES", "session%56ariables"] {
        let payload = "@a=1/*(*/;CREATE TEMPORARY TABLE users AS SELECT phone, phone AS remark FROM real_users;-- )";
        connection.url_params = Some(format!(
            "{key}={}",
            percent_encoding::utf8_percent_encode(payload, percent_encoding::NON_ALPHANUMERIC)
        ));
        assert_eq!(resolve_result_database(&policy, &connection, "app").unwrap_err(), SOURCE_UNRESOLVED);
    }
    connection.url_params = Some("sslmode=required&charset=utf8mb4".to_string());
    assert_eq!(resolve_result_database(&policy, &connection, "app").unwrap(), "app");
}

#[test]
fn database_overrides_reject_case_distinct_qualified_catalogs() {
    let protection = serde_json::from_value(json!({
        "overrides": [{ "connectionId": "conn", "database": "app", "settings": { "enabled": false } }]
    }))
    .unwrap();
    let policy = crate::storage::McpGlobalPolicy { result_protection: protection, ..Default::default() };
    let mut connection: crate::models::connection::ConnectionConfig = serde_json::from_value(json!({
        "id": "conn", "name": "test", "db_type": "mysql", "host": "localhost", "port": 3306,
        "username": "test", "password": "", "database": "app"
    }))
    .unwrap();
    for (db_type, allowed, blocked) in [
        (DatabaseType::Mysql, "SELECT phone FROM app.users", "SELECT phone FROM APP.users"),
        (DatabaseType::SqlServer, "SELECT phone FROM app.dbo.users", "SELECT phone FROM APP.dbo.users"),
    ] {
        connection.db_type = db_type;
        assert!(crate::mcp_policy::ensure_sql_database_execution_scope(&policy, &connection, "app", allowed).is_ok());
        assert_eq!(
            crate::mcp_policy::ensure_sql_database_execution_scope(&policy, &connection, "app", blocked).unwrap_err(),
            SOURCE_UNRESOLVED
        );
    }
}

#[test]
fn database_overrides_reject_unverified_statement_forms() {
    let protection = serde_json::from_value(json!({
        "default": { "enabled": true, "mode": "nameOnly" },
        "overrides": [{ "connectionId": "conn", "database": "app", "settings": { "enabled": false } }]
    }))
    .unwrap();
    let policy = crate::storage::McpGlobalPolicy { result_protection: protection, ..Default::default() };
    let mut connection: crate::models::connection::ConnectionConfig = serde_json::from_value(json!({
        "id": "conn", "name": "test", "db_type": "mysql", "host": "localhost", "port": 3306,
        "username": "test", "password": "", "database": "app"
    }))
    .unwrap();
    for (db_type, sql) in [
        (DatabaseType::Mysql, "SHOW CREATE TABLE APP.users"),
        (DatabaseType::Mysql, "SHOW CREATE TABLE app.users"),
        (DatabaseType::Mysql, "CALL APP.read_phone()"),
        (DatabaseType::Mysql, "EXPLAIN SELECT phone FROM app.users"),
        (DatabaseType::Mysql, "CREATE TABLE app.copy AS SELECT phone FROM APP.users"),
        (DatabaseType::Postgres, "(TABLE APP.users)"),
        (DatabaseType::Mysql, "SELECT APP.secret_fn()"),
        (DatabaseType::Mysql, "SELECT phone FROM app.users WHERE APP.secret_fn() = 1"),
        (DatabaseType::Mysql, "SELECT phone FROM /*!50000 APP.*/users"),
        (DatabaseType::Mysql, "/*!50000 SELECT phone FROM APP.users */"),
        (DatabaseType::Mysql, "/*M! SELECT phone FROM APP.users */"),
        (DatabaseType::Postgres, "COPY app.public.users TO STDOUT"),
        (DatabaseType::Postgres, "WITH hidden AS (TABLE APP.users) SELECT phone FROM hidden"),
        (DatabaseType::Postgres, "SELECT phone FROM users UNION SELECT phone FROM other_users"),
        (DatabaseType::Sqlite, "PRAGMA table_info('users')"),
        (DatabaseType::SqlServer, "EXEC APP.dbo.read_phone"),
        (DatabaseType::SqlServer, "SELECT phone FROM OPENQUERY(remote, 'SELECT phone FROM APP.dbo.users')"),
        (DatabaseType::SqlServer, "SELECT phone INTO APP.dbo.copy FROM app.dbo.users"),
    ] {
        connection.db_type = db_type;
        assert!(crate::sql_risk::parse_sql_for_result_protection(sql, db_type).is_ok(), "SQL: {sql}");
        assert_eq!(
            crate::mcp_policy::ensure_sql_database_execution_scope(&policy, &connection, "app", sql),
            Err(SOURCE_UNRESOLVED.to_string()),
            "SQL: {sql}"
        );
        assert!(crate::mcp_policy::ensure_sql_database_execution_scope(
            &crate::storage::McpGlobalPolicy::default(),
            &connection,
            "app",
            sql
        )
        .is_ok());
    }
}

#[test]
fn database_overrides_allow_verified_selects_and_exact_catalogs() {
    let protection = serde_json::from_value(json!({
        "overrides": [{ "connectionId": "conn", "database": "app", "settings": { "enabled": false } }]
    }))
    .unwrap();
    let policy = crate::storage::McpGlobalPolicy { result_protection: protection, ..Default::default() };
    let mut connection: crate::models::connection::ConnectionConfig = serde_json::from_value(json!({
        "id": "conn", "name": "test", "db_type": "mysql", "host": "localhost", "port": 3306,
        "username": "test", "password": "", "database": "app"
    }))
    .unwrap();
    for db_type in [DatabaseType::Mysql, DatabaseType::Postgres, DatabaseType::Sqlite, DatabaseType::SqlServer] {
        connection.db_type = db_type;
        for sql in [
            "SELECT 1",
            "SELECT phone AS remark FROM users WHERE id = 1 AND phone IS NOT NULL ORDER BY id",
            "SELECT phone FROM users; SELECT phone FROM users WHERE id IN (1, 2)",
            "/* ordinary comment */ SELECT phone FROM users",
        ] {
            assert!(
                crate::mcp_policy::ensure_sql_database_execution_scope(&policy, &connection, "app", sql).is_ok(),
                "SQL: {sql}; dialect: {db_type:?}"
            );
        }
    }
}

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable PostgreSQL database"]
async fn postgres_metadata_rejects_inherited_and_partitioned_parents() {
    use crate::db::postgres;
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool = postgres::connect(&url, std::time::Duration::from_secs(5)).await.unwrap();
    let schema = format!("dbx_mcp_{}", uuid::Uuid::new_v4().simple());
    postgres::execute_query(&pool, &format!("CREATE SCHEMA {schema}")).await.unwrap();
    let exercise = async {
        for sql in [
            format!("CREATE TABLE {schema}.parent (phone TEXT)"),
            format!("CREATE TABLE {schema}.child () INHERITS ({schema}.parent)"),
            format!("CREATE TABLE {schema}.partitioned (phone TEXT) PARTITION BY RANGE (phone)"),
            format!("CREATE TABLE {schema}.part PARTITION OF {schema}.partitioned DEFAULT"),
        ] {
            postgres::execute_query(&pool, &sql).await?;
        }
        let inherited = postgres::get_columns_for_result_protection(&pool, &schema, "parent").await;
        let partitioned = postgres::get_columns_for_result_protection(&pool, &schema, "partitioned").await;
        let leaf = postgres::get_columns_for_result_protection(&pool, &schema, "child").await?;
        Ok::<_, String>((inherited, partitioned, leaf))
    }
    .await;
    postgres::execute_query(&pool, &format!("DROP SCHEMA {schema} CASCADE")).await.unwrap();
    let (inherited, partitioned, leaf) = exercise.unwrap();
    assert_eq!(inherited.unwrap_err(), SOURCE_UNRESOLVED);
    assert_eq!(partitioned.unwrap_err(), SOURCE_UNRESOLVED);
    assert_eq!(leaf[0].name, "phone");
}
