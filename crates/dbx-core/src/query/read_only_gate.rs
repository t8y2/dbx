//! Shared read-only SQL gate used by plugin data access, the AI agent and the
//! MCP `dbx_query` tool.
//!
//! The gate is intentionally narrow: exactly one statement, rated read-only by
//! the dialect-aware risk classifier, and no session database switch. Callers
//! that need the extra keyword-level check (MySQL executable comments,
//! `SELECT ... INTO OUTFILE`) combine it with
//! [`crate::query_execution_sql::is_write_sql_for_database`].
//!
//! Messages stay generic because untrusted callers (plugins) must not be able
//! to use error text to probe the classifier.

use crate::models::connection::DatabaseType;
use crate::sql_risk::{classify_sql_risk_for_database, mcp_sql_has_forbidden_database_switch, SqlRisk};

/// Why a statement failed the shared read-only gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadOnlyGateError {
    /// The source held zero statements or more than one statement.
    NotSingleStatement,
    /// The classifier identified a write, DDL or transaction statement.
    NotReadOnly,
    /// The classifier could not parse or verify the statement.
    Unverifiable,
    /// `USE` / `SET CATALOG`-style session database switching.
    DatabaseSwitch,
}

impl ReadOnlyGateError {
    /// Stable caller-facing message; deliberately generic.
    pub fn message(self) -> &'static str {
        match self {
            Self::NotSingleStatement => "Exactly one SQL statement is allowed",
            Self::NotReadOnly => "The statement is not read-only; the request was rejected",
            Self::Unverifiable => "The statement could not be verified as read-only",
            Self::DatabaseSwitch => "Switching the session database is not allowed; pass `database` instead",
        }
    }
}

impl std::fmt::Display for ReadOnlyGateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for ReadOnlyGateError {}

/// Verify `sql` is exactly one read-only statement that does not switch the
/// session database.
///
/// `database_type` is load-bearing: the statement splitter and the risk
/// classifier are dialect-aware, so callers must pass the resolved connection
/// type rather than a generic default.
///
/// Returns `Ok(())` only for a statement the gate can prove read-only;
/// anything else fails closed with the specific rejection reason.
pub fn require_single_read_only_statement(sql: &str, database_type: DatabaseType) -> Result<(), ReadOnlyGateError> {
    // A script would let later statements escape the per-statement read-only
    // decision, so split with the dialect-aware splitter before counting.
    if crate::sql::split_sql_statements_for_database(sql, database_type).len() != 1 {
        return Err(ReadOnlyGateError::NotSingleStatement);
    }
    // Report database switches with their own reason instead of letting the
    // classifier lump them in with ordinary writes.
    if mcp_sql_has_forbidden_database_switch(sql, database_type) {
        return Err(ReadOnlyGateError::DatabaseSwitch);
    }
    // The classifier sees locking reads (FOR UPDATE/SHARE), writable CTEs and
    // side-effect functions that a keyword scan misses; parse failures fail
    // closed.
    match classify_sql_risk_for_database(sql, database_type) {
        Ok(SqlRisk::ReadOnly) => {}
        Ok(_) => return Err(ReadOnlyGateError::NotReadOnly),
        Err(_) => return Err(ReadOnlyGateError::Unverifiable),
    }
    // The classifier only looks at the statement inside EXPLAIN and would pass
    // EXPLAIN ANALYZE, but that form actually executes the statement
    // (including side-effect functions), so reject it explicitly.
    if contains_explain_analyze(sql) {
        return Err(ReadOnlyGateError::NotReadOnly);
    }
    Ok(())
}

/// Detect `EXPLAIN ANALYZE ...` and PostgreSQL's
/// `EXPLAIN (ANALYZE, ...) ...` spelling.
///
/// Comments and string literals are stripped first so a literal like
/// `SELECT 'EXPLAIN ANALYZE'` cannot trigger a false positive; only the
/// options immediately after EXPLAIN are inspected, so a column named
/// `analyze` in `EXPLAIN SELECT analyze FROM t` stays allowed.
fn contains_explain_analyze(sql: &str) -> bool {
    let cleaned = crate::query_execution_sql::strip_sql_comments_and_literals(sql);
    let upper = cleaned.trim_start().to_ascii_uppercase();
    let Some(rest) = upper.strip_prefix("EXPLAIN") else {
        return false;
    };
    // An identifier such as `EXPLAINPLAN` is not an EXPLAIN statement.
    if rest.chars().next().is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
        return false;
    }
    let rest = rest.trim_start();
    if starts_with_word(rest, "ANALYZE") {
        return true;
    }
    if let Some(options) = rest.strip_prefix('(') {
        let options = options.split(')').next().unwrap_or_default();
        return options.split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_').any(|word| word == "ANALYZE");
    }
    false
}

/// Whether `source` starts with `word` as a whole word (followed by a
/// delimiter or end of input).
fn starts_with_word(source: &str, word: &str) -> bool {
    source
        .strip_prefix(word)
        .is_some_and(|rest| rest.chars().next().is_none_or(|ch| !ch.is_ascii_alphanumeric() && ch != '_'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_single_read_statements() {
        for (sql, database_type) in [
            ("SELECT * FROM users WHERE id = 1", DatabaseType::Postgres),
            ("WITH t AS (SELECT 1) SELECT * FROM t", DatabaseType::Mysql),
            ("SHOW CREATE TABLE users", DatabaseType::Mysql),
            ("EXPLAIN SELECT 1", DatabaseType::Postgres),
        ] {
            assert!(
                require_single_read_only_statement(sql, database_type).is_ok(),
                "{sql} should pass the read-only gate"
            );
        }
    }

    #[test]
    fn rejects_writes_ddl_and_scripts() {
        for sql in [
            "DELETE FROM users",
            "UPDATE users SET name = 'x' WHERE id = 1",
            "DROP TABLE users",
            "WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x",
            "SELECT * FROM users FOR UPDATE",
            "EXPLAIN ANALYZE SELECT 1",
            "EXPLAIN (ANALYZE, BUFFERS) SELECT 1",
            "SELECT 1; SELECT 2",
            "SELECT 1; DELETE FROM users",
        ] {
            assert!(
                require_single_read_only_statement(sql, DatabaseType::Postgres).is_err(),
                "{sql} should be rejected"
            );
        }
    }

    #[test]
    fn rejects_database_switches() {
        assert_eq!(
            require_single_read_only_statement("USE other_db", DatabaseType::Mysql),
            Err(ReadOnlyGateError::DatabaseSwitch)
        );
    }

    #[test]
    fn rejects_empty_sql() {
        assert_eq!(
            require_single_read_only_statement("   ", DatabaseType::Mysql),
            Err(ReadOnlyGateError::NotSingleStatement)
        );
    }
}
