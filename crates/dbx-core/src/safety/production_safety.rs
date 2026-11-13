use crate::models::connection::{ConnectionConfig, DatabaseType};
use regex::Regex;
use sqlparser::ast::{Expr, Function, Select, Statement, TableFactor, Visit, Visitor};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::{Token, Tokenizer};
use std::collections::{HashMap, HashSet};
use std::ops::ControlFlow;
use std::sync::LazyLock;

/// Upper bound on the tokens the PostgreSQL scope proof will hand to the parser.
///
/// The bound exists because the parser and the AST visitor recurse, and this runs on
/// MCP worker stacks. It is deliberately below the measured crash point for an
/// unoptimised 2 MiB stack (roughly 28.5k tokens on a long additive expression,
/// #14586), and pathological nesting is refused separately by
/// `MAX_SCOPE_QUERY_NESTING_DEPTH` before anything is parsed.
const MAX_SCOPE_QUERY_TOKENS: usize = 16_384;

/// Deepest bracket nesting the scope proof attempts. Bracket depth is what a
/// recursive-descent parser turns into stack frames, so bounding it keeps a
/// long-but-flat query provable while still refusing adversarial input whose token
/// count alone stays under the cap.
const MAX_SCOPE_QUERY_NESTING_DEPTH: usize = 128;

/// Function-call syntax supported by PostgreSQL scope recognition. This policy
/// is independent of the manual-transaction read proof.
const POSTGRES_SCOPE_QUERY_FUNCTIONS: &[&str] = &[
    "abs",
    "age",
    "array_agg",
    "array_length",
    "ascii",
    "avg",
    "btrim",
    "cardinality",
    "ceil",
    "ceiling",
    "char_length",
    "character_length",
    "chr",
    "coalesce",
    "concat",
    "concat_ws",
    "count",
    "current_catalog",
    "current_date",
    "current_schema",
    "current_setting",
    "current_time",
    "current_timestamp",
    "current_user",
    "date_part",
    "date_trunc",
    "decode",
    "div",
    "encode",
    "every",
    "exp",
    "floor",
    "format",
    "gen_random_uuid",
    "greatest",
    "left",
    "length",
    "localtime",
    "localtimestamp",
    "log",
    "lower",
    "lpad",
    "ltrim",
    "max",
    "md5",
    "min",
    "mod",
    "now",
    "nullif",
    "position",
    "power",
    "repeat",
    "replace",
    "reverse",
    "right",
    "round",
    "rpad",
    "rtrim",
    "sha224",
    "sha256",
    "sha384",
    "sha512",
    "sign",
    "split_part",
    "sqrt",
    "starts_with",
    "strpos",
    "string_agg",
    "substr",
    "substring",
    "sum",
    "to_char",
    "to_date",
    "to_hex",
    "to_number",
    "to_timestamp",
    "trunc",
    "unnest",
    "upper",
    "version",
];

const IDENTIFIER_PATTERN: &str = r"[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*";
const TARGET_NAME_PATTERN: &str = r"[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*(?:\s*\.\s*(?:\*|[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*)){0,3}";
const QUALIFIED_NAME_PATTERN: &str = r"[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*(?:\s*\.\s*(?:\*|[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*)){1,3}";

static DML_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\s+({TARGET_NAME_PATTERN})"))
        .expect("valid DML target regex")
});
static APPLY_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)\b(?:CROSS|OUTER)\s+APPLY\s+({TARGET_NAME_PATTERN})")).expect("valid APPLY target regex")
});
static APPLY_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\b(?:CROSS|OUTER)\s+APPLY\b").expect("valid APPLY regex"));
static FROM_CLAUSE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\bFROM\s+(.+?)(?:\b(?:WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|FETCH|FOR|UNION|EXCEPT|INTERSECT|JOIN)\b|$)")
        .expect("valid FROM clause regex")
});
static LEADING_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?is)^\s*({TARGET_NAME_PATTERN})(?:\s+(?:AS\s+)?{IDENTIFIER_PATTERN})?\s*$"))
        .expect("valid leading target regex")
});
static DDL_OBJECT_TARGET_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?is)\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|TRIGGER|EVENT|TYPE|SYNONYM|PACKAGE(?:\s+BODY)?)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?({TARGET_NAME_PATTERN})"
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
        || (!database.trim().is_empty()
            && config
                .production_databases
                .iter()
                .any(|name| normalize_database_name(name) == normalize_database_name(database)))
}

/// Returns whether a MongoDB aggregation write stage targets production scope.
/// `$out` and `$merge` can name a database different from the pipeline's source
/// database, so checking only the selected database is insufficient.
pub fn mongo_pipeline_targets_production_database(
    config: &ConnectionConfig,
    active_database: &str,
    pipeline_json: &str,
) -> bool {
    if is_production_database(config, active_database) {
        return true;
    }

    let Ok(serde_json::Value::Array(stages)) = serde_json::from_str::<serde_json::Value>(pipeline_json) else {
        return true;
    };
    let mut has_write_stage = false;
    let mut uncertain = false;
    let mut targets = HashSet::new();

    for stage in stages {
        let Some(document) = stage.as_object() else {
            continue;
        };
        if let Some(target) = document.get("$out") {
            has_write_stage = true;
            match target {
                serde_json::Value::String(_) => {
                    add_mongo_current_database(&mut targets, &mut uncertain, active_database)
                }
                serde_json::Value::Object(target) => match target.get("db").and_then(serde_json::Value::as_str) {
                    Some(database) if !database.trim().is_empty() => {
                        targets.insert(database.to_string());
                    }
                    _ => uncertain = true,
                },
                _ => uncertain = true,
            }
        }
        if let Some(target) = document.get("$merge") {
            has_write_stage = true;
            match target {
                serde_json::Value::String(_) => {
                    add_mongo_current_database(&mut targets, &mut uncertain, active_database)
                }
                serde_json::Value::Object(target) => match target.get("into") {
                    Some(serde_json::Value::String(_)) => {
                        add_mongo_current_database(&mut targets, &mut uncertain, active_database)
                    }
                    Some(serde_json::Value::Object(into)) => match into.get("db").and_then(serde_json::Value::as_str) {
                        Some(database) if !database.trim().is_empty() => {
                            targets.insert(database.to_string());
                        }
                        _ => uncertain = true,
                    },
                    _ => uncertain = true,
                },
                _ => uncertain = true,
            }
        }
    }

    has_write_stage && (uncertain || targets.iter().any(|database| is_production_database(config, database)))
}

fn add_mongo_current_database(targets: &mut HashSet<String>, uncertain: &mut bool, active_database: &str) {
    if active_database.trim().is_empty() {
        *uncertain = true;
    } else {
        targets.insert(active_database.to_string());
    }
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

    let assessment = referenced_databases(sql, &config.db_type, active_database, false, false);
    assessment.databases.into_iter().any(|database| marked.contains(&database)) || assessment.uncertain
}

/// Returns whether a statement references a database outside an MCP database
/// allowlist. Unlike production protection this examines read queries too:
/// `SELECT * FROM other_db.users` must not bypass a scope that was selected via
/// the request's `database` argument.
///
/// The caller is responsible for checking the active database itself. This
/// helper only adds protection for object references qualified in SQL.
pub fn sql_references_disallowed_database(
    sql: &str,
    db_type: &DatabaseType,
    active_database: &str,
    allowed_databases: &[String],
) -> bool {
    sql_database_scope_is_disallowed(sql, db_type, active_database, allowed_databases, false)
}

/// Uses the connection profile to recognize PostgreSQL query blocks. Compatible
/// engines with different database qualifiers keep the original scope scan.
pub fn sql_references_disallowed_database_for_connection(
    sql: &str,
    connection: &ConnectionConfig,
    active_database: &str,
    allowed_databases: &[String],
) -> bool {
    let static_postgres_query = matches!(connection.db_type, DatabaseType::Postgres)
        && connection
            .driver_profile
            .as_deref()
            .is_none_or(|profile| profile.is_empty() || profile.eq_ignore_ascii_case("postgres"))
        && has_static_postgres_query_structure(sql);
    sql_database_scope_is_disallowed(
        sql,
        &connection.db_type,
        active_database,
        allowed_databases,
        static_postgres_query,
    )
}

fn sql_database_scope_is_disallowed(
    sql: &str,
    db_type: &DatabaseType,
    active_database: &str,
    allowed_databases: &[String],
    static_postgres_query: bool,
) -> bool {
    let allowed = allowed_databases
        .iter()
        .map(|database| normalize_database_name(database))
        .filter(|database| !database.is_empty())
        .collect::<HashSet<_>>();
    let assessment = referenced_databases(sql, db_type, active_database, true, static_postgres_query);
    assessment.uncertain || assessment.databases.into_iter().any(|database| !allowed.contains(&database))
}

fn normalize_database_name(value: &str) -> String {
    value.trim().trim_matches(|ch| matches!(ch, '`' | '"' | '[' | ']')).to_ascii_lowercase()
}

fn referenced_databases(
    sql: &str,
    db_type: &DatabaseType,
    active_database: &str,
    include_read_references: bool,
    static_postgres_query: bool,
) -> ReferencedDatabaseAssessment {
    let mut assessment = ReferencedDatabaseAssessment::default();
    let cleaned = sql_target_safety_text(sql, db_type);
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
            assessment.databases.insert(use_database.clone());
            continue;
        }

        if !statement_is_mutation && !include_read_references {
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
                &APPLY_TARGET_RE,
                &DDL_OBJECT_TARGET_RE,
                &INDEX_ON_TARGET_RE,
                &TRUNCATE_TARGET_RE,
                &MAINTENANCE_TABLE_TARGET_RE,
                &COMMENT_TARGET_RE,
                &ROUTINE_CALL_TARGET_RE,
                &PRIVILEGE_TARGET_RE,
            ],
        );
        if include_read_references
            && !static_postgres_query
            && collect_comma_separated_from_databases(
                statement,
                db_type,
                &cleaned.quoted_identifiers,
                current_database,
                &mut statement_databases,
            )
        {
            assessment.uncertain = true;
        }
        if include_read_references
            && APPLY_RE.find_iter(statement).count() != APPLY_TARGET_RE.captures_iter(statement).count()
        {
            assessment.uncertain = true;
        }
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

/// Recognizes PostgreSQL query blocks without changing database-name resolution.
/// Unsupported statements, call syntax and FROM factors keep the existing scan.
fn has_static_postgres_query_structure(sql: &str) -> bool {
    let dialect = PostgreSqlDialect {};
    let Ok(tokens) = Tokenizer::new(&dialect, sql).with_unescape(false).tokenize() else {
        return false;
    };
    // Bound AST traversal and drop on worker stacks; larger queries keep the
    // original scan even when parsing itself would not exceed its depth limit.
    if tokens.iter().filter(|token| !matches!(token, Token::Whitespace(_))).count() > MAX_SCOPE_QUERY_TOKENS {
        return false;
    }
    if bracket_nesting_exceeds(&tokens, MAX_SCOPE_QUERY_NESTING_DEPTH) {
        return false;
    }
    // Ordinary backslash strings depend on standard_conforming_strings, which
    // is not available here. E strings and dollar quotes have explicit semantics.
    if tokens.iter().any(|token| {
        matches!(token, Token::SingleQuotedString(value) | Token::NationalStringLiteral(value) if value.contains('\\'))
    }) {
        return false;
    }
    let Ok(statements) = Parser::new(&dialect).with_tokens(tokens).parse_statements() else {
        return false;
    };
    !statements.is_empty() && matches!(statements.visit(&mut StaticPostgresQuery), ControlFlow::Continue(()))
}

/// Whether bracket nesting goes deeper than `limit`.
///
/// Only `(` counts: it is the only token that makes the parser and the visitor
/// recurse without bound. Brackets and braces appear in fixed-shape syntax.
fn bracket_nesting_exceeds(tokens: &[Token], limit: usize) -> bool {
    let mut depth = 0usize;
    for token in tokens {
        match token {
            Token::LParen => {
                depth += 1;
                if depth > limit {
                    return true;
                }
            }
            Token::RParen => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    false
}

/// Matches supported scope-call syntax, without resolving runtime function identity.
fn is_supported_postgres_scope_call(function: &Function) -> bool {
    if function.over.is_some() {
        return false;
    }
    let [part] = function.name.0.as_slice() else {
        return false;
    };
    let Some(ident) = part.as_ident() else {
        return false;
    };
    POSTGRES_SCOPE_QUERY_FUNCTIONS.iter().any(|name| {
        if ident.quote_style.is_some() {
            ident.value == *name
        } else {
            ident.value.eq_ignore_ascii_case(name)
        }
    })
}

/// Limits relaxation to static relations, supported calls and queries without DML or INTO.
struct StaticPostgresQuery;

impl Visitor for StaticPostgresQuery {
    type Break = ();

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<Self::Break> {
        // This callback also receives data-modifying statements inside CTEs.
        match statement {
            Statement::Query(_) => ControlFlow::Continue(()),
            _ => ControlFlow::Break(()),
        }
    }

    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<Self::Break> {
        if select.into.is_some() {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    }

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<Self::Break> {
        match expr {
            Expr::Function(function) if !is_supported_postgres_scope_call(function) => ControlFlow::Break(()),
            _ => ControlFlow::Continue(()),
        }
    }

    fn pre_visit_table_factor(&mut self, table: &TableFactor) -> ControlFlow<Self::Break> {
        match table {
            TableFactor::Table { args: None, .. } | TableFactor::Derived { .. } | TableFactor::NestedJoin { .. } => {
                ControlFlow::Continue(())
            }
            _ => ControlFlow::Break(()),
        }
    }
}

/// Collects every table factor in a comma-separated FROM list. Table aliases
/// are accepted, while derived tables and other forms this lightweight parser
/// cannot safely resolve are reported to the caller as uncertain.
fn collect_comma_separated_from_databases(
    statement: &str,
    db_type: &DatabaseType,
    quoted_identifiers: &HashMap<String, String>,
    current_database: &str,
    databases: &mut HashSet<String>,
) -> bool {
    let mut uncertain = false;
    for capture in FROM_CLAUSE_RE.captures_iter(statement) {
        let Some(from_body) = capture.get(1).map(|value| value.as_str()) else {
            continue;
        };
        let factors = split_top_level_comma_separated_targets(from_body);
        if factors.len() < 2 {
            continue;
        }
        for factor in factors {
            let Some(target) = LEADING_TARGET_RE.captures(factor).and_then(|target| target.get(1)).and_then(|target| {
                database_from_qualified_name(target.as_str(), db_type, quoted_identifiers, current_database)
            }) else {
                uncertain = true;
                continue;
            };
            databases.insert(target);
        }
    }
    uncertain
}

fn split_top_level_comma_separated_targets(value: &str) -> Vec<&str> {
    let mut targets = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (index, ch) in value.char_indices() {
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                targets.push(value[start..index].trim());
                start = index + ch.len_utf8();
            }
            _ => {}
        }
    }
    targets.push(value[start..].trim());
    targets
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
    // SQL Server accepts four-part names as `server.database.schema.object`.
    // The database scope must use the second component in that form, otherwise
    // a linked-server name that matches an allowed database could bypass it.
    if matches!(db_type, DatabaseType::SqlServer) && parts.len() >= 4 {
        return parts.get(1).cloned();
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
            | DatabaseType::Uxdb
            | DatabaseType::Vastbase
            | DatabaseType::Gbase8c
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
            | DatabaseType::Gbase8s
            | DatabaseType::SapHana
            | DatabaseType::SqlServer
            | DatabaseType::Snowflake
            | DatabaseType::Trino
            | DatabaseType::PrestoSql
            | DatabaseType::Databricks
            | DatabaseType::Bigquery
            // A Spanner JDBC connection is bound to a single database, so there is no
            // cross-database `db.table` syntax — the first part of `a.b` is always a schema.
            | DatabaseType::Spanner
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
    matches!(keyword, "begin" | "start" | "commit" | "rollback" | "abort" | "savepoint" | "release" | "end" | "declare")
}

fn sql_target_safety_text(sql: &str, db_type: &DatabaseType) -> SqlTargetSafetyText {
    let chars: Vec<char> = sql.chars().collect();
    let mut result = SqlTargetSafetyText { text: String::with_capacity(sql.len()), quoted_identifiers: HashMap::new() };
    append_sql_target_safety_text(&chars, SqlScanLexerRules::for_database_type(db_type), &mut result);
    result
}

/// Lexer rules this scan reads. Everything the scan removes is text no target can
/// be found in, so claiming a feature the connection does not have hides writes
/// from the production gate: `SELECT * FROM #tmp; DELETE FROM prod_db.dbo.users;`
/// and `SELECT 'dir\'; DELETE FROM prod_db.dbo.users;` on SQL Server both lose the
/// `DELETE` when `#` and backslashes are read as MySQL constructs. Only features
/// the engine really has are assumed here, which can only make the gate stricter.
#[derive(Clone, Copy)]
struct SqlScanLexerRules {
    /// `#` starts a line comment: a MySQL family feature. On SQL Server `#tmp` is
    /// a temporary table, so the rest of the line is still SQL.
    hash_line_comments: bool,
    /// A backslash escapes the next character inside an ordinary `'...'` string.
    backslash_escaped_quotes: bool,
    /// `E'...'` literals escape with a backslash (PostgreSQL family).
    postgres_escape_strings: bool,
    /// `q'...'` / `nq'...'` alternative-quoted literals (Oracle family).
    oracle_alternative_quotes: bool,
}

impl SqlScanLexerRules {
    fn for_database_type(db_type: &DatabaseType) -> Self {
        let mysql_family = matches!(
            db_type,
            DatabaseType::Mysql
                | DatabaseType::Doris
                | DatabaseType::StarRocks
                | DatabaseType::ManticoreSearch
                | DatabaseType::Goldendb
        );
        let postgres_family = matches!(
            db_type,
            DatabaseType::Postgres
                | DatabaseType::OpenGauss
                | DatabaseType::Gaussdb
                | DatabaseType::Vastbase
                | DatabaseType::Kingbase
                | DatabaseType::Highgo
                | DatabaseType::Uxdb
                | DatabaseType::Gbase8c
                | DatabaseType::Kwdb
        );
        let oracle_family = matches!(db_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle);
        Self {
            hash_line_comments: mysql_family,
            // Only claim the escape where the engine has it: MySQL, and
            // PostgreSQL inside `E'...'`. Everywhere else a literal backslash can
            // only make this scan see more text, which asks for confirmation
            // sooner instead of hiding a write. (`ClickHouse` and Hive do escape,
            // so they may ask once too often — the safe direction here.)
            backslash_escaped_quotes: mysql_family,
            postgres_escape_strings: postgres_family,
            oracle_alternative_quotes: oracle_family,
        }
    }
}

/// True when `prefix` ends with a PostgreSQL `E'`/`e'` introducer that starts its
/// own token, so `DATE'2020-01-01'` and `x$e'...'` are ordinary strings.
fn ends_with_escape_string_prefix(prefix: &[char]) -> bool {
    let mut chars = prefix.iter().rev();
    if !matches!(chars.next(), Some('E' | 'e')) {
        return false;
    }
    !chars.next().is_some_and(|ch| ch.is_alphanumeric() || *ch == '_' || *ch == '$')
}

/// Oracle alternative quoting: `q'...'` / `nq'...'` literals delimited by
/// `[`/`]`, `{`/`}`, `(`/`)`, `<`/`>` or a self-delimiting character, where the
/// quote character may appear inside the literal unchanged. The literal ends at
/// the first `closer + '` — Oracle has no escape or nesting inside these
/// literals. Mirrors `readOracleAlternativeQuoteEnd` in
/// `apps/desktop/src/lib/sql/sqlRisk.ts`.
fn read_oracle_alternative_quote_end(chars: &[char], index: usize) -> Option<usize> {
    let mut quote_index = index;
    match chars.get(index)? {
        'n' | 'N' => {
            if !matches!(chars.get(index + 1), Some('q' | 'Q')) {
                return None;
            }
            quote_index += 1;
        }
        'q' | 'Q' => {}
        _ => return None,
    }
    if chars.get(quote_index + 1) != Some(&'\'') {
        return None;
    }
    // The introducer must start its own token, so `aq'...'` and `q '...'` stay
    // ordinary strings. Oracle identifiers may contain `$` and `#`.
    if chars[..index].last().is_some_and(|ch| ch.is_alphanumeric() || *ch == '_' || *ch == '$' || *ch == '#') {
        return None;
    }
    let opener = *chars.get(quote_index + 2)?;
    if opener.is_whitespace() {
        return None;
    }
    let closer = match opener {
        '[' => ']',
        '{' => '}',
        '(' => ')',
        '<' => '>',
        other => other,
    };
    let mut scan = quote_index + 3;
    while scan + 1 < chars.len() {
        if chars[scan] == closer && chars[scan + 1] == '\'' {
            return Some(scan + 2);
        }
        scan += 1;
    }
    Some(chars.len())
}

fn append_sql_target_safety_text(chars: &[char], rules: SqlScanLexerRules, result: &mut SqlTargetSafetyText) {
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
        if ch == '#' && rules.hash_line_comments {
            index += 1;
            while index < chars.len() && chars[index] != '\n' && chars[index] != '\r' {
                index += 1;
            }
            result.text.push(' ');
            continue;
        }
        if ch == '/' && next == Some('*') {
            if let Some((body, close_index)) = mysql_executable_comment_body(chars, index) {
                result.text.push(' ');
                let body_chars: Vec<char> = body.chars().collect();
                append_sql_target_safety_text(&body_chars, rules, result);
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
        if let Some((tag, tag_len)) = dollar_quote_tag_at(chars, index) {
            index += tag_len;
            while index + tag_len <= chars.len() && !chars[index..index + tag_len].iter().collect::<String>().eq(&tag) {
                index += 1;
            }
            index = (index + tag_len).min(chars.len());
            result.text.push(' ');
            continue;
        }
        if rules.oracle_alternative_quotes && matches!(ch, 'q' | 'Q' | 'n' | 'N') {
            if let Some(end) = read_oracle_alternative_quote_end(chars, index) {
                index = end;
                result.text.push(' ');
                continue;
            }
        }
        if ch == '\'' {
            index = skip_string_literal(chars, index, '\'', '\'', rules);
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

fn skip_string_literal(chars: &[char], start: usize, open: char, close: char, rules: SqlScanLexerRules) -> usize {
    let backslash_escapes = matches!(open, '\'' | '"')
        && (rules.backslash_escaped_quotes
            || (rules.postgres_escape_strings && open == '\'' && ends_with_escape_string_prefix(&chars[..start])));
    let mut index = start + 1;
    while index < chars.len() {
        if backslash_escapes && chars[index] == '\\' {
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
        is_production_database, mongo_pipeline_targets_production_database, sql_references_disallowed_database,
        sql_target_safety_text, targets_production_database,
    };
    use crate::models::connection::{ConnectionConfig, DatabaseType};
    use serde::Deserialize;

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
            oracle_oci_nls_lang: None,
            oracle_oci_tns_admin: None,
            docs_notes_path: None,
            id: "conn".to_string(),
            name: "test".to_string(),
            note: String::new(),
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
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            sidebar_auto_load_all_tables: false,
            show_database_links: None,
            show_native_jobs: None,
            show_user_admin: None,
            attached_databases: vec![],
            init_script: None,
            color: None,
            transport_layers: vec![],
            connect_timeout_secs: 10,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            manual_transaction_timeout_secs: 300,
            idle_disconnect_secs: 0,
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
            redis_database_aliases: Default::default(),
            redis_key_templates: Vec::new(),
            redis_key_filter: None,
            redis_key_grouping: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            plugin_id: None,
            plugin_connection_provider: None,
            plugin_connection_type: None,
            connection_secrets: Default::default(),
            one_time: false,
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec!["prod_app".to_string()],
            production_badge_scope: None,
            database_info: None,
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
        assert!(targets_production_database(&config(), "staging", "USE prod_app"));
    }

    #[test]
    fn reads_sqlserver_temp_tables_as_sql_instead_of_a_comment() {
        let config = ConnectionConfig { db_type: DatabaseType::SqlServer, ..config() };

        assert!(targets_production_database(&config, "staging", "SELECT * FROM #tmp; DELETE FROM prod_app.dbo.users;"));
    }

    #[test]
    fn reads_sqlserver_backslash_strings_as_literal_data() {
        let config = ConnectionConfig { db_type: DatabaseType::SqlServer, ..config() };

        // T-SQL escapes a quote by doubling it, so `'dir\'` ends at the second quote
        // and the DELETE behind it still targets production.
        assert!(targets_production_database(&config, "staging", r#"SELECT 'dir\'; DELETE FROM prod_app.dbo.users;"#));
    }

    #[test]
    fn keeps_mysql_hash_comments_and_backslash_escapes() {
        let mysql = config();

        assert!(!targets_production_database(&mysql, "staging", "SELECT 1; # DELETE FROM prod_app.users"));
        assert!(!targets_production_database(&mysql, "staging", r#"SELECT 'it\'s; DELETE FROM prod_app.users;'"#));
    }

    #[test]
    fn scans_postgres_strings_by_the_dialect_lexer_rules() {
        let plain = sql_target_safety_text(r#"SELECT 'dir\'; DELETE FROM users;"#, &DatabaseType::Postgres);
        assert!(plain.text.contains("DELETE FROM users"), "{}", plain.text);

        let escape_string = sql_target_safety_text(r#"SELECT E'it\'s; DELETE FROM users;'"#, &DatabaseType::Postgres);
        assert!(!escape_string.text.contains("DELETE FROM users"), "{}", escape_string.text);
    }

    #[test]
    fn scans_oracle_alternative_quoted_strings_by_the_dialect_lexer_rules() {
        for literal in ["q'[O'Reilly]'", "nq'{O'Reilly}'", "Q'<O'Reilly>'", "q'!O'Reilly!'"] {
            let sql = format!("SELECT {literal} FROM dual; DELETE FROM users;");
            // The quote inside q'...' is literal, so the DELETE after the
            // literal is real code and must stay visible to the gate.
            let scanned = sql_target_safety_text(&sql, &DatabaseType::Oracle);
            assert!(scanned.text.contains("DELETE FROM users"), "{literal}: {}", scanned.text);
            let scanned = sql_target_safety_text(&sql, &DatabaseType::OceanbaseOracle);
            assert!(scanned.text.contains("DELETE FROM users"), "{literal}: {}", scanned.text);
        }

        // SQL-looking text inside the literal stays literal data.
        let inside =
            sql_target_safety_text(r#"SELECT q'[it's; DELETE FROM users;]' FROM dual;"#, &DatabaseType::Oracle);
        assert!(!inside.text.contains("DELETE FROM users"), "{}", inside.text);
    }

    #[test]
    fn keeps_alternative_quoting_specific_to_the_oracle_family() {
        // Oracle reads the whole `q'[O' AS label FROM dual;` as an unterminated
        // alternative-quoted literal; PostgreSQL has no `q'...'` introducer.
        let oracle = sql_target_safety_text("SELECT q'[O' AS label FROM dual;", &DatabaseType::Oracle);
        assert!(!oracle.text.contains("AS label"), "{}", oracle.text);
        let postgres = sql_target_safety_text("SELECT q'[O' AS label FROM dual;", &DatabaseType::Postgres);
        assert!(postgres.text.contains("AS label"), "{}", postgres.text);
    }

    #[test]
    fn keeps_an_identifier_character_before_q_out_of_the_alternative_quote_rules() {
        // `aq` is one identifier, so the following literal is ordinary.
        let scanned = sql_target_safety_text(r#"SELECT aq'[x]' FROM dual; DELETE FROM users;"#, &DatabaseType::Oracle);
        assert!(scanned.text.contains("DELETE FROM users"), "{}", scanned.text);
    }

    #[test]
    fn detects_cross_database_references_for_mcp_database_scope() {
        let allowed = vec!["reporting".to_string()];
        let mysql = DatabaseType::Mysql;
        assert!(!sql_references_disallowed_database(
            "SELECT * FROM reporting.users JOIN reporting.audit_log ON 1 = 1",
            &mysql,
            "reporting",
            &allowed,
        ));
        assert!(sql_references_disallowed_database("SELECT * FROM production.users", &mysql, "reporting", &allowed,));
        assert!(sql_references_disallowed_database(
            "INSERT INTO reporting.audit_log SELECT * FROM production.users",
            &mysql,
            "reporting",
            &allowed,
        ));
        assert!(!sql_references_disallowed_database(
            "SELECT * FROM reporting.users AS users, reporting.audit_log AS audit_log",
            &mysql,
            "reporting",
            &allowed,
        ));
        assert!(sql_references_disallowed_database(
            "SELECT * FROM reporting.users, production.secrets",
            &mysql,
            "reporting",
            &allowed,
        ));
        assert!(sql_references_disallowed_database(
            "SELECT * FROM (SELECT * FROM reporting.users) AS users, reporting.audit_log AS audit_log",
            &mysql,
            "reporting",
            &allowed,
        ));

        let sqlserver = DatabaseType::SqlServer;
        assert!(sql_references_disallowed_database(
            "SELECT * FROM production.dbo.users",
            &sqlserver,
            "reporting",
            &allowed,
        ));
        assert!(sql_references_disallowed_database(
            "SELECT * FROM reporting.production.dbo.users",
            &sqlserver,
            "reporting",
            &allowed,
        ));
        assert!(!sql_references_disallowed_database(
            "SELECT * FROM reporting.dbo.users AS users CROSS APPLY reporting.dbo.visible_data(users.id) AS data",
            &sqlserver,
            "reporting",
            &allowed,
        ));
        assert!(sql_references_disallowed_database(
            "SELECT * FROM reporting.dbo.users AS users OUTER APPLY production.dbo.sensitive_data(users.id) AS data",
            &sqlserver,
            "reporting",
            &allowed,
        ));
        assert!(sql_references_disallowed_database(
            "SELECT * FROM reporting.dbo.users AS users CROSS APPLY (SELECT users.id) AS data",
            &sqlserver,
            "reporting",
            &allowed,
        ));
        assert!(!sql_references_disallowed_database("SELECT * FROM dbo.users", &sqlserver, "reporting", &allowed,));
    }

    /// Exercises connection-aware scope checks with the existing connection fixture.
    fn connection_scope_rejects(sql: &str, db_type: &DatabaseType, active: &str, allowed: &[String]) -> bool {
        let mut connection = config();
        connection.db_type = *db_type;
        super::sql_references_disallowed_database_for_connection(sql, &connection, active, allowed)
    }

    #[test]
    fn postgres_query_blocks_require_a_postgres_connection_profile() {
        // Compatible engines may resolve database qualifiers differently even
        // when they share DatabaseType::Postgres.
        let mut connection = config();
        connection.db_type = DatabaseType::Postgres;
        let allowed = vec!["reporting".to_string()];
        let cte = "WITH c AS (SELECT id FROM public.users) SELECT id, 2 FROM c";
        for profile in [None, Some(""), Some("postgres"), Some("POSTGRES")] {
            connection.driver_profile = profile.map(str::to_string);
            assert!(
                !super::sql_references_disallowed_database_for_connection(cte, &connection, "reporting", &allowed,)
            );
        }
        for profile in ["cockroachdb", "unknown-profile"] {
            connection.driver_profile = Some(profile.to_string());
            for sql in [
                cte,
                "WITH c AS (SELECT id FROM reporting.users) SELECT c.id, 2 FROM c, production.secrets s",
                "WITH c AS (SELECT id FROM reporting.public.users) SELECT c.id, 2 FROM c, production.public.secrets s",
            ] {
                assert!(
                    super::sql_references_disallowed_database_for_connection(sql, &connection, "reporting", &allowed,),
                    "compatible profile changed scope behavior ({profile}): {sql}"
                );
            }
        }
        assert!(sql_references_disallowed_database(cte, &DatabaseType::Postgres, "reporting", &allowed));
    }

    #[test]
    fn postgres_query_block_boundaries_do_not_trip_mcp_database_scope() {
        // A CTE's FROM must stop at its closing parenthesis so commas in the
        // outer SELECT list are not treated as additional table factors.
        let allowed = vec!["reporting".to_string()];
        for sql in [
            "WITH c AS (VALUES (1)), compared AS (SELECT * FROM c) SELECT 1, 2 FROM compared;",
            "WITH c(x) AS (VALUES (1), (2)), compared AS (SELECT x FROM c)
             SELECT COUNT(*) AS n, SUM(x) AS total FROM compared;",
            r#"WITH samples(state_code, event_code, checked_on, expected_result) AS (
                VALUES
                    (NULL::varchar, NULL::varchar, NULL::date, 'R0'::varchar),
                    (NULL::varchar, NULL::varchar, DATE '2020-01-02', 'R1'::varchar),
                    ('new'::varchar, 'requested'::varchar, NULL::date, 'R2'::varchar),
                    ('other'::varchar, 'responded'::varchar, NULL::date, 'R3'::varchar),
                    ('final_a'::varchar, 'requested'::varchar, NULL::date, 'R6'::varchar)
            ),
            compared AS (
                SELECT s.*,
                    CASE
                        WHEN s.state_code = CAST('final_a' AS varchar) THEN CAST('R6' AS varchar)
                        WHEN s.state_code = CAST('final_b' AS varchar) THEN CAST('R5' AS varchar)
                        WHEN s.state_code = CAST('intermediate' AS varchar) THEN CAST('R4' AS varchar)
                        WHEN s.event_code = CAST('responded' AS varchar) THEN CAST('R3' AS varchar)
                        WHEN s.event_code = CAST('requested' AS varchar) THEN CAST('R2' AS varchar)
                        WHEN s.checked_on::date BETWEEN DATE '2020-01-02' AND DATE '2020-01-05'
                            THEN CAST('R1' AS varchar)
                        ELSE CAST('R0' AS varchar)
                    END AS actual_result,
                    CASE
                        WHEN s.state_code = 'final_a' THEN 'R6'
                        WHEN s.state_code = 'final_b' THEN 'R5'
                        WHEN s.state_code = 'intermediate' THEN 'R4'
                        WHEN (s.state_code IS NULL OR s.state_code = 'new')
                            AND s.event_code = 'responded' THEN 'R3'
                        WHEN (s.state_code IS NULL OR s.state_code = 'new')
                            AND s.event_code = 'requested' THEN 'R2'
                        WHEN s.checked_on::date BETWEEN DATE '2020-01-02' AND DATE '2020-01-05'
                            THEN 'R1'
                        ELSE 'R0'
                    END AS previous_result
                FROM samples s
            )
            SELECT COUNT(1) AS sample_count,
                SUM(CASE WHEN actual_result IS DISTINCT FROM expected_result
                    THEN 1 ELSE 0 END) AS rule_mismatches,
                SUM(CASE WHEN actual_result IS DISTINCT FROM previous_result
                    THEN 1 ELSE 0 END) AS changed_count,
                SUM(CASE WHEN actual_result IS DISTINCT FROM previous_result
                    AND NOT (state_code = 'other' AND event_code IN ('requested', 'responded'))
                    THEN 1 ELSE 0 END) AS unexpected_changes
            FROM compared;"#,
            "WITH c AS (VALUES (1)), compared AS (SELECT * FROM c) SELECT 1 FROM compared;",
            "WITH c AS (VALUES (1)), compared AS (SELECT * FROM c WHERE TRUE) SELECT 1, 2 FROM compared;",
            "WITH c AS (VALUES (1)), compared AS (SELECT * FROM c LIMIT 1) SELECT 1, 2 FROM compared;",
            "WITH c AS (VALUES (1)), compared AS (SELECT * FROM c) SELECT 1, 2 FROM compared WHERE TRUE;",
            "SELECT (SELECT COUNT(*) FROM public.users) AS n, 2 FROM public.audit_log;",
        ] {
            assert!(
                !connection_scope_rejects(sql, &DatabaseType::Postgres, "reporting", &allowed),
                "query block boundaries must not be treated as FROM targets: {sql}"
            );
        }
    }

    #[test]
    fn long_read_only_postgres_queries_keep_the_static_scope_proof() {
        // #14586: the token bound only exists to keep the parser off a blown stack, so
        // it must sit far above ordinary long reports. A read-only CTE with thousands
        // of tokens used to fall back to the comma-FROM scan and be denied as
        // DATABASE_OUT_OF_SCOPE even though every reference was inside the allowlist.
        let allowed = vec!["reporting".to_string()];
        let mut sql = String::from("WITH c AS (SELECT id FROM reporting.users) SELECT c.id");
        for _ in 0..1200 {
            sql.push_str(" + 1");
        }
        sql.push_str(" AS total FROM c");
        assert!(
            sql.split_whitespace().count() > 2048,
            "the regression needs more tokens than the old bound: {}",
            sql.split_whitespace().count()
        );
        assert!(
            !connection_scope_rejects(&sql, &DatabaseType::Postgres, "reporting", &allowed),
            "a long read-only query must keep the static scope proof"
        );
    }

    #[test]
    fn deep_bracket_nesting_is_refused_before_parsing() {
        // The token bound alone cannot bound recursion: a short query can nest far
        // deeper than a long flat one, so depth is refused separately.
        let nested = |depth: usize| format!("SELECT {}1{}", "(".repeat(depth), ")".repeat(depth));
        let tokenize = |sql: &str| {
            sqlparser::tokenizer::Tokenizer::new(&sqlparser::dialect::PostgreSqlDialect {}, sql)
                .with_unescape(false)
                .tokenize()
                .expect("valid tokens")
        };
        let limit = super::MAX_SCOPE_QUERY_NESTING_DEPTH;
        assert!(!super::bracket_nesting_exceeds(&tokenize(&nested(limit)), limit));
        assert!(super::bracket_nesting_exceeds(&tokenize(&nested(limit + 2)), limit));
        // A long, flat query adds tokens but no depth.
        assert!(!super::bracket_nesting_exceeds(&tokenize(&format!("SELECT {}1", "1 + ".repeat(3000))), limit));

        // And the refusal is fail-closed: the query loses the static proof and the
        // comma-FROM scan sees the disallowed database again.
        let allowed = vec!["reporting".to_string()];
        let deep = format!(
            "WITH c AS (SELECT id FROM reporting.users) SELECT {}c.id{} FROM c, production.secrets s",
            "(".repeat(limit + 2),
            ")".repeat(limit + 2)
        );
        assert!(
            connection_scope_rejects(&deep, &DatabaseType::Postgres, "reporting", &allowed),
            "a pathologically nested query must not be relaxed"
        );
    }

    #[test]
    fn postgres_query_structure_preserves_scope_and_literal_semantics() {
        // Schema names, quoted identifiers and unused allowlist entries do not
        // change whether an otherwise static PostgreSQL query can be resolved.
        for sql in [
            "WITH c AS (SELECT id FROM public.users) SELECT id, 2 FROM c",
            "WITH c AS (TABLE public.users) SELECT id, 2 FROM c",
            "SELECT d.id, 2 FROM (SELECT id FROM public.users) d, public.audit_log a",
            "SELECT (SELECT COUNT(*) FROM public.users) AS n, 2 FROM public.audit_log",
            r#"WITH c AS (SELECT id FROM public."users.with.dots]") SELECT id, 2 FROM c"#,
            r#"WITH c AS (SELECT id FROM public."users\history") SELECT id, 2 FROM c"#,
            "WITH c AS (SELECT id FROM public.users) SELECT id, '/*!' FROM c",
            r"WITH c AS (SELECT id FROM public.users) SELECT id, E'it\'s' FROM c",
            r"WITH c AS (SELECT id FROM public.users) SELECT id, $$\$$ FROM c",
        ] {
            for database in ["reporting", "reporting]"] {
                for allowed in [vec![database.to_string()], vec![database.to_string(), "archive]".to_string()]] {
                    assert!(
                        !connection_scope_rejects(sql, &DatabaseType::Postgres, database, &allowed),
                        "static PostgreSQL query rejected: {sql}"
                    );
                }
            }
        }
        assert!(connection_scope_rejects(
            "SELECT id FROM public.users",
            &DatabaseType::Postgres,
            "reporting",
            &["other".to_string()],
        ));
    }

    #[test]
    fn postgres_non_static_queries_keep_the_existing_scope_scan() {
        // Function sources, session-dependent literals and writes remain on the
        // original path; no function-name exceptions weaken this boundary.
        for sql in [
            "WITH c AS (SELECT * FROM generate_series(1, 2) AS n) SELECT n, 2 FROM c",
            r#"WITH c AS (SELECT * FROM jsonb_each('{"a":1}'::jsonb)) SELECT key, value FROM c"#,
            "WITH c AS (SELECT * FROM regexp_split_to_table('a,b', ',') AS value) SELECT value, 2 FROM c",
            "WITH c AS (SELECT * FROM dblink('dbname=other', 'SELECT 1') AS t(id int)) SELECT id, 2 FROM c",
            r"WITH c AS (SELECT id FROM public.users) SELECT id, '\' FROM c",
            r"WITH c AS (SELECT id FROM public.users) SELECT id, N'\' FROM c",
            r"WITH c AS (SELECT id FROM public.users) SELECT 1, '\' -- '; DELETE FROM public.secret; -- ' FROM c",
            "WITH c AS (DELETE FROM public.users RETURNING id) SELECT id, 2 FROM c",
            "WITH seed AS (SELECT id FROM public.users), c AS (UPDATE public.users SET id = 1 RETURNING id) SELECT id, 2 FROM c",
            "WITH seed AS (SELECT id FROM public.users), c AS (INSERT INTO public.users VALUES (1) RETURNING id) SELECT id, 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT id, 2 AS marker INTO public.copy FROM c",
            "EXPLAIN WITH c AS (SELECT id FROM public.users) SELECT id, 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT id, 2 FROM c; DELETE FROM public.audit_log",
            "WITH c AS (SELECT id FROM public.users) SELECT id, 2 FROM c UNSUPPORTED SYNTAX",
        ] {
            assert!(
                connection_scope_rejects(
                    sql,
                    &DatabaseType::Postgres,
                    "reporting",
                    &["reporting".to_string()]
                ),
                "unsupported PostgreSQL query lost its existing check: {sql}"
            );
        }
        assert!(!connection_scope_rejects(
            "DELETE FROM public.users WHERE id = 1",
            &DatabaseType::Postgres,
            "reporting",
            &["reporting".to_string()],
        ));
    }

    #[test]
    fn postgres_unreviewed_expression_calls_keep_the_existing_scope_scan() {
        // The same call rule covers every expression position, including
        // nested arguments and aggregate filters; it is not a function denylist.
        let allowed = vec!["reporting".to_string()];
        for sql in [
            "WITH c AS (SELECT id FROM public.users) SELECT dblink_connect('remote', 'dbname=production'), 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT dblink_exec('dbname=production', 'SET application_name = ''scope_review'''), 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT dblink('dbname=production', 'SELECT 1'), 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT remote_value(id), 2 FROM c",
            "WITH c AS (SELECT remote_value(id) AS id FROM public.users) SELECT id, 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT id, 2 FROM c WHERE remote_value(id) > 0",
            "WITH c AS (SELECT id FROM public.users) SELECT id, COUNT(*) FROM c GROUP BY id HAVING remote_value(id) > 0",
            "WITH c AS (SELECT id FROM public.users) SELECT id, 2 FROM c ORDER BY remote_value(id)",
            "WITH c AS (SELECT id FROM public.users) SELECT COALESCE(remote_value(id), 0), 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT (SELECT remote_value(id) FROM c), 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT public.count(id), 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT \"COUNT\"(id), 2 FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT COUNT(*) OVER (), 2 FROM c",
        ] {
            assert!(sql_references_disallowed_database(sql, &DatabaseType::Postgres, "reporting", &allowed));
            assert!(
                connection_scope_rejects(sql, &DatabaseType::Postgres, "reporting", &allowed),
                "unreviewed expression call changed its original rejection: {sql}"
            );
        }
        for sql in [
            "WITH c AS (SELECT id FROM public.users) SELECT COUNT(*), SUM(id) FROM c",
            "WITH c AS (SELECT id FROM public.users) SELECT \"count\"(*), \"sum\"(id) FROM c",
        ] {
            assert!(!connection_scope_rejects(sql, &DatabaseType::Postgres, "reporting", &allowed));
        }
        // These shapes already pass the original scanner; falling back must
        // preserve that behavior rather than impose a new function policy.
        for sql in [
            "SELECT remote_value(id) FROM public.users",
            "WITH c AS (SELECT id FROM public.users) SELECT COUNT(*) FILTER (WHERE remote_value(id) > 0), 2 FROM c",
        ] {
            assert!(!sql_references_disallowed_database(sql, &DatabaseType::Postgres, "reporting", &allowed));
            assert!(!connection_scope_rejects(sql, &DatabaseType::Postgres, "reporting", &allowed));
        }
    }

    #[test]
    fn postgres_query_block_fix_does_not_change_other_engines() {
        // Other engines retain their original rejection of these query shapes,
        // including case-sensitive names and mode-dependent MySQL strings.
        let allowed = vec!["reporting".to_string()];
        for (db_type, sql) in [
            (DatabaseType::Mysql, "WITH c AS (SELECT id FROM REPORTING.users) SELECT id, 2 FROM c"),
            (
                DatabaseType::Mysql,
                r"WITH c AS (SELECT id FROM reporting.users) SELECT c.id, '\' FROM c, production.secrets s -- ' FROM c",
            ),
            (DatabaseType::Mysql, "WITH c AS (SELECT id FROM `reporting```.users) SELECT id, 2 FROM c"),
            (DatabaseType::SqlServer, "WITH c AS (SELECT id FROM [reporting]]].dbo.users) SELECT id, 2 FROM c"),
            (
                DatabaseType::Doris,
                "WITH c AS (SELECT id FROM reporting.users) SELECT c.id, 2 FROM c, reporting.production.secrets s",
            ),
            (
                DatabaseType::StarRocks,
                "WITH c AS (SELECT id FROM reporting.users) SELECT c.id, 2 FROM c, reporting.production.secrets s",
            ),
            (DatabaseType::Gaussdb, "WITH c AS (SELECT id FROM public.users) SELECT id, 2 FROM c"),
        ] {
            assert!(
                connection_scope_rejects(sql, &db_type, "reporting", &allowed),
                "non-PostgreSQL query changed behavior ({db_type:?}): {sql}"
            );
        }
    }

    #[test]
    fn oversized_postgres_queries_keep_the_existing_scope_scan() {
        // A long left-associative expression can exhaust a worker stack while
        // traversing or dropping its AST despite the parser's recursion limit.
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                let expression = vec!["1"; 30_000].join("+");
                let sql = format!("WITH c AS (SELECT id FROM public.users) SELECT {expression}, 2 FROM c");
                let allowed = vec!["reporting".to_string()];
                assert!(sql_references_disallowed_database(&sql, &DatabaseType::Postgres, "reporting", &allowed));
                assert!(connection_scope_rejects(&sql, &DatabaseType::Postgres, "reporting", &allowed));
                let sql = format!("SELECT {expression} FROM public.users");
                assert!(!sql_references_disallowed_database(&sql, &DatabaseType::Postgres, "reporting", &allowed));
                assert!(!connection_scope_rejects(&sql, &DatabaseType::Postgres, "reporting", &allowed));
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn plsql_block_terminators_do_not_trip_mcp_database_scope() {
        // PL/SQL 按分号切分后会产生 "end"/"end loop"/"declare ..." 这类无对象目标的
        // 碎片；它们不是事务语句但同样不应被误判为无法解析目标的写语句，否则任何
        // 含 "; end;" 的匿名块、存储过程、包都会被 MCP 库范围整体拒绝。
        let allowed = vec!["mesdev".to_string()];
        let oracle = DatabaseType::Oracle;
        for sql in [
            "begin null; end;",
            "BEGIN NULL; END;",
            "begin\n  insert into reporting_rows values (1);\nend;",
            "declare\n  v_count number;\nbegin\n  null;\nend;",
            "create or replace procedure zap as begin null; end;",
            "create or replace package body zap as procedure go is begin null; end; end;",
        ] {
            assert!(
                !sql_references_disallowed_database(sql, &oracle, "mesdev", &allowed),
                "PL/SQL must not be rejected by database scope: {sql}"
            );
        }
        // 白名单只豁免歧义启发式；限定名引用的收集不受影响，跨库写入仍然拦截
        //（Oracle 属 schema-first 方言，两段式名字首段不计为 database，用 MySQL 验证）。
        assert!(sql_references_disallowed_database(
            "begin delete from production.audit_log; end;",
            &DatabaseType::Mysql,
            "reporting",
            &["reporting".to_string()],
        ));
    }

    #[test]
    fn matches_shared_sql_target_safety_corpus() {
        let corpus: Vec<ProductionSafetyCorpusCase> =
            serde_json::from_str(include_str!("../../../../tests/fixtures/production-safety-corpus.json"))
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

    /// A Spanner JDBC connection is bound to exactly one database, so `a.b` can only be
    /// `schema.table`. Treating `a` as a database name would match a database that cannot
    /// be addressed from this connection at all.
    #[test]
    fn resolves_spanner_qualifiers_as_schema_not_database() {
        let mut spanner = config();
        spanner.db_type = DatabaseType::Spanner;

        assert!(!targets_production_database(&spanner, "staging", "DELETE FROM prod_app.users WHERE TRUE"));
        assert!(targets_production_database(&spanner, "prod_app", "DELETE FROM public.users WHERE TRUE"));
    }

    #[test]
    fn detects_cross_database_mongo_aggregate_write_targets() {
        let mut mongo = config();
        mongo.db_type = DatabaseType::MongoDb;
        mongo.database = Some("staging".to_string());
        mongo.production_databases = vec!["production".to_string()];

        assert!(mongo_pipeline_targets_production_database(
            &mongo,
            "staging",
            r#"[{"$out":{"db":"production","coll":"copied"}}]"#
        ));
        assert!(mongo_pipeline_targets_production_database(
            &mongo,
            "staging",
            r#"[{"$merge":{"into":{"db":"production","coll":"copied"}}}]"#
        ));
        assert!(!mongo_pipeline_targets_production_database(&mongo, "staging", r#"[{"$out":"copied"}]"#));
        assert!(mongo_pipeline_targets_production_database(&mongo, "production", r#"[{"$merge":{"into":"copied"}}]"#));
    }

    #[test]
    fn fails_closed_for_indeterminate_mongo_aggregate_write_targets() {
        let mut mongo = config();
        mongo.db_type = DatabaseType::MongoDb;
        mongo.database = None;
        mongo.production_databases = vec!["production".to_string()];

        assert!(mongo_pipeline_targets_production_database(&mongo, "", r#"[{"$out":"copied"}]"#));
        assert!(mongo_pipeline_targets_production_database(
            &mongo,
            "staging",
            r#"[{"$merge":{"whenMatched":"replace"}}]"#
        ));
    }
}
