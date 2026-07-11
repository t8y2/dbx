use crate::models::connection::{ConnectionConfig, DatabaseType};
use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

const IDENTIFIER_PATTERN: &str = r"[A-Za-z_@$#][A-Za-z0-9_@$#-]*";
const QUALIFIED_NAME_PATTERN: &str = r"[A-Za-z_@$#][A-Za-z0-9_@$#-]*\s*\.\s*(?:\*|[A-Za-z_@$#][A-Za-z0-9_@$#-]*)(?:\s*\.\s*(?:\*|[A-Za-z_@$#][A-Za-z0-9_@$#-]*))?";

static DML_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\s+({QUALIFIED_NAME_PATTERN})"))
        .expect("valid DML target regex")
});
static DDL_OBJECT_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?is)\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|TRIGGER|EVENT|TYPE|SYNONYM)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?({QUALIFIED_NAME_PATTERN})"
    ))
    .expect("valid DDL object target regex")
});
static INDEX_ON_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\b(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?INDEX\b.*?\bON\s+({QUALIFIED_NAME_PATTERN})"))
        .expect("valid index target regex")
});
static DATABASE_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?is)\b(?:CREATE|ALTER|DROP)\s+(DATABASE|SCHEMA|CATALOG)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?({IDENTIFIER_PATTERN})"
    ))
    .expect("valid database target regex")
});
static USE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?is)^\s*USE\s+({IDENTIFIER_PATTERN})")).expect("valid USE regex"));
static COPY_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)^\s*COPY\s+({QUALIFIED_NAME_PATTERN})\s+FROM\b")).expect("valid COPY target regex")
});
static ROUTINE_CALL_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\b(?:CALL|EXEC|EXECUTE)\s+({QUALIFIED_NAME_PATTERN})"))
        .expect("valid routine call target regex")
});
static PRIVILEGE_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?is)\b(?:GRANT|REVOKE|DENY)\b.*?\bON\s+(?:(?:TABLE|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|OBJECT)\s+|OBJECT\s*::\s*)?({QUALIFIED_NAME_PATTERN})"
    ))
    .expect("valid privilege target regex")
});
static PRIVILEGE_DATABASE_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?is)\b(?:GRANT|REVOKE|DENY)\b.*?\bON\s+(?:DATABASE|CATALOG)(?:::|\s+)\s*({IDENTIFIER_PATTERN})"
    ))
    .expect("valid privilege database target regex")
});
static GLOBAL_PRIVILEGE_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\b(?:GRANT|REVOKE|DENY)\b.*?\bON\s+\*\s*\.\s*\*").expect("valid global privilege target regex")
});
static GLOBAL_DDL_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)^\s*(?:CREATE|ALTER|DROP)\s+(?:USER|ROLE|LOGIN|SERVER|TABLESPACE|RESOURCE|PROFILE|ACCOUNT)\b")
        .expect("valid global DDL target regex")
});
static FIRST_KEYWORD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(IDENTIFIER_PATTERN).expect("valid first keyword regex"));

#[derive(Default)]
struct ReferencedDatabaseAssessment {
    databases: HashSet<String>,
    uncertain: bool,
}

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

    let assessment = referenced_databases(sql, &config.db_type, active_database);
    assessment.databases.into_iter().any(|database| marked.contains(&database)) || assessment.uncertain
}

fn normalize_database_name(value: &str) -> String {
    value.trim().trim_matches(|ch| matches!(ch, '`' | '"' | '[' | ']')).to_ascii_lowercase()
}

fn referenced_databases(sql: &str, db_type: &DatabaseType, active_database: &str) -> ReferencedDatabaseAssessment {
    let mut assessment = ReferencedDatabaseAssessment::default();
    let cleaned = sql_target_safety_text(sql);
    let mut use_database = String::new();
    let has_active_database = !normalize_database_name(active_database).is_empty();

    for statement in cleaned.split(';').map(str::trim).filter(|statement| !statement.is_empty()) {
        let before_size = assessment.databases.len();
        let statement_is_mutation = crate::query_execution_sql::is_write_sql(statement);
        if let Some(database) = USE_RE
            .captures(statement)
            .and_then(|capture| capture.get(1))
            .map(|value| normalize_database_name(value.as_str()))
            .filter(|value| !value.is_empty())
        {
            use_database = database;
            continue;
        }

        if !statement_is_mutation {
            continue;
        }

        if !use_database.is_empty() {
            assessment.databases.insert(use_database.clone());
        }

        collect_qualified_target_databases(
            statement,
            db_type,
            &mut assessment.databases,
            &[
                &DML_TARGET_RE,
                &DDL_OBJECT_TARGET_RE,
                &INDEX_ON_TARGET_RE,
                &ROUTINE_CALL_TARGET_RE,
                &PRIVILEGE_TARGET_RE,
            ],
        );
        for capture in DATABASE_TARGET_RE.captures_iter(statement) {
            if let Some(database) = capture
                .get(1)
                .filter(|kind| database_target_kind_means_database(kind.as_str(), db_type))
                .and_then(|_| capture.get(2))
                .map(|value| normalize_database_name(value.as_str()))
                .filter(|value| !value.is_empty())
            {
                assessment.databases.insert(database);
            }
        }
        for capture in PRIVILEGE_DATABASE_TARGET_RE.captures_iter(statement) {
            if let Some(database) =
                capture.get(1).map(|value| normalize_database_name(value.as_str())).filter(|value| !value.is_empty())
            {
                assessment.databases.insert(database);
            }
        }
        if let Some(database) = COPY_TARGET_RE
            .captures(statement)
            .and_then(|capture| capture.get(1))
            .and_then(|target| database_from_qualified_name(target.as_str(), db_type))
            .filter(|value| !value.is_empty())
        {
            assessment.databases.insert(database);
        }
        assessment.uncertain = assessment.uncertain
            || GLOBAL_PRIVILEGE_TARGET_RE.is_match(statement)
            || is_ambiguous_production_target_statement(
                statement,
                assessment.databases.len() > before_size,
                !use_database.is_empty() || has_active_database,
            );
    }
    assessment
}

fn collect_qualified_target_databases(
    statement: &str,
    db_type: &DatabaseType,
    databases: &mut HashSet<String>,
    patterns: &[&LazyLock<Regex>],
) {
    for pattern in patterns {
        for capture in pattern.captures_iter(statement) {
            if let Some(database) = capture
                .get(1)
                .and_then(|target| database_from_qualified_name(target.as_str(), db_type))
                .filter(|value| !value.is_empty())
            {
                databases.insert(database);
            }
        }
    }
}

fn database_from_qualified_name(qualified_name: &str, db_type: &DatabaseType) -> Option<String> {
    let parts: Vec<String> =
        qualified_name.split('.').map(normalize_database_name).filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 {
        return None;
    }
    if qualified_first_part_is_database(db_type, parts.len()) {
        return parts.first().cloned();
    }
    None
}

fn qualified_first_part_is_database(db_type: &DatabaseType, part_count: usize) -> bool {
    if part_count >= 3
        && matches!(
            db_type,
            DatabaseType::SqlServer
                | DatabaseType::Snowflake
                | DatabaseType::Trino
                | DatabaseType::PrestoSql
                | DatabaseType::Databricks
                | DatabaseType::Bigquery
        )
    {
        return true;
    }
    if schema_first_qualifier_type(db_type) {
        return false;
    }
    part_count >= 2
}

fn database_target_kind_means_database(kind: &str, db_type: &DatabaseType) -> bool {
    if kind.eq_ignore_ascii_case("database") || kind.eq_ignore_ascii_case("catalog") {
        return true;
    }
    kind.eq_ignore_ascii_case("schema") && !schema_first_qualifier_type(db_type)
}

fn schema_first_qualifier_type(db_type: &DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::Postgres
            | DatabaseType::Redshift
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::OpenGauss
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
            | DatabaseType::Yashandb
            | DatabaseType::Oracle
            | DatabaseType::OceanbaseOracle
            | DatabaseType::Dameng
            | DatabaseType::Firebird
            | DatabaseType::Exasol
            | DatabaseType::Teradata
            | DatabaseType::Vertica
            | DatabaseType::Db2
            | DatabaseType::Informix
            | DatabaseType::H2
            | DatabaseType::Iris
            | DatabaseType::Xugu
            | DatabaseType::Oscar
            | DatabaseType::Gbase
            | DatabaseType::SapHana
            | DatabaseType::SqlServer
            | DatabaseType::Snowflake
            | DatabaseType::Trino
            | DatabaseType::PrestoSql
            | DatabaseType::Databricks
            | DatabaseType::Bigquery
    )
}

fn is_ambiguous_production_target_statement(
    statement: &str,
    has_resolved_target: bool,
    has_current_database: bool,
) -> bool {
    if !crate::query_execution_sql::is_write_sql(statement) {
        return false;
    }
    if GLOBAL_DDL_TARGET_RE.is_match(statement) {
        return true;
    }
    let Some(first_keyword) = first_keyword(statement) else {
        return true;
    };
    if is_target_ambiguous_keyword(&first_keyword) && !has_resolved_target {
        return true;
    }
    if is_unqualified_target_keyword(&first_keyword) && !has_resolved_target && !has_current_database {
        return true;
    }
    is_unknown_target_keyword(&first_keyword) && !has_resolved_target
}

fn first_keyword(statement: &str) -> Option<String> {
    FIRST_KEYWORD_RE.find(statement).map(|value| value.as_str().to_ascii_lowercase())
}

fn is_target_ambiguous_keyword(keyword: &str) -> bool {
    matches!(keyword, "call" | "exec" | "execute" | "grant" | "revoke" | "deny")
}

fn is_unqualified_target_keyword(keyword: &str) -> bool {
    matches!(
        keyword,
        "insert"
            | "update"
            | "delete"
            | "merge"
            | "replace"
            | "load"
            | "copy"
            | "truncate"
            | "create"
            | "alter"
            | "drop"
    )
}

fn is_unknown_target_keyword(keyword: &str) -> bool {
    !matches!(
        keyword,
        "select"
            | "with"
            | "show"
            | "describe"
            | "desc"
            | "explain"
            | "from"
            | "values"
            | "table"
            | "use"
            | "begin"
            | "start"
            | "commit"
            | "rollback"
            | "abort"
            | "savepoint"
            | "release"
    ) && !is_target_ambiguous_keyword(keyword)
        && !is_unqualified_target_keyword(keyword)
}

fn sql_target_safety_text(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut output = String::with_capacity(sql.len());
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();

        if ch == '-' && next == Some('-') {
            index += 2;
            while index < chars.len() && chars[index] != '\n' && chars[index] != '\r' {
                index += 1;
            }
            output.push(' ');
            continue;
        }
        if ch == '#' {
            index += 1;
            while index < chars.len() && chars[index] != '\n' && chars[index] != '\r' {
                index += 1;
            }
            output.push(' ');
            continue;
        }
        if ch == '/' && next == Some('*') {
            if let Some((body, close_index)) = mysql_executable_comment_body(&chars, index) {
                output.push(' ');
                output.push_str(&sql_target_safety_text(&body));
                output.push(' ');
                index = close_index;
            } else {
                index += 2;
                while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                    index += 1;
                }
                index = (index + 2).min(chars.len());
                output.push(' ');
            }
            continue;
        }
        if let Some((tag, tag_len)) = dollar_quote_tag_at(&chars, index) {
            index += tag_len;
            while index + tag_len <= chars.len() && !chars[index..index + tag_len].iter().collect::<String>().eq(&tag) {
                index += 1;
            }
            index = (index + tag_len).min(chars.len());
            output.push(' ');
            continue;
        }
        if ch == '\'' {
            index = skip_string_literal(&chars, index, '\'', '\'');
            output.push(' ');
            continue;
        }
        if ch == '"' || ch == '`' || ch == '[' {
            let close = if ch == '[' { ']' } else { ch };
            index = append_unquoted_identifier(&chars, index, close, &mut output);
            continue;
        }

        output.push(ch);
        index += 1;
    }

    output
}

fn mysql_executable_comment_body(chars: &[char], start: usize) -> Option<(String, usize)> {
    if chars.get(start) != Some(&'/') || chars.get(start + 1) != Some(&'*') {
        return None;
    }
    let mut index = start + 2;
    match chars.get(index).copied() {
        Some('!') => index += 1,
        Some('M') if chars.get(index + 1) == Some(&'!') => index += 2,
        _ => return None,
    }
    while matches!(chars.get(index), Some(ch) if ch.is_ascii_digit() || ch.is_whitespace()) {
        index += 1;
    }
    let body_start = index;
    while index + 1 < chars.len() {
        if chars[index] == '*' && chars[index + 1] == '/' {
            return Some((chars[body_start..index].iter().collect(), index + 2));
        }
        index += 1;
    }
    Some((chars[body_start..].iter().collect(), chars.len()))
}

fn dollar_quote_tag_at(chars: &[char], start: usize) -> Option<(String, usize)> {
    if chars.get(start) != Some(&'$') {
        return None;
    }
    let mut index = start + 1;
    if chars.get(index) == Some(&'$') {
        return Some(("$$".to_string(), 2));
    }
    if !matches!(chars.get(index), Some(ch) if ch.is_ascii_alphabetic() || *ch == '_') {
        return None;
    }
    index += 1;
    while matches!(chars.get(index), Some(ch) if ch.is_ascii_alphanumeric() || *ch == '_') {
        index += 1;
    }
    if chars.get(index) != Some(&'$') {
        return None;
    }
    let tag: String = chars[start..=index].iter().collect();
    Some((tag, index - start + 1))
}

fn skip_string_literal(chars: &[char], start: usize, open: char, close: char) -> usize {
    let mut index = start + 1;
    while index < chars.len() {
        if chars[index] == '\\' && matches!(open, '\'' | '"') {
            index += 2;
            continue;
        }
        if chars[index] == close {
            if chars.get(index + 1) == Some(&close) {
                index += 2;
                continue;
            }
            return index + 1;
        }
        index += 1;
    }
    chars.len()
}

fn append_unquoted_identifier(chars: &[char], start: usize, close: char, output: &mut String) -> usize {
    let mut index = start + 1;
    output.push(' ');
    while index < chars.len() {
        if chars[index] == close {
            if chars.get(index + 1) == Some(&close) {
                output.push(close);
                index += 2;
                continue;
            }
            output.push(' ');
            return index + 1;
        }
        output.push(if chars[index] == ';' { ' ' } else { chars[index] });
        index += 1;
    }
    output.push(' ');
    chars.len()
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
        assert!(targets_production_database(&config(), "staging", "CALL prod_app.purge_users()"));
        assert!(targets_production_database(&config(), "staging", "CALL `prod_app`.`purge_users`()"));
        assert!(targets_production_database(&config(), "staging", "GRANT ALL ON prod_app.* TO 'u'@'%'"));
        assert!(targets_production_database(
            &config(),
            "staging",
            "GRANT EXECUTE ON PROCEDURE prod_app.purge_users TO 'u'@'%'"
        ));
        assert!(!targets_production_database(&config(), "staging", "DELETE FROM staging.users WHERE id = 1"));
        assert!(!targets_production_database(&config(), "staging", "CALL staging.purge_users()"));
        assert!(!targets_production_database(&config(), "staging", "GRANT ALL ON staging.* TO 'u'@'%'"));
        assert!(!targets_production_database(
            &config(),
            "staging",
            "DELETE FROM staging.users WHERE note = 'FROM prod_app.users'"
        ));
        assert!(!targets_production_database(
            &config(),
            "staging",
            "SELECT * FROM prod_app.users; DELETE FROM staging.users WHERE id = 1"
        ));
    }

    #[test]
    fn conservatively_blocks_ambiguous_production_targets() {
        assert!(targets_production_database(&config(), "staging", "CALL purge_users()"));
        assert!(targets_production_database(&config(), "staging", "GRANT PROCESS ON *.* TO 'u'@'%'"));
        assert!(targets_production_database(&config(), "staging", "GRANT ALL ON users TO 'u'@'%'"));
        assert!(targets_production_database(&config(), "staging", "CREATE USER 'u'@'%'"));
    }

    #[test]
    fn resolves_sqlserver_database_qualifiers_dialect_aware() {
        let mut sqlserver = config();
        sqlserver.db_type = DatabaseType::SqlServer;

        assert!(targets_production_database(&sqlserver, "staging", "DELETE FROM prod_app.dbo.users WHERE id = 1"));
        assert!(!targets_production_database(&sqlserver, "staging", "DELETE FROM prod_app.users WHERE id = 1"));
    }
}
