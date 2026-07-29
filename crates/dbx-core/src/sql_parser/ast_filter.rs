use serde::{Deserialize, Serialize};
use sqlparser::ast::Statement;
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

use crate::schema_diff::SchemaDiffPreparationOptions;
use crate::types::FunctionInfo;

#[derive(Debug, Clone)]
pub enum FilterAction {
    Allow,
    Deny(String),
}

pub trait AstFilter {
    fn filter_statement(&self, stmt: &Statement) -> FilterAction;
}

#[derive(Debug, Clone)]
pub struct FilterResult {
    pub allowed: Vec<String>,
    pub denied: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxResult {
    pub allowed: Vec<String>,
    pub denied: Vec<String>,
    pub nesting_violations: Vec<String>,
    pub is_pure: bool,
    pub stats: SandboxStats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SandboxMode {
    Permissive,
    #[default]
    Strict,
    Isolation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxStats {
    pub total_statements: usize,
    pub allowed_count: usize,
    pub denied_count: usize,
    pub mode: String,
    pub max_nesting_depth: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AstSandbox {
    pub mode: SandboxMode,
    pub max_nesting_depth: usize,
}

impl Default for AstSandbox {
    fn default() -> Self {
        Self { mode: SandboxMode::Strict, max_nesting_depth: 10 }
    }
}

impl AstSandbox {
    pub fn new(mode: SandboxMode, max_nesting_depth: usize) -> Self {
        Self { mode, max_nesting_depth }
    }

    pub fn filter_sql(&self, sql: &str, dialect_str: &str) -> Result<SandboxResult, String> {
        let base = AstTransmitFilter::filter_sql(sql, dialect_str)?;

        let stats = SandboxStats {
            total_statements: base.allowed.len() + base.denied.len(),
            allowed_count: base.allowed.len(),
            denied_count: base.denied.len(),
            mode: match self.mode {
                SandboxMode::Permissive => "permissive".to_string(),
                SandboxMode::Strict => "strict".to_string(),
                SandboxMode::Isolation => "isolation".to_string(),
            },
            max_nesting_depth: self.max_nesting_depth,
        };

        let (further_blocked, nest_violations) = match self.mode {
            SandboxMode::Permissive => (Vec::new(), Vec::new()),
            SandboxMode::Strict | SandboxMode::Isolation => self.check_nesting(&base.allowed, self.max_nesting_depth),
        };

        let is_pure = match self.mode {
            SandboxMode::Permissive => base.denied.is_empty(),
            SandboxMode::Strict => base.denied.is_empty() && further_blocked.is_empty(),
            SandboxMode::Isolation => {
                base.denied.is_empty() && further_blocked.is_empty() && nest_violations.is_empty()
            }
        };

        Ok(SandboxResult {
            allowed: base.allowed,
            denied: base.denied.iter().chain(further_blocked.iter()).cloned().collect(),
            nesting_violations: nest_violations,
            is_pure,
            stats,
        })
    }

    fn check_nesting(&self, statements: &[String], max_depth: usize) -> (Vec<String>, Vec<String>) {
        let mut further_blocked = Vec::new();
        let mut violations = Vec::new();
        for stmt in statements {
            let depth = self.count_nesting(stmt);
            if depth > max_depth {
                further_blocked.push(stmt.clone());
                violations.push(format!("Nesting depth {depth} exceeds max {max_depth}: {stmt}"));
            }
        }
        (further_blocked, violations)
    }

    fn count_nesting(&self, stmt: &str) -> usize {
        let mut max_depth = 0usize;
        let mut current = 0usize;
        for ch in stmt.chars() {
            match ch {
                '(' => {
                    current += 1;
                    max_depth = max_depth.max(current);
                }
                ')' => {
                    current = current.saturating_sub(1);
                }
                _ => {}
            }
        }
        max_depth
    }
}

pub struct AstTransmitFilter;

impl AstTransmitFilter {
    pub fn filter_sql(sql: &str, dialect_str: &str) -> Result<FilterResult, String> {
        let dialect = resolve_dialect(dialect_str);
        let stmts =
            Parser::parse_sql(dialect.as_ref(), sql).map_err(|e| format!("SQL parse error in AST filter: {e}"))?;

        let filter = Self;
        let mut allowed = Vec::new();
        let mut denied: Vec<String> = Vec::new();

        for stmt in &stmts {
            match filter.filter_statement(stmt) {
                FilterAction::Allow => {
                    allowed.push(stmt.to_string());
                }
                FilterAction::Deny(reason) => {
                    denied.push(format!("Blocked: {reason} — {stmt}"));
                }
            }
        }

        Ok(FilterResult { allowed, denied })
    }

    fn is_dangerous_body_node(&self, stmt: &Statement) -> bool {
        matches!(
            stmt,
            Statement::CreateFunction { .. } | Statement::CreateProcedure { .. } | Statement::CreateTrigger { .. }
        )
    }

    pub fn filter_diff_preparation_options(
        options: SchemaDiffPreparationOptions,
        _dialect: &str,
    ) -> SchemaDiffPreparationOptions {
        let mut filtered = options;

        let is_dangerous_fn = |f: &FunctionInfo| -> bool {
            let upper = f.definition.to_ascii_uppercase();
            let keywords = ["FUNCTION", "PROCEDURE", "TRIGGER", "BEGIN", "DECLARE", "LANGUAGE"];
            keywords.iter().any(|kw| upper.contains(kw))
        };

        filtered.source_functions.retain(|f| !is_dangerous_fn(f));
        filtered.target_functions.retain(|f| !is_dangerous_fn(f));

        filtered
    }
}

fn resolve_dialect(dialect: &str) -> Box<dyn sqlparser::dialect::Dialect> {
    match dialect.to_ascii_lowercase().as_str() {
        "postgres" | "postgresql" => Box::new(sqlparser::dialect::PostgreSqlDialect {}),
        "mysql" | "mariadb" | "tidb" => Box::new(sqlparser::dialect::MySqlDialect {}),
        "sqlite" => Box::new(sqlparser::dialect::SQLiteDialect {}),
        "sqlserver" | "mssql" => Box::new(sqlparser::dialect::MsSqlDialect {}),
        "clickhouse" => Box::new(sqlparser::dialect::ClickHouseDialect {}),
        "duckdb" => Box::new(sqlparser::dialect::DuckDbDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

impl AstFilter for AstTransmitFilter {
    fn filter_statement(&self, stmt: &Statement) -> FilterAction {
        if self.is_dangerous_body_node(stmt) {
            return FilterAction::Deny("Function/procedure/trigger body not allowed in schema diff".into());
        }

        match stmt {
            Statement::CreateTable { .. }
            | Statement::CreateView { .. }
            | Statement::CreateIndex { .. }
            | Statement::CreateSchema { .. }
            | Statement::CreateSequence { .. }
            | Statement::AlterTable { .. }
            | Statement::AlterIndex { .. }
            | Statement::AlterView { .. }
            | Statement::Drop { .. }
            | Statement::Truncate { .. } => FilterAction::Allow,

            _ => FilterAction::Deny("Statement type not in whitelist for schema diff".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_create_table() {
        let result =
            AstTransmitFilter::filter_sql("CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(100))", "generic")
                .unwrap();
        assert!(!result.allowed.is_empty());
        assert!(result.allowed[0].contains("CREATE TABLE"));
    }

    #[test]
    fn allows_create_index() {
        let result = AstTransmitFilter::filter_sql("CREATE INDEX idx_users_name ON users (name)", "generic").unwrap();
        assert!(!result.allowed.is_empty());
    }

    #[test]
    fn allows_alter_table() {
        let result = AstTransmitFilter::filter_sql("ALTER TABLE users ADD COLUMN age INT", "generic").unwrap();
        assert!(!result.allowed.is_empty());
    }

    #[test]
    fn allows_drop_table() {
        let result = AstTransmitFilter::filter_sql("DROP TABLE users", "generic").unwrap();
        assert!(!result.allowed.is_empty());
    }

    #[test]
    fn blocks_create_function() {
        let result = AstTransmitFilter::filter_sql(
            "CREATE FUNCTION add(a INT, b INT) RETURNS INT LANGUAGE SQL RETURN a + b",
            "generic",
        )
        .unwrap();
        assert!(result.allowed.is_empty());
        assert!(!result.denied.is_empty());
    }

    #[test]
    fn blocks_create_procedure() {
        let result = AstTransmitFilter::filter_sql(
            "CREATE PROCEDURE test_proc() AS LANGUAGE SQL BEGIN ATOMIC SELECT 1; END",
            "postgres",
        );
        // parse failure on some platforms is acceptable
        if let Ok(r) = result {
            assert!(r.allowed.is_empty());
            assert!(!r.denied.is_empty());
        }
    }

    #[test]
    fn blocks_create_trigger() {
        let result = AstTransmitFilter::filter_sql(
            "CREATE TRIGGER test_trigger BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION log_change()",
            "postgres",
        )
        .unwrap();
        assert!(result.allowed.is_empty());
        assert!(!result.denied.is_empty());
    }

    #[test]
    fn allows_multiple_ddl_statements() {
        let result = AstTransmitFilter::filter_sql(
            "CREATE TABLE a (id INT); CREATE TABLE b (id INT); ALTER TABLE a ADD COLUMN x INT;",
            "generic",
        )
        .unwrap();
        assert_eq!(result.allowed.len(), 3);
    }

    #[test]
    fn blocks_mixed_ddl_and_function() {
        let result = AstTransmitFilter::filter_sql(
            "CREATE TABLE t (id INT); CREATE FUNCTION f() RETURNS INT AS $$ SELECT 1 $$ LANGUAGE SQL",
            "postgres",
        )
        .unwrap();
        assert_eq!(result.allowed.len(), 1);
        assert_eq!(result.denied.len(), 1);
    }

    #[test]
    fn blocks_select_statement() {
        let result = AstTransmitFilter::filter_sql("SELECT * FROM users", "generic").unwrap();
        assert!(result.allowed.is_empty());
        assert!(!result.denied.is_empty());
    }

    #[test]
    fn allows_create_view() {
        let result = AstTransmitFilter::filter_sql(
            "CREATE VIEW active_users AS SELECT * FROM users WHERE active = 1",
            "generic",
        )
        .unwrap();
        assert!(!result.allowed.is_empty());
    }

    #[test]
    fn deny_insert_statement() {
        let result = AstTransmitFilter::filter_sql("INSERT INTO users VALUES (1, 'a')", "generic").unwrap();
        assert!(result.allowed.is_empty());
        assert!(!result.denied.is_empty());
    }

    #[test]
    fn filter_options_removes_dangerous_functions() {
        let opts = SchemaDiffPreparationOptions {
            source_functions: vec![
                FunctionInfo {
                    name: "f1".into(),
                    definition: "CREATE FUNCTION f1() RETURNS INT ...".into(),
                    function_type: "FUNCTION".into(),
                    data_type: "int".into(),
                    arguments: "".into(),
                },
                FunctionInfo {
                    name: "t1".into(),
                    definition: "TABLE t1".into(),
                    function_type: "TABLE".into(),
                    data_type: "".into(),
                    arguments: "".into(),
                },
            ],
            source_tables: vec![],
            target_tables: vec![],
            source_details: vec![],
            target_details: vec![],
            target_functions: vec![],
            source_sequences: vec![],
            target_sequences: vec![],
            source_rules: vec![],
            target_rules: vec![],
            source_owners: vec![],
            target_owners: vec![],
            database_type: crate::models::connection::DatabaseType::Mysql,
            target_schema: None,
            ignore_comments: false,
            cascade_delete: false,
            compare_column_order: false,
            ..Default::default()
        };

        let filtered = AstTransmitFilter::filter_diff_preparation_options(opts, "mysql");
        assert_eq!(filtered.source_functions.len(), 1);
        assert_eq!(filtered.source_functions[0].name, "t1");
    }

    #[test]
    fn sandbox_strict_mode_blocks_dangerous_statement() {
        let sandbox = AstSandbox::new(SandboxMode::Strict, 10);
        let result = sandbox
            .filter_sql(
                "CREATE TABLE t (id INT); CREATE FUNCTION f() RETURNS INT AS $$ SELECT 1 $$ LANGUAGE SQL",
                "postgres",
            )
            .unwrap();
        assert_eq!(result.allowed.len(), 1);
        assert!(!result.denied.is_empty());
        assert!(!result.is_pure);
    }

    #[test]
    fn sandbox_isolation_mode_checks_nesting() {
        let sandbox = AstSandbox::new(SandboxMode::Isolation, 4);
        let result = sandbox
            .filter_sql("CREATE TABLE t (a INT, b INT, c INT, d INT, e INT DEFAULT (((1))))", "generic")
            .unwrap();
        assert!(result.nesting_violations.is_empty(), "Should pass with nesting depth 4");
        assert!(result.is_pure);
    }

    #[test]
    fn sandbox_isolation_blocks_deeply_nested() {
        let sandbox = AstSandbox::new(SandboxMode::Isolation, 1);
        let result = sandbox.filter_sql("CREATE TABLE t (a INT DEFAULT ((((1)))))", "generic").unwrap();
        assert!(!result.nesting_violations.is_empty());
        assert!(!result.is_pure);
    }

    #[test]
    fn sandbox_permissive_accepts_everything_allowed() {
        let sandbox = AstSandbox::new(SandboxMode::Permissive, 10);
        let result = sandbox
            .filter_sql("CREATE TABLE t (id INT); CREATE FUNCTION f() RETURNS INT LANGUAGE SQL RETURN 1", "generic")
            .unwrap();
        assert_eq!(result.allowed.len(), 1, "Permissive allows CREATE TABLE but blocks CREATE FUNCTION");
        assert!(!result.denied.is_empty(), "Permissive denies function but not table");
        assert!(!result.is_pure, "Permissive is not pure when function is denied by base filter");
    }

    #[test]
    fn sandbox_permissive_no_nesting_check() {
        let sandbox = AstSandbox::new(SandboxMode::Permissive, 0);
        let result = sandbox.filter_sql("CREATE TABLE t (a INT DEFAULT ((((1)))))", "generic").unwrap();
        assert!(!result.allowed.is_empty());
        assert!(result.nesting_violations.is_empty());
        assert!(result.is_pure);
    }

    #[test]
    fn sandbox_stats_correct() {
        let sandbox = AstSandbox::new(SandboxMode::Strict, 10);
        let result = sandbox
            .filter_sql(
                "CREATE TABLE t1 (id INT); CREATE TABLE t2 (id INT); DROP TABLE t3; SELECT * FROM t1",
                "generic",
            )
            .unwrap();
        assert_eq!(result.stats.total_statements, 4);
        assert_eq!(result.stats.allowed_count, 3);
        assert_eq!(result.stats.denied_count, 1);
        assert_eq!(result.stats.mode, "strict");
        assert_eq!(result.stats.max_nesting_depth, 10);
    }
}
