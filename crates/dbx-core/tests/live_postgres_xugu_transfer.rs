//! Opt-in integration coverage. Supply disposable connection configurations via
//! environment variables; never commit an endpoint, account or password here.

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::transfer::{execute_on_pool, execute_read_on_pool, transfer_table_with_result, TransferRequest};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

fn config(variable: &str, id: &str) -> ConnectionConfig {
    let mut config: Value = serde_json::from_str(&std::env::var(variable).expect(variable)).expect("connection JSON");
    config["id"] = json!(id);
    config["name"] = json!(id);
    serde_json::from_value(config).expect("connection configuration")
}

fn request(
    source: &ConnectionConfig,
    target: &ConnectionConfig,
    source_schema: &str,
    target_schema: &str,
    table: &str,
) -> TransferRequest {
    serde_json::from_value(json!({
        "transferId":uuid::Uuid::new_v4().to_string(),
        "sourceConnectionId":source.id,"sourceDatabase":source.database,"sourceSchema":source_schema,
        "targetConnectionId":target.id,"targetDatabase":target.database,"targetSchema":target_schema,
        "tables":[table],"createTable":true,"content":"structureAndData","objects":[],"mode":"append",
        "targetTableNameCase":"preserve","targetColumnNameCase":"preserve","quoteTargetColumnNames":true,
        "ownershipPolicy":"preserve","batchSize":2
    }))
    .expect("transfer request")
}

async fn scalar(state: &AppState, pool: &str, sql: &str) -> Value {
    execute_read_on_pool(state, pool, sql).await.expect("read verification").rows[0][0].clone()
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[tokio::test]
#[ignore = "creates a temporary fixture-only PostgreSQL login; requires explicit operator approval"]
async fn live_postgres_xugu_source_permissions() {
    assert_eq!(
        std::env::var("DBX_LIVE_PG_XUGU_ALLOW_TEMP_LOGIN").as_deref(),
        Ok("1"),
        "Explicit temporary-login test approval is required"
    );
    let admin = config("DBX_LIVE_PG_XUGU_SOURCE_CONFIG", "pg-permission-admin");
    let target = config("DBX_LIVE_PG_XUGU_TARGET_CONFIG", "pg-permission-target");
    let target_schema = std::env::var("DBX_LIVE_PG_XUGU_TARGET_SCHEMA").unwrap();
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let schema = format!("dbx_px_acl_{suffix}");
    let role = format!("dbx_px_reader_{suffix}");
    let table = format!("DBX_PX_{suffix}_Permission");
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        PathBuf::from(std::env::var("DBX_LIVE_PG_XUGU_AGENT_DIR").unwrap()),
        env!("CARGO_PKG_VERSION"),
    ));
    let password = uuid::Uuid::new_v4().simple().to_string();
    let mut ordinary = serde_json::to_value(&admin).unwrap();
    ordinary["id"] = json!("pg-permission-ordinary");
    ordinary["name"] = json!("pg-permission-ordinary");
    ordinary["username"] = json!(role);
    ordinary["password"] = json!(password);
    let ordinary: ConnectionConfig = serde_json::from_value(ordinary).unwrap();
    {
        let mut configs = state.configs.write().await;
        for cfg in [&admin, &ordinary, &target] {
            configs.insert(cfg.id.clone(), cfg.clone());
        }
    }
    let admin_pool = state.get_or_create_pool(&admin.id, admin.database.as_deref()).await.unwrap();
    let target_pool = state.get_or_create_pool(&target.id, target.database.as_deref()).await.unwrap();
    let expires = (chrono::Utc::now() + chrono::Duration::hours(2)).to_rfc3339();
    execute_on_pool(&state, &admin_pool, &format!(
        "CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '{password}' VALID UNTIL '{expires}'", quote(&role)
    )).await.expect("create isolated test login");
    let src = format!("{}.{}", quote(&schema), quote(&table));
    let dst = format!("{}.{}", quote(&target_schema), quote(&table));
    let checks: Result<(), String> = async {
        execute_on_pool(&state, &admin_pool, &format!("CREATE SCHEMA {}", quote(&schema))).await?;
        execute_on_pool(&state, &admin_pool, &format!("CREATE TABLE {src}(\"v\" INTEGER)")).await?;
        execute_on_pool(&state, &admin_pool, &format!("INSERT INTO {src} VALUES(1),(2)")).await?;
        execute_on_pool(&state, &admin_pool, &format!("GRANT USAGE ON SCHEMA {} TO {}", quote(&schema), quote(&role))).await?;
        execute_on_pool(&state, &target_pool, &format!("CREATE TABLE {dst}(\"v\" INTEGER)")).await?;
        execute_on_pool(&state, &target_pool, &format!("INSERT INTO {dst} VALUES(987)")).await?;
        let ordinary_pool = state.get_or_create_pool(&ordinary.id, ordinary.database.as_deref()).await?;
        let facts = execute_read_on_pool(&state, &ordinary_pool, "SELECT rolsuper::text,rolcreatedb::text,rolcreaterole::text,rolinherit::text,rolreplication::text,rolbypassrls::text FROM pg_catalog.pg_roles WHERE rolname=current_user").await?;
        if facts.rows.len()!=1 || facts.rows[0].iter().any(|v|v.as_str()!=Some("false")) {
            return Err("Temporary login unexpectedly has elevated attributes".into());
        }
        let mut transfer = request(&ordinary, &target, &schema, &target_schema, &table);
        transfer.mode = dbx_core::transfer::TransferMode::Overwrite;
        for (allowed, expected, expected_sum) in [(false,"1","987"),(true,"2","3"),(false,"2","3")] {
            if allowed {
                execute_on_pool(&state, &admin_pool, &format!("GRANT SELECT ON {src} TO {}", quote(&role))).await?;
            } else {
                execute_on_pool(&state, &admin_pool, &format!("REVOKE SELECT ON {src} FROM {}", quote(&role))).await?;
            }
            let outcome = transfer_table_with_result(&state,&transfer,&table,0,&ordinary.db_type,&target.db_type,&ordinary_pool,&target_pool,&HashMap::new(),&mut Vec::new(),None,false,|_|{},|_|{}).await;
            if allowed {
                if outcome?.moved_rows != 2 { return Err("Ordinary reader did not transfer both rows".into()); }
            } else {
                let error = outcome.err().ok_or("Missing SELECT unexpectedly allowed overwrite")?;
                if !error.to_ascii_lowercase().contains("permission denied") { return Err(error); }
            }
            if scalar(&state,&target_pool,&format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {dst}")).await!=json!(expected) {
                return Err("Source permission failure changed the target".into());
            }
            let sum = scalar(&state,&target_pool,&format!("SELECT CAST(SUM(\"v\") AS VARCHAR(30)) FROM {dst}")).await;
            if sum != json!(expected_sum) { return Err("Target sentinel or copied values changed unexpectedly".into()); }
        }
        if execute_on_pool(&state,&ordinary_pool,&format!("INSERT INTO {src} VALUES(3)")).await.is_ok() {
            return Err("Read-only fixture grant unexpectedly permitted INSERT".into());
        }
        Ok(())
    }.await;
    state.close_database_pool(&ordinary.id, ordinary.database.as_deref()).await.unwrap();
    execute_on_pool(&state, &target_pool, &format!("DROP TABLE IF EXISTS {dst}")).await.unwrap();
    execute_on_pool(&state, &admin_pool, &format!("DROP OWNED BY {}", quote(&role))).await.unwrap();
    execute_on_pool(&state, &admin_pool, &format!("DROP ROLE {}", quote(&role))).await.unwrap();
    execute_on_pool(&state, &admin_pool, &format!("DROP SCHEMA IF EXISTS {} CASCADE", quote(&schema))).await.unwrap();
    if scalar(&state, &admin_pool, &format!("SELECT COUNT(*)::text FROM pg_catalog.pg_roles WHERE rolname='{}'", role))
        .await
        != json!("0")
    {
        panic!("Temporary role cleanup did not complete");
    }
    checks.unwrap();
}

#[tokio::test]
#[ignore = "requires an operator-created temporary SELECT-only target and the existing mixed UI fixture"]
async fn live_postgres_xugu_readonly_target() {
    let source = config("DBX_LIVE_PG_XUGU_SOURCE_CONFIG", "pg-ro-target-source");
    let admin = config("DBX_LIVE_PG_XUGU_TARGET_CONFIG", "pg-ro-target-admin");
    let reader = config("DBX_LIVE_PG_XUGU_READONLY_TARGET_CONFIG", "pg-ro-target-reader");
    assert!(reader.username.starts_with("DBX_PX_RO_"));
    let schema = std::env::var("DBX_LIVE_PG_XUGU_UI_SCHEMA").unwrap();
    let table = std::env::var("DBX_LIVE_PG_XUGU_UI_TABLE").unwrap();
    assert!(schema.starts_with("dbx_px_ui_") && table.starts_with("DBX_PX_UI_"));
    let target_schema = std::env::var("DBX_LIVE_PG_XUGU_TARGET_SCHEMA").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        PathBuf::from(std::env::var("DBX_LIVE_PG_XUGU_AGENT_DIR").unwrap()),
        env!("CARGO_PKG_VERSION"),
    ));
    {
        let mut configs = state.configs.write().await;
        for c in [&source, &admin, &reader] {
            configs.insert(c.id.clone(), c.clone());
        }
    }
    let source_pool = state.get_or_create_pool(&source.id, source.database.as_deref()).await.unwrap();
    let admin_pool = state.get_or_create_pool(&admin.id, admin.database.as_deref()).await.unwrap();
    let reader_pool = state.get_or_create_pool(&reader.id, reader.database.as_deref()).await.unwrap();
    assert_eq!(scalar(&state, &reader_pool, "SELECT USER FROM DUAL").await, json!(reader.username));
    let dst = format!("{}.{}", quote(&target_schema), quote(&table));
    let snapshot = format!("SELECT CAST(COUNT(*) AS VARCHAR(40)),CAST(SUM(\"id\") AS VARCHAR(40)) FROM {dst}");
    let original = execute_read_on_pool(&state, &admin_pool, &snapshot).await.unwrap().rows;
    assert_eq!(original, execute_read_on_pool(&state, &reader_pool, &snapshot).await.unwrap().rows);
    for sql in [
        format!("INSERT INTO {dst}(\"id\",\"name\") VALUES(-999999,'denied fixture')"),
        format!("TRUNCATE TABLE {dst}"),
    ] {
        let error =
            execute_on_pool(&state, &reader_pool, &sql).await.expect_err("SELECT-only target must reject writes");
        assert!(error.contains("18012") || error.contains("权限"), "{error}");
        assert_eq!(original, execute_read_on_pool(&state, &admin_pool, &snapshot).await.unwrap().rows);
    }
    let mut transfer = request(&source, &reader, &schema, &target_schema, &table);
    transfer.content = dbx_core::transfer::TransferContent::DataOnly;
    transfer.create_table = false;
    for mode in [dbx_core::transfer::TransferMode::Append, dbx_core::transfer::TransferMode::Overwrite] {
        transfer.mode = mode;
        let error = transfer_table_with_result(
            &state,
            &transfer,
            &table,
            0,
            &source.db_type,
            &reader.db_type,
            &source_pool,
            &reader_pool,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| {},
            |_| {},
        )
        .await
        .expect_err("SELECT-only target must not transfer");
        assert!(error.contains("does not exist") || error.contains("权限") || error.contains("permission"), "{error}");
        assert_eq!(original, execute_read_on_pool(&state, &admin_pool, &snapshot).await.unwrap().rows);
    }
}

#[tokio::test]
#[ignore = "requires an explicitly armed loopback INSERT-response-loss fixture proxy"]
async fn live_postgres_xugu_lost_insert_reply() {
    assert_eq!(std::env::var("DBX_LIVE_PG_XUGU_ALLOW_FAULT").as_deref(), Ok("1"));
    let source = config("DBX_LIVE_PG_XUGU_SOURCE_CONFIG", "pg-fault-source");
    let admin = config("DBX_LIVE_PG_XUGU_TARGET_CONFIG", "pg-fault-admin");
    let proxy = config("DBX_LIVE_PG_XUGU_PROXY_CONFIG", "pg-fault-proxy");
    assert_eq!(proxy.host, "127.0.0.1");
    let source_schema = "dbx_px_ui_261029";
    let table = "DBX_PX_UI_Mixed_261029";
    let target_schema = std::env::var("DBX_LIVE_PG_XUGU_TARGET_SCHEMA").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        PathBuf::from(std::env::var("DBX_LIVE_PG_XUGU_AGENT_DIR").unwrap()),
        env!("CARGO_PKG_VERSION"),
    ));
    {
        let mut configs = state.configs.write().await;
        for cfg in [&source, &admin, &proxy] {
            configs.insert(cfg.id.clone(), cfg.clone());
        }
    }
    let source_pool = state.get_or_create_pool(&source.id, source.database.as_deref()).await.unwrap();
    let admin_pool = state.get_or_create_pool(&admin.id, admin.database.as_deref()).await.unwrap();
    let proxy_pool = state.get_or_create_pool(&proxy.id, proxy.database.as_deref()).await.unwrap();
    let dst = format!("{}.{}", quote(&target_schema), quote(table));
    assert_eq!(
        scalar(&state, &admin_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {dst}")).await,
        json!("4")
    );
    execute_on_pool(
        &state,
        &admin_pool,
        &format!("INSERT INTO {dst}(\"id\",\"name\") VALUES(5,'response-loss sentinel')"),
    )
    .await
    .unwrap();
    let mut transfer = request(&source, &proxy, source_schema, &target_schema, table);
    transfer.content = dbx_core::transfer::TransferContent::DataOnly;
    transfer.create_table = false;
    transfer.mode = dbx_core::transfer::TransferMode::Overwrite;
    transfer.batch_size = 1000;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        dbx_core::transfer::with_transfer_operation_timeout(
            Some(2),
            transfer_table_with_result(
                &state,
                &transfer,
                table,
                0,
                &source.db_type,
                &proxy.db_type,
                &source_pool,
                &proxy_pool,
                &HashMap::new(),
                &mut Vec::new(),
                None,
                false,
                |_| {},
                |_| {},
            ),
        ),
    )
    .await
    .expect("unknown write must settle");
    let error = result.expect_err("lost INSERT reply must not be reported as success");
    assert!(error.to_ascii_lowercase().contains("timed out"), "{error}");
    let rows=execute_read_on_pool(&state,&admin_pool,&format!("SELECT CAST(COUNT(*) AS VARCHAR(30)),CAST(SUM(\"id\") AS VARCHAR(30)),CAST(SUM(CASE WHEN \"id\"=5 THEN 1 ELSE 0 END) AS VARCHAR(30)) FROM {dst}")).await.unwrap().rows;
    assert_eq!(
        rows,
        vec![vec![json!("4"), json!("10"), json!("0")]],
        "INSERT committed despite the lost acknowledgment; the old sentinel was cleared"
    );
    // The proxy independently records the number of forwarded INSERT requests.
    // Its operator must verify exactly one before declaring the no-replay test passed.
}

#[tokio::test]
#[ignore = "requires disposable DBX_LIVE_PG_XUGU_SOURCE_CONFIG / TARGET_CONFIG and installed Xugu agent"]
async fn live_postgres_xugu_types_pages_and_overwrite_protection() {
    let mut source = config("DBX_LIVE_PG_XUGU_SOURCE_CONFIG", "pg-xugu-source");
    source.init_script = Some("SET DateStyle TO 'SQL, DMY'".into());
    let target = config("DBX_LIVE_PG_XUGU_TARGET_CONFIG", "pg-xugu-target");
    assert_eq!(source.db_type, DatabaseType::Postgres);
    assert_eq!(target.db_type, DatabaseType::Xugu);
    let target_schema = std::env::var("DBX_LIVE_PG_XUGU_TARGET_SCHEMA").expect("target test schema");
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let source_schema = format!("dbx_px_{suffix}");
    let table = format!("DBX_PX_{suffix}_Mixed");
    let dir = std::env::temp_dir().join(format!("dbx-pg-xugu-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let agent_dir = PathBuf::from(std::env::var("DBX_LIVE_PG_XUGU_AGENT_DIR").expect("installed agent directory"));
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.join("plugins"),
        agent_dir,
        env!("CARGO_PKG_VERSION"),
    ));
    {
        let mut configs = state.configs.write().await;
        configs.insert(source.id.clone(), source.clone());
        configs.insert(target.id.clone(), target.clone());
    }
    let source_pool =
        state.get_or_create_pool(&source.id, source.database.as_deref()).await.expect("source connection");
    if let Some(dbx_core::connection::PoolKind::Postgres(pool)) = state.pool_handle(&source_pool).await {
        pool.resize(1);
    }
    execute_on_pool(&state, &source_pool, "SET DateStyle TO 'SQL, DMY'").await.unwrap();
    assert!(scalar(&state, &source_pool, "SHOW DateStyle")
        .await
        .as_str()
        .is_some_and(|v| v.contains("SQL") && v.contains("DMY")));
    let target_pool =
        state.get_or_create_pool(&target.id, target.database.as_deref()).await.expect("target connection");
    eprintln!(
        "Native Xugu JSON numeric control: {}",
        scalar(
            &state,
            &target_pool,
            "SELECT CAST(CAST('{\"n\":123456789012345678901234567890}' AS JSON) AS VARCHAR(4000)) FROM DUAL"
        )
        .await
    );
    let src = format!("{}.{}", quote(&source_schema), quote(&table));
    let dst = format!("{}.{}", quote(&target_schema), quote(&table));
    execute_on_pool(&state, &source_pool, &format!("CREATE SCHEMA {}", quote(&source_schema))).await.unwrap();
    execute_on_pool(&state,&source_pool,&format!("CREATE TABLE {src} (\"id\" INTEGER PRIMARY KEY, \"big\" BIGINT, \"exact\" NUMERIC(38,6), \"flag\" BOOLEAN, \"fixed\" CHARACTER(5), \"var\" VARCHAR(120), \"long\" TEXT, \"bin\" BYTEA, \"d\" DATE, \"t\" TIME(3), \"ts\" TIMESTAMP(6), \"uuid\" UUID, \"j\" JSON, \"jb\" JSONB, \"oidv\" OID)")).await.unwrap();
    execute_on_pool(&state,&source_pool,&format!(r#"INSERT INTO {src} VALUES
      (1,9223372036854775807,12345678901234567890123456789012.123456,true,'abc','quote''s \path','中文\path' || chr(10),decode('00017fff','hex'),'2026-02-03','04:05:06.123','2026-02-03 04:05:06.123456','123e4567-e89b-12d3-a456-426614174000','{{"n":123456789012345678901234567890,"s":"a\\b"}}','{{"a":[true,null,1]}}',4294967295),
      (2,-9223372036854775808,-0.000001,false,'z','', '',decode('','hex'),'2000-02-29','00:00:00','2000-02-29 00:00:00','00000000-0000-0000-0000-000000000000','null','[]',0),
      (9,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
      (10,10,10,true,'x','ten',repeat('L',160000),decode(repeat('00ff',70000),'hex'),'9999-12-31','23:59:59.999','9999-12-31 23:59:59.999999','ffffffff-ffff-ffff-ffff-ffffffffffff','"scalar"','false',10),
      (99,99,99,false,'a','99','tail',decode('ff','hex'),'0001-01-01','00:00:00','0001-01-01 00:00:00','10000000-0000-0000-0000-000000000000','1','{{}}',99),
      (100,100,100,true,'b','100','tail',decode('01','hex'),'2026-01-01','12:00:00','2026-01-01 12:00:00','20000000-0000-0000-0000-000000000000','true','null',100)
    "#)).await.unwrap();
    let transfer = request(&source, &target, &source_schema, &target_schema, &table);
    let result = transfer_table_with_result(
        &state,
        &transfer,
        &table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("mixed transfer");
    assert_eq!(result.moved_rows, 6);
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {dst}")).await,
        json!("6")
    );
    let rows=execute_read_on_pool(&state,&target_pool,&format!("SELECT \"id\",CAST(\"big\" AS VARCHAR(40)),CAST(\"exact\" AS VARCHAR(60)),\"var\",LENGTH(\"long\"),LENGTH(\"bin\") FROM {dst} ORDER BY \"id\"")).await.unwrap().rows;
    assert_eq!(rows.len(), 6);
    assert_eq!(rows[0][1], json!("9223372036854775807"));
    assert_eq!(rows[0][2], json!("12345678901234567890123456789012.123456"));
    assert_eq!(rows[0][3], json!("quote's \\path"));
    assert_eq!(rows[1][3], json!(""));
    assert_eq!(rows[1][4].to_string(), "0", "empty CLOB must not become NULL");
    assert_eq!(rows[1][5].to_string(), "0", "empty BLOB must not become NULL");
    assert_eq!(rows[2][1], Value::Null);
    assert_eq!(rows[2][4], Value::Null);
    assert_eq!(rows[2][5], Value::Null);
    assert_eq!(rows[3][4].to_string(), "160000");
    assert_eq!(rows[3][5].to_string(), "140000");
    let json_text =
        scalar(&state, &target_pool, &format!("SELECT CAST(\"j\" AS VARCHAR(4000)) FROM {dst} WHERE \"id\"=1")).await;
    let json_text = json_text.as_str().expect("JSON text");
    assert!(json_text.contains("123456789012345678901234567890"));
    assert_eq!(serde_json::from_str::<Value>(json_text).unwrap()["s"], json!("a\\b"));
    let binary = scalar(&state, &target_pool, &format!("SELECT RAWTOHEX(\"bin\") FROM {dst} WHERE \"id\"=10")).await;
    assert!(binary.as_str().expect("binary hex").eq_ignore_ascii_case(&"00ff".repeat(70000)));
    let temporal = execute_read_on_pool(&state, &target_pool, &format!("SELECT CAST(\"d\" AS VARCHAR(60)),CAST(\"t\" AS VARCHAR(60)),TO_CHAR(\"ts\",'YYYY-MM-DD HH24:MI:SS.SSSSSS'),CASE WHEN \"flag\"=TRUE THEN 'true' ELSE 'false' END,\"uuid\" FROM {dst} WHERE \"id\"=1")).await.unwrap().rows;
    assert!(matches!(temporal[0][0].as_str(), Some("2026-02-03" | "2026-02-03 00:00:00")));
    assert_eq!(temporal[0][1], json!("04:05:06.123"));
    assert_eq!(temporal[0][2], json!("2026-02-03 04:05:06.123456"));
    assert_eq!(temporal[0][3], json!("true"));
    assert_eq!(temporal[0][4], json!("123e4567-e89b-12d3-a456-426614174000"));
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(\"oidv\" AS VARCHAR(30)) FROM {dst} WHERE \"id\"=1")).await,
        json!("4294967295")
    );
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT SUBSTR(\"long\",1,100) FROM {dst} WHERE \"id\"=1")).await,
        json!("中文\\path\n")
    );
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT SUBSTR(\"j\",1,100) FROM {dst} WHERE \"id\"=2")).await,
        json!("null")
    );
    assert_eq!(scalar(&state, &target_pool, &format!("SELECT \"j\" FROM {dst} WHERE \"id\"=9")).await, Value::Null);
    for offset in (1..=160000).step_by(5000) {
        let part =
            scalar(&state, &target_pool, &format!("SELECT SUBSTR(\"long\",{offset},5000) FROM {dst} WHERE \"id\"=10"))
                .await;
        assert_eq!(part, json!("L".repeat(5000)));
    }
    // A non-finite value must be caught before overwriting the six target rows.
    let unsafe_table = format!("DBX_PX_{suffix}_Unsafe");
    let unsafe_src = format!("{}.{}", quote(&source_schema), quote(&unsafe_table));
    let unsafe_dst = format!("{}.{}", quote(&target_schema), quote(&unsafe_table));
    execute_on_pool(&state, &source_pool, &format!("CREATE TABLE {unsafe_src}(\"v\" DOUBLE PRECISION)")).await.unwrap();
    execute_on_pool(&state, &source_pool, &format!("INSERT INTO {unsafe_src} VALUES ('NaN')")).await.unwrap();
    execute_on_pool(&state, &target_pool, &format!("CREATE TABLE {unsafe_dst}(\"v\" DOUBLE)")).await.unwrap();
    execute_on_pool(&state, &target_pool, &format!("INSERT INTO {unsafe_dst} VALUES (123)")).await.unwrap();
    let mut unsafe_request = request(&source, &target, &source_schema, &target_schema, &unsafe_table);
    unsafe_request.mode = dbx_core::transfer::TransferMode::Overwrite;
    let error = transfer_table_with_result(
        &state,
        &unsafe_request,
        &unsafe_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .unwrap_err();
    assert!(error.contains("target has not been modified"), "{error}");
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(\"v\" AS VARCHAR(20)) FROM {unsafe_dst}")).await,
        json!("123")
    );
    let boundary_table = format!("DBX_PX_{suffix}_Bounds");
    let boundary_src = format!("{}.{}", quote(&source_schema), quote(&boundary_table));
    let boundary_dst = format!("{}.{}", quote(&target_schema), quote(&boundary_table));
    execute_on_pool(&state,&source_pool,&format!("CREATE TABLE {boundary_src}(\"id\" INTEGER PRIMARY KEY,\"s\" SMALLINT,\"n\" NUMERIC(38,0),\"v\" VARCHAR(4),\"c\" CHAR(4),\"unlimited\" VARCHAR)")).await.unwrap();
    execute_on_pool(&state,&source_pool,&format!("INSERT INTO {boundary_src} VALUES (1,-32768,99999999999999999999999999999999999999,'中文测试','中文测试','trailing '),(2,32767,-99999999999999999999999999999999999999,'ABCD','ABCD','')")).await.unwrap();
    let boundary_request = request(&source, &target, &source_schema, &target_schema, &boundary_table);
    transfer_table_with_result(
        &state,
        &boundary_request,
        &boundary_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("character and numeric boundaries");
    let boundary=execute_read_on_pool(&state,&target_pool,&format!("SELECT CAST(\"s\" AS VARCHAR(20)),CAST(\"n\" AS VARCHAR(60)),\"v\",\"c\",SUBSTR(\"unlimited\",1,100) FROM {boundary_dst} ORDER BY \"id\"")).await.unwrap().rows;
    assert_eq!(
        boundary[0],
        vec![
            json!("-32768"),
            json!("99999999999999999999999999999999999999"),
            json!("中文测试"),
            json!("中文测试"),
            json!("trailing ")
        ]
    );
    assert_eq!(boundary[1][0], json!("32767"));
    assert_eq!(boundary[1][1], json!("-99999999999999999999999999999999999999"));
    assert_eq!(boundary[1][4], json!(""));
    execute_on_pool(&state, &target_pool, &format!("DROP TABLE {boundary_dst}")).await.unwrap();
    let unique_table = format!("DBX_PX_{suffix}_NullableUK");
    let unique_src = format!("{}.{}", quote(&source_schema), quote(&unique_table));
    let unique_dst = format!("{}.{}", quote(&target_schema), quote(&unique_table));
    execute_on_pool(
        &state,
        &source_pool,
        &format!(
            "CREATE TABLE {unique_src}(\"id\" INTEGER PRIMARY KEY,\"a\" INTEGER,\"b\" INTEGER,UNIQUE(\"a\",\"b\"))"
        ),
    )
    .await
    .unwrap();
    execute_on_pool(
        &state,
        &source_pool,
        &format!(
            "INSERT INTO {unique_src} VALUES(1,1,NULL),(2,1,NULL),(3,NULL,1),(4,NULL,1),(5,NULL,NULL),(6,NULL,NULL)"
        ),
    )
    .await
    .unwrap();
    let unique_request = request(&source, &target, &source_schema, &target_schema, &unique_table);
    transfer_table_with_result(
        &state,
        &unique_request,
        &unique_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("nullable composite unique key");
    assert_eq!(
        scalar(
            &state,
            &target_pool,
            &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {unique_dst} WHERE \"a\" IS NULL AND \"b\" IS NULL")
        )
        .await,
        json!("2")
    );
    execute_on_pool(&state, &source_pool, &format!("TRUNCATE TABLE {unique_src}")).await.unwrap();
    execute_on_pool(&state, &source_pool, &format!("INSERT INTO {unique_src} VALUES(7,7,7)")).await.unwrap();
    transfer_table_with_result(
        &state,
        &unique_request,
        &unique_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("unique-key append");
    execute_on_pool(&state, &source_pool, &format!("TRUNCATE TABLE {unique_src}")).await.unwrap();
    execute_on_pool(&state, &source_pool, &format!("INSERT INTO {unique_src} VALUES(8,7,7)")).await.unwrap();
    assert!(transfer_table_with_result(
        &state,
        &unique_request,
        &unique_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {}
    )
    .await
    .is_err());
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {unique_dst}")).await,
        json!("7")
    );
    execute_on_pool(&state, &target_pool, &format!("DROP TABLE {unique_dst}")).await.unwrap();
    let float_table = format!("DBX_PX_{suffix}_Floats");
    let float_src = format!("{}.{}", quote(&source_schema), quote(&float_table));
    let float_dst = format!("{}.{}", quote(&target_schema), quote(&float_table));
    execute_on_pool(
        &state,
        &source_pool,
        &format!("CREATE TABLE {float_src}(\"id\" INTEGER PRIMARY KEY,\"f\" REAL,\"d\" DOUBLE PRECISION)"),
    )
    .await
    .unwrap();
    execute_on_pool(&state,&source_pool,&format!("INSERT INTO {float_src} VALUES (1,'1.234567','1.2345678901234567'),(2,'1.40129846e-45','4.9406564584124654e-324'),(3,'3.4028234e38','1.7976931348623157e308'),(4,'-0','-0'),(5,'-1.234567e-30','-1.234567890123e-300')")).await.unwrap();
    let float_request = request(&source, &target, &source_schema, &target_schema, &float_table);
    transfer_table_with_result(
        &state,
        &float_request,
        &float_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("finite float transfer");
    let expected = execute_read_on_pool(
        &state,
        &source_pool,
        &format!("SELECT \"f\"::text,\"d\"::text FROM {float_src} ORDER BY \"id\""),
    )
    .await
    .unwrap()
    .rows;
    let actual =
        execute_read_on_pool(&state, &target_pool, &format!("SELECT \"f\",\"d\" FROM {float_dst} ORDER BY \"id\""))
            .await
            .unwrap()
            .rows;
    for (expected, actual) in expected.iter().zip(&actual) {
        for i in 0..2 {
            let text = expected[i].as_str().unwrap();
            let expected = if i == 0 { text.parse::<f32>().unwrap() as f64 } else { text.parse::<f64>().unwrap() };
            let actual = actual[i].as_f64().or_else(|| actual[i].as_str().and_then(|v| v.parse::<f64>().ok())).unwrap();
            if expected == 0.0 {
                assert_eq!(actual, 0.0);
            } else {
                assert_ne!(actual, 0.0, "finite float underflow");
                assert!(
                    (actual - expected).abs() / expected.abs() < if i == 0 { 1e-6 } else { 1e-12 },
                    "float mismatch: {text} vs {actual}"
                );
            }
        }
    }
    execute_on_pool(&state, &target_pool, &format!("DROP TABLE {float_dst}")).await.unwrap();
    // Every rejected type/feature must leave a preexisting target sentinel intact.
    for (index, definition) in [
        "\"v\" numeric",
        "\"v\" numeric(39,0)",
        "\"v\" timetz(6)",
        "\"v\" tsvector",
        "\"v\" interval",
        "\"v\" integer[]",
        "\"v\" bit(60001)",
        "\"v\" cidr",
        "\"v\" inet",
        "\"v\" money",
        "\"v\" point",
        "\"v\" INTEGER CHECK(\"v\">0)",
        "\"v\" INTEGER GENERATED ALWAYS AS IDENTITY",
    ]
    .iter()
    .enumerate()
    {
        let rejected_table = format!("DBX_PX_{suffix}_Reject_{index}");
        let rejected_src = format!("{}.{}", quote(&source_schema), quote(&rejected_table));
        let rejected_dst = format!("{}.{}", quote(&target_schema), quote(&rejected_table));
        execute_on_pool(&state, &source_pool, &format!("CREATE TABLE {rejected_src}({definition})")).await.unwrap();
        execute_on_pool(&state, &target_pool, &format!("CREATE TABLE {rejected_dst}(\"v\" INTEGER)")).await.unwrap();
        execute_on_pool(&state, &target_pool, &format!("INSERT INTO {rejected_dst} VALUES (987)")).await.unwrap();
        let mut rejected = request(&source, &target, &source_schema, &target_schema, &rejected_table);
        rejected.mode = dbx_core::transfer::TransferMode::Overwrite;
        assert!(
            transfer_table_with_result(
                &state,
                &rejected,
                &rejected_table,
                0,
                &source.db_type,
                &target.db_type,
                &source_pool,
                &target_pool,
                &HashMap::new(),
                &mut Vec::new(),
                None,
                false,
                |_| {},
                |_| {}
            )
            .await
            .is_err(),
            "must reject {definition}"
        );
        assert_eq!(
            scalar(&state, &target_pool, &format!("SELECT CAST(\"v\" AS VARCHAR(30)) FROM {rejected_dst}")).await,
            json!("987")
        );
        execute_on_pool(&state, &target_pool, &format!("DROP TABLE {rejected_dst}")).await.unwrap();
    }
    for (index, feature) in [
        "index",
        "referenced_index",
        "rule",
        "rls",
        "unlogged",
        "generated",
        "deferrable",
        "include",
        "collation",
        "default_expression",
        "foreign_key",
        "partition",
        "inheritance",
        "trigger",
        "bytea_default",
        "owned_nonserial",
    ]
    .iter()
    .enumerate()
    {
        let feature_table = format!("DBX_PX_{suffix}_Feature_{index}");
        let feature_src = format!("{}.{}", quote(&source_schema), quote(&feature_table));
        let feature_dst = format!("{}.{}", quote(&target_schema), quote(&feature_table));
        let aux = format!("{}.{}", quote(&source_schema), quote(&format!("{feature_table}_aux")));
        let key_name = quote(&format!("{feature_table}_idx"));
        let create = match *feature {
            "unlogged" => format!("CREATE UNLOGGED TABLE {feature_src}(\"v\" INTEGER)"),
            "generated" => format!(
                "CREATE TABLE {feature_src}(\"base\" INTEGER,\"v\" INTEGER GENERATED ALWAYS AS (\"base\"+1) STORED)"
            ),
            "deferrable" => format!("CREATE TABLE {feature_src}(\"v\" INTEGER UNIQUE DEFERRABLE)"),
            "include" => format!(
                "CREATE TABLE {feature_src}(\"v\" INTEGER,\"payload\" INTEGER,UNIQUE(\"v\") INCLUDE(\"payload\"))"
            ),
            "collation" => format!("CREATE TABLE {feature_src}(\"v\" VARCHAR(4) COLLATE \"C\")"),
            "default_expression" => format!("CREATE TABLE {feature_src}(\"v\" INTEGER DEFAULT (1+2))"),
            "bytea_default" => format!(r"CREATE TABLE {feature_src}(v BYTEA DEFAULT '\x00ff'::bytea)"),
            "partition" => format!("CREATE TABLE {feature_src}(\"v\" INTEGER) PARTITION BY RANGE(\"v\")"),
            _ => format!("CREATE TABLE {feature_src}(\"v\" INTEGER)"),
        };
        execute_on_pool(&state, &source_pool, &create).await.unwrap();
        let extra = match *feature {
            "index" => vec![format!("CREATE INDEX {key_name} ON {feature_src}(\"v\")")],
            "referenced_index" => vec![
                format!("CREATE UNIQUE INDEX {key_name} ON {feature_src}(\"v\")"),
                format!("CREATE TABLE {aux}(\"v\" INTEGER REFERENCES {feature_src}(\"v\"))"),
            ],
            "rule" => vec![format!("CREATE RULE test_rule AS ON INSERT TO {feature_src} DO INSTEAD NOTHING")],
            "rls" => vec![format!("ALTER TABLE {feature_src} ENABLE ROW LEVEL SECURITY")],
            "owned_nonserial" => vec![format!("CREATE SEQUENCE {aux} AS INTEGER OWNED BY {feature_src}.\"v\"")],
            "foreign_key" => vec![
                format!("CREATE TABLE {aux}(\"v\" INTEGER PRIMARY KEY)"),
                format!("ALTER TABLE {feature_src} ADD FOREIGN KEY(\"v\") REFERENCES {aux}(\"v\")"),
            ],
            "inheritance" => vec![format!("CREATE TABLE {aux}() INHERITS({feature_src})")],
            "trigger" => vec![
                format!("CREATE FUNCTION {aux}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$"),
                format!(
                    "CREATE TRIGGER test_trigger BEFORE INSERT ON {feature_src} FOR EACH ROW EXECUTE FUNCTION {aux}()"
                ),
            ],
            _ => Vec::new(),
        };
        for sql in extra {
            execute_on_pool(&state, &source_pool, &sql).await.unwrap();
        }
        execute_on_pool(&state, &target_pool, &format!("CREATE TABLE {feature_dst}(\"v\" INTEGER)")).await.unwrap();
        execute_on_pool(&state, &target_pool, &format!("INSERT INTO {feature_dst} VALUES (987)")).await.unwrap();
        let mut feature_request = request(&source, &target, &source_schema, &target_schema, &feature_table);
        feature_request.mode = dbx_core::transfer::TransferMode::Overwrite;
        assert!(
            transfer_table_with_result(
                &state,
                &feature_request,
                &feature_table,
                0,
                &source.db_type,
                &target.db_type,
                &source_pool,
                &target_pool,
                &HashMap::new(),
                &mut Vec::new(),
                None,
                false,
                |_| {},
                |_| {}
            )
            .await
            .is_err(),
            "must reject {feature}"
        );
        assert_eq!(
            scalar(&state, &target_pool, &format!("SELECT CAST(\"v\" AS VARCHAR(30)) FROM {feature_dst}")).await,
            json!("987"),
            "sentinel for {feature}"
        );
        execute_on_pool(&state, &target_pool, &format!("DROP TABLE {feature_dst}")).await.unwrap();
    }
    for (index, (source_definition, target_definition, sentinel)) in [
        ("\"v\" NUMERIC(38,6)", "\"v\" NUMERIC(10,2)", "987.65"),
        ("\"v\" VARCHAR(4)", "\"v\" VARCHAR(2)", "'OK'"),
        ("\"v\" TEXT", "\"v\" VARCHAR(4)", "'KEEP'"),
        ("\"v\" TIMESTAMP(6)", "\"v\" DATETIME(3)", "'2026-01-01 00:00:00'"),
        ("\"v\" INTEGER", "\"v\" INTEGER,\"required\" INTEGER NOT NULL", "987,1"),
        ("\"v\" INTEGER", "\"v\" INTEGER NOT NULL", "987"),
    ]
    .iter()
    .enumerate()
    {
        let capacity_table = format!("DBX_PX_{suffix}_Capacity_{index}");
        let capacity_src = format!("{}.{}", quote(&source_schema), quote(&capacity_table));
        let capacity_dst = format!("{}.{}", quote(&target_schema), quote(&capacity_table));
        execute_on_pool(&state, &source_pool, &format!("CREATE TABLE {capacity_src}({source_definition})"))
            .await
            .unwrap();
        execute_on_pool(&state, &target_pool, &format!("CREATE TABLE {capacity_dst}({target_definition})"))
            .await
            .unwrap();
        execute_on_pool(&state, &target_pool, &format!("INSERT INTO {capacity_dst} VALUES ({sentinel})"))
            .await
            .unwrap();
        let mut capacity = request(&source, &target, &source_schema, &target_schema, &capacity_table);
        capacity.mode = dbx_core::transfer::TransferMode::Overwrite;
        assert!(
            transfer_table_with_result(
                &state,
                &capacity,
                &capacity_table,
                0,
                &source.db_type,
                &target.db_type,
                &source_pool,
                &target_pool,
                &HashMap::new(),
                &mut Vec::new(),
                None,
                false,
                |_| {},
                |_| {}
            )
            .await
            .is_err(),
            "must reject target {target_definition}"
        );
        assert_eq!(
            scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {capacity_dst}")).await,
            json!("1")
        );
        execute_on_pool(&state, &target_pool, &format!("DROP TABLE {capacity_dst}")).await.unwrap();
    }
    // More than 10,000 rows exercise keyset ordering and the keyless ctid path.
    for keyed in [true, false] {
        let large_table = format!("DBX_PX_{suffix}_{}", if keyed { "Keys" } else { "Heap" });
        let large_src = format!("{}.{}", quote(&source_schema), quote(&large_table));
        let large_dst = format!("{}.{}", quote(&target_schema), quote(&large_table));
        let key = if keyed { ", PRIMARY KEY(\"a\",\"b\")" } else { "" };
        execute_on_pool(
            &state,
            &source_pool,
            &format!("CREATE TABLE {large_src}(\"a\" INTEGER NOT NULL,\"b\" INTEGER NOT NULL,\"v\" TEXT{key})"),
        )
        .await
        .unwrap();
        execute_on_pool(
            &state,
            &source_pool,
            &format!("INSERT INTO {large_src} SELECT g/3,g%3,'value-'||g FROM generate_series(1,12007) g"),
        )
        .await
        .unwrap();
        let mut large_request = request(&source, &target, &source_schema, &target_schema, &large_table);
        large_request.batch_size = 257;
        let result = transfer_table_with_result(
            &state,
            &large_request,
            &large_table,
            0,
            &source.db_type,
            &target.db_type,
            &source_pool,
            &target_pool,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| {},
            |_| {},
        )
        .await
        .expect("large transfer");
        assert_eq!(result.moved_rows, 12007);
        let signature = "COUNT(*)||':'||SUM(\"a\")||':'||SUM(\"b\")";
        let expected = scalar(&state, &source_pool, &format!("SELECT {signature} FROM {large_src}")).await;
        let actual = scalar(&state, &target_pool, &format!("SELECT {signature} FROM {large_dst}")).await;
        assert_eq!(actual, expected);
        assert_eq!(scalar(&state,&target_pool,&format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM (SELECT \"a\",\"b\" FROM {large_dst} GROUP BY \"a\",\"b\") q")).await,json!("12007"));
        if keyed {
            execute_on_pool(&state, &target_pool, &format!("TRUNCATE TABLE {large_dst}")).await.unwrap();
            let cancel_id = large_request.transfer_id.clone();
            let mut requested = false;
            let mut acknowledged = 0;
            let cancelled = transfer_table_with_result(
                &state,
                &large_request,
                &large_table,
                0,
                &source.db_type,
                &target.db_type,
                &source_pool,
                &target_pool,
                &HashMap::new(),
                &mut Vec::new(),
                None,
                false,
                |progress| {
                    acknowledged = progress.rows_transferred;
                    if !requested && acknowledged >= 257 {
                        requested = true;
                        let id = cancel_id.clone();
                        tokio::spawn(async move {
                            dbx_core::transfer::set_cancelled(&id).await;
                        });
                    }
                },
                |_| {},
            )
            .await;
            assert!(cancelled.is_err_and(|error| error == "Cancelled"));
            assert!((257..12007).contains(&acknowledged));
            assert_eq!(
                scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {large_dst}")).await,
                json!(acknowledged.to_string())
            );
            dbx_core::transfer::clear_cancelled(&cancel_id).await;
        }
        execute_on_pool(&state, &target_pool, &format!("DROP TABLE {large_dst}")).await.unwrap();
    }
    // Positive and negative identities, then append below the advanced bound.
    for step in [5, -3, 1] {
        let identity_table = format!(
            "DBX_PX_{suffix}_{}",
            if step == 1 {
                "Serial"
            } else if step > 0 {
                "Pos"
            } else {
                "Neg"
            }
        );
        let identity_src = format!("{}.{}", quote(&source_schema), quote(&identity_table));
        let identity_dst = format!("{}.{}", quote(&target_schema), quote(&identity_table));
        let start = if step > 0 { 100 } else { -10 };
        let explicit = if step > 0 { 100000 } else { -100000 };
        let definition = if step == 1 {
            "SERIAL".to_string()
        } else {
            format!("INTEGER GENERATED BY DEFAULT AS IDENTITY (START WITH {start} INCREMENT BY {step})")
        };
        execute_on_pool(
            &state,
            &source_pool,
            &format!("CREATE TABLE {identity_src}(\"id\" {definition} PRIMARY KEY,\"note\" TEXT)"),
        )
        .await
        .unwrap();
        execute_on_pool(
            &state,
            &source_pool,
            &format!("INSERT INTO {identity_src}(\"id\",\"note\") VALUES ({explicit},'explicit')"),
        )
        .await
        .unwrap();
        let identity_request = request(&source, &target, &source_schema, &target_schema, &identity_table);
        transfer_table_with_result(
            &state,
            &identity_request,
            &identity_table,
            0,
            &source.db_type,
            &target.db_type,
            &source_pool,
            &target_pool,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| {},
            |_| {},
        )
        .await
        .expect("identity transfer");
        execute_on_pool(
            &state,
            &target_pool,
            &format!("INSERT INTO {identity_dst}(\"note\") VALUES ('generated-first')"),
        )
        .await
        .unwrap();
        assert_eq!(
            scalar(
                &state,
                &target_pool,
                &format!("SELECT CAST(\"id\" AS VARCHAR(30)) FROM {identity_dst} WHERE \"note\"='generated-first'")
            )
            .await,
            json!((explicit + step).to_string())
        );
        execute_on_pool(&state, &source_pool, &format!("TRUNCATE TABLE {identity_src}")).await.unwrap();
        execute_on_pool(
            &state,
            &source_pool,
            &format!("INSERT INTO {identity_src}(\"id\",\"note\") VALUES ({start},'append-below-bound')"),
        )
        .await
        .unwrap();
        transfer_table_with_result(
            &state,
            &identity_request,
            &identity_table,
            0,
            &source.db_type,
            &target.db_type,
            &source_pool,
            &target_pool,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            false,
            |_| {},
            |_| {},
        )
        .await
        .expect("advanced identity append");
        execute_on_pool(
            &state,
            &target_pool,
            &format!("INSERT INTO {identity_dst}(\"note\") VALUES ('generated-second')"),
        )
        .await
        .unwrap();
        assert_eq!(
            scalar(
                &state,
                &target_pool,
                &format!("SELECT CAST(\"id\" AS VARCHAR(30)) FROM {identity_dst} WHERE \"note\"='generated-second'")
            )
            .await,
            json!((explicit + step * 2).to_string())
        );
        execute_on_pool(&state, &target_pool, &format!("DROP TABLE {identity_dst}")).await.unwrap();
    }
    let structure_table = format!("DBX_PX_{suffix}_Structure");
    let structure_src = format!("{}.{}", quote(&source_schema), quote(&structure_table));
    let structure_dst = format!("{}.{}", quote(&target_schema), quote(&structure_table));
    execute_on_pool(
        &state,
        &source_pool,
        &format!("CREATE TABLE {structure_src}(\"id\" INTEGER PRIMARY KEY,\"v\" TEXT)"),
    )
    .await
    .unwrap();
    execute_on_pool(&state, &source_pool, &format!("INSERT INTO {structure_src} VALUES(1,'one'),(2,'two')"))
        .await
        .unwrap();
    let mut structure = request(&source, &target, &source_schema, &target_schema, &structure_table);
    structure.content = dbx_core::transfer::TransferContent::StructureOnly;
    transfer_table_with_result(
        &state,
        &structure,
        &structure_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("structure-only transfer");
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {structure_dst}")).await,
        json!("0")
    );
    structure.content = dbx_core::transfer::TransferContent::DataOnly;
    structure.create_table = false;
    let result = transfer_table_with_result(
        &state,
        &structure,
        &structure_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("data-only transfer");
    assert_eq!(result.moved_rows, 2);
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {structure_dst}")).await,
        json!("2")
    );
    execute_on_pool(&state, &source_pool, &format!("TRUNCATE TABLE {structure_src}")).await.unwrap();
    structure.mode = dbx_core::transfer::TransferMode::Overwrite;
    let empty = transfer_table_with_result(
        &state,
        &structure,
        &structure_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("empty source overwrite");
    assert_eq!(empty.moved_rows, 0);
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {structure_dst}")).await,
        json!("0")
    );
    execute_on_pool(&state, &target_pool, &format!("DROP TABLE {structure_dst}")).await.unwrap();
    let duplicate = transfer_table_with_result(
        &state,
        &transfer,
        &table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect_err("duplicate append must fail");
    assert!(duplicate.contains("13001") || duplicate.to_ascii_lowercase().contains("unique"), "{duplicate}");
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {dst}")).await,
        json!("6")
    );
    let mut overwrite = transfer.clone();
    overwrite.mode = dbx_core::transfer::TransferMode::Overwrite;
    let result = transfer_table_with_result(
        &state,
        &overwrite,
        &table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("overwrite transfer");
    assert_eq!(result.moved_rows, 6);
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {dst}")).await,
        json!("6")
    );
    // A blocked source read must time out without modifying the target, and a
    // later transfer must recover after the independent lock is released.
    execute_on_pool(&state, &source_pool, &format!("TRUNCATE TABLE {unsafe_src}")).await.unwrap();
    execute_on_pool(&state, &source_pool, &format!("INSERT INTO {unsafe_src} VALUES (456)")).await.unwrap();
    let locker_pool =
        dbx_core::db::postgres::connect(&source.connection_url(), std::time::Duration::from_secs(10)).await.unwrap();
    let mut locker =
        dbx_core::db::postgres::checkout_postgres_client(&locker_pool, None, std::time::Duration::from_secs(10))
            .await
            .unwrap();
    let lock = locker.transaction().await.unwrap();
    lock.batch_execute(&format!("LOCK TABLE {unsafe_src} IN ACCESS EXCLUSIVE MODE")).await.unwrap();
    unsafe_request.mode = dbx_core::transfer::TransferMode::Append;
    let timed = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        dbx_core::transfer::with_transfer_operation_timeout(
            Some(1),
            transfer_table_with_result(
                &state,
                &unsafe_request,
                &unsafe_table,
                0,
                &source.db_type,
                &target.db_type,
                &source_pool,
                &target_pool,
                &HashMap::new(),
                &mut Vec::new(),
                None,
                false,
                |_| {},
                |_| {},
            ),
        ),
    )
    .await;
    lock.rollback().await.unwrap();
    let error = timed.expect("source timeout must settle").expect_err("locked source must not transfer");
    assert!(error.to_ascii_lowercase().contains("timed out"), "{error}");
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(\"v\" AS VARCHAR(30)) FROM {unsafe_dst}")).await,
        json!("123")
    );
    let recovered = transfer_table_with_result(
        &state,
        &unsafe_request,
        &unsafe_table,
        0,
        &source.db_type,
        &target.db_type,
        &source_pool,
        &target_pool,
        &HashMap::new(),
        &mut Vec::new(),
        None,
        false,
        |_| {},
        |_| {},
    )
    .await
    .expect("transfer after source timeout");
    assert_eq!(recovered.moved_rows, 1);
    assert_eq!(
        scalar(&state, &target_pool, &format!("SELECT CAST(COUNT(*) AS VARCHAR(30)) FROM {unsafe_dst}")).await,
        json!("2")
    );
    execute_on_pool(&state, &target_pool, &format!("DROP TABLE {unsafe_dst}")).await.unwrap();
    execute_on_pool(&state, &target_pool, &format!("DROP TABLE {dst}")).await.unwrap();
    execute_on_pool(&state, &source_pool, &format!("DROP SCHEMA {} CASCADE", quote(&source_schema))).await.unwrap();
}
