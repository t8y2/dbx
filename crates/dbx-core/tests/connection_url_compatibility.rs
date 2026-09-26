use dbx_core::models::connection::{
    default_connect_timeout_secs, default_idle_timeout_secs, default_keepalive_interval_secs,
    default_query_timeout_secs, default_redis_key_separator, ConnectionConfig, DatabaseType,
};
use std::str::FromStr;

fn mysql_config(username: &str, password: &str, database: Option<&str>) -> ConnectionConfig {
    ConnectionConfig {
        docs_notes_path: None,
        id: "id".to_string(),
        name: "name".to_string(),
        note: String::new(),
        db_type: DatabaseType::Mysql,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: "10.1.2.3".to_string(),
        port: 2883,
        username: username.to_string(),
        password: password.to_string(),
        database: database.map(str::to_string),
        default_schema: None,
        visible_databases: None,
        visible_database_patterns: None,
        visible_schemas: None,
        show_system_schemas: false,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: default_connect_timeout_secs(),
        query_timeout_secs: default_query_timeout_secs(),
        idle_timeout_secs: default_idle_timeout_secs(),
        keepalive_interval_secs: default_keepalive_interval_secs(),
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
        redis_key_separator: default_redis_key_separator(),
        redis_scan_page_size: None,
        redis_database_aliases: Default::default(),
        redis_key_templates: Vec::new(),
        redis_key_grouping: None,
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        plugin_id: None,
        plugin_connection_provider: None,
        plugin_connection_type: None,
        connection_secrets: Default::default(),
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        save_password: true,
        read_only: false,
        is_production: false,
        production_databases: vec![],
        database_info: None,
    }
}

#[test]
fn doris_database_type_enables_cleartext_password_auth_for_direct_and_tunneled_urls() {
    let mut config = mysql_config("root", "secret", Some("analytics"));
    config.db_type = DatabaseType::Doris;
    config.port = 9030;

    let direct_url = config.connection_url();
    assert_eq!(direct_url, "mysql://root:secret@10.1.2.3:9030/analytics?enable_cleartext_plugin=true");
    assert!(mysql_async::Opts::from_url(&direct_url).unwrap().enable_cleartext_plugin());
    assert_eq!(
        config.connection_url_with_host("127.0.0.1", 19030),
        "mysql://root:secret@127.0.0.1:19030/analytics?enable_cleartext_plugin=true"
    );
}

#[test]
fn postgres_url_normalizes_timezone_param_into_options() {
    let mut config = mysql_config("postgres", "secret", Some("test"));
    config.db_type = DatabaseType::Postgres;
    config.url_params = Some("sslmode=require&timezone=Asia/Shanghai".to_string());

    assert_eq!(
        config.connection_url(),
        "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=require&options=%2Dc%20TimeZone%3DAsia%2FShanghai"
    );
    let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
    assert_eq!(pg_config.get_options(), Some("-c TimeZone=Asia/Shanghai"));
}

#[test]
fn postgres_url_maps_schema_param_into_search_path_options() {
    let mut config = mysql_config("postgres", "secret", Some("test"));
    config.db_type = DatabaseType::Postgres;
    config.url_params = Some("schema=public".to_string());

    assert_eq!(
        config.connection_url(),
        "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dpublic"
    );
    let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
    assert_eq!(pg_config.get_options(), Some("-c search_path=public"));
}

#[test]
fn postgres_url_maps_current_schema_param_into_search_path_options() {
    let mut config = mysql_config("postgres", "secret", Some("test"));
    config.db_type = DatabaseType::Postgres;
    config.url_params = Some("currentSchema=app".to_string());

    assert_eq!(
        config.connection_url(),
        "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dapp"
    );
    let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
    assert_eq!(pg_config.get_options(), Some("-c search_path=app"));
}

#[test]
fn postgres_url_ignores_jdbc_stringtype_param() {
    let mut config = mysql_config("postgres", "secret", Some("test"));
    config.db_type = DatabaseType::Postgres;
    config.url_params = Some("currentSchema=public&stringtype=unspecified".to_string());

    assert_eq!(config.validate_native_url_params(), Ok(()));
    assert_eq!(
        config.connection_url(),
        "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dpublic"
    );
    let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
    assert_eq!(pg_config.get_options(), Some("-c search_path=public"));
}

#[test]
fn postgres_url_accepts_encoded_jdbc_varchar_stringtype_param() {
    let mut config = mysql_config("postgres", "secret", Some("test"));
    config.db_type = DatabaseType::Postgres;
    config.url_params = Some("currentSchema=app&%73tringtype=%76aRcHaR".to_string());

    assert_eq!(config.validate_native_url_params(), Ok(()));
    assert_eq!(
        config.connection_url(),
        "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dapp"
    );
    let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
    assert_eq!(pg_config.get_options(), Some("-c search_path=app"));
}

#[test]
fn postgres_url_uses_only_the_structured_endpoint() {
    let mut config = mysql_config("postgres", "secret", Some("test"));
    config.db_type = DatabaseType::Postgres;
    config.url_params = Some(
        "HOST=origin.example.com&%68ostaddr=203.0.113.10&%70ort=6432&currentSchema=app&application_name=dbx"
            .to_string(),
    );

    let url = config.connection_url_with_host("127.0.0.1", 6543);

    assert_eq!(
            url,
            "postgres://postgres:secret@127.0.0.1:6543/test?sslmode=prefer&application_name=dbx&options=%2Dc%20search%5Fpath%3Dapp"
        );
    let pg_config = tokio_postgres::Config::from_str(&url).unwrap();
    assert_eq!(pg_config.get_hosts().len(), 1);
    assert_eq!(pg_config.get_ports(), &[6543]);
    assert!(pg_config.get_hostaddrs().is_empty());
    assert_eq!(pg_config.get_options(), Some("-c search_path=app"));
}

#[test]
fn postgres_url_query_password_keeps_priority_but_is_redacted() {
    let mut config = mysql_config("postgres", "field-secret", Some("test"));
    config.db_type = DatabaseType::Postgres;
    config.url_params = Some("%70assword=query-secret&application_name=dbx".to_string());

    let url = config.connection_url();
    let pg_config = tokio_postgres::Config::from_str(&url).unwrap();
    assert_eq!(pg_config.get_password(), Some(b"query-secret".as_slice()));
    assert_eq!(config.redacted_connection_url(), "postgres://10.1.2.3:2883/test?sslmode=prefer&application_name=dbx");
}

#[test]
fn postgres_url_ignores_mysql_only_params_from_saved_connections() {
    let mut config = mysql_config("postgres", "secret", Some("test"));
    config.db_type = DatabaseType::Postgres;
    config.url_params = Some("ssl-mode=preferred&charset=utf8mb4".to_string());

    assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer");
    tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
}

#[test]
fn postgres_url_maps_mysql_ssl_mode_require_to_sslmode() {
    let mut config = mysql_config("postgres", "secret", Some("test"));
    config.db_type = DatabaseType::Postgres;
    config.url_params = Some("ssl-mode=required&verify_ca=false&verify_identity=false".to_string());

    assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=require");
    tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
}
