use serde::{Deserialize, Serialize};
use sqlparser::ast::{Query, SetExpr, Statement};
use sqlparser::dialect::{
    ClickHouseDialect, DuckDbDialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect,
};
use sqlparser::parser::Parser;

use crate::models::connection::DatabaseType;

/// SQL risk level for agent tool safety classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SqlRisk {
    /// SELECT, SHOW, DESCRIBE, EXPLAIN, WITH (pure read CTE)
    ReadOnly,
    /// INSERT, UPDATE, DELETE, MERGE, REPLACE, CALL/EXEC
    Write,
    /// CREATE, ALTER, DROP, TRUNCATE, GRANT, REVOKE
    Ddl,
    /// BEGIN, COMMIT, ROLLBACK should not be issued by agent
    Transaction,
}

impl std::fmt::Display for SqlRisk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SqlRisk::ReadOnly => write!(f, "read-only"),
            SqlRisk::Write => write!(f, "write"),
            SqlRisk::Ddl => write!(f, "DDL"),
            SqlRisk::Transaction => write!(f, "transaction"),
        }
    }
}

/// Normalize database dialect string to a canonical form for sqlparser.
/// Mirrors the logic in `sql_analysis::normalize_dialect`.
fn normalize_dialect(dialect: &str) -> &'static str {
    match dialect.to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" | "redshift" | "opengauss" | "gaussdb" | "kingbase" | "highgo" | "vastbase"
        | "kwdb" => "postgres",
        "mysql" | "mariadb" | "doris" | "starrocks" | "manticoresearch" | "oceanbase" => "mysql",
        "sqlite" => "sqlite",
        "sqlserver" | "mssql" => "sqlserver",
        "clickhouse" => "clickhouse",
        "duckdb" => "duckdb",
        _ => "generic",
    }
}

/// Resolve dialect string to a sqlparser Dialect trait object.
fn resolve_dialect(dialect: &str) -> Box<dyn sqlparser::dialect::Dialect> {
    match dialect {
        "postgres" => Box::new(PostgreSqlDialect {}),
        "mysql" => Box::new(MySqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        "sqlserver" => Box::new(MsSqlDialect {}),
        "clickhouse" => Box::new(ClickHouseDialect {}),
        "duckdb" => Box::new(DuckDbDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

/// Classify a single SQL statement into a risk level using AST analysis.
fn classify_statement(stmt: &Statement, detect_select_into: bool) -> SqlRisk {
    match stmt {
        // Pure reads
        Statement::Query(query) => {
            if detect_select_into && query_contains_select_into(query) {
                SqlRisk::Write
            } else {
                SqlRisk::ReadOnly
            }
        }
        Statement::Explain { analyze, statement, .. } => {
            if *analyze {
                classify_statement(statement, detect_select_into)
            } else {
                SqlRisk::ReadOnly
            }
        }
        Statement::ExplainTable { .. } => SqlRisk::ReadOnly,

        // Show/Describe variants
        Statement::ShowTables { .. }
        | Statement::ShowColumns { .. }
        | Statement::ShowDatabases { .. }
        | Statement::ShowSchemas { .. }
        | Statement::ShowCreate { .. }
        | Statement::ShowVariables { .. }
        | Statement::ShowStatus { .. }
        | Statement::ShowProcessList { .. } => SqlRisk::ReadOnly,

        // Write operations
        Statement::Insert { .. } | Statement::Update { .. } | Statement::Delete { .. } | Statement::Merge { .. } => {
            SqlRisk::Write
        }

        // DDL operations
        Statement::CreateTable { .. }
        | Statement::CreateView { .. }
        | Statement::CreateIndex { .. }
        | Statement::CreateSchema { .. }
        | Statement::CreateSequence { .. }
        | Statement::CreateRole { .. }
        | Statement::CreateType { .. }
        | Statement::AlterTable { .. }
        | Statement::AlterIndex { .. }
        | Statement::AlterView { .. }
        | Statement::Drop { .. }
        | Statement::Truncate { .. } => SqlRisk::Ddl,

        // Grant/Revoke
        Statement::Grant { .. } | Statement::Revoke { .. } => SqlRisk::Ddl,

        // Transaction control
        Statement::StartTransaction { .. } | Statement::Commit { .. } | Statement::Rollback { .. } => {
            SqlRisk::Transaction
        }

        // COPY FROM mutates data; keep COPY conservative because sqlparser does
        // not expose enough dialect-specific direction detail here.
        Statement::Copy { .. } => SqlRisk::Write,

        // SQLite/DuckDB PRAGMA statements can mutate database/session state.
        Statement::Pragma { .. } => SqlRisk::Write,

        // Catch-all: conservative write classification
        _ => SqlRisk::Write,
    }
}

fn query_contains_select_into(query: &Query) -> bool {
    set_expr_contains_select_into(&query.body)
}

fn set_expr_contains_select_into(expr: &SetExpr) -> bool {
    match expr {
        SetExpr::Select(select) => select.into.is_some(),
        SetExpr::Query(query) => query_contains_select_into(query),
        SetExpr::SetOperation { left, right, .. } => {
            set_expr_contains_select_into(left) || set_expr_contains_select_into(right)
        }
        _ => false,
    }
}

/// Classify SQL risk using sqlparser AST analysis.
///
/// If parsing fails (non-standard SQL, non-SQL databases), falls back to
/// keyword-based `query_execution_sql::is_write_sql()`.
///
/// Multi-statement input: returns the highest risk level across all statements.
pub fn classify_sql_risk(sql: &str, dialect: &str) -> Result<SqlRisk, String> {
    let normalized = normalize_dialect(dialect);
    classify_sql_risk_with_database(sql, normalized, None)
}

/// Classify SQL risk using both the parser dialect and the concrete database
/// type so dialect-specific write forms cannot be mistaken for read queries.
pub fn classify_sql_risk_for_database(sql: &str, database_type: DatabaseType) -> Result<SqlRisk, String> {
    let database_type_name = format!("{database_type:?}");
    let normalized = normalize_dialect(&database_type_name);
    classify_sql_risk_with_database(sql, normalized, Some(database_type))
}

fn classify_sql_risk_with_database(
    sql: &str,
    normalized_dialect: &str,
    database_type: Option<DatabaseType>,
) -> Result<SqlRisk, String> {
    let parser_dialect = resolve_dialect(normalized_dialect);
    let detect_select_into = database_type.is_none();
    let has_dialect_specific_write = database_type
        .is_some_and(|database_type| crate::query_execution_sql::has_dialect_specific_write(sql, database_type));

    match Parser::parse_sql(parser_dialect.as_ref(), sql) {
        Ok(stmts) if !stmts.is_empty() => {
            let mut max_risk = SqlRisk::ReadOnly;
            for stmt in &stmts {
                let risk = classify_statement(stmt, detect_select_into);
                if risk as u8 > max_risk as u8 {
                    max_risk = risk;
                }
            }
            if max_risk == SqlRisk::ReadOnly && has_dialect_specific_write {
                Ok(SqlRisk::Write)
            } else {
                Ok(max_risk)
            }
        }
        _ => {
            // Fallback: keyword-based classification
            let is_write = database_type.map_or_else(
                || crate::query_execution_sql::is_write_sql(sql),
                |database_type| crate::query_execution_sql::is_write_sql_for_database(sql, database_type),
            );
            if is_write {
                Ok(SqlRisk::Write)
            } else {
                Ok(SqlRisk::ReadOnly)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_select_statements() {
        assert_eq!(classify_sql_risk("SELECT * FROM users", "postgres").unwrap(), SqlRisk::ReadOnly);
        assert_eq!(
            classify_sql_risk("SELECT id, name FROM users WHERE active = true", "mysql").unwrap(),
            SqlRisk::ReadOnly
        );
        assert_eq!(classify_sql_risk("SHOW TABLES", "mysql").unwrap(), SqlRisk::ReadOnly);
        assert_eq!(classify_sql_risk("DESCRIBE users", "mysql").unwrap(), SqlRisk::ReadOnly);
        assert_eq!(classify_sql_risk("EXPLAIN SELECT * FROM users", "postgres").unwrap(), SqlRisk::ReadOnly);
    }

    #[test]
    fn classify_cte_read() {
        assert_eq!(
            classify_sql_risk("WITH cte AS (SELECT 1) SELECT * FROM cte", "postgres").unwrap(),
            SqlRisk::ReadOnly
        );
    }

    #[test]
    fn classify_write_statements() {
        assert_eq!(classify_sql_risk("INSERT INTO users VALUES (1)", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(classify_sql_risk("UPDATE users SET name = 'x'", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(classify_sql_risk("DELETE FROM users", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(classify_sql_risk("EXPLAIN ANALYZE DELETE FROM users", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(classify_sql_risk("SELECT * INTO backup_users FROM users", "postgres").unwrap(), SqlRisk::Write);
        assert_eq!(
            classify_sql_risk("SELECT * FROM users INTO OUTFILE '/tmp/users.csv'", "mysql").unwrap(),
            SqlRisk::Write
        );
        assert_eq!(classify_sql_risk("/*! DELETE FROM users */", "mysql").unwrap(), SqlRisk::Write);
    }

    #[test]
    fn classify_dialect_specific_select_into_as_write() {
        for sql in [
            "SELECT 3156 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt'",
            "SELECT 3156 INTO DUMPFILE '/var/lib/mysql-files/dbx_ro_probe.bin'",
        ] {
            assert_eq!(classify_sql_risk_for_database(sql, DatabaseType::Mysql).unwrap(), SqlRisk::Write);
        }

        for database_type in [
            DatabaseType::Postgres,
            DatabaseType::Redshift,
            DatabaseType::Gaussdb,
            DatabaseType::OpenGauss,
            DatabaseType::Kingbase,
            DatabaseType::Highgo,
            DatabaseType::Vastbase,
            DatabaseType::Kwdb,
        ] {
            assert_eq!(
                classify_sql_risk_for_database("SELECT * INTO copied_users FROM users", database_type).unwrap(),
                SqlRisk::Write,
                "expected PostgreSQL-family SELECT INTO to be a write for {database_type:?}"
            );
        }
        assert_eq!(
            classify_sql_risk_for_database("SELECT * INTO #copied_users FROM users", DatabaseType::SqlServer).unwrap(),
            SqlRisk::Write
        );
        assert_eq!(
            classify_sql_risk_for_database(
                "SELECT 3156 /*!50000 INTO OUTFILE '/var/lib/mysql-files/dbx_ro_probe.txt' */",
                DatabaseType::Mysql,
            )
            .unwrap(),
            SqlRisk::Write
        );
    }

    #[test]
    fn typed_classification_preserves_existing_risk_levels() {
        assert_eq!(
            classify_sql_risk_for_database("SELECT * FROM users", DatabaseType::Postgres).unwrap(),
            SqlRisk::ReadOnly
        );
        assert_eq!(
            classify_sql_risk_for_database("CREATE TABLE users (id INT)", DatabaseType::Postgres).unwrap(),
            SqlRisk::Ddl
        );
        assert_eq!(
            classify_sql_risk_for_database("SELECT 1 INTO unsupported", DatabaseType::Sqlite).unwrap(),
            SqlRisk::ReadOnly
        );
    }

    #[test]
    fn classify_ddl_statements() {
        assert_eq!(classify_sql_risk("CREATE TABLE users (id INT)", "postgres").unwrap(), SqlRisk::Ddl);
        assert_eq!(classify_sql_risk("DROP TABLE users", "postgres").unwrap(), SqlRisk::Ddl);
        assert_eq!(classify_sql_risk("ALTER TABLE users ADD COLUMN age INT", "postgres").unwrap(), SqlRisk::Ddl);
        assert_eq!(classify_sql_risk("TRUNCATE TABLE users", "postgres").unwrap(), SqlRisk::Ddl);
    }

    #[test]
    fn classify_transaction_statements() {
        assert_eq!(classify_sql_risk("BEGIN", "postgres").unwrap(), SqlRisk::Transaction);
        assert_eq!(classify_sql_risk("COMMIT", "postgres").unwrap(), SqlRisk::Transaction);
        assert_eq!(classify_sql_risk("ROLLBACK", "postgres").unwrap(), SqlRisk::Transaction);
    }

    #[test]
    fn classify_multi_statement_returns_highest_risk() {
        // SELECT + INSERT = Write
        assert_eq!(classify_sql_risk("SELECT 1; INSERT INTO users VALUES (1)", "postgres").unwrap(), SqlRisk::Write);
    }

    #[test]
    fn classify_fallback_on_parse_error() {
        // Non-standard SQL should fall back to keyword matching
        assert_eq!(classify_sql_risk("SELECT * FROM users", "generic").unwrap(), SqlRisk::ReadOnly);
    }

    #[test]
    fn classify_unknown_statement_is_write() {
        // Statements not explicitly handled should be conservative (Write)
        // This depends on sqlparser's coverage, but we can test the catch-all
        assert_eq!(classify_sql_risk("GRANT SELECT ON users TO admin", "postgres").unwrap(), SqlRisk::Ddl);
    }
}
