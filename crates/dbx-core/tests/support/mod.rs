//! Shared Docker-backed PostgreSQL test scaffolding for integration tests
//! that need a real, disposable server (not a mock) to exercise driver SQL
//! against. Needs local Docker; callers should check `docker_ready()` (via
//! `start_docker_postgres`, which does this for them) and skip cleanly when
//! it's unavailable rather than failing the whole test run.

use std::process::Command;

use dbx_core::models::connection::{ConnectionConfig, DatabaseType};

pub struct DockerPostgres {
    pub name: String,
    pub port: u16,
    /// `false` when this wraps an already-running container the caller
    /// provided via `DBX_TEST_POSTGRES_CONTAINER` (see
    /// `start_docker_postgres_with_server_args`) instead of one this helper
    /// started itself — that container is the caller's to manage, not ours
    /// to tear down.
    remove_on_drop: bool,
}

impl Drop for DockerPostgres {
    fn drop(&mut self) {
        if self.remove_on_drop {
            let _ = Command::new("docker").args(["rm", "-f", &self.name]).status();
        }
    }
}

pub fn docker_ready() -> bool {
    Command::new("docker")
        .args(["version", "--format", "{{.Server.Version}}"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Starts a disposable `postgres:16-alpine` container named
/// `{name_prefix}-{random uuid}`, waiting for it to accept connections.
/// Returns `None` (rather than panicking) when Docker itself isn't
/// available, so tests can skip cleanly in environments without it.
pub fn start_docker_postgres(name_prefix: &str) -> Option<DockerPostgres> {
    start_docker_postgres_with_server_args(name_prefix, &[])
}

/// Same as `start_docker_postgres`, but forwards extra `-c name=value`
/// postmaster arguments — e.g. `&["-c", "allow_system_table_mods=on"]` to let
/// a test create a stand-in `pg_catalog` table for a system catalog this
/// image doesn't actually have (like OpenTenBase/Cloudberry-only ones).
///
/// If `DBX_TEST_POSTGRES_CONTAINER`/`DBX_TEST_POSTGRES_PORT` are set, reuses
/// that already-running container instead of starting (and later tearing
/// down) a fresh one — handy for iterating on a single test locally without
/// paying container startup cost every run. `server_args` is ignored in that
/// case, since the caller's container is already configured however they set
/// it up.
pub fn start_docker_postgres_with_server_args(name_prefix: &str, server_args: &[&str]) -> Option<DockerPostgres> {
    if let Ok(name) = std::env::var("DBX_TEST_POSTGRES_CONTAINER") {
        let port = std::env::var("DBX_TEST_POSTGRES_PORT")
            .expect("DBX_TEST_POSTGRES_PORT must accompany DBX_TEST_POSTGRES_CONTAINER")
            .parse()
            .expect("DBX_TEST_POSTGRES_PORT must be a valid port");
        return Some(DockerPostgres { name, port, remove_on_drop: false });
    }
    if !docker_ready() {
        eprintln!("skipping docker-backed test because Docker is unavailable");
        return None;
    }

    let port = portpicker::pick_unused_port().expect("pick unused postgres port");
    let container =
        DockerPostgres { name: format!("{name_prefix}-{}", uuid::Uuid::new_v4()), port, remove_on_drop: true };

    let mut args = vec![
        "run".to_string(),
        "-d".to_string(),
        "--rm".to_string(),
        "--name".to_string(),
        container.name.clone(),
        "-e".to_string(),
        "POSTGRES_PASSWORD=postgres".to_string(),
        "-e".to_string(),
        "POSTGRES_USER=postgres".to_string(),
        "-e".to_string(),
        "POSTGRES_DB=postgres".to_string(),
        "-p".to_string(),
        format!("{port}:5432"),
        "postgres:16-alpine".to_string(),
    ];
    args.extend(server_args.iter().map(|arg| arg.to_string()));

    let status = Command::new("docker").args(&args).status().expect("start docker postgres");
    assert!(status.success(), "docker run postgres container should succeed");

    // The postgres image's initdb briefly starts and restarts the server, so
    // a single successful probe may still land inside that bootstrap window;
    // require two consecutive successful `SELECT 1`s before calling it ready.
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

pub fn psql(container: &DockerPostgres, sql: &str) {
    let output = Command::new("docker")
        .args(["exec", &container.name, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql])
        .output()
        .expect("run psql");
    assert!(output.status.success(), "psql failed: {}", String::from_utf8_lossy(&output.stderr));
}

// Each `tests/*.rs` file compiles this module as its own separate crate, so
// a helper only some of those test binaries call is "unused" in the others.
#[allow(dead_code)]
pub fn psql_allow_failure(container: &DockerPostgres, sql: &str) -> bool {
    Command::new("docker")
        .args(["exec", &container.name, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub fn postgres_test_config(id: &str, port: u16) -> ConnectionConfig {
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
        port,
        username: "postgres".to_string(),
        password: "postgres".to_string(),
        database: Some("postgres".to_string()),
        default_schema: None,
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
