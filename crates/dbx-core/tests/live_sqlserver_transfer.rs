use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;
use dbx_core::transfer::{
    drop_backup_tables, rename_tables_to_backup, transfer_table, TransferContent, TransferMode,
    TransferOwnershipPolicy, TransferRequest, TransferTableNameCase,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

fn live_sqlserver_config(id: &str, database: &str) -> ConnectionConfig {
    ConnectionConfig {
        docs_notes_path: None,
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
        db_type: DatabaseType::SqlServer,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        port: std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433),
        username: std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string()),
        password: std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD"),
        database: Some(database.to_string()),
        default_schema: None,
        visible_databases: None,
        visible_database_patterns: None,
        visible_schemas: None,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 15,
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
        redis_key_grouping: None,
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

async fn sqlserver_env() -> (String, u16, String, String) {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    (host, port, user, password)
}

async fn sqlserver_connect(database: &str) -> dbx_core::db::sqlserver::SqlServerClient {
    let (host, port, user, password) = sqlserver_env().await;
    dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(database), None, Duration::from_secs(20))
        .await
        .expect("connect SQL Server")
}

/// Whether a schema-scoped object with `name` still exists on `table`.
async fn sqlserver_object_on_table_exists(
    client: &mut dbx_core::db::sqlserver::SqlServerClient,
    table: &str,
    name: &str,
) -> bool {
    let sql = format!(
        "SELECT CASE WHEN EXISTS ( \
            SELECT 1 FROM sys.objects o WHERE o.name = N'{name}' AND o.parent_object_id = OBJECT_ID(N'dbo.{table}') \
            UNION ALL \
            SELECT 1 FROM sys.indexes i WHERE i.name = N'{name}' AND i.object_id = OBJECT_ID(N'dbo.{table}') \
         ) THEN 1 ELSE 0 END",
        name = name.replace('\'', "''"),
        table = table.replace('\'', "''"),
    );
    let result = dbx_core::db::sqlserver::execute_query(client, &sql).await.expect("query object existence");
    result.rows.first().and_then(|row| row.first()).and_then(|v| v.as_i64()).map(|n| n == 1).unwrap_or(false)
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn live_sqlserver_transfer_rebuild_releases_constraint_and_index_names() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_db = format!("dbx_rebuild_src_{}", &suffix[..12]);
    let target_db = format!("dbx_rebuild_dst_{}", &suffix[..12]);
    let connection_id = format!("live-sqlserver-rebuild-{suffix}");

    // Create both databases and populate source + target with same-named constraints.
    let mut master = sqlserver_connect("master").await;
    dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!("CREATE DATABASE [{source_db}]; CREATE DATABASE [{target_db}];"),
    )
    .await
    .expect("create rebuild databases");

    let mut source_client = sqlserver_connect(&source_db).await;
    dbx_core::db::sqlserver::execute_batch(
        &mut source_client,
        "CREATE TABLE dbo.departments (id INT NOT NULL CONSTRAINT PK_departments PRIMARY KEY, name NVARCHAR(32)); \
         CREATE TABLE dbo.employees (id INT NOT NULL CONSTRAINT PK_employees PRIMARY KEY, dept_id INT NULL, \
             CONSTRAINT FK_emp_dept FOREIGN KEY (dept_id) REFERENCES dbo.departments(id)); \
         CREATE INDEX IX_emp_dept ON dbo.employees(dept_id); \
         INSERT INTO dbo.departments VALUES (10, N'Engineering'), (20, N'Sales'); \
         INSERT INTO dbo.employees VALUES (1, 10), (2, 20);",
    )
    .await
    .expect("create source tables");

    let mut target_client = sqlserver_connect(&target_db).await;
    dbx_core::db::sqlserver::execute_batch(
        &mut target_client,
        "CREATE TABLE dbo.departments (id INT NOT NULL CONSTRAINT PK_departments PRIMARY KEY, name NVARCHAR(32)); \
         CREATE TABLE dbo.employees (id INT NOT NULL CONSTRAINT PK_employees PRIMARY KEY, dept_id INT NULL, \
             CONSTRAINT FK_emp_dept FOREIGN KEY (dept_id) REFERENCES dbo.departments(id)); \
         CREATE INDEX IX_emp_dept ON dbo.employees(dept_id); \
         INSERT INTO dbo.departments VALUES (99, N'Stale'); \
         INSERT INTO dbo.employees VALUES (98, 99);",
    )
    .await
    .expect("create target tables");

    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-rebuild-{suffix}"));
    std::fs::create_dir_all(&dir).expect("create rebuild directory");
    let storage = Storage::open(&dir.join("storage.db")).await.expect("open rebuild storage");
    let state = Arc::new(AppState::new(storage));
    let config = live_sqlserver_config(&connection_id, &source_db);
    state.configs.write().await.insert(connection_id.clone(), config);
    let source_pool_key = state.get_or_create_pool(&connection_id, Some(&source_db)).await.expect("source pool");
    let target_pool_key = state.get_or_create_pool(&connection_id, Some(&target_db)).await.expect("target pool");

    let request = TransferRequest {
        transfer_id: format!("live-sqlserver-rebuild-{suffix}"),
        source_connection_id: connection_id.clone(),
        source_database: source_db.clone(),
        source_schema: "dbo".to_string(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: target_db.clone(),
        target_schema: "dbo".to_string(),
        target_catalog: None,
        tables: vec!["departments".to_string(), "employees".to_string()],
        create_table: true,
        drop_target_before_create: true,
        drop_target_confirmed: true,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    let test_result = async {
        let backup_names = rename_tables_to_backup(
            &state,
            &request,
            &request.tables,
            DatabaseType::SqlServer,
            &target_pool_key,
            |_| {},
        )
        .await?;
        assert_eq!(backup_names.len(), 2, "both preexisting targets must be backed up");

        // The pre-pass must have released every schema-unique constraint and index name
        // so the rebuilt tables can reuse the source DDL's names without colliding.
        for (table, name) in [
            ("departments", "PK_departments"),
            ("employees", "PK_employees"),
            ("employees", "FK_emp_dept"),
            ("employees", "IX_emp_dept"),
        ] {
            assert!(
                !sqlserver_object_on_table_exists(&mut target_client, table, name).await,
                "{name} on {table} must have been released before rebuild"
            );
        }

        let mut pending_fk_alters: Vec<(String, String)> = Vec::new();
        for (i, table) in request.tables.iter().enumerate() {
            transfer_table(
                &state,
                &request,
                table,
                i,
                &DatabaseType::SqlServer,
                &DatabaseType::SqlServer,
                &source_pool_key,
                &target_pool_key,
                &HashMap::new(),
                &mut pending_fk_alters,
                Some(&backup_names),
                |_| {},
            )
            .await?;
        }

        // The rebuilt tables must have reclaimed the FK and index names — the names that
        // would otherwise collide with the backups. Primary keys are regenerated inline by
        // the source DDL (SQL Server auto-names them), so only their presence matters.
        for (table, name) in [("employees", "FK_emp_dept"), ("employees", "IX_emp_dept")] {
            assert!(
                sqlserver_object_on_table_exists(&mut target_client, table, name).await,
                "{name} on {table} must be rebuilt"
            );
        }
        for table in ["departments", "employees"] {
            let pk = dbx_core::db::sqlserver::execute_query(
                &mut target_client,
                &format!(
                    "SELECT COUNT(*) FROM sys.key_constraints WHERE parent_object_id = OBJECT_ID('dbo.{table}') AND type = 'PK'"
                ),
            )
            .await
            .expect("count primary key");
            assert_eq!(
                pk.rows.first().and_then(|r| r.first()).and_then(|v| v.as_i64()),
                Some(1),
                "{table} must have a primary key"
            );
        }

        // Stale target rows replaced by source data.
        let count = dbx_core::db::sqlserver::execute_query(
            &mut target_client,
            "SELECT CAST(COUNT(*) AS INT) FROM dbo.departments WHERE id IN (10,20)",
        )
        .await
        .expect("count rebuilt departments");
        assert_eq!(count.rows.first().and_then(|r| r.first()).and_then(|v| v.as_i64()), Some(2));

        // The rebuilt foreign key must still reject an orphan reference.
        let orphan = dbx_core::db::sqlserver::execute_query(&mut target_client, "INSERT INTO dbo.employees VALUES (7, 999)").await;
        assert!(orphan.is_err(), "rebuilt FK must reject a missing referenced department");

        drop_backup_tables(&state, &request, DatabaseType::SqlServer, &target_pool_key, &backup_names, &request.tables).await?;
        Ok::<_, String>(())
    }
    .await;

    // SQL Server refuses to drop a database with active connections (code 3702); the
    // state pools and setup clients still hold some. Force them all off first.
    let cleanup = dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!(
            "ALTER DATABASE [{source_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{source_db}]; \
             ALTER DATABASE [{target_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{target_db}];"
        ),
    )
    .await;
    let _ = std::fs::remove_dir_all(dir);
    cleanup.expect("drop rebuild databases");
    test_result.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn live_sqlserver_transfer_overwrite_handles_existing_identity_target() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "dbx_sqlserver_demo".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-sqlserver-8690-{suffix}");
    let source_schema = format!("dbx_8690_src_{}", &suffix[..12]);
    let target_schema = format!("dbx_8690_dst_{}", &suffix[..12]);
    let table = "identity_rows";

    let mut client = sqlserver_connect(&database).await;
    for statement in [
        format!("CREATE SCHEMA [{source_schema}]"),
        format!("CREATE SCHEMA [{target_schema}]"),
        format!(
            "CREATE TABLE [{source_schema}].[{table}] (id INT IDENTITY(100,1) NOT NULL CONSTRAINT [PK_8690_src_{suffix}] PRIMARY KEY, name NVARCHAR(64) NOT NULL)"
        ),
        format!(
            "CREATE TABLE [{target_schema}].[{table}] (id INT IDENTITY(1,1) NOT NULL CONSTRAINT [PK_8690_dst_{suffix}] PRIMARY KEY, name NVARCHAR(64) NOT NULL)"
        ),
        format!("INSERT INTO [{source_schema}].[{table}] (name) VALUES (N'first'), (N'second')"),
        format!("INSERT INTO [{target_schema}].[{table}] (name) VALUES (N'stale')"),
    ] {
        dbx_core::db::sqlserver::execute_batch(&mut client, &statement)
            .await
            .expect("create issue #8690 fixtures");
    }

    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-8690-{suffix}"));
    std::fs::create_dir_all(&dir).expect("create issue #8690 directory");
    let storage = Storage::open(&dir.join("storage.db")).await.expect("open issue #8690 storage");
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_sqlserver_config(&connection_id, &database));
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database)).await.expect("create SQL Server pool");
    let request = TransferRequest {
        transfer_id: format!("live-sqlserver-8690-transfer-{suffix}"),
        source_connection_id: connection_id.clone(),
        source_database: database.clone(),
        source_schema: source_schema.clone(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: database.clone(),
        target_schema: target_schema.clone(),
        target_catalog: None,
        tables: vec![table.to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Overwrite,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 1,
    };

    let test_result = async {
        let transferred = transfer_table(
            &state,
            &request,
            table,
            0,
            &DatabaseType::SqlServer,
            &DatabaseType::SqlServer,
            &pool_key,
            &pool_key,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(transferred, 2);

        let rows = dbx_core::db::sqlserver::execute_query(
            &mut client,
            &format!("SELECT id, name FROM [{target_schema}].[{table}] ORDER BY id"),
        )
        .await
        .map_err(|error| format!("read transferred rows: {error}"))?;
        assert_eq!(rows.rows.len(), 2);
        assert_eq!(rows.rows[0][0].as_i64(), Some(100));
        assert_eq!(rows.rows[1][0].as_i64(), Some(101));
        assert_eq!(rows.rows[0][1].as_str(), Some("first"));
        assert_eq!(rows.rows[1][1].as_str(), Some("second"));
        Ok::<_, String>(())
    }
    .await;

    let cleanup = dbx_core::db::sqlserver::execute_batch(
        &mut client,
        &format!(
            "IF OBJECT_ID(N'[{target_schema}].[{table}]', N'U') IS NOT NULL DROP TABLE [{target_schema}].[{table}]; \
             IF OBJECT_ID(N'[{source_schema}].[{table}]', N'U') IS NOT NULL DROP TABLE [{source_schema}].[{table}]; \
             IF SCHEMA_ID(N'{target_schema}') IS NOT NULL DROP SCHEMA [{target_schema}]; \
             IF SCHEMA_ID(N'{source_schema}') IS NOT NULL DROP SCHEMA [{source_schema}];"
        ),
    )
    .await;
    let _ = std::fs::remove_dir_all(dir);
    cleanup.expect("cleanup issue #8690 fixtures");
    test_result.expect("SQL Server overwrite transfer should preserve explicit identity values");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn live_sqlserver_keyset_pagination_copies_every_row() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_db = format!("dbx_keyset_src_{}", &suffix[..12]);
    let target_db = format!("dbx_keyset_dst_{}", &suffix[..12]);
    let source_connection_id = format!("live-sqlserver-keyset-src-{suffix}");
    let target_connection_id = format!("live-sqlserver-keyset-dst-{suffix}");

    let mut master = sqlserver_connect("master").await;
    dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!("CREATE DATABASE [{source_db}]; CREATE DATABASE [{target_db}];"),
    )
    .await
    .expect("create keyset databases");

    let mut source_client = sqlserver_connect(&source_db).await;
    dbx_core::db::sqlserver::execute_batch(
        &mut source_client,
        "CREATE TABLE dbo.big (id INT NOT NULL CONSTRAINT PK_big PRIMARY KEY, name NVARCHAR(64) NOT NULL); \
         ;WITH seq AS (SELECT 1 n UNION ALL SELECT n + 1 FROM seq WHERE n < 25) \
         INSERT INTO dbo.big (id, name) \
         SELECT n, CONCAT('row-', n) FROM seq OPTION (MAXRECURSION 0);",
    )
    .await
    .expect("create source table");

    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-keyset-{suffix}"));
    std::fs::create_dir_all(&dir).expect("create keyset directory");
    let storage = Storage::open(&dir.join("storage.db")).await.expect("open keyset storage");
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.clone(), live_sqlserver_config(&source_connection_id, &source_db));
    state
        .configs
        .write()
        .await
        .insert(target_connection_id.clone(), live_sqlserver_config(&target_connection_id, &target_db));
    let source_pool_key = state.get_or_create_pool(&source_connection_id, Some(&source_db)).await.expect("source pool");
    let target_pool_key = state.get_or_create_pool(&target_connection_id, Some(&target_db)).await.expect("target pool");

    let request = TransferRequest {
        transfer_id: format!("live-sqlserver-keyset-{suffix}"),
        source_connection_id: source_connection_id.clone(),
        source_database: source_db.clone(),
        source_schema: "dbo".to_string(),
        source_catalog: None,
        target_connection_id: target_connection_id.clone(),
        target_database: target_db.clone(),
        target_schema: "dbo".to_string(),
        target_catalog: None,
        tables: vec!["big".to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 3,
    };

    let test_result = async {
        let transferred = transfer_table(
            &state,
            &request,
            "big",
            0,
            &DatabaseType::SqlServer,
            &DatabaseType::SqlServer,
            &source_pool_key,
            &target_pool_key,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(transferred, 25, "keyset pagination must copy every row");

        let mut target_client = sqlserver_connect(&target_db).await;
        let rows = dbx_core::db::sqlserver::execute_query(&mut target_client, "SELECT id FROM dbo.big ORDER BY id")
            .await
            .expect("read target ids");
        let collected: Vec<i64> = rows.rows.iter().map(|row| row[0].as_i64().unwrap()).collect();
        assert_eq!(collected, (1..=25).collect::<Vec<i64>>(), "keyset pagination must not drop or duplicate rows");
        Ok::<_, String>(())
    }
    .await;

    let cleanup = dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!(
            "ALTER DATABASE [{source_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{source_db}]; \
             ALTER DATABASE [{target_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{target_db}];"
        ),
    )
    .await;
    let _ = std::fs::remove_dir_all(dir);
    cleanup.expect("drop keyset databases");
    test_result.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn live_sqlserver_progress_read_survives_total_duration_beyond_timeout() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_db = format!("dbx_progress_src_{}", &suffix[..12]);
    let target_db = format!("dbx_progress_dst_{}", &suffix[..12]);
    let source_connection_id = format!("live-sqlserver-progress-src-{suffix}");
    let target_connection_id = format!("live-sqlserver-progress-dst-{suffix}");

    let mut master = sqlserver_connect("master").await;
    dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!("CREATE DATABASE [{source_db}]; CREATE DATABASE [{target_db}];"),
    )
    .await
    .expect("create progress databases");

    // The transfer spans several pages whose total duration far exceeds the 1s
    // budget. With the timeout treated as an inactivity window, a steady stream must
    // never be cancelled just for taking longer than the timeout in total. Generate
    // the rows with a non-recursive cross join so the fixture itself stays fast.
    let mut source_client = sqlserver_connect(&source_db).await;
    dbx_core::db::sqlserver::execute_batch(
        &mut source_client,
        "CREATE TABLE dbo.big (id INT NOT NULL CONSTRAINT PK_big PRIMARY KEY, name NVARCHAR(64) NOT NULL); \
         INSERT INTO dbo.big (id, name) \
         SELECT t.n, REPLICATE('x', 64) \
         FROM ( \
             SELECT a.n + b.n * 10 + c.n * 100 + d.n * 1000 + e.n * 10000 + 1 AS n \
             FROM (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) a(n) \
             CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) b(n) \
             CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) c(n) \
             CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) d(n) \
             CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)) e(n) \
         ) t WHERE t.n <= 20000;",
    )
    .await
    .expect("create source table");

    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-progress-{suffix}"));
    std::fs::create_dir_all(&dir).expect("create progress directory");
    let storage = Storage::open(&dir.join("storage.db")).await.expect("open progress storage");
    let state = Arc::new(AppState::new(storage));
    // The read runs under the source's query timeout; keep it at 1s so the test only
    // passes when the transfer treats it as an inactivity budget, not a wall clock.
    let mut source_config = live_sqlserver_config(&source_connection_id, &source_db);
    source_config.query_timeout_secs = 1;
    state.configs.write().await.insert(source_connection_id.clone(), source_config);
    state
        .configs
        .write()
        .await
        .insert(target_connection_id.clone(), live_sqlserver_config(&target_connection_id, &target_db));
    let source_pool_key = state.get_or_create_pool(&source_connection_id, Some(&source_db)).await.expect("source pool");
    let target_pool_key = state.get_or_create_pool(&target_connection_id, Some(&target_db)).await.expect("target pool");

    let request = TransferRequest {
        transfer_id: format!("live-sqlserver-progress-{suffix}"),
        source_connection_id: source_connection_id.clone(),
        source_database: source_db.clone(),
        source_schema: "dbo".to_string(),
        source_catalog: None,
        target_connection_id: target_connection_id.clone(),
        target_database: target_db.clone(),
        target_schema: "dbo".to_string(),
        target_catalog: None,
        tables: vec!["big".to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10000,
    };

    let test_result = async {
        let transferred = transfer_table(
            &state,
            &request,
            "big",
            0,
            &DatabaseType::SqlServer,
            &DatabaseType::SqlServer,
            &source_pool_key,
            &target_pool_key,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(transferred, 20000, "the whole table must be transferred across multiple pages without timing out");

        let mut target_client = sqlserver_connect(&target_db).await;
        let count = dbx_core::db::sqlserver::execute_query(&mut target_client, "SELECT COUNT(*) FROM dbo.big")
            .await
            .expect("count target rows");
        assert_eq!(count.rows[0][0].as_i64(), Some(20000), "no row may be dropped or duplicated");
        Ok::<_, String>(())
    }
    .await;

    let cleanup = dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!(
            "ALTER DATABASE [{source_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{source_db}]; \
             ALTER DATABASE [{target_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{target_db}];"
        ),
    )
    .await;
    let _ = std::fs::remove_dir_all(dir);
    cleanup.expect("drop progress databases");
    test_result.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn live_sqlserver_keyset_uniqueidentifier_datetime2_composite_key() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_db = format!("dbx_typed_src_{}", &suffix[..12]);
    let target_db = format!("dbx_typed_dst_{}", &suffix[..12]);
    let source_connection_id = format!("live-sqlserver-typed-src-{suffix}");
    let target_connection_id = format!("live-sqlserver-typed-dst-{suffix}");

    let mut master = sqlserver_connect("master").await;
    dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!("CREATE DATABASE [{source_db}]; CREATE DATABASE [{target_db}];"),
    )
    .await
    .expect("create typed databases");

    let mut source_client = sqlserver_connect(&source_db).await;
    dbx_core::db::sqlserver::execute_batch(
        &mut source_client,
        "CREATE TABLE dbo.typed_key ( \
             uid UNIQUEIDENTIFIER NOT NULL, \
             ts DATETIME2(3) NOT NULL, \
             name NVARCHAR(32) NOT NULL, \
             CONSTRAINT PK_typed_key PRIMARY KEY (uid, ts) \
         ); \
         INSERT INTO dbo.typed_key (uid, ts, name) VALUES \
             ('00000000-0000-0000-0000-000000000001', '2024-01-01 00:00:00.000', N'a'), \
             ('00000000-0000-0000-0000-000000000002', '2024-01-02 00:00:00.000', N'b'), \
             ('00000000-0000-0000-0000-000000000003', '2024-01-03 00:00:00.000', N'c'), \
             ('00000000-0000-0000-0000-000000000004', '2024-01-04 00:00:00.000', N'd'), \
             ('00000000-0000-0000-0000-000000000005', '2024-01-05 00:00:00.000', N'e'), \
             ('00000000-0000-0000-0000-000000000006', '2024-01-06 00:00:00.000', N'f'), \
             ('00000000-0000-0000-0000-000000000007', '2024-01-07 00:00:00.000', N'g'), \
             ('00000000-0000-0000-0000-000000000008', '2024-01-08 00:00:00.000', N'h');",
    )
    .await
    .expect("create source typed table");

    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-typed-{suffix}"));
    std::fs::create_dir_all(&dir).expect("create typed directory");
    let storage = Storage::open(&dir.join("storage.db")).await.expect("open typed storage");
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.clone(), live_sqlserver_config(&source_connection_id, &source_db));
    state
        .configs
        .write()
        .await
        .insert(target_connection_id.clone(), live_sqlserver_config(&target_connection_id, &target_db));
    let source_pool_key = state.get_or_create_pool(&source_connection_id, Some(&source_db)).await.expect("source pool");
    let target_pool_key = state.get_or_create_pool(&target_connection_id, Some(&target_db)).await.expect("target pool");

    let request = TransferRequest {
        transfer_id: format!("live-sqlserver-typed-{suffix}"),
        source_connection_id: source_connection_id.clone(),
        source_database: source_db.clone(),
        source_schema: "dbo".to_string(),
        source_catalog: None,
        target_connection_id: target_connection_id.clone(),
        target_database: target_db.clone(),
        target_schema: "dbo".to_string(),
        target_catalog: None,
        tables: vec!["typed_key".to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 3,
    };

    let test_result = async {
        let transferred = transfer_table(
            &state,
            &request,
            "typed_key",
            0,
            &DatabaseType::SqlServer,
            &DatabaseType::SqlServer,
            &source_pool_key,
            &target_pool_key,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(transferred, 8, "keyset pagination must copy every typed row");

        let mut target_client = sqlserver_connect(&target_db).await;
        let rows = dbx_core::db::sqlserver::execute_query(
            &mut target_client,
            "SELECT LOWER(CAST(uid AS VARCHAR(36))) FROM dbo.typed_key ORDER BY uid",
        )
        .await
        .expect("read target uids");
        let collected: Vec<String> = rows.rows.iter().map(|row| row[0].as_str().unwrap().to_string()).collect();
        let expected: Vec<String> = (1..=8).map(|i| format!("00000000-0000-0000-0000-{i:012}")).collect();
        assert_eq!(collected, expected, "uniqueidentifier + datetime2 keyset cursor must round-trip every row");
        Ok::<_, String>(())
    }
    .await;

    let cleanup = dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!(
            "ALTER DATABASE [{source_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{source_db}]; \
             ALTER DATABASE [{target_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{target_db}];"
        ),
    )
    .await;
    let _ = std::fs::remove_dir_all(dir);
    cleanup.expect("drop typed databases");
    test_result.unwrap();
}
