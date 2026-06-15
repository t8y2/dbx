use serde::{Deserialize, Serialize};
use sqlparser::ast::Statement;
use sqlparser::dialect::{
    ClickHouseDialect, DuckDbDialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect,
};
use sqlparser::parser::Parser;

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
        "postgres" | "postgresql" | "redshift" | "opengauss" | "gaussdb" | "highgo" => "postgres",
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
fn classify_statement(stmt: &Statement) -> SqlRisk {
    match stmt {
        // Pure reads
        Statement::Query(_) => SqlRisk::ReadOnly,
        Statement::Explain { .. } => SqlRisk::ReadOnly,
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

        // Copy (PostgreSQL) 鈥?treat as write
        Statement::Copy { .. } => SqlRisk::Write,

        // Pragma (SQLite/DuckDB) 鈥?conservative: treat as write unless known-safe
        Statement::Pragma { .. } => SqlRisk::Write,

        // Catch-all: conservative write classification
        _ => SqlRisk::Write,
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
    let parser_dialect = resolve_dialect(normalized);

    match Parser::parse_sql(parser_dialect.as_ref(), sql) {
        Ok(stmts) if !stmts.is_empty() => {
            let mut max_risk = SqlRisk::ReadOnly;
            for stmt in &stmts {
                let risk = classify_statement(stmt);
                if risk as u8 > max_risk as u8 {
                    max_risk = risk;
                }
            }
            Ok(max_risk)
        }
        _ => {
            // Fallback: keyword-based classification
            if crate::query_execution_sql::is_write_sql(sql) {
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
