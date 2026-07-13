use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};

use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::path_utils::expand_tilde;

const OCEANBASE_ORACLE_COMPATIBLE_OJDBC_VERSION_KEY: &str = "compatibleOjdbcVersion";
const OCEANBASE_ORACLE_COMPATIBLE_OJDBC_VERSION_PARAM: &str = "compatibleOjdbcVersion=8";

pub fn agent_connect_params(config: &ConnectionConfig, host: &str, port: u16, database: &str) -> serde_json::Value {
    let agent_database = if config.db_type == DatabaseType::MongoDb {
        mongo_agent_database(config, database)
    } else if matches!(config.db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) {
        oracle_agent_database(config, database)
    } else if matches!(config.db_type, DatabaseType::Kingbase | DatabaseType::Highgo | DatabaseType::Vastbase) {
        postgres_like_agent_database(config, database).to_string()
    } else if is_h2_file_connection(config) {
        h2_agent_database(config)
    } else {
        database.to_string()
    };
    let connection_string = if config.db_type == DatabaseType::MongoDb {
        config.connection_url_with_host(host, port)
    } else if config.db_type == DatabaseType::Oracle {
        oracle_jdbc_connection_string(config, host, port, database)
    } else if config.db_type == DatabaseType::OceanbaseOracle {
        oceanbase_oracle_jdbc_connection_string(config, host, port, database)
    } else if matches!(config.db_type, DatabaseType::Kingbase | DatabaseType::Highgo | DatabaseType::Vastbase) {
        postgres_like_agent_jdbc_connection_string(config, host, port, database)
    } else if config.db_type == DatabaseType::SapHana {
        sap_hana_jdbc_connection_string(config, host, port, database)
    } else if matches!(config.db_type, DatabaseType::Trino | DatabaseType::PrestoSql) {
        trino_like_jdbc_connection_string(config, host, port, database)
    } else if config.db_type == DatabaseType::H2 {
        h2_agent_jdbc_connection_string(config)
    } else {
        config.connection_string.as_deref().unwrap_or("").to_string()
    };
    let etcd_endpoints =
        if config.db_type == DatabaseType::Etcd { normalize_etcd_endpoints(config, host, port) } else { String::new() };
    let zookeeper_connect_string = if config.db_type == DatabaseType::ZooKeeper {
        normalize_zookeeper_connect_string(config, host, port)
    } else {
        String::new()
    };
    let (agent_host, agent_port) = if is_h2_file_connection(config) { ("", 0) } else { (host, port) };

    serde_json::json!({
        "host": agent_host,
        "port": agent_port,
        "port_explicit": config.sqlserver_port_explicit(),
        "database": agent_database,
        "username": config.username,
        "password": config.password,
        "sysdba": oracle_uses_sysdba(config),
        "url_params": config.url_params.as_deref().unwrap_or(""),
        "connection_string": connection_string,
        "ssl": config.ssl,
        "ca_cert_path": config.ca_cert_path,
        "client_cert_path": config.client_cert_path,
        "client_key_path": config.client_key_path,
        "etcd_endpoints": etcd_endpoints,
        "zookeeper_connect_string": zookeeper_connect_string,
        "gbase_server": config.gbase_server,
        "informix_server": config.informix_server,
        "jdbc_driver_class": config.jdbc_driver_class.as_deref().unwrap_or(""),
        "jdbc_driver_paths": &config.jdbc_driver_paths,
    })
}

fn oracle_uses_sysdba(config: &ConnectionConfig) -> bool {
    config.sysdba || (config.db_type == DatabaseType::Oracle && config.username.trim().eq_ignore_ascii_case("sys"))
}

fn oracle_agent_database(config: &ConnectionConfig, database: &str) -> String {
    let database = database.trim();
    if database.is_empty() || !oracle_uses_sysdba(config) || database.to_uppercase().starts_with("SYSDBA:") {
        return database.to_string();
    }
    format!("SYSDBA:{database}")
}

fn mongo_agent_database(config: &ConnectionConfig, database: &str) -> String {
    if let Some(database) = non_empty_database(database) {
        return database.to_string();
    }
    if let Some(database) = config.database.as_deref().and_then(non_empty_database) {
        return database.to_string();
    }
    if let Some(database) = config.connection_string.as_deref().and_then(mongo_uri_database) {
        return database;
    }
    "admin".to_string()
}

fn non_empty_database(database: &str) -> Option<&str> {
    let database = database.trim();
    (!database.is_empty()).then_some(database)
}

pub fn is_h2_file_connection(config: &ConnectionConfig) -> bool {
    config.db_type == DatabaseType::H2
        && (config.connection_string.as_deref().is_some_and(is_h2_file_jdbc_url)
            || (config.port == 0 && !config.host.trim().is_empty()))
}

pub fn h2_agent_jdbc_connection_string(config: &ConnectionConfig) -> String {
    if let Some(connection_string) =
        config.connection_string.as_deref().map(str::trim).filter(|value| !value.is_empty())
    {
        if is_h2_file_jdbc_url(connection_string) {
            return normalize_h2_file_jdbc_url(connection_string).unwrap_or_else(|| connection_string.to_string());
        }
        return connection_string.to_string();
    }
    if is_h2_file_connection(config) {
        return h2_file_jdbc_url(&config.host);
    }
    String::new()
}

fn h2_agent_database(config: &ConnectionConfig) -> String {
    let jdbc_url = h2_agent_jdbc_connection_string(config);
    jdbc_url.strip_prefix("jdbc:h2:").unwrap_or(&jdbc_url).to_string()
}

pub fn h2_file_jdbc_url(path: &str) -> String {
    let url = h2_file_jdbc_url_base(path);
    format!("{url};AUTO_SERVER=TRUE")
}

fn h2_file_jdbc_url_base(path: &str) -> String {
    let path = h2_jdbc_file_base_path(path);
    format!("jdbc:h2:file:{path}")
}

pub fn h2_jdbc_file_base_path(path: &str) -> String {
    let path = expand_tilde(path.trim());
    let lower = path.to_ascii_lowercase();
    for suffix in [".mv.db", ".h2.db"] {
        if lower.ends_with(suffix) {
            return path[..path.len() - suffix.len()].to_string();
        }
    }
    path
}

pub fn h2_file_path_from_jdbc_url(connection_string: &str) -> Option<String> {
    let connection_string = connection_string.trim();
    h2_file_jdbc_url_prefix(connection_string).map(|prefix| {
        let raw_path = connection_string[prefix.len()..].split(';').next().unwrap_or("");
        if prefix.eq_ignore_ascii_case("jdbc:h2:split:") {
            raw_path
                .split_once(':')
                .and_then(|(block_size, path)| block_size.chars().all(|ch| ch.is_ascii_digit()).then_some(path))
                .unwrap_or(raw_path)
                .to_string()
        } else {
            raw_path.to_string()
        }
    })
}

fn h2_file_jdbc_url_prefix(connection_string: &str) -> Option<&'static str> {
    ["jdbc:h2:file:", "jdbc:h2:split:"]
        .into_iter()
        .find(|prefix| connection_string.get(..prefix.len()).is_some_and(|value| value.eq_ignore_ascii_case(prefix)))
}

fn normalize_h2_file_jdbc_url(connection_string: &str) -> Option<String> {
    let connection_string = connection_string.trim();
    let prefix = "jdbc:h2:file:";
    if !connection_string.get(..prefix.len())?.eq_ignore_ascii_case(prefix) {
        return None;
    }
    let rest = &connection_string[prefix.len()..];
    let (path, options) = rest.split_once(';').map(|(path, options)| (path, Some(options))).unwrap_or((rest, None));
    let mut url = if options.is_some() { h2_file_jdbc_url_base(path) } else { h2_file_jdbc_url(path) };
    if let Some(options) = options {
        url.push(';');
        url.push_str(options);
    }
    Some(url)
}

fn is_h2_file_jdbc_url(connection_string: &str) -> bool {
    h2_file_jdbc_url_prefix(connection_string.trim()).is_some()
}

fn mongo_uri_database(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("mongodb://").or_else(|| uri.strip_prefix("mongodb+srv://"))?;
    let (_, after_hosts) = rest.split_once('/')?;
    let database = after_hosts.split(['?', '#']).next()?.trim();
    if database.is_empty() {
        return None;
    }
    Some(percent_decode_str(database).decode_utf8_lossy().into_owned())
}

pub fn mongo_legacy_error_with_auth_hint(err: &str) -> String {
    let Some(source_start) = err.find("source='") else {
        return err.to_string();
    };
    if !err.contains("Exception authenticating MongoCredential") || err.contains("Current authentication database:") {
        return err.to_string();
    }
    let source = &err[source_start + "source='".len()..];
    let Some(source_end) = source.find('\'') else {
        return err.to_string();
    };
    let source = &source[..source_end];
    format!(
        "{err}\n\nCurrent authentication database: {source}. If this user was created in admin, set Authentication database to admin or add authSource=admin to URL params."
    )
}

pub fn mongo_uses_legacy_driver(config: &ConnectionConfig) -> bool {
    config.driver_profile.as_deref().is_some_and(|profile| {
        profile.eq_ignore_ascii_case("mongodb-legacy")
            || profile.eq_ignore_ascii_case("mongodb_legacy")
            || profile.eq_ignore_ascii_case("legacy")
    })
}

pub fn should_retry_mongo_with_legacy_driver(err: &str) -> bool {
    let normalized = err.to_lowercase();
    if normalized.contains("wire version") {
        return true;
    }

    let looks_like_handshake_io_error = normalized.contains("unexpected end of file")
        || normalized.contains("connection reset by peer")
        || normalized.contains("broken pipe");
    looks_like_handshake_io_error
        && (normalized.contains("server selection timeout")
            || normalized.contains("no available servers")
            || normalized.contains("topology:")
            || normalized.contains("i/o error"))
}

pub fn oracle_error_with_driver_hint(config: &ConnectionConfig, err: &str) -> String {
    if config.db_type != DatabaseType::Oracle {
        return err.to_string();
    }

    let normalized = err.to_lowercase();
    if !normalized.contains("ora-12541") && !err.contains("没有监听程序") {
        return err.to_string();
    }

    format!("{err}\n\nOracle listener was not reachable. If the host and port are correct, try switching between Service Name and SID.")
}

pub fn oracle_alternate_connect_configs(config: &ConnectionConfig, err: &str) -> Vec<ConnectionConfig> {
    if config.db_type != DatabaseType::Oracle {
        return Vec::new();
    }
    if config.connection_string.as_deref().is_some_and(|value| !value.trim().is_empty()) {
        return Vec::new();
    }
    if !oracle_listener_error_can_retry(err) {
        return Vec::new();
    }

    let database = config.effective_database().unwrap_or("").trim();
    if database.is_empty() {
        return Vec::new();
    }

    let host = config.host.trim();
    let port = config.port;
    let current_url = oracle_jdbc_connection_string(config, host, port, database);
    let service_url = oracle_service_jdbc_url(host, port, database);
    let sid_url = oracle_sid_jdbc_url(host, port, database);
    let legacy_service_url = oracle_legacy_service_jdbc_url(host, port, database);
    let descriptor_service_url = oracle_descriptor_jdbc_url(host, port, database, "SERVICE_NAME");
    let descriptor_sid_url = oracle_descriptor_jdbc_url(host, port, database, "SID");

    let normalized = err.to_lowercase();
    let candidates = if normalized.contains("ora-12505") {
        vec![service_url, descriptor_service_url, legacy_service_url]
    } else if normalized.contains("ora-12514") {
        vec![sid_url, descriptor_sid_url, legacy_service_url]
    } else {
        match config.oracle_connection_type.as_deref() {
            Some("sid") => vec![service_url, legacy_service_url, descriptor_sid_url, descriptor_service_url],
            _ => vec![sid_url, legacy_service_url, descriptor_service_url, descriptor_sid_url],
        }
    };

    let mut urls = Vec::new();
    for url in candidates {
        if url == current_url || urls.iter().any(|seen| seen == &url) {
            continue;
        }
        urls.push(url);
    }

    urls.into_iter()
        .map(|url| {
            let mut retry = config.clone();
            retry.oracle_connection_type = None;
            retry.connection_string = Some(url);
            retry
        })
        .collect()
}

fn oracle_jdbc_connection_string(config: &ConnectionConfig, host: &str, port: u16, database: &str) -> String {
    if let Some(connection_string) = config.connection_string.as_deref().filter(|value| !value.trim().is_empty()) {
        let connection_string = connection_string.trim();
        if host == config.host && port == config.port {
            return connection_string.to_string();
        }
        return crate::models::connection::rewrite_jdbc_url_host(connection_string, host, port);
    }

    let database = database.trim();
    if database.is_empty() {
        return String::new();
    }

    if config.oracle_connection_type.as_deref() == Some("sid") {
        oracle_sid_jdbc_url(host, port, database)
    } else {
        oracle_service_jdbc_url(host, port, database)
    }
}

fn oracle_listener_error_can_retry(err: &str) -> bool {
    let normalized = err.to_lowercase();
    normalized.contains("ora-12505")
        || normalized.contains("ora-12514")
        || normalized.contains("ora-12541")
        || normalized.contains("no listener")
        || err.contains("没有监听程序")
}

fn oracle_service_jdbc_url(host: &str, port: u16, database: &str) -> String {
    format!("jdbc:oracle:thin:@//{host}:{port}/{database}")
}

fn oracle_sid_jdbc_url(host: &str, port: u16, database: &str) -> String {
    format!("jdbc:oracle:thin:@{host}:{port}:{database}")
}

fn oracle_legacy_service_jdbc_url(host: &str, port: u16, database: &str) -> String {
    format!("jdbc:oracle:thin:@{host}:{port}/{database}")
}

fn oracle_descriptor_jdbc_url(host: &str, port: u16, database: &str, key: &str) -> String {
    format!("jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST={host})(PORT={port}))(CONNECT_DATA=({key}={database})))")
}

fn oceanbase_oracle_jdbc_connection_string(config: &ConnectionConfig, host: &str, port: u16, database: &str) -> String {
    if let Some(connection_string) = config.connection_string.as_deref().filter(|value| !value.trim().is_empty()) {
        let connection_string = connection_string.trim();
        let url = if host == config.host && port == config.port {
            connection_string.to_string()
        } else {
            crate::models::connection::rewrite_jdbc_url_host(connection_string, host, port)
        };
        if url_has_query_key(&url, OCEANBASE_ORACLE_COMPATIBLE_OJDBC_VERSION_KEY) {
            return url;
        }
        return append_agent_url_params(url, Some(OCEANBASE_ORACLE_COMPATIBLE_OJDBC_VERSION_PARAM));
    }

    let database = database.trim();
    if database.is_empty() {
        return String::new();
    }

    let base = format!("jdbc:oceanbase://{host}:{port}/{database}");
    append_agent_url_params(base, Some(&oceanbase_oracle_jdbc_params(config)))
}

fn oceanbase_oracle_jdbc_params(config: &ConnectionConfig) -> String {
    let user_params = normalize_agent_url_params(config.url_params.as_deref());
    let mut params = Vec::new();
    if !user_params.is_empty() {
        params.push(user_params.to_string());
    }
    if !url_params_has_key(user_params, OCEANBASE_ORACLE_COMPATIBLE_OJDBC_VERSION_KEY) {
        params.push(OCEANBASE_ORACLE_COMPATIBLE_OJDBC_VERSION_PARAM.to_string());
    }
    params.join("&")
}

fn postgres_like_agent_jdbc_connection_string(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
    database: &str,
) -> String {
    let scheme = match config.db_type {
        DatabaseType::Kingbase => "kingbase8",
        DatabaseType::Highgo => "highgo",
        DatabaseType::Vastbase => "vastbase",
        _ => unreachable!("postgres-like agent JDBC URL requested for {:?}", config.db_type),
    };
    let database = postgres_like_agent_database(config, database);
    let base = format!("jdbc:{scheme}://{host}:{port}/{database}");
    append_agent_url_params(base, config.url_params.as_deref())
}

fn postgres_like_agent_database<'a>(config: &'a ConnectionConfig, database: &'a str) -> &'a str {
    let database = database.trim();
    if !database.is_empty() {
        return database;
    }
    // Vastbase/PostgreSQL-compatible JDBC drivers can reject an empty catalog path.
    config.effective_database().unwrap_or("")
}

pub fn oracle_alternate_connect_config(config: &ConnectionConfig, err: &str) -> Option<ConnectionConfig> {
    oracle_alternate_connect_configs(config, err).into_iter().next()
}

pub fn oracle_alternate_connect_config_labels(configs: &[ConnectionConfig]) -> Vec<String> {
    configs
        .iter()
        .map(|config| {
            config
                .connection_string
                .as_deref()
                .map(oracle_connection_string_label)
                .unwrap_or_else(|| config.oracle_connection_type.as_deref().unwrap_or("service_name").to_string())
        })
        .collect()
}

fn oracle_connection_string_label(connection_string: &str) -> String {
    let upper = connection_string.to_ascii_uppercase();
    if upper.contains("(SERVICE_NAME=") {
        "descriptor service name".to_string()
    } else if upper.contains("(SID=") {
        "descriptor SID".to_string()
    } else if connection_string.starts_with("jdbc:oracle:thin:@//") {
        "service name".to_string()
    } else if connection_string.contains(':') && !connection_string.contains('/') {
        "SID".to_string()
    } else {
        "legacy service name".to_string()
    }
}

fn sap_hana_jdbc_connection_string(config: &ConnectionConfig, host: &str, port: u16, database: &str) -> String {
    let database = database.trim();
    let params = config.url_params.as_deref().unwrap_or("").trim().trim_start_matches('?');
    let has_database_name = params
        .split(['&', ';'])
        .any(|part| part.split_once('=').map(|(key, _)| key.eq_ignore_ascii_case("databaseName")).unwrap_or(false));

    let mut query_parts = Vec::new();
    if !database.is_empty() && !has_database_name {
        query_parts.push(format!("databaseName={}", utf8_percent_encode(database, NON_ALPHANUMERIC)));
    }
    if !params.is_empty() {
        query_parts.push(params.to_string());
    }

    if query_parts.is_empty() {
        format!("jdbc:sap://{host}:{port}")
    } else {
        format!("jdbc:sap://{host}:{port}/?{}", query_parts.join("&"))
    }
}

pub fn trino_like_jdbc_connection_string(config: &ConnectionConfig, host: &str, port: u16, database: &str) -> String {
    let jdbc_scheme = match config.db_type {
        DatabaseType::PrestoSql => "presto",
        _ => "trino",
    };
    let jdbc_prefix = format!("jdbc:{jdbc_scheme}:");
    let base = config
        .connection_string
        .as_deref()
        .map(str::trim)
        .filter(|value| value.get(..jdbc_prefix.len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case(&jdbc_prefix)))
        .map(|connection_string| {
            if host == config.host && port == config.port {
                connection_string.to_string()
            } else {
                crate::models::connection::rewrite_jdbc_url_host(connection_string, host, port)
            }
        })
        .unwrap_or_else(|| {
            let database = database.trim();
            if database.is_empty() {
                format!("jdbc:{jdbc_scheme}://{host}:{port}")
            } else {
                format!("jdbc:{jdbc_scheme}://{host}:{port}/{database}")
            }
        });

    let params = trino_agent_jdbc_params(config, &base);
    if params.is_empty() {
        base
    } else {
        append_agent_url_params(base, Some(&params))
    }
}

fn trino_agent_jdbc_params(config: &ConnectionConfig, base: &str) -> String {
    let user_params = normalize_agent_url_params(config.url_params.as_deref());
    let mut params = Vec::new();
    if !user_params.is_empty() {
        params.push(user_params.to_string());
    }
    if config.ssl && !url_params_has_key(user_params, "SSL") && !url_has_query_key(base, "SSL") {
        params.push("SSL=true".to_string());
    }
    params.join("&")
}

fn normalize_etcd_endpoints(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let endpoints = config.etcd_endpoints.trim();
    if !endpoints.is_empty() {
        return endpoints.to_string();
    }
    let scheme = if config.ssl { "https" } else { "http" };
    format!("{scheme}://{host}:{port}")
}

fn normalize_zookeeper_connect_string(config: &ConnectionConfig, host: &str, port: u16) -> String {
    config
        .connection_string
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{host}:{port}"))
}

fn normalize_agent_url_params(params: Option<&str>) -> &str {
    params.unwrap_or("").trim().trim_start_matches(['?', '&'])
}

fn url_has_query_key(url: &str, key: &str) -> bool {
    let Some((_, query)) = url.split_once('?') else {
        return false;
    };
    let query = query.split('#').next().unwrap_or(query);
    url_params_has_key(query, key)
}

fn url_params_has_key(params: &str, key: &str) -> bool {
    params
        .split(['&', ';'])
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            Some(part.split_once('=').map(|(param_key, _)| param_key).unwrap_or(part).trim())
        })
        .any(|param_key| param_key.eq_ignore_ascii_case(key))
}

fn append_agent_url_params(base: String, params: Option<&str>) -> String {
    let params = normalize_agent_url_params(params);
    if params.is_empty() {
        return base;
    }
    let separator = if base.contains('?') { '&' } else { '?' };
    format!("{base}{separator}{params}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{
        default_connect_timeout_secs, default_idle_timeout_secs, default_keepalive_interval_secs,
        default_query_timeout_secs, default_redis_key_separator,
    };

    fn config(db_type: DatabaseType, database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "conn".to_string(),
            name: "Connection".to_string(),
            db_type,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 3306,
            username: "user".to_string(),
            password: "secret".to_string(),
            database: database.map(str::to_string),
            visible_databases: None,
            visible_schemas: None,
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
        }
    }

    #[test]
    fn mongodb_database_falls_back_to_uri_database() {
        let mut cfg = config(DatabaseType::MongoDb, None);
        cfg.connection_string = Some("mongodb://user:secret@127.0.0.1:27017/app_db?authSource=admin".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 27017, "");

        assert_eq!(params["database"], "app_db");
    }

    #[test]
    fn h2_file_path_builds_jdbc_file_url_and_strips_database_suffix() {
        assert_eq!(h2_file_jdbc_url("/tmp/app.mv.db"), "jdbc:h2:file:/tmp/app;AUTO_SERVER=TRUE");
        assert_eq!(h2_file_jdbc_url("/tmp/App.MV.DB"), "jdbc:h2:file:/tmp/App;AUTO_SERVER=TRUE");
        assert_eq!(h2_file_jdbc_url("/tmp/legacy.h2.db"), "jdbc:h2:file:/tmp/legacy;AUTO_SERVER=TRUE");
        assert_eq!(h2_file_jdbc_url("/tmp/app"), "jdbc:h2:file:/tmp/app;AUTO_SERVER=TRUE");
    }

    #[test]
    fn h2_file_connection_passes_jdbc_file_url_to_agent() {
        let mut cfg = config(DatabaseType::H2, None);
        cfg.host = "/tmp/app.mv.db".to_string();
        cfg.port = 0;

        let params = agent_connect_params(&cfg, "/tmp/app.mv.db", 0, "");

        assert_eq!(params["host"], "");
        assert_eq!(params["port"], 0);
        assert_eq!(params["database"], "file:/tmp/app;AUTO_SERVER=TRUE");
        assert_eq!(params["connection_string"], "jdbc:h2:file:/tmp/app;AUTO_SERVER=TRUE");
    }

    #[test]
    fn h2_file_connection_normalizes_existing_jdbc_file_url_and_preserves_options() {
        let mut cfg = config(DatabaseType::H2, None);
        cfg.connection_string = Some("jdbc:h2:file:/tmp/app.mv.db;AUTO_SERVER=TRUE".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 9092, "test");

        assert_eq!(params["host"], "");
        assert_eq!(params["port"], 0);
        assert_eq!(params["database"], "file:/tmp/app;AUTO_SERVER=TRUE");
        assert_eq!(params["connection_string"], "jdbc:h2:file:/tmp/app;AUTO_SERVER=TRUE");
    }

    #[test]
    fn h2_split_connection_string_is_treated_as_file_mode() {
        let mut cfg = config(DatabaseType::H2, None);
        cfg.connection_string = Some("jdbc:h2:split:28:C:/dbx-test/h2/sample-db;AUTO_SERVER=TRUE".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 9092, "test");

        assert_eq!(
            h2_file_path_from_jdbc_url(cfg.connection_string.as_deref().unwrap()).as_deref(),
            Some("C:/dbx-test/h2/sample-db")
        );
        assert_eq!(params["host"], "");
        assert_eq!(params["port"], 0);
        assert_eq!(params["database"], "split:28:C:/dbx-test/h2/sample-db;AUTO_SERVER=TRUE");
        assert_eq!(params["connection_string"], "jdbc:h2:split:28:C:/dbx-test/h2/sample-db;AUTO_SERVER=TRUE");
    }

    #[test]
    fn h2_tcp_connection_keeps_empty_agent_connection_string() {
        let mut cfg = config(DatabaseType::H2, Some("test"));
        cfg.host = "127.0.0.1".to_string();
        cfg.port = 9092;

        let params = agent_connect_params(&cfg, "127.0.0.1", 9092, "test");

        assert_eq!(params["host"], "127.0.0.1");
        assert_eq!(params["port"], 9092);
        assert_eq!(params["database"], "test");
        assert_eq!(params["connection_string"], "");
    }

    #[test]
    fn vastbase_agent_url_defaults_to_postgres_database_when_empty() {
        let cfg = config(DatabaseType::Vastbase, Some(""));

        let params = agent_connect_params(&cfg, "vastbase.example.com", 5432, "");

        assert_eq!(params["database"], "postgres");
        assert_eq!(params["connection_string"], "jdbc:vastbase://vastbase.example.com:5432/postgres");
    }

    #[test]
    fn zookeeper_agent_params_preserve_configured_connect_string() {
        let mut cfg = config(DatabaseType::ZooKeeper, None);
        cfg.connection_string = Some("zk-1:2181,zk-2:2181/app".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 2181, "");

        assert_eq!(params["connection_string"], "zk-1:2181,zk-2:2181/app");
        assert_eq!(params["zookeeper_connect_string"], "zk-1:2181,zk-2:2181/app");
    }

    #[test]
    fn zookeeper_agent_params_fall_back_to_host_port_connect_string() {
        let cfg = config(DatabaseType::ZooKeeper, None);

        let params = agent_connect_params(&cfg, "zk.local", 2281, "");

        assert_eq!(params["connection_string"], "");
        assert_eq!(params["zookeeper_connect_string"], "zk.local:2281");
    }

    #[test]
    fn mongo_auth_hint_preserves_original_error() {
        let err = "Agent RPC error: Exception authenticating MongoCredential{mechanism=SCRAM-SHA-1, userName='rwuser', source='admin'}";

        let hinted = mongo_legacy_error_with_auth_hint(err);

        assert!(hinted.starts_with(err));
        assert!(hinted.contains("Current authentication database: admin"));
    }

    #[test]
    fn oracle_listener_error_adds_driver_version_hint_for_default_profile() {
        let mut cfg = config(DatabaseType::Oracle, Some("ORCL"));
        cfg.driver_profile = Some("oracle".to_string());
        let err = "Agent RPC error (-1): ORA-12541: TNS:no listener";

        let hinted = oracle_error_with_driver_hint(&cfg, err);

        assert!(hinted.starts_with(err));
        assert!(hinted.contains("Service Name"));
        assert!(hinted.contains("SID"));
    }

    #[test]
    fn oracle_listener_error_hint_skips_non_oracle_databases() {
        let err = "Agent RPC error (-1): ORA-12541: TNS:no listener";
        let mut cfg = config(DatabaseType::Oracle, Some("ORCL"));

        assert!(oracle_error_with_driver_hint(&cfg, err).contains("Service Name"));

        cfg.db_type = DatabaseType::OceanbaseOracle;
        cfg.driver_profile = None;
        assert_eq!(oracle_error_with_driver_hint(&cfg, err), err);
    }

    #[test]
    fn oracle_url_uses_sid_or_service_name() {
        let mut cfg = config(DatabaseType::Oracle, Some("ORCL"));
        cfg.oracle_connection_type = Some("sid".to_string());

        let sid = agent_connect_params(&cfg, "oracle.example.com", 1521, "ORCL");
        assert_eq!(sid["connection_string"], "jdbc:oracle:thin:@oracle.example.com:1521:ORCL");

        cfg.oracle_connection_type = Some("service_name".to_string());
        let service = agent_connect_params(&cfg, "oracle.example.com", 1521, "ORCL");
        assert_eq!(service["connection_string"], "jdbc:oracle:thin:@//oracle.example.com:1521/ORCL");
    }

    #[test]
    fn oracle_sys_user_connects_as_sysdba_for_agent_protocol() {
        let mut cfg = config(DatabaseType::Oracle, Some("ORCLPDB1"));
        cfg.username = "SYS".to_string();
        cfg.oracle_connection_type = Some("service_name".to_string());

        let params = agent_connect_params(&cfg, "oracle.example.com", 1521, "ORCLPDB1");

        assert_eq!(params["database"], "SYSDBA:ORCLPDB1");
        assert_eq!(params["sysdba"], true);
        assert_eq!(params["connection_string"], "jdbc:oracle:thin:@//oracle.example.com:1521/ORCLPDB1");
    }

    #[test]
    fn oracle_sysdba_checkbox_connects_as_sysdba_for_agent_protocol() {
        let mut cfg = config(DatabaseType::Oracle, Some("ORCLPDB1"));
        cfg.username = "system".to_string();
        cfg.sysdba = true;

        let params = agent_connect_params(&cfg, "oracle.example.com", 1521, "ORCLPDB1");

        assert_eq!(params["database"], "SYSDBA:ORCLPDB1");
        assert_eq!(params["sysdba"], true);
    }

    #[test]
    fn oceanbase_oracle_uses_oceanbase_jdbc_connection_string_for_agent_protocol() {
        let mut cfg = config(DatabaseType::OceanbaseOracle, Some("sys"));
        cfg.host = "oceanbase.example.com".to_string();
        cfg.port = 2881;

        let params = agent_connect_params(&cfg, "oceanbase.example.com", 2881, "sys");

        assert_eq!(params["database"], "sys");
        assert_eq!(params["sysdba"], false);
        assert_eq!(
            params["connection_string"],
            "jdbc:oceanbase://oceanbase.example.com:2881/sys?compatibleOjdbcVersion=8"
        );
    }

    #[test]
    fn oceanbase_oracle_jdbc_url_appends_params_and_rewrites_forwarded_host() {
        let mut cfg = config(DatabaseType::OceanbaseOracle, Some("sys"));
        cfg.host = "oceanbase.example.com".to_string();
        cfg.port = 2881;
        cfg.url_params = Some("useSSL=false".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 12881, "sys");

        assert_eq!(
            params["connection_string"],
            "jdbc:oceanbase://127.0.0.1:12881/sys?useSSL=false&compatibleOjdbcVersion=8"
        );
    }

    #[test]
    fn oceanbase_oracle_jdbc_url_keeps_explicit_compatible_ojdbc_version() {
        let mut cfg = config(DatabaseType::OceanbaseOracle, Some("sys"));
        cfg.host = "oceanbase.example.com".to_string();
        cfg.port = 2881;
        cfg.url_params = Some("compatibleOjdbcVersion=6&useSSL=false".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 12881, "sys");

        assert_eq!(
            params["connection_string"],
            "jdbc:oceanbase://127.0.0.1:12881/sys?compatibleOjdbcVersion=6&useSSL=false"
        );
    }

    #[test]
    fn oceanbase_oracle_custom_jdbc_url_gets_compatible_ojdbc_version_and_forwarded_host() {
        let mut cfg = config(DatabaseType::OceanbaseOracle, Some("sys"));
        cfg.host = "oceanbase.example.com".to_string();
        cfg.port = 2881;
        cfg.connection_string = Some("jdbc:oceanbase://oceanbase.example.com:2881/sys?useSSL=false".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 12881, "sys");

        assert_eq!(
            params["connection_string"],
            "jdbc:oceanbase://127.0.0.1:12881/sys?useSSL=false&compatibleOjdbcVersion=8"
        );
    }

    #[test]
    fn oracle_url_preserves_custom_jdbc_descriptor_and_rewrites_host_port() {
        let mut cfg = config(DatabaseType::Oracle, Some("ORCL"));
        cfg.host = "oracle.example.com".to_string();
        cfg.port = 1521;
        cfg.connection_string = Some(
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=oracle.example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL)))"
                .to_string(),
        );

        let params = agent_connect_params(&cfg, "127.0.0.1", 11521, "ORCL");

        assert_eq!(
            params["connection_string"],
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=11521))(CONNECT_DATA=(SERVICE_NAME=ORCL)))"
        );
    }

    #[test]
    fn oracle_url_preserves_custom_jdbc_descriptor_without_forwarding() {
        let mut cfg = config(DatabaseType::Oracle, Some("ORCL"));
        cfg.host = "form-host.example.com".to_string();
        cfg.port = 1521;
        cfg.connection_string = Some(
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=descriptor-host.example.com)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=ORCL)))"
                .to_string(),
        );

        let params = agent_connect_params(&cfg, "form-host.example.com", 1521, "ORCL");

        assert_eq!(
            params["connection_string"],
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=descriptor-host.example.com)(PORT=1522))(CONNECT_DATA=(SERVICE_NAME=ORCL)))"
        );
    }

    #[test]
    fn oracle_listener_errors_can_switch_descriptor() {
        let mut cfg = config(DatabaseType::Oracle, Some("ORCL"));
        cfg.driver_profile = Some("oracle".to_string());
        cfg.oracle_connection_type = Some("service_name".to_string());

        let retry = oracle_alternate_connect_config(&cfg, "ORA-12514: listener does not know service").unwrap();

        assert_eq!(retry.connection_string.as_deref(), Some("jdbc:oracle:thin:@127.0.0.1:3306:ORCL"));
        assert!(oracle_alternate_connect_config(&retry, "ORA-01017: invalid username/password").is_none());
        assert!(oracle_alternate_connect_config(&cfg, "ORA-12541: TNS:no listener").is_some());
    }

    #[test]
    fn oracle_custom_connection_string_skips_alternate_descriptor_retry() {
        let mut cfg = config(DatabaseType::Oracle, Some("ORCL"));
        cfg.driver_profile = Some("oracle".to_string());
        cfg.oracle_connection_type = Some("service_name".to_string());
        cfg.connection_string = Some("jdbc:oracle:thin:@//oracle.example.com:1521/ORCL".to_string());

        assert!(oracle_alternate_connect_config(&cfg, "ORA-12514: listener does not know service").is_none());
    }

    #[test]
    fn oracle_no_listener_errors_try_common_jdbc_url_variants() {
        let mut cfg = config(DatabaseType::Oracle, Some("ORCL"));
        cfg.host = "oracle.example.com".to_string();
        cfg.port = 1521;
        cfg.driver_profile = Some("oracle".to_string());
        cfg.oracle_connection_type = Some("service_name".to_string());

        let retries = oracle_alternate_connect_configs(&cfg, "ORA-12541: TNS:no listener");
        let urls: Vec<_> = retries.iter().filter_map(|retry| retry.connection_string.as_deref()).collect();

        assert_eq!(
            urls,
            vec![
                "jdbc:oracle:thin:@oracle.example.com:1521:ORCL",
                "jdbc:oracle:thin:@oracle.example.com:1521/ORCL",
                "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=oracle.example.com)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=ORCL)))",
                "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=oracle.example.com)(PORT=1521))(CONNECT_DATA=(SID=ORCL)))",
            ]
        );
    }

    #[test]
    fn sap_hana_url_includes_selected_database_and_params() {
        let mut cfg = config(DatabaseType::SapHana, Some("TENANT1"));
        cfg.url_params = Some("encrypt=true".to_string());

        let params = agent_connect_params(&cfg, "hana.example.com", 30013, "TENANT1");

        assert_eq!(params["connection_string"], "jdbc:sap://hana.example.com:30013/?databaseName=TENANT1&encrypt=true");
    }

    #[test]
    fn trino_agent_url_uses_jdbc_scheme_without_ssl_by_default() {
        let mut cfg = config(DatabaseType::Trino, Some("hive"));
        cfg.host = "trino.example.com".to_string();
        cfg.port = 8080;

        let params = agent_connect_params(&cfg, "trino.example.com", 8080, "hive");

        assert_eq!(params["connection_string"], "jdbc:trino://trino.example.com:8080/hive");
        assert_eq!(params["ssl"], false);
    }

    #[test]
    fn prestosql_jdbc_url_uses_presto_jdbc_scheme() {
        let mut cfg = config(DatabaseType::PrestoSql, Some("hive/default"));
        cfg.host = "presto.example.com".to_string();
        cfg.port = 9090;

        let params = agent_connect_params(&cfg, "presto.example.com", 9090, "hive/default");

        assert_eq!(params["connection_string"], "jdbc:presto://presto.example.com:9090/hive/default");
        assert_eq!(params["ssl"], false);
    }

    #[test]
    fn prestosql_custom_jdbc_url_rewrites_forwarded_host() {
        let mut cfg = config(DatabaseType::PrestoSql, Some("hive/default"));
        cfg.host = "presto.internal".to_string();
        cfg.port = 9090;
        cfg.connection_string = Some("jdbc:presto://presto.internal:9090/hive/default?source=dbx".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 19090, "hive/default");

        assert_eq!(params["connection_string"], "jdbc:presto://127.0.0.1:19090/hive/default?source=dbx");
    }

    #[test]
    fn trino_agent_url_appends_ssl_when_enabled() {
        let mut cfg = config(DatabaseType::Trino, Some("hive"));
        cfg.ssl = true;

        let params = agent_connect_params(&cfg, "trino.example.com", 8443, "hive");

        assert_eq!(params["connection_string"], "jdbc:trino://trino.example.com:8443/hive?SSL=true");
    }

    #[test]
    fn trino_agent_url_preserves_ssl_verification_and_avoids_duplicate_ssl() {
        let mut cfg = config(DatabaseType::Trino, Some("hive"));
        cfg.ssl = true;
        cfg.url_params = Some("ssl=true&SSLVerification=NONE".to_string());

        let params = agent_connect_params(&cfg, "trino.example.com", 8443, "hive");

        assert_eq!(
            params["connection_string"],
            "jdbc:trino://trino.example.com:8443/hive?ssl=true&SSLVerification=NONE"
        );
    }

    #[test]
    fn trino_agent_url_preserves_tls_store_params() {
        let mut cfg = config(DatabaseType::Trino, Some("hive"));
        cfg.ssl = true;
        cfg.url_params = Some(
            "SSLTrustStorePath=C:\\certs\\trino.jks&SSLTrustStorePassword=secret&SSLKeyStorePath=C:\\certs\\client.jks"
                .to_string(),
        );

        let params = agent_connect_params(&cfg, "trino.example.com", 8443, "hive");

        assert_eq!(
            params["connection_string"],
            "jdbc:trino://trino.example.com:8443/hive?SSLTrustStorePath=C:\\certs\\trino.jks&SSLTrustStorePassword=secret&SSLKeyStorePath=C:\\certs\\client.jks&SSL=true"
        );
    }

    #[test]
    fn trino_agent_url_uses_forwarded_host_and_port_with_params() {
        let mut cfg = config(DatabaseType::Trino, Some("hive"));
        cfg.host = "trino.internal".to_string();
        cfg.port = 8443;
        cfg.ssl = true;
        cfg.url_params = Some("SSLVerification=NONE".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 15443, "hive");

        assert_eq!(params["connection_string"], "jdbc:trino://127.0.0.1:15443/hive?SSLVerification=NONE&SSL=true");
    }

    #[test]
    fn trino_agent_custom_jdbc_url_rewrites_forwarded_host_and_preserves_query_ssl() {
        let mut cfg = config(DatabaseType::Trino, Some("hive"));
        cfg.host = "trino.internal".to_string();
        cfg.port = 8443;
        cfg.ssl = true;
        cfg.connection_string = Some("jdbc:trino://trino.internal:8443/hive?SSL=true&source=dbx".to_string());
        cfg.url_params = Some("SSLVerification=NONE".to_string());

        let params = agent_connect_params(&cfg, "127.0.0.1", 15443, "hive");

        assert_eq!(
            params["connection_string"],
            "jdbc:trino://127.0.0.1:15443/hive?SSL=true&source=dbx&SSLVerification=NONE"
        );
    }
}
