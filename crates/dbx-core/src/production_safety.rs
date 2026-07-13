use crate::models::connection::{ConnectionConfig, DatabaseType};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const PRODUCTION_WRITE_PERMIT_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
struct ProductionWritePermit {
    connection_id: String,
    database: String,
    operation: String,
    request_digest: String,
    expires_at: Instant,
}

/// Authorization carried by exactly one production mutation after an operator confirms it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductionWriteAuthorization {
    pub token: String,
    pub operation: String,
    pub request_digest: String,
}

tokio::task_local! {
    static ACTIVE_PRODUCTION_WRITE_AUTHORIZATION: Option<ProductionWriteAuthorization>;
}

/// Stores short-lived, single-use permits created after an operator confirms a production write.
///
/// Permits are deliberately kept in memory and bound to a random token, connection, effective
/// database, operation kind, and request digest. Concurrent writes therefore cannot consume
/// another operation's confirmation merely because they share a connection and database.
#[derive(Default)]
pub struct ProductionWritePermitStore {
    permits: Mutex<HashMap<String, ProductionWritePermit>>,
}

impl ProductionWritePermitStore {
    /// Issues a cryptographically random token for one confirmed production mutation.
    pub async fn authorize(
        &self,
        connection_id: &str,
        database: Option<&str>,
        operation: &str,
        request_digest: &str,
    ) -> Result<ProductionWriteAuthorization, String> {
        validate_production_write_intent(operation, request_digest)?;
        let mut permits = self.permits.lock().await;
        let now = Instant::now();
        permits.retain(|_, permit| permit.expires_at > now);

        let token = loop {
            let candidate = uuid::Uuid::new_v4().to_string();
            if !permits.contains_key(&candidate) {
                break candidate;
            }
        };
        let authorization = ProductionWriteAuthorization {
            token: token.clone(),
            operation: operation.trim().to_string(),
            request_digest: request_digest.trim().to_ascii_lowercase(),
        };
        permits.insert(
            token,
            ProductionWritePermit {
                connection_id: connection_id.trim().to_string(),
                database: normalize_database_name(database.unwrap_or_default()),
                operation: authorization.operation.clone(),
                request_digest: authorization.request_digest.clone(),
                expires_at: now + PRODUCTION_WRITE_PERMIT_TTL,
            },
        );
        Ok(authorization)
    }

    async fn consume(
        &self,
        authorization: &ProductionWriteAuthorization,
        connection_id: &str,
        database: Option<&str>,
        operation: &str,
    ) -> bool {
        let mut permits = self.permits.lock().await;
        let now = Instant::now();
        permits.retain(|_, permit| permit.expires_at > now);
        let expected_database = normalize_database_name(database.unwrap_or_default());
        let expected_operation = operation.trim();
        let Some(permit) = permits.get(&authorization.token) else {
            return false;
        };
        let matches = permit.connection_id == connection_id.trim()
            && permit.database == expected_database
            && permit.operation == expected_operation
            && permit.operation == authorization.operation
            && permit.request_digest == authorization.request_digest.trim().to_ascii_lowercase();
        if matches {
            // Validation and removal happen under the same lock, making replay impossible.
            permits.remove(&authorization.token);
        }
        matches
    }
}

fn validate_production_write_intent(operation: &str, request_digest: &str) -> Result<(), String> {
    let operation = operation.trim();
    if operation.is_empty() || operation.len() > 128 {
        return Err("Production write operation must contain 1 to 128 characters".to_string());
    }
    let digest = request_digest.trim();
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Production write request digest must be a SHA-256 hex string".to_string());
    }
    Ok(())
}

/// Runs a backend request with the production authorization explicitly carried by its transport.
pub async fn with_production_write_authorization<F>(
    authorization: Option<ProductionWriteAuthorization>,
    future: F,
) -> F::Output
where
    F: Future,
{
    ACTIVE_PRODUCTION_WRITE_AUTHORIZATION.scope(authorization, future).await
}

fn active_production_write_authorization() -> Option<ProductionWriteAuthorization> {
    ACTIVE_PRODUCTION_WRITE_AUTHORIZATION.try_with(Clone::clone).ok().flatten()
}

/// Issues a request-bound permit after the operator has confirmed a production mutation.
pub async fn authorize_production_write(
    state: &crate::connection::AppState,
    connection_id: &str,
    database: Option<&str>,
    operation: &str,
    request_digest: &str,
) -> Result<ProductionWriteAuthorization, String> {
    let config = state.configs.read().await.get(connection_id).cloned().ok_or("Connection not found")?;
    if !is_production_database(&config, database.unwrap_or_default()) {
        return Err("Production write authorization can only be issued for a production target".to_string());
    }
    state.production_write_permits.authorize(connection_id, database, operation, request_digest).await
}

/// Applies ordinary read-only protection and consumes explicit confirmation for production writes.
pub async fn ensure_write_allowed(
    state: &crate::connection::AppState,
    connection_id: &str,
    database: Option<&str>,
    operation: &str,
    action: &str,
) -> Result<(), String> {
    let authorization = active_production_write_authorization();
    ensure_write_allowed_with_authorization(state, connection_id, database, operation, action, authorization.as_ref())
        .await
}

/// Applies production protection using authorization carried by a Tauri command argument.
pub async fn ensure_write_allowed_with_authorization(
    state: &crate::connection::AppState,
    connection_id: &str,
    database: Option<&str>,
    operation: &str,
    action: &str,
    authorization: Option<&ProductionWriteAuthorization>,
) -> Result<(), String> {
    let config = state.configs.read().await.get(connection_id).cloned().ok_or("Connection not found")?;
    if config.read_only {
        return Err(format!(
            "Read-only mode: connection '{}' has read-only protection enabled. {} blocked.",
            config.name, action
        ));
    }
    if !is_production_database(&config, database.unwrap_or_default()) {
        return Ok(());
    }
    if let Some(authorization) = authorization {
        if state.production_write_permits.consume(authorization, connection_id, database, operation).await {
            return Ok(());
        }
    }
    Err(format!(
        "Production protection: connection '{}' targets a production environment. A valid request-bound confirmation is required before {}.",
        config.name, action
    ))
}

/// Enforces a raw Redis mutation against every logical database the command can affect.
///
/// Cross-database commands such as `MOVE`, `COPY ... DB`, `SWAPDB`, and `FLUSHALL`
/// are resolved before consuming the operator's database-bound production permit.
pub async fn ensure_redis_command_write_allowed(
    state: &crate::connection::AppState,
    connection_id: &str,
    selected_database: u32,
    command: &str,
    operation: &str,
    action: &str,
    authorization: Option<&ProductionWriteAuthorization>,
) -> Result<(), String> {
    let config = state.configs.read().await.get(connection_id).cloned().ok_or("Connection not found")?;
    let database = redis_command_production_database(&config, selected_database, command)
        .unwrap_or_else(|| selected_database.to_string());
    let carried_authorization = authorization.cloned().or_else(active_production_write_authorization);
    ensure_write_allowed_with_authorization(
        state,
        connection_id,
        Some(&database),
        operation,
        action,
        carried_authorization.as_ref(),
    )
    .await
}

/// Returns the first marked production database affected by a raw Redis command.
pub fn redis_command_production_database(
    config: &ConnectionConfig,
    selected_database: u32,
    command: &str,
) -> Option<String> {
    redis_command_database_targets(config, selected_database, command)
        .into_iter()
        .find(|database| is_production_database(config, database))
}

fn redis_command_database_targets(config: &ConnectionConfig, selected_database: u32, command: &str) -> Vec<String> {
    let mut databases = vec![selected_database.to_string()];
    let Ok(argv) = crate::db::redis_driver::parse_command_argv(command) else {
        return databases;
    };
    let command = argv.first().map(|value| value.to_ascii_uppercase()).unwrap_or_default();
    match command.as_str() {
        "MOVE" => push_redis_database_argument(&mut databases, argv.get(2)),
        "COPY" => {
            if let Some(index) = argv.iter().position(|value| value.eq_ignore_ascii_case("DB")) {
                push_redis_database_argument(&mut databases, argv.get(index + 1));
            }
        }
        "SWAPDB" => {
            push_redis_database_argument(&mut databases, argv.get(1));
            push_redis_database_argument(&mut databases, argv.get(2));
        }
        "FLUSHALL" => databases.extend(config.production_databases.iter().cloned()),
        _ => {}
    }
    databases
}

fn push_redis_database_argument(databases: &mut Vec<String>, value: Option<&String>) {
    if let Some(database) = value.and_then(|value| value.parse::<u32>().ok()) {
        let database = database.to_string();
        if !databases.contains(&database) {
            databases.push(database);
        }
    }
}

const IDENTIFIER_PATTERN: &str = r"[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*";
const TARGET_NAME_PATTERN: &str = r"[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*(?:\s*\.\s*(?:\*|[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*)){0,2}";
const QUALIFIED_NAME_PATTERN: &str = r"[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*\s*\.\s*(?:\*|[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*)(?:\s*\.\s*(?:\*|[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*))?";

static DML_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\s+({TARGET_NAME_PATTERN})"))
        .expect("valid DML target regex")
});
static DDL_OBJECT_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?is)\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|TRIGGER|EVENT|TYPE|SYNONYM)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?({TARGET_NAME_PATTERN})"
    ))
    .expect("valid DDL object target regex")
});
static INDEX_ON_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\b(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?INDEX\b.*?\bON\s+({TARGET_NAME_PATTERN})"))
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
    Regex::new(&format!(r"(?is)^\s*COPY\s+({TARGET_NAME_PATTERN})\s+FROM\b")).expect("valid COPY target regex")
});
static TRUNCATE_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\bTRUNCATE\s+(?:TABLE\s+)?({TARGET_NAME_PATTERN})"))
        .expect("valid truncate target regex")
});
static RENAME_TABLE_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\bRENAME\s+TABLE\s+({TARGET_NAME_PATTERN})\s+TO\s+({TARGET_NAME_PATTERN})"))
        .expect("valid rename table target regex")
});
static MAINTENANCE_TABLE_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?is)\b(?:ANALYZE|OPTIMIZE|REPAIR|CHECK)\s+(?:NO_WRITE_TO_BINLOG\s+|LOCAL\s+)?TABLE\s+({TARGET_NAME_PATTERN})"
    ))
    .expect("valid maintenance table target regex")
});
static COMMENT_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?is)\bCOMMENT\s+ON\s+(?:TABLE|VIEW|COLUMN|INDEX|SEQUENCE|FUNCTION|PROCEDURE|TYPE)\s+({TARGET_NAME_PATTERN})"
    ))
    .expect("valid comment target regex")
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
static MULTI_TARGET_MUTATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)^\s*(?:DROP\s+(?:TEMPORARY\s+)?TABLE\b.*,|RENAME\s+TABLE\b.*,)")
        .expect("valid multi-target mutation regex")
});
static FIRST_KEYWORD_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(IDENTIFIER_PATTERN).expect("valid first keyword regex"));

#[derive(Default)]
struct ReferencedDatabaseAssessment {
    databases: HashSet<String>,
    uncertain: bool,
}

#[derive(Default)]
struct SqlTargetSafetyText {
    text: String,
    quoted_identifiers: HashMap<String, String>,
}

/// Returns whether the selected database inherits an explicit production marker.
pub fn is_production_database(config: &ConnectionConfig, database: &str) -> bool {
    config.is_production
        || (connection_scoped_non_sql_type(&config.db_type) && !config.production_databases.is_empty())
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
    let normalized_active_database = normalize_database_name(active_database);

    for statement in cleaned.text.split(';').map(str::trim).filter(|statement| !statement.is_empty()) {
        let mut statement_databases = HashSet::new();
        let statement_is_mutation = crate::query_execution_sql::is_write_sql(statement);
        if let Some(database) = USE_RE
            .captures(statement)
            .and_then(|capture| capture.get(1))
            .map(|value| normalize_target_database_name(value.as_str(), &cleaned.quoted_identifiers))
            .filter(|value| !value.is_empty())
        {
            use_database = database;
            continue;
        }

        if !statement_is_mutation {
            continue;
        }

        let current_database =
            if use_database.is_empty() { normalized_active_database.as_str() } else { use_database.as_str() };

        collect_qualified_target_databases(
            statement,
            db_type,
            &cleaned.quoted_identifiers,
            current_database,
            &mut statement_databases,
            &[
                &DML_TARGET_RE,
                &DDL_OBJECT_TARGET_RE,
                &INDEX_ON_TARGET_RE,
                &TRUNCATE_TARGET_RE,
                &MAINTENANCE_TABLE_TARGET_RE,
                &COMMENT_TARGET_RE,
                &ROUTINE_CALL_TARGET_RE,
                &PRIVILEGE_TARGET_RE,
            ],
        );
        collect_qualified_target_database_groups(
            statement,
            db_type,
            &cleaned.quoted_identifiers,
            current_database,
            &mut statement_databases,
            &RENAME_TABLE_TARGET_RE,
            &[1, 2],
        );
        for capture in DATABASE_TARGET_RE.captures_iter(statement) {
            if let Some(database) = capture
                .get(1)
                .filter(|kind| database_target_kind_means_database(kind.as_str(), db_type))
                .and_then(|_| capture.get(2))
                .map(|value| normalize_target_database_name(value.as_str(), &cleaned.quoted_identifiers))
                .filter(|value| !value.is_empty())
            {
                statement_databases.insert(database);
            }
        }
        for capture in PRIVILEGE_DATABASE_TARGET_RE.captures_iter(statement) {
            if let Some(database) = capture
                .get(1)
                .map(|value| normalize_target_database_name(value.as_str(), &cleaned.quoted_identifiers))
                .filter(|value| !value.is_empty())
            {
                statement_databases.insert(database);
            }
        }
        if let Some(database) = COPY_TARGET_RE
            .captures(statement)
            .and_then(|capture| capture.get(1))
            .and_then(|target| {
                database_from_qualified_name(target.as_str(), db_type, &cleaned.quoted_identifiers, current_database)
            })
            .filter(|value| !value.is_empty())
        {
            statement_databases.insert(database);
        }
        let has_resolved_target = !statement_databases.is_empty();
        assessment.databases.extend(statement_databases);
        // The target regexes intentionally extract one object at a time. Until all
        // list forms are parsed, never let a resolved first target disable fallback.
        assessment.uncertain = assessment.uncertain
            || GLOBAL_PRIVILEGE_TARGET_RE.is_match(statement)
            || MULTI_TARGET_MUTATION_RE.is_match(statement)
            || is_ambiguous_production_target_statement(statement, has_resolved_target);
    }
    assessment
}

fn collect_qualified_target_databases(
    statement: &str,
    db_type: &DatabaseType,
    quoted_identifiers: &HashMap<String, String>,
    current_database: &str,
    databases: &mut HashSet<String>,
    patterns: &[&LazyLock<Regex>],
) {
    for pattern in patterns {
        collect_qualified_target_database_groups(
            statement,
            db_type,
            quoted_identifiers,
            current_database,
            databases,
            pattern,
            &[1],
        );
    }
}

fn collect_qualified_target_database_groups(
    statement: &str,
    db_type: &DatabaseType,
    quoted_identifiers: &HashMap<String, String>,
    current_database: &str,
    databases: &mut HashSet<String>,
    pattern: &LazyLock<Regex>,
    capture_indexes: &[usize],
) {
    for capture in pattern.captures_iter(statement) {
        for capture_index in capture_indexes {
            if let Some(database) = capture
                .get(*capture_index)
                .and_then(|target| {
                    database_from_qualified_name(target.as_str(), db_type, quoted_identifiers, current_database)
                })
                .filter(|value| !value.is_empty())
            {
                databases.insert(database);
            }
        }
    }
}

fn database_from_qualified_name(
    qualified_name: &str,
    db_type: &DatabaseType,
    quoted_identifiers: &HashMap<String, String>,
    current_database: &str,
) -> Option<String> {
    let parts: Vec<String> = qualified_name
        .split('.')
        .map(|part| normalize_target_database_name(part, quoted_identifiers))
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 2 {
        return (!current_database.is_empty()).then(|| current_database.to_string());
    }
    if qualified_first_part_is_database(db_type, parts.len()) {
        return parts.first().cloned();
    }
    (!current_database.is_empty()).then(|| current_database.to_string())
}

fn normalize_target_database_name(value: &str, quoted_identifiers: &HashMap<String, String>) -> String {
    let normalized = normalize_database_name(value);
    quoted_identifiers.get(&normalized).map(|quoted| normalize_database_name(quoted)).unwrap_or(normalized)
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

fn is_ambiguous_production_target_statement(statement: &str, has_resolved_target: bool) -> bool {
    if !crate::query_execution_sql::is_write_sql(statement) {
        return false;
    }
    let Some(first_keyword) = first_keyword(statement) else {
        return true;
    };
    if is_transaction_keyword(&first_keyword) {
        return false;
    }
    GLOBAL_DDL_TARGET_RE.is_match(statement) || !has_resolved_target
}

fn first_keyword(statement: &str) -> Option<String> {
    FIRST_KEYWORD_RE.find(statement).map(|value| value.as_str().to_ascii_lowercase())
}

fn is_transaction_keyword(keyword: &str) -> bool {
    matches!(keyword, "begin" | "start" | "commit" | "rollback" | "abort" | "savepoint" | "release")
}

fn sql_target_safety_text(sql: &str) -> SqlTargetSafetyText {
    let chars: Vec<char> = sql.chars().collect();
    let mut result = SqlTargetSafetyText { text: String::with_capacity(sql.len()), quoted_identifiers: HashMap::new() };
    append_sql_target_safety_text(&chars, &mut result);
    result
}

fn append_sql_target_safety_text(chars: &[char], result: &mut SqlTargetSafetyText) {
    let mut index = 0usize;

    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();

        if ch == '-' && next == Some('-') {
            index += 2;
            while index < chars.len() && chars[index] != '\n' && chars[index] != '\r' {
                index += 1;
            }
            result.text.push(' ');
            continue;
        }
        if ch == '#' {
            index += 1;
            while index < chars.len() && chars[index] != '\n' && chars[index] != '\r' {
                index += 1;
            }
            result.text.push(' ');
            continue;
        }
        if ch == '/' && next == Some('*') {
            if let Some((body, close_index)) = mysql_executable_comment_body(&chars, index) {
                result.text.push(' ');
                let body_chars: Vec<char> = body.chars().collect();
                append_sql_target_safety_text(&body_chars, result);
                result.text.push(' ');
                index = close_index;
            } else {
                index += 2;
                while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                    index += 1;
                }
                index = (index + 2).min(chars.len());
                result.text.push(' ');
            }
            continue;
        }
        if let Some((tag, tag_len)) = dollar_quote_tag_at(&chars, index) {
            index += tag_len;
            while index + tag_len <= chars.len() && !chars[index..index + tag_len].iter().collect::<String>().eq(&tag) {
                index += 1;
            }
            index = (index + tag_len).min(chars.len());
            result.text.push(' ');
            continue;
        }
        if ch == '\'' {
            index = skip_string_literal(&chars, index, '\'', '\'');
            result.text.push(' ');
            continue;
        }
        if ch == '"' || ch == '`' || ch == '[' {
            let close = if ch == '[' { ']' } else { ch };
            index = append_quoted_identifier_token(chars, index, close, result);
            continue;
        }

        result.text.push(ch);
        index += 1;
    }
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

fn append_quoted_identifier_token(
    chars: &[char],
    start: usize,
    close: char,
    result: &mut SqlTargetSafetyText,
) -> usize {
    let mut index = start + 1;
    let mut identifier = String::new();
    while index < chars.len() {
        if chars[index] == close {
            if chars.get(index + 1) == Some(&close) {
                identifier.push(close);
                index += 2;
                continue;
            }
            let token = format!("__dbxq{}__", result.quoted_identifiers.len());
            result.quoted_identifiers.insert(token.to_ascii_lowercase(), identifier);
            result.text.push(' ');
            result.text.push_str(&token);
            result.text.push(' ');
            return index + 1;
        }
        identifier.push(if chars[index] == ';' { ' ' } else { chars[index] });
        index += 1;
    }
    let token = format!("__dbxq{}__", result.quoted_identifiers.len());
    result.quoted_identifiers.insert(token.to_ascii_lowercase(), identifier);
    result.text.push(' ');
    result.text.push_str(&token);
    result.text.push(' ');
    chars.len()
}

#[cfg(test)]
mod tests {
    use super::{
        is_production_database, redis_command_production_database, targets_production_database,
        ProductionWriteAuthorization, ProductionWritePermit, ProductionWritePermitStore,
    };
    use crate::models::connection::{ConnectionConfig, DatabaseType};
    use serde::Deserialize;
    use std::time::{Duration, Instant};

    const DIGEST_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DIGEST_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProductionSafetyCorpusCase {
        name: String,
        dialect: DatabaseType,
        production_databases: Vec<String>,
        active_database: String,
        sql: String,
        active: bool,
    }

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
            init_script: None,
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
    fn legacy_non_sql_database_markers_fail_closed_as_connection_scope() {
        for db_type in [
            DatabaseType::Elasticsearch,
            DatabaseType::Qdrant,
            DatabaseType::Etcd,
            DatabaseType::ZooKeeper,
            DatabaseType::Nacos,
            DatabaseType::MessageQueue,
            DatabaseType::Neo4j,
            DatabaseType::InfluxDb,
        ] {
            let mut connection = config();
            connection.db_type = db_type;
            assert!(is_production_database(&connection, "staging"));
        }
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
    fn matches_shared_sql_target_safety_corpus() {
        let corpus: Vec<ProductionSafetyCorpusCase> =
            serde_json::from_str(include_str!("../../../tests/fixtures/production-safety-corpus.json"))
                .expect("production safety corpus is valid JSON");

        for corpus_case in corpus {
            let mut config = config();
            config.db_type = corpus_case.dialect;
            config.production_databases = corpus_case.production_databases;
            assert_eq!(
                targets_production_database(&config, &corpus_case.active_database, &corpus_case.sql),
                corpus_case.active,
                "{}",
                corpus_case.name
            );
        }
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

    #[tokio::test]
    async fn production_write_tokens_are_random() {
        let permits = ProductionWritePermitStore::default();
        let first = permits.authorize("conn", Some("prod_app"), "redisSetString", DIGEST_A).await.unwrap();
        let second = permits.authorize("conn", Some("prod_app"), "redisSetString", DIGEST_A).await.unwrap();

        assert_ne!(first.token, second.token);
        assert_eq!(uuid::Uuid::parse_str(&first.token).unwrap().get_version_num(), 4);
        assert_eq!(uuid::Uuid::parse_str(&second.token).unwrap().get_version_num(), 4);
    }

    #[tokio::test]
    async fn production_write_permits_reject_mismatched_requests_without_consuming_the_token() {
        let permits = ProductionWritePermitStore::default();
        let authorization = permits.authorize("conn", Some("prod_app"), "redisSetString", DIGEST_A).await.unwrap();

        assert!(!permits.consume(&authorization, "other-conn", Some("prod_app"), "redisSetString").await);
        assert!(!permits.consume(&authorization, "conn", Some("other_prod"), "redisSetString").await);
        assert!(!permits.consume(&authorization, "conn", Some("prod_app"), "redisDeleteKey").await);

        let mut wrong_operation = authorization.clone();
        wrong_operation.operation = "redisDeleteKey".to_string();
        assert!(!permits.consume(&wrong_operation, "conn", Some("prod_app"), "redisSetString").await);

        let mut wrong_digest = authorization.clone();
        wrong_digest.request_digest = DIGEST_B.to_string();
        assert!(!permits.consume(&wrong_digest, "conn", Some("prod_app"), "redisSetString").await);

        assert!(permits.consume(&authorization, "conn", Some("PROD_APP"), "redisSetString").await);
        assert!(!permits.consume(&authorization, "conn", Some("prod_app"), "redisSetString").await);
    }

    #[tokio::test]
    async fn a_single_production_write_token_can_only_be_consumed_once_concurrently() {
        let permits = ProductionWritePermitStore::default();
        let authorization = permits.authorize("conn", Some("prod_app"), "redisSetString", DIGEST_A).await.unwrap();

        let (first, second) = tokio::join!(
            permits.consume(&authorization, "conn", Some("prod_app"), "redisSetString"),
            permits.consume(&authorization, "conn", Some("prod_app"), "redisSetString")
        );

        assert_eq!(usize::from(first) + usize::from(second), 1);
    }

    #[tokio::test]
    async fn concurrent_production_write_same_operation_permits_do_not_consume_each_other() {
        let permits = ProductionWritePermitStore::default();
        let first = permits.authorize("conn", Some("prod_app"), "redisSetString", DIGEST_A).await.unwrap();
        let second = permits.authorize("conn", Some("prod_app"), "redisSetString", DIGEST_B).await.unwrap();

        let (first_consumed, second_consumed) = tokio::join!(
            permits.consume(&first, "conn", Some("prod_app"), "redisSetString"),
            permits.consume(&second, "conn", Some("prod_app"), "redisSetString")
        );

        assert!(first_consumed);
        assert!(second_consumed);
    }

    #[tokio::test]
    async fn expired_production_write_permits_are_rejected() {
        let permits = ProductionWritePermitStore::default();
        let authorization = ProductionWriteAuthorization {
            token: uuid::Uuid::new_v4().to_string(),
            operation: "redisSetString".to_string(),
            request_digest: DIGEST_A.to_string(),
        };
        permits.permits.lock().await.insert(
            authorization.token.clone(),
            ProductionWritePermit {
                connection_id: "conn".to_string(),
                database: "prod_app".to_string(),
                operation: authorization.operation.clone(),
                request_digest: authorization.request_digest.clone(),
                expires_at: Instant::now().checked_sub(Duration::from_secs(1)).expect("instant supports subtraction"),
            },
        );

        assert!(!permits.consume(&authorization, "conn", Some("prod_app"), "redisSetString").await);
    }

    #[test]
    fn resolves_cross_database_redis_write_targets() {
        let mut redis = config();
        redis.db_type = DatabaseType::Redis;
        redis.production_databases = vec!["7".to_string(), "8".to_string()];

        assert_eq!(redis_command_production_database(&redis, 2, "MOVE key 7"), Some("7".to_string()));
        assert_eq!(
            redis_command_production_database(&redis, 2, "COPY source dest DB 8 REPLACE"),
            Some("8".to_string())
        );
        assert_eq!(redis_command_production_database(&redis, 2, "FLUSHALL"), Some("7".to_string()));
        assert_eq!(redis_command_production_database(&redis, 2, "SET key value"), None);
    }
}

fn connection_scoped_non_sql_type(db_type: &DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::Elasticsearch
            | DatabaseType::Qdrant
            | DatabaseType::Milvus
            | DatabaseType::Weaviate
            | DatabaseType::ChromaDb
            | DatabaseType::Etcd
            | DatabaseType::ZooKeeper
            | DatabaseType::Nacos
            | DatabaseType::MessageQueue
            | DatabaseType::Neo4j
            | DatabaseType::InfluxDb
    )
}
