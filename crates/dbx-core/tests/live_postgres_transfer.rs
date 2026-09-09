use dbx_core::connection::{AppState, PoolKind};
use dbx_core::db::postgres;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;
use dbx_core::transfer::{
    drop_backup_tables, get_db_type, rename_tables_to_backup, transfer_postgres_schema_dependencies,
    transfer_postgres_schema_objects, transfer_table, TransferContent, TransferMode, TransferObjectKind,
    TransferObjectSelection, TransferOwnershipPolicy, TransferRequest, TransferTableNameCase,
};
use serde_json::json;
use std::sync::Arc;

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

/// Query scalar as text for structural assertions (like MySQL `schema_count`).
async fn query_text(pool: &deadpool_postgres::Pool, sql: &str) -> String {
    let val = query_scalar(pool, sql).await;
    if let Some(s) = val.as_str() {
        return s.to_string();
    }
    if let Some(n) = val.as_i64() {
        return n.to_string();
    }
    String::new()
}

/// `COUNT(*)` over `information_schema`, the shape every drop_target structural assertion needs.
async fn schema_count(pool: &deadpool_postgres::Pool, from_and_where: &str) -> String {
    query_text(pool, &format!("SELECT COUNT(*)::text FROM information_schema.{from_and_where}")).await
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
    let state = Arc::new(AppState::new(storage));
    let source_connection_id = "live-always-source";
    let target_connection_id = "live-always-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");
    state
        .update_connection_pools(|connections| {
            connections.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
            connections.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
        })
        .await;
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
        drop_target_before_create: false,
        drop_target_confirmed: false,
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
        None,
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
        None,
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
    let state = Arc::new(AppState::new(storage));
    let source_connection_id = "live-structure-only-source";
    let target_connection_id = "live-structure-only-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");
    state
        .update_connection_pools(|connections| {
            connections.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
            connections.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
        })
        .await;
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
        drop_target_before_create: false,
        drop_target_confirmed: false,
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
        None,
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
        None,
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
    let state = Arc::new(AppState::new(storage));

    let source_connection_id = "live-source";
    let target_connection_id = "live-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");

    state
        .update_connection_pools(|connections| {
            connections.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
            connections.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
        })
        .await;
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
        drop_target_before_create: false,
        drop_target_confirmed: false,
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
            None,
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

/// Scope: `drop_target_before_create: false`, the default. `create_table` is a request,
/// not a command — an existing target table is reused as-is and the CREATE DDL is
/// skipped, so the source rows are appended into the table the user already had.
///
/// `drop_target_before_create: true` inverts this on purpose: the rename pre-pass frees
/// the name, so the CREATE DDL always runs and the target is rebuilt from the source
/// structure. See `live_postgres_transfer_drop_target_rebuilds_structure_and_indexes`.
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
    let state = Arc::new(AppState::new(storage));

    let source_connection_id = "live-existing-source";
    let target_connection_id = "live-existing-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");

    state
        .update_connection_pools(|connections| {
            connections.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
            connections.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
        })
        .await;
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
        drop_target_before_create: false,
        drop_target_confirmed: false,
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
        None,
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
    let state = Arc::new(AppState::new(storage));
    let source_connection_id = "live-sequence-source";
    let target_connection_id = "live-sequence-target";
    let source_pool_key = format!("{source_connection_id}:{source_database}");
    let target_pool_key = format!("{target_connection_id}:{target_database}");
    state
        .update_connection_pools(|connections| {
            connections.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
            connections.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
        })
        .await;
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
        drop_target_before_create: false,
        drop_target_confirmed: false,
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
        None,
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

/// Counterpart to `live_postgres_transfer_skips_create_ddl_for_existing_target_table`: when
/// `drop_target_before_create` is true, the rename pre-pass frees the name so the CREATE DDL
/// always runs and the target is rebuilt from the source structure, including indexes.
///
/// This test also verifies Fix B: PG backup table indexes are renamed during the pre-pass so
/// schema-scoped index names are freed for the rebuilt table. Without Fix B, `CREATE INDEX IF
/// NOT EXISTS {original_name}` would silently skip because the backup still holds that name.
#[tokio::test]
#[ignore = "requires live PostgreSQL connection"]
async fn live_postgres_transfer_drop_target_rebuilds_structure_and_indexes() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("pg-drop-rebuild-{suffix}");
    let source_schema = format!("drop_src_{}", &suffix[..12]);
    let target_schema = format!("drop_tgt_{}", &suffix[..12]);

    let url = std::env::var("DBX_LIVE_PG_TRANSFER_SOURCE_URL").expect("DBX_LIVE_PG_TRANSFER_SOURCE_URL");
    let pool = postgres::connect(&url, std::time::Duration::from_secs(5)).await.expect("live PG connection");
    let database = query_text(&pool, "SELECT current_database()").await;
    let config = postgres_test_config(&connection_id, &database);

    // Source: orders(id, name, extra_col) + secondary index on name
    postgres::execute_batch(
        &pool,
        &[
            format!("CREATE SCHEMA {source_schema}"),
            format!(
                "CREATE TABLE {source_schema}.orders (\
                 id INT PRIMARY KEY, name TEXT NOT NULL, extra_col TEXT)"
            ),
            format!("CREATE INDEX idx_orders_name ON {source_schema}.orders(name)"),
            format!("COMMENT ON INDEX {source_schema}.idx_orders_name IS 'source index comment'"),
            format!("INSERT INTO {source_schema}.orders VALUES (1, 'alpha', 'x')"),
        ],
    )
    .await
    .unwrap();

    // Target: incompatible structure orders(id, name) with stale row, plus its own index
    postgres::execute_batch(
        &pool,
        &[
            format!("CREATE SCHEMA {target_schema}"),
            format!("CREATE TABLE {target_schema}.orders (id INT PRIMARY KEY, name TEXT NOT NULL)"),
            format!("CREATE INDEX idx_orders_name ON {target_schema}.orders(name)"),
            format!("COMMENT ON INDEX {target_schema}.idx_orders_name IS 'stale target index comment'"),
            format!("INSERT INTO {target_schema}.orders VALUES (99, 'stale')"),
        ],
    )
    .await
    .unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-live-drop-rebuild-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), config);

    let pool_key = format!("{}:{}", connection_id, database);
    state
        .update_connection_pools(|connections| {
            connections.insert(pool_key.clone(), PoolKind::Postgres(pool.clone()));
        })
        .await;

    let transfer_id = format!("transfer-{suffix}");
    let request = TransferRequest {
        transfer_id: transfer_id.clone(),
        source_connection_id: connection_id.clone(),
        source_database: database.to_string(),
        source_schema: source_schema.clone(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: database.to_string(),
        target_schema: target_schema.clone(),
        target_catalog: None,
        tables: vec!["orders".to_string()],
        create_table: true,
        drop_target_before_create: true,
        drop_target_confirmed: true,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 1000,
    };

    // Execute rename pre-pass + transfer + backup cleanup
    let backup_names =
        rename_tables_to_backup(&state, &request, &request.tables, DatabaseType::Postgres, &pool_key, |_| {})
            .await
            .unwrap();

    let backup_name = backup_names.get("orders").cloned().expect("preexisting target must be backed up");
    assert!(backup_name.starts_with("orders__dbx_bak_"), "unexpected backup name: {backup_name}");

    // After pre-pass: backup table exists, original indexes were renamed (Fix B)
    assert_eq!(
        schema_count(&pool, &format!("tables WHERE table_schema = '{target_schema}' AND table_name = '{backup_name}'"))
            .await,
        "1",
        "backup table must exist after rename pre-pass"
    );

    // Verify backup's index was renamed (Fix B): the original idx_orders_name should not exist on backup
    let backup_indexes = postgres::execute_query(
        &pool,
        &format!(
            "SELECT indexname FROM pg_indexes WHERE schemaname = '{target_schema}' \
             AND tablename = '{backup_name}' ORDER BY indexname"
        ),
    )
    .await
    .unwrap();
    assert!(
        backup_indexes.rows.iter().all(|row| {
            let idx_name = row[0].as_str().unwrap();
            idx_name.contains("__dbx_bak_") || idx_name.ends_with("_pkey")
        }),
        "backup indexes should be renamed with __dbx_bak_ suffix, got: {:?}",
        backup_indexes.rows
    );

    let transferred = transfer_table(
        &state,
        &request,
        "orders",
        0,
        &DatabaseType::Postgres,
        &DatabaseType::Postgres,
        &pool_key,
        &pool_key,
        &std::collections::HashMap::new(),
        &mut Vec::new(),
        Some(&backup_names),
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(transferred, 1, "should transfer 1 row");

    drop_backup_tables(&state, &request, DatabaseType::Postgres, &pool_key, &backup_names, &request.tables)
        .await
        .unwrap();

    // Verify structure rebuild: extra_col present (source had it, target didn't)
    assert_eq!(
        schema_count(
            &pool,
            &format!(
                "columns WHERE table_schema = '{target_schema}' AND table_name = 'orders' \
                 AND column_name = 'extra_col'"
            )
        )
        .await,
        "1",
        "extra_col from source must be present after rebuild"
    );

    // Verify index rebuilt: idx_orders_name exists on the new table
    assert_eq!(
        query_text(
            &pool,
            &format!(
                "SELECT COUNT(*)::text FROM pg_indexes WHERE schemaname = '{target_schema}' \
                 AND tablename = 'orders' AND indexname = 'idx_orders_name'"
            )
        )
        .await,
        "1",
        "idx_orders_name must be rebuilt on the new table"
    );

    // Verify index comment transferred to the rebuilt table's index
    let rebuilt_comment = postgres::execute_query(
        &pool,
        &format!(
            "SELECT obj_description(c.oid, 'pg_class') FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = '{target_schema}' AND c.relname = 'idx_orders_name'"
        ),
    )
    .await
    .unwrap();
    assert_eq!(rebuilt_comment.rows[0][0], json!("source index comment"), "index comment must come from source");

    // Verify data: stale row gone, source row present
    assert_eq!(
        query_text(&pool, &format!("SELECT COUNT(*)::text FROM {target_schema}.orders WHERE id = 99")).await,
        "0",
        "stale target row must be gone"
    );
    assert_eq!(
        query_scalar(&pool, &format!("SELECT name FROM {target_schema}.orders WHERE id = 1")).await,
        json!("alpha")
    );
    assert_eq!(
        query_scalar(&pool, &format!("SELECT extra_col FROM {target_schema}.orders WHERE id = 1")).await,
        json!("x")
    );

    // Verify backup dropped
    assert_eq!(
        schema_count(&pool, &format!("tables WHERE table_schema = '{target_schema}' AND table_name = '{backup_name}'"))
            .await,
        "0",
        "backup must be dropped after successful transfer"
    );

    let _ = postgres::execute_batch(
        &pool,
        &[format!("DROP SCHEMA {source_schema} CASCADE"), format!("DROP SCHEMA {target_schema} CASCADE")],
    )
    .await;
    let _ = std::fs::remove_dir_all(dir);
}

struct PostgresRebuildFixture {
    state: Arc<AppState>,
    source_pool: deadpool_postgres::Pool,
    target_pool: deadpool_postgres::Pool,
    source_pool_key: String,
    target_pool_key: String,
    request: TransferRequest,
    _storage_dir: tempfile::TempDir,
}

impl PostgresRebuildFixture {
    async fn new(label: &str, tables: &[&str]) -> Self {
        let source_url = std::env::var("DBX_LIVE_PG_TRANSFER_SOURCE_URL").expect("DBX_LIVE_PG_TRANSFER_SOURCE_URL");
        let target_url = std::env::var("DBX_LIVE_PG_TRANSFER_TARGET_URL").unwrap_or_else(|_| source_url.clone());
        let source_pool = postgres::connect(&source_url, std::time::Duration::from_secs(5)).await.unwrap();
        let target_pool = postgres::connect(&target_url, std::time::Duration::from_secs(5)).await.unwrap();
        let source_database = query_text(&source_pool, "SELECT current_database()").await;
        let target_database = query_text(&target_pool, "SELECT current_database()").await;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let source_schema = format!("dbx_{label}_src_{}", &suffix[..8]);
        let target_schema = format!("dbx_{label}_dst_{}", &suffix[..8]);
        let source_connection_id = format!("{label}-source-{suffix}");
        let target_connection_id = format!("{label}-target-{suffix}");
        let source_pool_key = format!("{source_connection_id}:{source_database}");
        let target_pool_key = format!("{target_connection_id}:{target_database}");
        let storage_dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(Storage::open(&storage_dir.path().join("storage.db")).await.unwrap()));
        state
            .update_connection_pools(|connections| {
                connections.insert(source_pool_key.clone(), PoolKind::Postgres(source_pool.clone()));
                connections.insert(target_pool_key.clone(), PoolKind::Postgres(target_pool.clone()));
            })
            .await;
        {
            let mut configs = state.configs.write().await;
            configs.insert(source_connection_id.clone(), postgres_test_config(&source_connection_id, &source_database));
            configs.insert(target_connection_id.clone(), postgres_test_config(&target_connection_id, &target_database));
        }
        postgres::execute_query(&source_pool, &format!("CREATE SCHEMA {source_schema}")).await.unwrap();
        postgres::execute_query(&target_pool, &format!("CREATE SCHEMA {target_schema}")).await.unwrap();
        Self {
            state,
            source_pool,
            target_pool,
            source_pool_key,
            target_pool_key,
            request: TransferRequest {
                transfer_id: format!("{label}-{suffix}"),
                source_connection_id,
                source_database,
                source_schema,
                source_catalog: None,
                target_connection_id,
                target_database,
                target_schema,
                target_catalog: None,
                tables: tables.iter().map(|table| (*table).to_string()).collect(),
                create_table: true,
                drop_target_before_create: true,
                drop_target_confirmed: true,
                content: TransferContent::default(),
                objects: Vec::new(),
                mode: TransferMode::Append,
                target_table_name_case: TransferTableNameCase::Preserve,
                quote_target_column_names: true,
                ownership_policy: TransferOwnershipPolicy::Preserve,
                batch_size: 100,
            },
            _storage_dir: storage_dir,
        }
    }

    async fn rename(&self) -> Result<std::collections::HashMap<String, String>, String> {
        rename_tables_to_backup(
            &self.state,
            &self.request,
            &self.request.tables,
            DatabaseType::Postgres,
            &self.target_pool_key,
            |_| {},
        )
        .await
    }

    async fn transfer(&self, backups: &std::collections::HashMap<String, String>) -> Result<u64, String> {
        transfer_table(
            &self.state,
            &self.request,
            &self.request.tables[0],
            0,
            &DatabaseType::Postgres,
            &DatabaseType::Postgres,
            &self.source_pool_key,
            &self.target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            Some(backups),
            |_| {},
        )
        .await
    }

    async fn drop_backups(&self, backups: &std::collections::HashMap<String, String>) -> Result<(), String> {
        drop_backup_tables(
            &self.state,
            &self.request,
            DatabaseType::Postgres,
            &self.target_pool_key,
            backups,
            &self.request.tables,
        )
        .await
    }

    async fn cleanup(&self) {
        postgres::execute_query(&self.source_pool, &format!("DROP SCHEMA {} CASCADE", self.request.source_schema))
            .await
            .unwrap();
        postgres::execute_query(&self.target_pool, &format!("DROP SCHEMA {} CASCADE", self.request.target_schema))
            .await
            .unwrap();
    }
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL URLs via DBX_LIVE_PG_TRANSFER_SOURCE_URL and DBX_LIVE_PG_TRANSFER_TARGET_URL"]
async fn live_postgres_transfer_rebuilds_same_named_serial_sequence() {
    let fixture = PostgresRebuildFixture::new("serial_rebuild", &["orders"]).await;
    let source_schema = &fixture.request.source_schema;
    let target_schema = &fixture.request.target_schema;
    postgres::execute_batch(
        &fixture.source_pool,
        &[
            format!("CREATE TABLE {source_schema}.orders (id SERIAL PRIMARY KEY, name TEXT NOT NULL)"),
            format!("INSERT INTO {source_schema}.orders (id, name) VALUES (42, 'source')"),
        ],
    )
    .await
    .unwrap();
    postgres::execute_batch(
        &fixture.target_pool,
        &[
            format!("CREATE TABLE {target_schema}.orders (id SERIAL PRIMARY KEY, name TEXT NOT NULL)"),
            format!("INSERT INTO {target_schema}.orders (id, name) VALUES (99, 'old target')"),
        ],
    )
    .await
    .unwrap();

    let result = async {
        let backups = fixture.rename().await?;
        let backup = backups.get("orders").expect("original target must have a backup");
        assert_eq!(fixture.transfer(&backups).await?, 1);
        assert_eq!(
            query_text(&fixture.target_pool, &format!("SELECT name FROM {target_schema}.{backup} WHERE id = 99")).await,
            "old target",
            "original data remains recoverable until successful cleanup"
        );
        let new_sequence =
            query_text(&fixture.target_pool, &format!("SELECT pg_get_serial_sequence('{target_schema}.orders', 'id')"))
                .await;
        let old_sequence = query_text(
            &fixture.target_pool,
            &format!("SELECT pg_get_serial_sequence('{target_schema}.{backup}', 'id')"),
        )
        .await;
        assert!(!new_sequence.is_empty() && !old_sequence.is_empty());
        assert_ne!(new_sequence, old_sequence, "new table and backup must own independent sequences");

        fixture.drop_backups(&backups).await?;
        assert_eq!(
            query_scalar(
                &fixture.target_pool,
                &format!("INSERT INTO {target_schema}.orders (name) VALUES ('after rebuild') RETURNING id")
            )
            .await,
            json!(43),
            "dropping the backup must preserve the rebuilt sequence, synchronized to transferred data"
        );
        assert_eq!(
            query_text(&fixture.target_pool, &format!("SELECT name FROM {target_schema}.orders WHERE id=42")).await,
            "source"
        );
        assert_eq!(
            query_scalar(&fixture.target_pool, &format!("SELECT to_regclass('{old_sequence}')::text")).await,
            serde_json::Value::Null,
            "backup cleanup must also remove the old owned sequence"
        );
        Ok::<_, String>(())
    }
    .await;
    fixture.cleanup().await;
    result.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL URLs via DBX_LIVE_PG_TRANSFER_SOURCE_URL and DBX_LIVE_PG_TRANSFER_TARGET_URL"]
async fn live_postgres_transfer_rebuilds_indexes_with_shared_long_prefix() {
    let fixture = PostgresRebuildFixture::new("long_indexes", &["orders"]).await;
    let source_schema = &fixture.request.source_schema;
    let target_schema = &fixture.request.target_schema;
    // Both identifiers fit PostgreSQL's 63-byte limit but share their first 46 bytes.
    let index_a = format!("{}first", "i".repeat(46));
    let index_b = format!("{}second", "i".repeat(46));
    for (pool, schema, row) in [
        (&fixture.source_pool, source_schema, "(1, 'source', 7)"),
        (&fixture.target_pool, target_schema, "(99, 'old target', 9)"),
    ] {
        postgres::execute_batch(
            pool,
            &[
                format!("CREATE TABLE {schema}.orders (id INT PRIMARY KEY, name TEXT NOT NULL, amount INT)"),
                format!("CREATE INDEX {index_a} ON {schema}.orders (name)"),
                format!("CREATE INDEX {index_b} ON {schema}.orders (amount)"),
                format!("INSERT INTO {schema}.orders VALUES {row}"),
            ],
        )
        .await
        .unwrap();
    }

    let result = async {
        let backups = fixture.rename().await?;
        let backup = backups.get("orders").expect("original target must have a backup");
        assert_eq!(fixture.transfer(&backups).await?, 1);
        fixture.drop_backups(&backups).await?;
        let indexes = postgres::execute_query(
            &fixture.target_pool,
            &format!(
                "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = '{target_schema}' \
                 AND tablename = 'orders' AND indexname IN ('{index_a}', '{index_b}') ORDER BY indexname"
            ),
        )
        .await?;
        assert_eq!(indexes.rows.len(), 2, "both secondary indexes must survive rebuild; got {:?}", indexes.rows);
        assert_eq!(indexes.rows[0][0], json!(index_a));
        assert!(indexes.rows[0][1].as_str().unwrap().contains("(name)"));
        assert_eq!(indexes.rows[1][0], json!(index_b));
        assert!(indexes.rows[1][1].as_str().unwrap().contains("(amount)"));
        assert_eq!(
            query_text(&fixture.target_pool, &format!("SELECT name FROM {target_schema}.orders WHERE id=1")).await,
            "source"
        );
        assert_eq!(
            query_scalar(&fixture.target_pool, &format!("SELECT to_regclass('{target_schema}.{backup}')::text")).await,
            serde_json::Value::Null,
            "successful rebuild must remove the backup"
        );
        Ok::<_, String>(())
    }
    .await;
    fixture.cleanup().await;
    result.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL URLs via DBX_LIVE_PG_TRANSFER_SOURCE_URL and DBX_LIVE_PG_TRANSFER_TARGET_URL"]
async fn live_postgres_transfer_rebuild_rejects_target_only_view_before_any_rename() {
    let fixture = PostgresRebuildFixture::new("external_view", &["first_table", "orders"]).await;
    let source_schema = &fixture.request.source_schema;
    let target_schema = &fixture.request.target_schema;
    for (pool, schema, row) in [
        (&fixture.source_pool, source_schema, "(1, 'source')"),
        (&fixture.target_pool, target_schema, "(99, 'old target')"),
    ] {
        postgres::execute_batch(
            pool,
            &[
                format!("CREATE TABLE {schema}.first_table (id INT PRIMARY KEY, name TEXT NOT NULL)"),
                format!("CREATE TABLE {schema}.orders (id INT PRIMARY KEY, name TEXT NOT NULL)"),
                format!("INSERT INTO {schema}.first_table VALUES {row}"),
                format!("INSERT INTO {schema}.orders VALUES {row}"),
            ],
        )
        .await
        .unwrap();
    }
    postgres::execute_query(
        &fixture.target_pool,
        &format!("CREATE VIEW {target_schema}.target_only_orders AS SELECT id, name FROM {target_schema}.orders"),
    )
    .await
    .unwrap();
    let catalog_snapshot_sql = format!(
        "SELECT c.relname, c.oid::text, c.relkind::text FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = '{target_schema}' ORDER BY c.relname"
    );
    let before = postgres::execute_query(&fixture.target_pool, &catalog_snapshot_sql).await.unwrap().rows;
    let result = fixture.rename().await;
    let after = postgres::execute_query(&fixture.target_pool, &catalog_snapshot_sql).await.unwrap().rows;

    // Collect observations before cleanup so even a missing preflight leaves no schemas behind.
    let rows = postgres::execute_query(
        &fixture.target_pool,
        &format!(
            "SELECT 'first_table', id, name FROM {target_schema}.first_table \
             UNION ALL SELECT 'orders', id, name FROM {target_schema}.orders \
             UNION ALL SELECT 'target_only_orders', id, name FROM {target_schema}.target_only_orders ORDER BY 1"
        ),
    )
    .await;
    fixture.cleanup().await;

    let error = result.expect_err("target-only dependent view must reject the whole plan before any table rename");
    assert!(error.contains("target_only_orders"), "preflight must identify the dependent view: {error}");
    assert_eq!(after, before, "all original table, index and view identities must remain unchanged");
    assert_eq!(
        rows.unwrap().rows,
        vec![
            vec![json!("first_table"), json!(99), json!("old target")],
            vec![json!("orders"), json!(99), json!("old target")],
            vec![json!("target_only_orders"), json!(99), json!("old target")],
        ],
        "preflight rejection must preserve both selected tables and the target-only view's result"
    );
}
