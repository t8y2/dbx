//! 整库 SQL 导出的端到端回归测试（元数据并发预取后输出必须与逐表查询一致）。
//! 需要本机 Docker；不可用时自动跳过。

use std::process::Command;

use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;

struct DockerPostgres {
    name: String,
    port: u16,
}

impl Drop for DockerPostgres {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.name]).status();
    }
}

fn docker_ready() -> bool {
    Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn start_docker_postgres() -> Option<DockerPostgres> {
    if !docker_ready() {
        eprintln!("skipping docker-backed export test because Docker is unavailable");
        return None;
    }

    let port = portpicker::pick_unused_port().expect("pick unused postgres port");
    let container = DockerPostgres { name: format!("dbx-export-prefetch-{}", uuid::Uuid::new_v4()), port };

    let status = Command::new("docker")
        .args([
            "run",
            "-d",
            "--rm",
            "--name",
            &container.name,
            "-e",
            "POSTGRES_PASSWORD=postgres",
            "-e",
            "POSTGRES_USER=postgres",
            "-e",
            "POSTGRES_DB=postgres",
            "-p",
            &format!("{port}:5432"),
            "postgres:16-alpine",
        ])
        .status()
        .expect("start docker postgres");
    assert!(status.success(), "docker run postgres container should succeed");

    // postgres 镜像 initdb 期间会短暂拉起再重启服务，单次探测可能命中引导期，
    // 要求 SELECT 1 连续两次成功才算就绪
    let mut consecutive_ok = 0;
    for _ in 0..120 {
        let ready = Command::new("docker")
            .args(["exec", &container.name, "psql", "-U", "postgres", "-d", "postgres", "-c", "SELECT 1"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        consecutive_ok = if ready { consecutive_ok + 1 } else { 0 };
        if consecutive_ok >= 2 {
            return Some(container);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    panic!("postgres container did not become ready");
}

fn psql(container: &DockerPostgres, sql: &str) {
    let output = Command::new("docker")
        .args(["exec", &container.name, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql])
        .output()
        .expect("run psql");
    assert!(output.status.success(), "psql failed: {}", String::from_utf8_lossy(&output.stderr));
}

fn postgres_test_config(id: &str, port: u16) -> ConnectionConfig {
    ConnectionConfig {
        id: id.to_string(),
        name: id.to_string(),
        db_type: DatabaseType::Postgres,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: "127.0.0.1".to_string(),
        port,
        username: "postgres".to_string(),
        password: "postgres".to_string(),
        database: Some("postgres".to_string()),
        visible_databases: None,
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
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        read_only: false,
        is_production: false,
        production_databases: vec![],
        database_info: None,
    }
}

#[tokio::test]
async fn database_export_writes_structure_and_data_for_all_tables() {
    let Some(container) = start_docker_postgres() else {
        return;
    };

    psql(
        &container,
        "CREATE TABLE parent (id INT PRIMARY KEY, label TEXT NOT NULL);\
         CREATE TABLE child (id INT PRIMARY KEY, parent_id INT REFERENCES parent(id), note TEXT);\
         CREATE TABLE standalone_a (id INT PRIMARY KEY, payload JSONB);\
         CREATE TABLE standalone_b (id INT PRIMARY KEY, created_at TIMESTAMPTZ);\
         CREATE TABLE empty_table (id INT PRIMARY KEY);\
         INSERT INTO parent VALUES (1, 'alpha'), (2, 'beta');\
         INSERT INTO child VALUES (10, 1, 'first-child'), (11, 2, NULL);\
         INSERT INTO standalone_a VALUES (100, '{\"k\": \"v\"}');\
         INSERT INTO standalone_b VALUES (200, '2024-05-06T07:08:09Z');",
    );

    let dir = std::env::temp_dir().join(format!("dbx-export-prefetch-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);

    let connection_id = "export-prefetch-conn";
    state.configs.write().await.insert(connection_id.to_string(), postgres_test_config(connection_id, container.port));

    let file_path = dir.join("export.sql");
    let request = DatabaseExportRequest {
        export_id: format!("export-prefetch-{}", uuid::Uuid::new_v4()),
        connection_id: connection_id.to_string(),
        database: "postgres".to_string(),
        schema: "public".to_string(),
        file_path: file_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: false,
        drop_table_if_exists: true,
        omit_auto_increment: false,
        fail_on_error: true,
        snapshot_session_id: None,
        batch_size: 1000,
    };

    export_database_sql_core(&state, &request, |_progress| {}).await.expect("export should succeed");

    let exported = std::fs::read_to_string(&file_path).expect("read exported file");

    for table in ["parent", "child", "standalone_a", "standalone_b", "empty_table"] {
        assert!(
            exported.contains(&format!("CREATE TABLE \"public\".\"{table}\"")),
            "exported SQL should contain CREATE TABLE for {table}:\n{exported}"
        );
    }
    assert!(!exported.contains("-- ERROR"), "exported SQL should not contain errors:\n{exported}");

    for expected in ["'alpha'", "'beta'", "'first-child'", "\"k\"", "2024-05-06"] {
        assert!(exported.contains(expected), "exported SQL should contain literal {expected}:\n{exported}");
    }

    // 依赖排序：被引用的 parent 必须先于 child 建表
    let parent_pos = exported.find("CREATE TABLE \"public\".\"parent\"").unwrap();
    let child_pos = exported.find("CREATE TABLE \"public\".\"child\"").unwrap();
    assert!(parent_pos < child_pos, "parent table DDL should precede child table DDL");

    // 空表只导结构不导数据
    assert!(
        !exported.contains("INSERT INTO \"public\".\"empty_table\""),
        "empty table should not produce INSERT statements"
    );
}
