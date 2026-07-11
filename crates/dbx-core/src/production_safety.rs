use crate::models::connection::ConnectionConfig;
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

static QUALIFIED_IDENTIFIER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:FROM|JOIN|UPDATE|INTO|TABLE|REFERENCES)\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+)\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+))"#)
        .expect("valid qualified identifier regex")
});
static DATABASE_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b(?:CREATE|ALTER|DROP)\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([`"\[]?[^\s;`"\]]+[`"\]]?)"#)
        .expect("valid database target regex")
});
static USE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)^\s*USE\s+([`"\[]?[^\s;`"\]]+[`"\]]?)"#).expect("valid USE regex"));
static COPY_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)^\s*COPY\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+)\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+))\s+FROM\b"#)
        .expect("valid COPY target regex")
});

/// Returns whether the selected database inherits an explicit production marker.
pub fn is_production_database(config: &ConnectionConfig, database: &str) -> bool {
    config.is_production
        || (!database.trim().is_empty()
            && config
                .production_databases
                .iter()
                .any(|name| normalize_database_name(name) == normalize_database_name(database)))
}

/// Returns whether a non-read SQL statement targets production scope.
///
/// Agent execution already classifies SQL risk with `sql_risk`; this function
/// focuses only on production scope, including qualified cross-database writes
/// such as `DELETE FROM prod_app.users` while the selected database is staging.
pub fn targets_production_database(config: &ConnectionConfig, active_database: &str, sql: &str) -> bool {
    if is_production_database(config, active_database) {
        return true;
    }

    let marked: HashSet<String> =
        config.production_databases.iter().map(|name| normalize_database_name(name)).collect();
    if marked.is_empty() {
        return false;
    }

    referenced_databases(sql).into_iter().any(|database| marked.contains(&database))
}

fn normalize_database_name(value: &str) -> String {
    value.trim().trim_matches(|ch| matches!(ch, '`' | '"' | '[' | ']')).to_ascii_lowercase()
}

fn referenced_databases(sql: &str) -> HashSet<String> {
    let mut databases = HashSet::new();
    let cleaned = crate::query_execution_sql::strip_sql_comments_and_literals(sql);
    let mut use_database = String::new();

    for statement in cleaned.split(';').map(str::trim).filter(|statement| !statement.is_empty()) {
        if let Some(database) = USE_RE
            .captures(statement)
            .and_then(|capture| capture.get(1))
            .map(|value| normalize_database_name(value.as_str()))
            .filter(|value| !value.is_empty())
        {
            use_database = database;
            continue;
        }

        if !use_database.is_empty() {
            databases.insert(use_database.clone());
        }

        for capture in QUALIFIED_IDENTIFIER_RE.captures_iter(statement) {
            if let Some(target) = capture.get(1) {
                if let Some(database) =
                    target.as_str().split('.').next().map(normalize_database_name).filter(|value| !value.is_empty())
                {
                    databases.insert(database);
                }
            }
        }
        for capture in DATABASE_TARGET_RE.captures_iter(statement) {
            if let Some(database) =
                capture.get(1).map(|value| normalize_database_name(value.as_str())).filter(|value| !value.is_empty())
            {
                databases.insert(database);
            }
        }
        if let Some(database) = COPY_TARGET_RE
            .captures(statement)
            .and_then(|capture| capture.get(1))
            .and_then(|target| target.as_str().split('.').next().map(normalize_database_name))
            .filter(|value| !value.is_empty())
        {
            databases.insert(database);
        }
    }
    databases
}

#[cfg(test)]
mod tests {
    use super::{is_production_database, targets_production_database};
    use crate::models::connection::{ConnectionConfig, DatabaseType};

    fn config() -> ConnectionConfig {
        ConnectionConfig {
            id: "conn".to_string(),
            name: "test".to_string(),
            db_type: DatabaseType::Mysql,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: vec![],
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            attached_databases: vec![],
            color: None,
            transport_layers: vec![],
            connect_timeout_secs: 10,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 30,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: vec![],
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".to_string(),
            redis_scan_page_size: Some(1000),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec!["prod_app".to_string()],
        }
    }

    #[test]
    fn matches_marked_database_case_insensitively() {
        assert!(is_production_database(&config(), "`PROD_APP`"));
        assert!(!is_production_database(&config(), "staging"));
    }

    #[test]
    fn detects_cross_database_production_targets() {
        assert!(targets_production_database(&config(), "staging", "DELETE FROM prod_app.users WHERE id = 1"));
        assert!(targets_production_database(&config(), "staging", "USE prod_app; DELETE FROM users WHERE id = 1"));
        assert!(targets_production_database(&config(), "staging", "COPY prod_app.users FROM '/tmp/users.csv'"));
        assert!(targets_production_database(&config(), "staging", "DROP DATABASE IF EXISTS `prod_app`"));
        assert!(!targets_production_database(&config(), "staging", "DELETE FROM staging.users WHERE id = 1"));
        assert!(!targets_production_database(
            &config(),
            "staging",
            "DELETE FROM staging.users WHERE note = 'FROM prod_app.users'"
        ));
    }
}
