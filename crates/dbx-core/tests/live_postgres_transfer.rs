use dbx_core::connection::{AppState, PoolKind};
use dbx_core::db::postgres;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;
use dbx_core::transfer::{
    get_db_type, transfer_postgres_schema_dependencies, transfer_postgres_schema_objects, transfer_table, TransferMode,
    TransferObjectKind, TransferObjectSelection, TransferOwnershipPolicy, TransferRequest, TransferTableNameCase,
};
use serde_json::json;

fn postgres_test_config(id: &str, database: &str) -> ConnectionConfig {
    ConnectionConfig {
        docs_notes_path: None,
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
        db_type: DatabaseType::Postgres,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: "127.0.0.1".to_string(),
        port: 5432,
        username: "postgres".to_string(),
        password: String::new(),
        database: Some(database.to_string()),
        default_schema: None,
        visible_databases: None,
        visible_database_patterns: None,
        visible_schemas: None,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 5,
        query_timeout_secs: 30,
        idle_timeout_secs: 60,
        keepalive_interval_secs: 0,
        ssl: false,
        ca_cert_path: String::new(),
        client_cert_path: String::new(),
        client_key_path: String::new(),
        sysdba: false,
        oracle_connection_type: None,
        connection_string: None,
        redis_connection_mode: None,
        redis_sentinel_master: String::new(),
        redis_sentinel_nodes: String::new(),
        redis_sentinel_username: String::new(),
        redis_sentinel_password: String::new(),
        redis_sentinel_tls: false,
        redis_cluster_nodes: String::new(),
        redis_key_separator: dbx_core::models::connection::default_redis_key_separator(),
        redis_scan_page_size: None,
        redis_database_aliases: Default::default(),
        redis_key_templates: Vec::new(),
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        save_password: true,
        read_only: false,
        is_production: false,
        production_databases: vec![],
        show_system_schemas: false,
        database_info: None,
    }
}

async fn query_scalar(pool: &deadpool_postgres::Pool, sql: &str) -> serde_json::Value {
    postgres::execute_query(pool, sql).await.unwrap().rows[0][0].clone()
}

async fn query_index_rows(pool: &deadpool_postgres::Pool, schema: &str) -> Vec<(String, String)> {
    postgres::execute_query(
        pool,
        &format!(
            "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = '{}' AND tablename = 'index_transfer' ORDER BY indexname",
            schema
        ),
    )
    .await
    .unwrap()
    .rows
    .into_iter()
    .filter_map(|row| Some((row.first()?.as_str()?.to_string(), row.get(1)?.as_str()?.to_string())))
    .collect()
}

async fn query_index_comment(pool: &deadpool_postgres::Pool, schema: &str) -> Option<serde_json::Value> {
    postgres::execute_query(
        pool,
        &format!(
            "SELECT obj_description(i.indexrelid, 'pg_class') FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '{}' AND c.relname = 'index_transfer_status_idx'",
            schema
        ),
    )
    .await
    .ok()
    .and_then(|result| result.rows.first().and_then(|row| row.first()).cloned())
}

#[tokio::test]
#[ignore = "requires PostgreSQL URLs via DBX_LIVE_PG_TRANSFER_SOURCE_URL and DBX_LIVE_PG_TRANSFER_TARGET_URL"]
async fn live_postgres_transfer_upserts_generated_always_identity_values() {
    let source_url = std::env::var("DBX_LIVE_PG_TRANSFER_SOURCE_URL").expect("DBX_LIVE_PG_TRANSFER_SOURCE_URL");
    let target_url = std::env::var("DBX_LIVE_PG_TRANSFER_TARGET_URL").unwrap_or_else(|_| source_url.clone());
    let source_pool = postgres::connect(&source_url, std::time::Duration::from_secs(5)).await.unwrap();
    let target_pool = postgres::connect(&target_url, std::time::Duration::from_secs(5)).await.unwrap();
    let source_database = query_scalar(&source_pool, "SELECT current_database()").await.as_str().unwrap().to_string();
    let target_database = query_scalar(&target_pool, "SELECT current_database()").await.as_str().unwrap().to_string();

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_schema = format!("dbx_src_always_{}", &suffix[..8]);
    let target_schema = format!("dbx_dst_always_{}", &suffix[..8]);
    let cleanup_sql = [
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", source_schema),
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", target_schema),
    ];

    postgres::execute_batch(
        &source_pool,
        &[
            format!("CREATE SCHEMA \"{}\"", source_schema),
            format!(
                "CREATE TABLE \"{}\".\"items\" (\"id\" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, \"name\" text NOT NULL)",
                source_schema
            ),
            format!(
                "INSERT INTO \"{}\".\"items\" (\"id\", \"name\") OVERRIDING SYSTEM VALUE VALUES (42, 'Ada')",
                source_schema
            ),
        ],
    )
    .await
    .unwrap();
    postgres::execute_batch(
        &target_pool,
        &[
            format!("CREATE SCHEMA \"{}\"", target_schema),
            format!(
                "CREATE TABLE \"{}\".\"items\" (\"id\" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, \"name\" text NOT NULL)",
                target_schema
            ),
        ],
    )
    .await
    .unwrap();

    let old_sql = format!(
        "INSERT INTO \"{}\".\"items\" (\"id\", \"name\") VALUES (43, 'old-writer') ON CONFLICT (\"id\") DO UPDATE SET \"name\" = EXCLUDED.\"name\"",
        target_schema
    );
    let old_error = postgres::execute_query(&target_pool, &old_sql).await.unwrap_err();
    assert!(old_error.contains("identity column defined as GENERATED ALWAYS"), "{old_error}");

    postgres::execute_query(
        &target_pool,
        &format!(
            "INSERT INTO \"{}\".\"items\" (\"id\", \"name\") OVERRIDING SYSTEM VALUE VALUES (43, 'append')",
            target_schema
        ),
    )
    .await
    .unwrap();
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT \"name\" FROM \"{}\".\"items\" WHERE \"id\" = 43", target_schema))
            .await,
        json!("append")
    );
    postgres::execute_batch(
        &target_pool,
        &[
            format!("TRUNCATE TABLE \"{}\".\"items\"", target_schema),
            format!(
                "INSERT INTO \"{}\".\"items\" (\"id\", \"name\") OVERRIDING SYSTEM VALUE VALUES (44, 'overwrite')",
                target_schema
            ),
        ],
    )
    .await
    .unwrap();
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT \"name\" FROM \"{}\".\"items\" WHERE \"id\" = 44", target_schema))
            .await,
        json!("overwrite")
    );
    postgres::execute_query(&target_pool, &format!("TRUNCATE TABLE \"{}\".\"items\"", target_schema)).await.unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-live-always-transfer-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let source_connection_id = "live-always-source";
    let target_connection_id = "live-always-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");
    state.connections.write().await.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
    state.connections.write().await.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.to_string(), postgres_test_config(source_connection_id, &source_database));
    state
        .configs
        .write()
        .await
        .insert(target_connection_id.to_string(), postgres_test_config(target_connection_id, &target_database));

    let request = TransferRequest {
        transfer_id: format!("live-always-transfer-{suffix}"),
        source_connection_id: source_connection_id.to_string(),
        source_database: source_database.clone(),
        source_schema: source_schema.clone(),
        source_catalog: None,
        target_connection_id: target_connection_id.to_string(),
        target_database: target_database.clone(),
        target_schema: target_schema.clone(),
        target_catalog: None,
        tables: vec!["items".to_string()],
        create_table: false,
        content: dbx_core::transfer::TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Upsert,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };
    let source_db_type = get_db_type(&state, source_connection_id).await.unwrap();
    let target_db_type = get_db_type(&state, target_connection_id).await.unwrap();
    let transferred = transfer_table(
        &state,
        &request,
        "items",
        0,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
        &std::collections::HashMap::new(),
        &mut Vec::new(),
        |_| {},
    )
    .await
    .unwrap();

    assert_eq!(transferred, 1);
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT \"name\" FROM \"{}\".\"items\" WHERE \"id\" = 42", target_schema))
            .await,
        json!("Ada")
    );
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT count(*) FROM \"{}\".\"items\"", target_schema)).await,
        json!(1)
    );

    postgres::execute_query(
        &source_pool,
        &format!("UPDATE \"{}\".\"items\" SET \"name\" = 'Grace' WHERE \"id\" = 42", source_schema),
    )
    .await
    .unwrap();
    let updated = transfer_table(
        &state,
        &request,
        "items",
        0,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
        &std::collections::HashMap::new(),
        &mut Vec::new(),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(updated, 1);
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT \"name\" FROM \"{}\".\"items\" WHERE \"id\" = 42", target_schema))
            .await,
        json!("Grace")
    );

    let _ = postgres::execute_batch(&source_pool, &[cleanup_sql[0].clone()]).await;
    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
#[ignore = "requires source/target PostgreSQL URLs via DBX_LIVE_PG_TRANSFER_SOURCE_URL and DBX_LIVE_PG_TRANSFER_TARGET_URL"]
async fn live_postgres_structure_only_preserves_table_indexes() {
    let source_url = std::env::var("DBX_LIVE_PG_TRANSFER_SOURCE_URL").expect("DBX_LIVE_PG_TRANSFER_SOURCE_URL");
    let target_url = std::env::var("DBX_LIVE_PG_TRANSFER_TARGET_URL").unwrap_or_else(|_| source_url.clone());
    let source_pool = postgres::connect(&source_url, std::time::Duration::from_secs(5)).await.unwrap();
    let target_pool = postgres::connect(&target_url, std::time::Duration::from_secs(5)).await.unwrap();
    let source_database = query_scalar(&source_pool, "SELECT current_database()").await.as_str().unwrap().to_string();
    let target_database = query_scalar(&target_pool, "SELECT current_database()").await.as_str().unwrap().to_string();

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_schema = format!("dbx_src_structure_only_{}", &suffix[..8]);
    let target_schema = format!("dbx_dst_structure_only_{}", &suffix[..8]);
    let cleanup_sql = [
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", source_schema),
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", target_schema),
    ];
    let _ = postgres::execute_batch(&source_pool, &[cleanup_sql[0].clone()]).await;
    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;

    postgres::execute_batch(
        &source_pool,
        &[
            format!("CREATE SCHEMA \"{}\"", source_schema),
            format!(
                "CREATE TABLE \"{}\".\"index_transfer\" (\"id\" bigint PRIMARY KEY, \"email\" text NOT NULL, \"status\" text, \"created_at\" timestamptz)",
                source_schema
            ),
            format!(
                "CREATE INDEX \"index_transfer_status_idx\" ON \"{}\".\"index_transfer\" (\"status\")",
                source_schema
            ),
            format!(
                "CREATE UNIQUE INDEX \"index_transfer_email_uidx\" ON \"{}\".\"index_transfer\" (\"email\")",
                source_schema
            ),
            format!(
                "CREATE INDEX \"index_transfer_email_lower_idx\" ON \"{}\".\"index_transfer\" (lower(\"email\"))",
                source_schema
            ),
            format!(
                "CREATE INDEX \"index_transfer_created_at_partial_idx\" ON \"{}\".\"index_transfer\" (\"created_at\") WHERE \"status\" IS NOT NULL",
                source_schema
            ),
            format!(
                "CREATE INDEX \"index_transfer_status_include_idx\" ON \"{}\".\"index_transfer\" (\"status\") INCLUDE (\"created_at\")",
                source_schema
            ),
            format!(
                "COMMENT ON INDEX \"{}\".\"index_transfer_status_idx\" IS 'status lookup'",
                source_schema
            ),
            format!(
                "INSERT INTO \"{}\".\"index_transfer\" (\"id\", \"email\", \"status\", \"created_at\") VALUES (1, 'alpha@example.com', 'active', now())",
                source_schema
            ),
        ],
    )
    .await
    .unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-live-structure-only-transfer-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let source_connection_id = "live-structure-only-source";
    let target_connection_id = "live-structure-only-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");
    state.connections.write().await.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
    state.connections.write().await.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.to_string(), postgres_test_config(source_connection_id, &source_database));
    state
        .configs
        .write()
        .await
        .insert(target_connection_id.to_string(), postgres_test_config(target_connection_id, &target_database));

    let mut request = TransferRequest {
        transfer_id: format!("live-structure-only-transfer-{suffix}"),
        source_connection_id: source_connection_id.to_string(),
        source_database: source_database.clone(),
        source_schema: source_schema.clone(),
        source_catalog: None,
        target_connection_id: target_connection_id.to_string(),
        target_database: target_database.clone(),
        target_schema: target_schema.clone(),
        target_catalog: None,
        tables: vec!["index_transfer".to_string()],
        create_table: true,
        content: dbx_core::transfer::TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };

    transfer_postgres_schema_dependencies(&state, &request, &source_pool_key, &target_pool_key, |_| {}).await.unwrap();
    let source_db_type = get_db_type(&state, source_connection_id).await.unwrap();
    let target_db_type = get_db_type(&state, target_connection_id).await.unwrap();
    let structure_and_data_result = transfer_table(
        &state,
        &request,
        "index_transfer",
        0,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
        &std::collections::HashMap::new(),
        &mut Vec::new(),
        |_| {},
    )
    .await;

    let structure_and_data_index_rows = query_index_rows(&target_pool, &target_schema).await;
    let structure_and_data_row_count =
        query_scalar(&target_pool, &format!("SELECT count(*) FROM \"{}\".\"index_transfer\"", target_schema)).await;
    let structure_and_data_index_comment = query_index_comment(&target_pool, &target_schema).await;

    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;
    request.content = dbx_core::transfer::TransferContent::StructureOnly;
    transfer_postgres_schema_dependencies(&state, &request, &source_pool_key, &target_pool_key, |_| {}).await.unwrap();
    let structure_only_result = transfer_table(
        &state,
        &request,
        "index_transfer",
        0,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
        &std::collections::HashMap::new(),
        &mut Vec::new(),
        |_| {},
    )
    .await;
    let structure_only_index_rows = query_index_rows(&target_pool, &target_schema).await;
    let structure_only_row_count =
        query_scalar(&target_pool, &format!("SELECT count(*) FROM \"{}\".\"index_transfer\"", target_schema)).await;
    let structure_only_index_comment = query_index_comment(&target_pool, &target_schema).await;

    let _ = postgres::execute_batch(&source_pool, &[cleanup_sql[0].clone()]).await;
    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;
    let _ = std::fs::remove_dir_all(dir);

    assert_eq!(structure_and_data_result.unwrap(), 1);
    assert_eq!(structure_and_data_row_count, json!(1));
    assert_eq!(structure_only_result.unwrap(), 0);
    assert_eq!(structure_only_row_count, json!(0));
    let assert_indexes = |rows: &[(String, String)]| {
        let names = rows.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>();
        assert!(names.contains(&"index_transfer_pkey"), "target indexes: {names:?}");
        for expected in [
            "index_transfer_status_idx",
            "index_transfer_email_uidx",
            "index_transfer_email_lower_idx",
            "index_transfer_created_at_partial_idx",
            "index_transfer_status_include_idx",
        ] {
            assert!(names.contains(&expected), "missing {expected}; target indexes: {names:?}");
        }
        assert!(
            rows.iter()
                .any(|(name, definition)| name == "index_transfer_email_lower_idx" && definition.contains("lower")),
            "target indexes: {rows:?}"
        );
        assert!(
            rows.iter()
                .any(|(name, definition)| name == "index_transfer_created_at_partial_idx"
                    && definition.contains("WHERE")),
            "target indexes: {rows:?}"
        );
        assert!(
            rows.iter().any(|(name, definition)| name == "index_transfer_status_include_idx" && definition.contains("INCLUDE")),
            "target indexes: {rows:?}"
        );
    };
    assert_indexes(&structure_and_data_index_rows);
    assert_indexes(&structure_only_index_rows);
    assert_eq!(structure_and_data_index_comment, Some(json!("status lookup")));
    assert_eq!(structure_only_index_comment, Some(json!("status lookup")));
}

#[tokio::test]
#[ignore = "requires source/target PostgreSQL URLs via DBX_LIVE_PG_TRANSFER_SOURCE_URL and DBX_LIVE_PG_TRANSFER_TARGET_URL"]
async fn live_postgres_transfer_preserves_data_and_schema_objects() {
    let source_url = std::env::var("DBX_LIVE_PG_TRANSFER_SOURCE_URL").expect("DBX_LIVE_PG_TRANSFER_SOURCE_URL");
    let target_url = std::env::var("DBX_LIVE_PG_TRANSFER_TARGET_URL").unwrap_or_else(|_| source_url.clone());

    let source_pool = postgres::connect(&source_url, std::time::Duration::from_secs(5)).await.unwrap();
    let target_pool = postgres::connect(&target_url, std::time::Duration::from_secs(5)).await.unwrap();

    let source_database = query_scalar(&source_pool, "SELECT current_database()").await.as_str().unwrap().to_string();
    let target_database = query_scalar(&target_pool, "SELECT current_database()").await.as_str().unwrap().to_string();

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_schema = format!("dbx_src_{}", &suffix[..8]);
    let target_schema = format!("dbx_dst_{}", &suffix[..8]);

    let cleanup_sql = [
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", source_schema),
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", target_schema),
    ];
    let _ = postgres::execute_batch(&source_pool, &[cleanup_sql[0].clone()]).await;
    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;

    let setup_sql = vec![
        format!("CREATE SCHEMA \"{}\"", source_schema),
        format!("CREATE TYPE \"{}\".\"user_status\" AS ENUM ('active', 'disabled')", source_schema),
        format!(
            "CREATE DOMAIN \"{}\".\"email_text\" AS text CHECK (position('@' in VALUE) > 1)",
            source_schema
        ),
        format!(
            "CREATE TABLE \"{}\".\"users\" (\
                \"id\" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\
                \"email\" \"{}\".\"email_text\" NOT NULL,\
                \"status\" \"{}\".\"user_status\" NOT NULL DEFAULT 'active',\
                \"created_at\" timestamptz NOT NULL DEFAULT now(),\
                \"active\" boolean NOT NULL DEFAULT true,\
                \"display_name\" text NOT NULL\
            )",
            source_schema, source_schema, source_schema
        ),
        format!(
            "CREATE TABLE \"{}\".\"audit_logs\" (\
                \"id\" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,\
                \"user_id\" integer NOT NULL REFERENCES \"{}\".\"users\"(\"id\"),\
                \"action\" text NOT NULL,\
                \"created_at\" timestamptz NOT NULL DEFAULT now()\
            )",
            source_schema, source_schema
        ),
        format!(
            "CREATE TABLE \"{}\".\"files\" (\
                \"id\" integer PRIMARY KEY,\
                \"payload\" bytea NOT NULL,\
                \"note\" text NOT NULL\
            )",
            source_schema
        ),
        format!(
            "CREATE INDEX \"users_display_name_idx\" ON \"{}\".\"users\" USING btree (lower(display_name))",
            source_schema
        ),
        format!(
            "COMMENT ON COLUMN \"{}\".\"users\".\"display_name\" IS 'Display name used in transfer test'",
            source_schema
        ),
        format!("COMMENT ON INDEX \"{}\".\"users_display_name_idx\" IS 'lookup index'", source_schema),
        format!(
            "CREATE OR REPLACE FUNCTION \"{}\".\"log_user_insert\"() RETURNS trigger LANGUAGE plpgsql AS $$ \
             BEGIN \
                 INSERT INTO \"{}\".\"audit_logs\" (\"user_id\", \"action\") VALUES (NEW.\"id\", 'insert'); \
                 RETURN NEW; \
             END; \
             $$",
            source_schema, source_schema
        ),
        format!(
            "CREATE TRIGGER \"users_insert_audit\" AFTER INSERT ON \"{}\".\"users\" \
             FOR EACH ROW EXECUTE FUNCTION \"{}\".\"log_user_insert\"()",
            source_schema, source_schema
        ),
        format!(
            "INSERT INTO \"{}\".\"users\" (\"email\", \"status\", \"active\", \"display_name\") VALUES \
             ('alpha@example.com', 'active', true, 'Alpha'), \
             ('beta@example.com', 'disabled', false, 'Beta')",
            source_schema
        ),
        format!(
            "INSERT INTO \"{}\".\"files\" (\"id\", \"payload\", \"note\") VALUES \
             (1, decode('48656c6c6f', 'hex'), '0x48656c6c6f')",
            source_schema
        ),
        format!(
            "CREATE VIEW \"{}\".\"active_users\" AS \
             SELECT \"id\", \"email\", \"display_name\" FROM \"{}\".\"users\" WHERE \"active\"",
            source_schema, source_schema
        ),
        format!(
            "CREATE MATERIALIZED VIEW \"{}\".\"user_stats\" AS \
             SELECT \"status\", count(*)::bigint AS \"total\" FROM \"{}\".\"users\" GROUP BY \"status\"",
            source_schema, source_schema
        ),
        format!("ALTER TABLE \"{}\".\"users\" ENABLE ROW LEVEL SECURITY", source_schema),
        format!(
            "CREATE POLICY \"users_public_read\" ON \"{}\".\"users\" AS PERMISSIVE FOR SELECT TO PUBLIC USING (\"active\")",
            source_schema
        ),
        format!("GRANT USAGE ON SCHEMA \"{}\" TO PUBLIC", source_schema),
        format!("GRANT SELECT ON TABLE \"{}\".\"users\" TO PUBLIC", source_schema),
        format!("GRANT SELECT ON TABLE \"{}\".\"active_users\" TO PUBLIC", source_schema),
        format!("GRANT EXECUTE ON FUNCTION \"{}\".\"log_user_insert\"() TO PUBLIC", source_schema),
    ];
    postgres::execute_batch(&source_pool, &setup_sql).await.unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-live-transfer-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);

    let source_connection_id = "live-source";
    let target_connection_id = "live-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");

    state.connections.write().await.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
    state.connections.write().await.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.to_string(), postgres_test_config(source_connection_id, &source_database));
    state
        .configs
        .write()
        .await
        .insert(target_connection_id.to_string(), postgres_test_config(target_connection_id, &target_database));

    let request = TransferRequest {
        transfer_id: format!("live-transfer-{suffix}"),
        source_connection_id: source_connection_id.to_string(),
        source_database: source_database.clone(),
        source_schema: source_schema.clone(),
        source_catalog: None,
        target_connection_id: target_connection_id.to_string(),
        target_database: target_database.clone(),
        target_schema: target_schema.clone(),
        target_catalog: None,
        tables: vec!["users".to_string(), "audit_logs".to_string(), "files".to_string()],
        create_table: true,
        content: dbx_core::transfer::TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };

    transfer_postgres_schema_dependencies(&state, &request, &source_pool_key, &target_pool_key, |_| {}).await.unwrap();

    let source_db_type = get_db_type(&state, source_connection_id).await.unwrap();
    let target_db_type = get_db_type(&state, target_connection_id).await.unwrap();
    for (index, table) in request.tables.iter().enumerate() {
        transfer_table(
            &state,
            &request,
            table,
            index,
            &source_db_type,
            &target_db_type,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            |_| {},
        )
        .await
        .unwrap();
    }

    transfer_postgres_schema_objects(&state, &request, &source_pool_key, &target_pool_key, |_| {}).await.unwrap();

    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT count(*) FROM \"{}\".\"users\"", target_schema)).await,
        json!(2)
    );
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT count(*) FROM \"{}\".\"audit_logs\"", target_schema)).await,
        json!(2)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!("SELECT octet_length(\"payload\") FROM \"{}\".\"files\" WHERE \"id\" = 1", target_schema)
        )
        .await,
        json!(5)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!("SELECT encode(\"payload\", 'hex') FROM \"{}\".\"files\" WHERE \"id\" = 1", target_schema)
        )
        .await,
        json!("48656c6c6f")
    );
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT \"note\" FROM \"{}\".\"files\" WHERE \"id\" = 1", target_schema))
            .await,
        json!("0x48656c6c6f")
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT column_default NOT LIKE '%{}%' AND column_default LIKE '%user_status%' \
                 FROM information_schema.columns \
                 WHERE table_schema = '{}' AND table_name = 'users' AND column_name = 'status'",
                source_schema, target_schema
            )
        )
        .await,
        json!(true)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT is_identity FROM information_schema.columns \
                 WHERE table_schema = '{}' AND table_name = 'users' AND column_name = 'id'",
                target_schema
            )
        )
        .await,
        json!("YES")
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT udt_name FROM information_schema.columns \
                 WHERE table_schema = '{}' AND table_name = 'users' AND column_name = 'status'",
                target_schema
            )
        )
        .await,
        json!("user_status")
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT domain_name FROM information_schema.columns \
                 WHERE table_schema = '{}' AND table_name = 'users' AND column_name = 'email'",
                target_schema
            )
        )
        .await,
        json!("email_text")
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT col_description(c.oid, a.attnum) \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid \
                 WHERE n.nspname = '{}' AND c.relname = 'users' AND a.attname = 'display_name'",
                target_schema
            )
        )
        .await,
        json!("Display name used in transfer test")
    );
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT count(*) FROM \"{}\".\"active_users\"", target_schema)).await,
        json!(1)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!("SELECT count(*) FROM \"{}\".\"user_stats\" WHERE \"status\" = 'active'", target_schema)
        )
        .await,
        json!(1)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT relrowsecurity FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{}' AND c.relname = 'users'",
                target_schema
            )
        )
        .await,
        json!(true)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT count(*) FROM pg_catalog.pg_policy p \
                 JOIN pg_catalog.pg_class c ON c.oid = p.polrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{}' AND c.relname = 'users' AND p.polname = 'users_public_read'",
                target_schema
            )
        )
        .await,
        json!(1)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT count(*) \
                 FROM pg_catalog.pg_namespace n \
                 JOIN LATERAL aclexplode(n.nspacl) a ON true \
                 WHERE n.nspname = '{}' AND a.grantee = 0 AND a.privilege_type = 'USAGE'",
                target_schema
            )
        )
        .await,
        json!(1)
    );

    postgres::execute_query(
        &target_pool,
        &format!(
            "INSERT INTO \"{}\".\"users\" (\"email\", \"status\", \"active\", \"display_name\") \
             VALUES ('gamma@example.com', 'active', true, 'Gamma')",
            target_schema
        ),
    )
    .await
    .unwrap();

    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT count(*) FROM \"{}\".\"audit_logs\"", target_schema)).await,
        json!(3)
    );

    let _ = postgres::execute_batch(&source_pool, &[cleanup_sql[0].clone()]).await;
    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
#[ignore = "requires PostgreSQL URLs via DBX_LIVE_PG_TRANSFER_SOURCE_URL and DBX_LIVE_PG_TRANSFER_TARGET_URL"]
async fn live_postgres_transfer_skips_create_ddl_for_existing_target_table() {
    let source_url = std::env::var("DBX_LIVE_PG_TRANSFER_SOURCE_URL").expect("DBX_LIVE_PG_TRANSFER_SOURCE_URL");
    let target_url = std::env::var("DBX_LIVE_PG_TRANSFER_TARGET_URL").unwrap_or_else(|_| source_url.clone());

    let source_pool = postgres::connect(&source_url, std::time::Duration::from_secs(5)).await.unwrap();
    let target_pool = postgres::connect(&target_url, std::time::Duration::from_secs(5)).await.unwrap();

    let source_database = query_scalar(&source_pool, "SELECT current_database()").await.as_str().unwrap().to_string();
    let target_database = query_scalar(&target_pool, "SELECT current_database()").await.as_str().unwrap().to_string();

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_schema = format!("dbx_src_existing_{}", &suffix[..8]);
    let target_schema = format!("dbx_dst_existing_{}", &suffix[..8]);

    let cleanup_sql = [
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", source_schema),
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", target_schema),
    ];
    let _ = postgres::execute_batch(&source_pool, &[cleanup_sql[0].clone()]).await;
    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;

    postgres::execute_batch(
        &source_pool,
        &[
            format!("CREATE SCHEMA \"{}\"", source_schema),
            format!(
                "CREATE TABLE \"{}\".\"items\" (\"id\" integer PRIMARY KEY, \"name\" text NOT NULL)",
                source_schema
            ),
            format!(
                "INSERT INTO \"{}\".\"items\" (\"id\", \"name\") VALUES (1, 'existing-target-transfer')",
                source_schema
            ),
        ],
    )
    .await
    .unwrap();
    postgres::execute_batch(
        &target_pool,
        &[
            format!("CREATE SCHEMA \"{}\"", target_schema),
            format!(
                "CREATE TABLE \"{}\".\"items\" (\"id\" integer PRIMARY KEY, \"name\" text NOT NULL)",
                target_schema
            ),
        ],
    )
    .await
    .unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-live-existing-transfer-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);

    let source_connection_id = "live-existing-source";
    let target_connection_id = "live-existing-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");

    state.connections.write().await.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
    state.connections.write().await.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.to_string(), postgres_test_config(source_connection_id, &source_database));
    state
        .configs
        .write()
        .await
        .insert(target_connection_id.to_string(), postgres_test_config(target_connection_id, &target_database));

    let request = TransferRequest {
        transfer_id: format!("live-existing-transfer-{suffix}"),
        source_connection_id: source_connection_id.to_string(),
        source_database: source_database.clone(),
        source_schema: source_schema.clone(),
        source_catalog: None,
        target_connection_id: target_connection_id.to_string(),
        target_database: target_database.clone(),
        target_schema: target_schema.clone(),
        target_catalog: None,
        tables: vec!["items".to_string()],
        create_table: true,
        content: dbx_core::transfer::TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };

    let source_db_type = get_db_type(&state, source_connection_id).await.unwrap();
    let target_db_type = get_db_type(&state, target_connection_id).await.unwrap();
    let transferred = transfer_table(
        &state,
        &request,
        "items",
        0,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
        &std::collections::HashMap::new(),
        &mut Vec::new(),
        |_| {},
    )
    .await
    .unwrap();

    assert_eq!(transferred, 1);
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT \"name\" FROM \"{}\".\"items\" WHERE \"id\" = 1", target_schema))
            .await,
        json!("existing-target-transfer")
    );

    let _ = postgres::execute_batch(&source_pool, &[cleanup_sql[0].clone()]).await;
    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
#[ignore = "requires PostgreSQL URLs via DBX_LIVE_PG_TRANSFER_SOURCE_URL and DBX_LIVE_PG_TRANSFER_TARGET_URL"]
async fn live_postgres_transfer_creates_selected_sequence_before_referencing_table() {
    let source_url = std::env::var("DBX_LIVE_PG_TRANSFER_SOURCE_URL").expect("DBX_LIVE_PG_TRANSFER_SOURCE_URL");
    let target_url = std::env::var("DBX_LIVE_PG_TRANSFER_TARGET_URL").unwrap_or_else(|_| source_url.clone());

    let source_pool = postgres::connect(&source_url, std::time::Duration::from_secs(5)).await.unwrap();
    let target_pool = postgres::connect(&target_url, std::time::Duration::from_secs(5)).await.unwrap();
    let source_database = query_scalar(&source_pool, "SELECT current_database()").await.as_str().unwrap().to_string();
    let target_database = query_scalar(&target_pool, "SELECT current_database()").await.as_str().unwrap().to_string();

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_schema = format!("dbx_src_sequence_{}", &suffix[..8]);
    let target_schema = format!("dbx_dst_sequence_{}", &suffix[..8]);
    let cleanup_sql = [
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", source_schema),
        format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", target_schema),
    ];
    let _ = postgres::execute_batch(&source_pool, &[cleanup_sql[0].clone()]).await;
    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;

    postgres::execute_batch(
        &source_pool,
        &[
            format!("CREATE SCHEMA \"{}\"", source_schema),
            format!(
                "CREATE SEQUENCE \"{}\".\"biz_banner_id_seq\" AS bigint START WITH 5 INCREMENT BY 2 MINVALUE 1 MAXVALUE 999 CACHE 1 CYCLE",
                source_schema
            ),
            format!(
                "CREATE TABLE \"{}\".\"biz_banner\" (\
                    \"id\" bigint DEFAULT nextval('\"{}\".\"biz_banner_id_seq\"'::regclass) PRIMARY KEY,\
                    \"name\" text NOT NULL\
                )",
                source_schema, source_schema
            ),
            format!("INSERT INTO \"{}\".\"biz_banner\" (\"name\") VALUES ('first')", source_schema),
            format!("SELECT setval('\"{}\".\"biz_banner_id_seq\"', 41, true)", source_schema),
            format!("INSERT INTO \"{}\".\"biz_banner\" (\"name\") VALUES ('second')", source_schema),
            format!("GRANT USAGE ON SEQUENCE \"{}\".\"biz_banner_id_seq\" TO PUBLIC", source_schema),
        ],
    )
    .await
    .unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-live-sequence-transfer-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let source_connection_id = "live-sequence-source";
    let target_connection_id = "live-sequence-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");
    state.connections.write().await.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
    state.connections.write().await.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.to_string(), postgres_test_config(source_connection_id, &source_database));
    state
        .configs
        .write()
        .await
        .insert(target_connection_id.to_string(), postgres_test_config(target_connection_id, &target_database));

    let request = TransferRequest {
        transfer_id: format!("live-sequence-transfer-{suffix}"),
        source_connection_id: source_connection_id.to_string(),
        source_database: source_database.clone(),
        source_schema: source_schema.clone(),
        source_catalog: None,
        target_connection_id: target_connection_id.to_string(),
        target_database: target_database.clone(),
        target_schema: target_schema.clone(),
        target_catalog: None,
        tables: vec!["biz_banner".to_string()],
        create_table: true,
        content: dbx_core::transfer::TransferContent::default(),
        objects: vec![
            TransferObjectSelection { object_type: TransferObjectKind::Table, names: vec!["biz_banner".to_string()] },
            TransferObjectSelection {
                object_type: TransferObjectKind::Sequence,
                names: vec!["biz_banner_id_seq".to_string()],
            },
        ],
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };
    let source_db_type = get_db_type(&state, source_connection_id).await.unwrap();
    let target_db_type = get_db_type(&state, target_connection_id).await.unwrap();

    transfer_postgres_schema_dependencies(&state, &request, &source_pool_key, &target_pool_key, |_| {}).await.unwrap();
    let transferred = transfer_table(
        &state,
        &request,
        "biz_banner",
        0,
        &source_db_type,
        &target_db_type,
        &source_pool_key,
        &target_pool_key,
        &std::collections::HashMap::new(),
        &mut Vec::new(),
        |_| {},
    )
    .await
    .unwrap();
    let outcome =
        transfer_postgres_schema_objects(&state, &request, &source_pool_key, &target_pool_key, |_| {}).await.unwrap();

    assert_eq!(transferred, 2);
    assert!(outcome.failed.is_empty());
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT count(*) FROM \"{}\".\"biz_banner\"", target_schema)).await,
        json!(2)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT format_type(s.seqtypid, NULL) || ':' || s.seqstart || ':' || s.seqincrement || ':' || s.seqmin || ':' || s.seqmax || ':' || s.seqcache || ':' || s.seqcycle \
                 FROM pg_catalog.pg_sequence s \
                 JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{}' AND c.relname = 'biz_banner_id_seq'",
                target_schema
            )
        )
        .await,
        json!("bigint:5:2:1:999:1:true")
    );
    assert_eq!(
        query_scalar(&target_pool, &format!("SELECT nextval('\"{}\".\"biz_banner_id_seq\"'::regclass)", target_schema))
            .await,
        json!(45)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT column_default LIKE '%{}%' AND column_default NOT LIKE '%{}%' \
                 FROM information_schema.columns \
                 WHERE table_schema = '{}' AND table_name = 'biz_banner' AND column_name = 'id'",
                target_schema, source_schema, target_schema
            )
        )
        .await,
        json!(true)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT count(*) FROM pg_catalog.pg_depend d \
                 JOIN pg_catalog.pg_class c ON c.oid = d.objid \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = '{}' AND c.relname = 'biz_banner_id_seq' AND d.deptype IN ('a', 'i')",
                target_schema
            )
        )
        .await,
        json!(0)
    );
    assert_eq!(
        query_scalar(
            &target_pool,
            &format!(
                "SELECT count(*) \
                 FROM pg_catalog.pg_class c \
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                 JOIN LATERAL aclexplode(c.relacl) a ON true \
                 WHERE n.nspname = '{}' AND c.relname = 'biz_banner_id_seq' \
                   AND c.relkind = 'S' AND a.grantee = 0 AND a.privilege_type = 'USAGE'",
                target_schema
            )
        )
        .await,
        json!(1)
    );

    let _ = postgres::execute_batch(&source_pool, &[cleanup_sql[0].clone()]).await;
    let _ = postgres::execute_batch(&target_pool, &[cleanup_sql[1].clone()]).await;
    let _ = std::fs::remove_dir_all(dir);
}
