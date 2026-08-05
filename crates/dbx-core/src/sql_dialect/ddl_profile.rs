//! Target-database DDL profile: how to *write* SQL for a concrete [`DatabaseType`].
//!
//! Profiles are data + small enums. Call sites must not branch on individual databases;
//! they only consult profile fields (quote style, auto-increment form, type map, …).

use crate::models::connection::DatabaseType;

/// Identifier quoting style for generated DDL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteStyle {
    /// MySQL-family: `name`
    Backtick,
    /// PostgreSQL / Access / most ANSI: "name"
    DoubleQuote,
    /// SQL Server: [name]
    Brackets,
    /// Oracle-style unquoted uppercase
    UnquotedUpper,
}

/// How auto-increment / identity is expressed on the target database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoIncSyntax {
    /// No special auto-increment DDL.
    None,
    /// Append a fixed suffix to the column definition (e.g. ` AUTO_INCREMENT`, ` IDENTITY(1,1)`).
    Suffix(&'static str),
    /// Replace the mapped type with this type name for auto PK columns (e.g. Access `COUNTER`).
    ReplaceTypeWith(&'static str),
    /// PostgreSQL-style sequence + DEFAULT nextval (handled by generator after CREATE).
    PostgresSequence,
}

/// Static type rewrite rule: source base type (uppercase, no params) → target template.
/// Target may use `{}` for a single length/precision placeholder (first param only).
#[derive(Debug, Clone, Copy)]
pub struct TypeMapEntry {
    pub source_base: &'static str,
    pub target_template: &'static str,
}

/// How CREATE INDEX places the index method / type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexTypePlacement {
    /// No index-type clause.
    None,
    /// PostgreSQL: `CREATE INDEX … ON t USING btree (…)`
    UsingSuffix,
    /// SQL Server: `CREATE CLUSTERED INDEX …`
    TypePrefix,
    /// MySQL: `CREATE INDEX … USING BTREE ON t (…)`
    UsingBeforeOn,
}

/// CREATE TRIGGER body shape (templates use `{name}` `{timing}` `{event}` `{table}` `{body}`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TriggerTemplate {
    /// `CREATE TRIGGER {name} {timing} {event} ON {table} FOR EACH ROW BEGIN {body} END;`
    MysqlStyle,
    /// `CREATE TRIGGER {name} {timing} {event} ON {table} FOR EACH ROW EXECUTE FUNCTION {body};`
    PostgresStyle,
    /// `CREATE TRIGGER {name} ON {table} {timing} {event} AS BEGIN {body} END;`
    SqlServerStyle,
    /// Conservative MySQL-like default for unknown engines.
    GenericRowBody,
}

/// RENAME COLUMN strategy inside ALTER TABLE.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenameColumnSyntax {
    /// `CHANGE COLUMN old new_def` (MySQL)
    MysqlChangeColumn,
    /// `RENAME COLUMN old TO new`
    RenameColumn,
    /// `ALTER COLUMN old RENAME TO new` (H2)
    AlterColumnRenameTo,
    /// `EXEC sp_rename 't.old', 'new', 'COLUMN'`
    SqlServerSpRename,
}

/// DDL generation profile for one [`DatabaseType`].
#[derive(Debug, Clone, Copy)]
pub struct DdlDialectProfile {
    pub database_type: DatabaseType,
    pub quote: QuoteStyle,
    pub auto_inc: AutoIncSyntax,
    /// When false, display widths like `INT(11)` are stripped if no type_map hit.
    pub supports_display_width: bool,
    /// Cap for length params when applying `{}` templates (e.g. Access TEXT max 255).
    pub max_varchar_len: Option<u32>,
    /// MySQL-style inline `COMMENT '...'` on columns.
    pub inline_column_comment: bool,
    /// SQLite-style: emit FOREIGN KEY clauses inside CREATE TABLE.
    pub foreign_keys_inline_in_create: bool,
    /// `DROP INDEX name ON table` (MySQL) vs `DROP INDEX IF EXISTS name`.
    pub drop_index_uses_on_table: bool,
    /// `DROP FOREIGN KEY` (MySQL) vs `DROP CONSTRAINT`.
    pub drop_fk_as_foreign_key: bool,
    /// Index method placement.
    pub index_type_placement: IndexTypePlacement,
    /// `INCLUDE (cols)` on indexes.
    pub index_supports_include: bool,
    /// Partial index `WHERE …`.
    pub index_supports_filter: bool,
    /// Index `COMMENT '…'` (MySQL).
    pub index_supports_comment: bool,
    /// Table comment: `ALTER TABLE t COMMENT = '…'` vs `COMMENT ON TABLE`.
    pub table_comment_via_alter: bool,
    /// Standalone column comment SQL is unsupported (MySQL needs MODIFY COLUMN).
    pub column_comment_via_modify_only: bool,
    pub trigger_template: TriggerTemplate,
    pub rename_column: RenameColumnSyntax,
    /// MySQL `MODIFY COLUMN` vs ANSI `ALTER COLUMN … TYPE/SET`.
    pub alter_uses_modify_column: bool,
    /// Batch multiple alter clauses in one `ALTER TABLE` statement.
    pub alter_batches_clauses: bool,
    /// Prefer emitting source SHOW CREATE / native DDL when dialects match (MySQL-family).
    pub prefers_native_source_ddl: bool,
    /// GRANT/REVOKE identifier style: backtick + user quotes vs ANSI double-quote.
    pub grant_uses_mysql_user_syntax: bool,
    /// Emit a comment that FK changes may need table rebuild (SQLite-family).
    pub warn_fk_needs_table_rebuild: bool,
    pub create_table_if_not_exists: bool,
    pub create_index_if_not_exists: bool,
    pub create_function_or_replace: bool,
    pub supports_function_ddl: bool,
    pub supports_sequence_ddl: bool,
    pub supports_rule_ddl: bool,
    pub supports_owner_ddl: bool,
    /// `{create_kw} {name} {definition};` — `create_kw` is CREATE [OR REPLACE] FUNCTION.
    pub function_create_template: Option<&'static str>,
    /// `DROP FUNCTION IF EXISTS {name}{cascade};`
    pub function_drop_template: Option<&'static str>,
    /// `CREATE SEQUENCE {name} AS {data_type} START WITH {start_value} … {cycle};`
    pub sequence_create_template: Option<&'static str>,
    /// `ALTER SEQUENCE {name} AS {data_type} START WITH {start_value} … {cycle};`
    pub sequence_alter_template: Option<&'static str>,
    /// `DROP SEQUENCE {name}{cascade};`
    pub sequence_drop_template: Option<&'static str>,
    /// `DROP RULE IF EXISTS {rule_name} ON {table_name};`
    pub rule_drop_template: Option<&'static str>,
    /// `ALTER {object_type} {name} OWNER TO {owner};`
    pub owner_alter_template: Option<&'static str>,
    /// Optional session lock-timeout preamble for generated scripts.
    pub lock_timeout_sql: Option<&'static str>,
    /// Data-driven base-type rewrites for this target (empty → rely on matrix / normalize only).
    pub type_map: &'static [TypeMapEntry],
}

impl DdlDialectProfile {
    pub fn lookup_type(&self, source_base_upper: &str) -> Option<&'static str> {
        self.type_map.iter().find(|e| e.source_base.eq_ignore_ascii_case(source_base_upper)).map(|e| e.target_template)
    }

    pub fn quote_ident(&self, name: &str) -> String {
        match self.quote {
            QuoteStyle::Backtick => format!("`{}`", name.replace('`', "``")),
            QuoteStyle::DoubleQuote => format!("\"{}\"", name.replace('"', "\"\"")),
            QuoteStyle::Brackets => format!("[{}]", name.replace(']', "]]")),
            // Oracle: unquoted identifiers fold to uppercase. Mixed-case names and
            // special characters must be double-quoted with original spelling preserved.
            QuoteStyle::UnquotedUpper => {
                let has_lower = name.chars().any(|c| c.is_ascii_lowercase());
                let has_upper = name.chars().any(|c| c.is_ascii_uppercase());
                let has_special = name.chars().any(|c| !c.is_ascii_alphanumeric() && c != '_' && c != '$' && c != '#');
                let bad_start =
                    name.is_empty() || !name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
                // All-lower "emp" stays unquoted → EMP (Oracle fold). Mixed "empMixed" → "empMixed".
                let needs_quotes = (has_lower && has_upper) || has_special || bad_start;
                if needs_quotes {
                    format!("\"{}\"", name.replace('"', "\"\""))
                } else {
                    name.to_uppercase()
                }
            }
        }
    }

    /// Replace `{key}` placeholders. Unknown keys are left unchanged.
    pub fn render_template(template: &str, vars: &[(&str, &str)]) -> String {
        let mut out = template.to_string();
        for (key, value) in vars {
            out = out.replace(&format!("{{{key}}}"), value);
        }
        out
    }
}

const FN_CREATE: &str = "{create_kw} {name} {definition};";
const FN_DROP: &str = "DROP FUNCTION IF EXISTS {name}{cascade};";
const SEQ_CREATE: &str =
    "CREATE SEQUENCE {name} AS {data_type} START WITH {start_value} INCREMENT BY {increment} MINVALUE {min_value} MAXVALUE {max_value} {cycle};";
const SEQ_ALTER: &str =
    "ALTER SEQUENCE {name} AS {data_type} START WITH {start_value} INCREMENT BY {increment} MINVALUE {min_value} MAXVALUE {max_value} {cycle};";
const SEQ_DROP: &str = "DROP SEQUENCE {name}{cascade};";
const RULE_DROP: &str = "DROP RULE IF EXISTS {rule_name} ON {table_name}{cascade};";
const OWNER_ALTER: &str = "ALTER {object_type} {name} OWNER TO {owner};";

// ---------------------------------------------------------------------------
// Type maps (data only — no per-database logic at call sites)
// ---------------------------------------------------------------------------

const ACCESS_TYPE_MAP: &[TypeMapEntry] = &[
    TypeMapEntry { source_base: "BOOL", target_template: "YESNO" },
    TypeMapEntry { source_base: "BOOLEAN", target_template: "YESNO" },
    TypeMapEntry { source_base: "BIT", target_template: "YESNO" },
    TypeMapEntry { source_base: "YESNO", target_template: "YESNO" },
    TypeMapEntry { source_base: "TINYINT", target_template: "BYTE" },
    TypeMapEntry { source_base: "BYTE", target_template: "BYTE" },
    TypeMapEntry { source_base: "SMALLINT", target_template: "SMALLINT" },
    TypeMapEntry { source_base: "SHORT", target_template: "SMALLINT" },
    TypeMapEntry { source_base: "MEDIUMINT", target_template: "INTEGER" },
    TypeMapEntry { source_base: "INT", target_template: "INTEGER" },
    TypeMapEntry { source_base: "INTEGER", target_template: "INTEGER" },
    TypeMapEntry { source_base: "INT4", target_template: "INTEGER" },
    TypeMapEntry { source_base: "LONG", target_template: "INTEGER" },
    TypeMapEntry { source_base: "BIGINT", target_template: "DECIMAL(20,0)" },
    TypeMapEntry { source_base: "INT8", target_template: "DECIMAL(20,0)" },
    TypeMapEntry { source_base: "FLOAT", target_template: "SINGLE" },
    TypeMapEntry { source_base: "REAL", target_template: "SINGLE" },
    TypeMapEntry { source_base: "SINGLE", target_template: "SINGLE" },
    TypeMapEntry { source_base: "DOUBLE", target_template: "DOUBLE" },
    TypeMapEntry { source_base: "DOUBLE PRECISION", target_template: "DOUBLE" },
    TypeMapEntry { source_base: "DECIMAL", target_template: "DECIMAL({})" },
    TypeMapEntry { source_base: "NUMERIC", target_template: "DECIMAL({})" },
    TypeMapEntry { source_base: "NUMBER", target_template: "DECIMAL({})" },
    TypeMapEntry { source_base: "CURRENCY", target_template: "CURRENCY" },
    TypeMapEntry { source_base: "VARCHAR", target_template: "TEXT({})" },
    TypeMapEntry { source_base: "CHARACTER VARYING", target_template: "TEXT({})" },
    TypeMapEntry { source_base: "CHAR", target_template: "TEXT({})" },
    TypeMapEntry { source_base: "CHARACTER", target_template: "TEXT({})" },
    TypeMapEntry { source_base: "NVARCHAR", target_template: "TEXT({})" },
    TypeMapEntry { source_base: "NVARCHAR2", target_template: "TEXT({})" },
    TypeMapEntry { source_base: "VARCHAR2", target_template: "TEXT({})" },
    TypeMapEntry { source_base: "TEXT", target_template: "LONGTEXT" },
    TypeMapEntry { source_base: "TINYTEXT", target_template: "LONGTEXT" },
    TypeMapEntry { source_base: "MEDIUMTEXT", target_template: "LONGTEXT" },
    TypeMapEntry { source_base: "LONGTEXT", target_template: "LONGTEXT" },
    TypeMapEntry { source_base: "CLOB", target_template: "LONGTEXT" },
    TypeMapEntry { source_base: "MEMO", target_template: "LONGTEXT" },
    TypeMapEntry { source_base: "DATE", target_template: "DATETIME" },
    TypeMapEntry { source_base: "DATETIME", target_template: "DATETIME" },
    TypeMapEntry { source_base: "TIMESTAMP", target_template: "DATETIME" },
    TypeMapEntry { source_base: "TIME", target_template: "DATETIME" },
    TypeMapEntry { source_base: "YEAR", target_template: "SMALLINT" },
    TypeMapEntry { source_base: "BLOB", target_template: "OLEOBJECT" },
    TypeMapEntry { source_base: "TINYBLOB", target_template: "OLEOBJECT" },
    TypeMapEntry { source_base: "MEDIUMBLOB", target_template: "OLEOBJECT" },
    TypeMapEntry { source_base: "LONGBLOB", target_template: "OLEOBJECT" },
    TypeMapEntry { source_base: "BINARY", target_template: "OLEOBJECT" },
    TypeMapEntry { source_base: "VARBINARY", target_template: "OLEOBJECT" },
    TypeMapEntry { source_base: "IMAGE", target_template: "OLEOBJECT" },
    TypeMapEntry { source_base: "JSON", target_template: "LONGTEXT" },
    TypeMapEntry { source_base: "JSONB", target_template: "LONGTEXT" },
    TypeMapEntry { source_base: "UUID", target_template: "GUID" },
    TypeMapEntry { source_base: "UNIQUEIDENTIFIER", target_template: "GUID" },
    TypeMapEntry { source_base: "GUID", target_template: "GUID" },
];

const SQLITE_TYPE_MAP: &[TypeMapEntry] = &[
    TypeMapEntry { source_base: "TINYINT", target_template: "INTEGER" },
    TypeMapEntry { source_base: "SMALLINT", target_template: "INTEGER" },
    TypeMapEntry { source_base: "MEDIUMINT", target_template: "INTEGER" },
    TypeMapEntry { source_base: "INT", target_template: "INTEGER" },
    TypeMapEntry { source_base: "INTEGER", target_template: "INTEGER" },
    TypeMapEntry { source_base: "BIGINT", target_template: "INTEGER" },
    TypeMapEntry { source_base: "FLOAT", target_template: "REAL" },
    TypeMapEntry { source_base: "DOUBLE", target_template: "REAL" },
    TypeMapEntry { source_base: "DOUBLE PRECISION", target_template: "REAL" },
    TypeMapEntry { source_base: "DECIMAL", target_template: "NUMERIC" },
    TypeMapEntry { source_base: "NUMERIC", target_template: "NUMERIC" },
    TypeMapEntry { source_base: "VARCHAR", target_template: "TEXT" },
    TypeMapEntry { source_base: "CHAR", target_template: "TEXT" },
    TypeMapEntry { source_base: "TEXT", target_template: "TEXT" },
    TypeMapEntry { source_base: "TINYTEXT", target_template: "TEXT" },
    TypeMapEntry { source_base: "MEDIUMTEXT", target_template: "TEXT" },
    TypeMapEntry { source_base: "LONGTEXT", target_template: "TEXT" },
    TypeMapEntry { source_base: "DATETIME", target_template: "TEXT" },
    TypeMapEntry { source_base: "TIMESTAMP", target_template: "TEXT" },
    TypeMapEntry { source_base: "DATE", target_template: "TEXT" },
    TypeMapEntry { source_base: "BLOB", target_template: "BLOB" },
    TypeMapEntry { source_base: "JSON", target_template: "TEXT" },
];

// ---------------------------------------------------------------------------
// Profile families (shared shapes; registration is the only DatabaseType match)
// ---------------------------------------------------------------------------

fn mysql_family(db: DatabaseType) -> DdlDialectProfile {
    DdlDialectProfile {
        database_type: db,
        quote: QuoteStyle::Backtick,
        auto_inc: AutoIncSyntax::Suffix(" AUTO_INCREMENT"),
        supports_display_width: true,
        max_varchar_len: Some(65_535),
        inline_column_comment: true,
        foreign_keys_inline_in_create: false,
        drop_index_uses_on_table: true,
        drop_fk_as_foreign_key: true,
        index_type_placement: IndexTypePlacement::UsingBeforeOn,
        index_supports_include: false,
        index_supports_filter: false,
        index_supports_comment: true,
        table_comment_via_alter: true,
        column_comment_via_modify_only: true,
        trigger_template: TriggerTemplate::MysqlStyle,
        rename_column: RenameColumnSyntax::MysqlChangeColumn,
        prefers_native_source_ddl: true,
        grant_uses_mysql_user_syntax: true,
        warn_fk_needs_table_rebuild: false,
        alter_uses_modify_column: true,
        alter_batches_clauses: true,
        create_table_if_not_exists: true,
        create_index_if_not_exists: false,
        create_function_or_replace: false,
        supports_function_ddl: false,
        supports_sequence_ddl: false,
        supports_rule_ddl: false,
        supports_owner_ddl: false,
        function_create_template: None,
        function_drop_template: None,
        sequence_create_template: None,
        sequence_alter_template: None,
        sequence_drop_template: None,
        rule_drop_template: None,
        owner_alter_template: None,
        lock_timeout_sql: Some("SET SESSION lock_wait_timeout = 3;"),
        type_map: &[],
    }
}

fn postgres_family(db: DatabaseType) -> DdlDialectProfile {
    DdlDialectProfile {
        database_type: db,
        quote: QuoteStyle::DoubleQuote,
        auto_inc: AutoIncSyntax::PostgresSequence,
        supports_display_width: false,
        max_varchar_len: None,
        inline_column_comment: false,
        foreign_keys_inline_in_create: false,
        drop_index_uses_on_table: false,
        drop_fk_as_foreign_key: false,
        index_type_placement: IndexTypePlacement::UsingSuffix,
        index_supports_include: true,
        index_supports_filter: true,
        index_supports_comment: false,
        table_comment_via_alter: false,
        column_comment_via_modify_only: false,
        trigger_template: TriggerTemplate::PostgresStyle,
        rename_column: RenameColumnSyntax::RenameColumn,
        prefers_native_source_ddl: false,
        grant_uses_mysql_user_syntax: false,
        warn_fk_needs_table_rebuild: false,
        alter_uses_modify_column: false,
        alter_batches_clauses: false,
        create_table_if_not_exists: false,
        create_index_if_not_exists: true,
        create_function_or_replace: true,
        supports_function_ddl: true,
        supports_sequence_ddl: true,
        supports_rule_ddl: true,
        supports_owner_ddl: true,
        function_create_template: Some(FN_CREATE),
        function_drop_template: Some(FN_DROP),
        sequence_create_template: Some(SEQ_CREATE),
        sequence_alter_template: Some(SEQ_ALTER),
        sequence_drop_template: Some(SEQ_DROP),
        rule_drop_template: Some(RULE_DROP),
        owner_alter_template: Some(OWNER_ALTER),
        lock_timeout_sql: Some("SET lock_timeout = '3s';"),
        type_map: &[],
    }
}

fn oracle_family(db: DatabaseType) -> DdlDialectProfile {
    DdlDialectProfile {
        database_type: db,
        quote: QuoteStyle::UnquotedUpper,
        auto_inc: AutoIncSyntax::Suffix(" GENERATED BY DEFAULT AS IDENTITY"),
        supports_display_width: false,
        max_varchar_len: Some(4000),
        inline_column_comment: false,
        foreign_keys_inline_in_create: false,
        drop_index_uses_on_table: false,
        drop_fk_as_foreign_key: false,
        index_type_placement: IndexTypePlacement::None,
        index_supports_include: false,
        index_supports_filter: false,
        index_supports_comment: false,
        table_comment_via_alter: false,
        column_comment_via_modify_only: false,
        trigger_template: TriggerTemplate::GenericRowBody,
        rename_column: RenameColumnSyntax::RenameColumn,
        prefers_native_source_ddl: false,
        grant_uses_mysql_user_syntax: false,
        warn_fk_needs_table_rebuild: false,
        alter_uses_modify_column: false,
        alter_batches_clauses: false,
        create_table_if_not_exists: false,
        create_index_if_not_exists: false,
        create_function_or_replace: false,
        supports_function_ddl: true,
        supports_sequence_ddl: true,
        supports_rule_ddl: false,
        supports_owner_ddl: false,
        // Same ANSI shapes as Postgres for the subset currently generated by schema_diff.
        function_create_template: Some(FN_CREATE),
        function_drop_template: Some(FN_DROP),
        sequence_create_template: Some(SEQ_CREATE),
        sequence_alter_template: Some(SEQ_ALTER),
        sequence_drop_template: Some(SEQ_DROP),
        rule_drop_template: None,
        owner_alter_template: None,
        lock_timeout_sql: Some("ALTER SESSION SET DDL_LOCK_TIMEOUT = 3;"),
        type_map: &[],
    }
}

fn sqlserver_family(db: DatabaseType) -> DdlDialectProfile {
    DdlDialectProfile {
        database_type: db,
        quote: QuoteStyle::DoubleQuote,
        auto_inc: AutoIncSyntax::Suffix(" IDENTITY(1,1)"),
        supports_display_width: false,
        max_varchar_len: None,
        inline_column_comment: false,
        foreign_keys_inline_in_create: false,
        drop_index_uses_on_table: false,
        drop_fk_as_foreign_key: false,
        index_type_placement: IndexTypePlacement::TypePrefix,
        index_supports_include: true,
        index_supports_filter: true,
        index_supports_comment: false,
        table_comment_via_alter: false,
        column_comment_via_modify_only: false,
        trigger_template: TriggerTemplate::SqlServerStyle,
        rename_column: RenameColumnSyntax::SqlServerSpRename,
        prefers_native_source_ddl: false,
        grant_uses_mysql_user_syntax: false,
        warn_fk_needs_table_rebuild: false,
        alter_uses_modify_column: false,
        alter_batches_clauses: false,
        create_table_if_not_exists: false,
        create_index_if_not_exists: true,
        create_function_or_replace: false,
        supports_function_ddl: true,
        supports_sequence_ddl: true,
        supports_rule_ddl: false,
        supports_owner_ddl: false,
        function_create_template: Some(FN_CREATE),
        function_drop_template: Some(FN_DROP),
        sequence_create_template: Some(SEQ_CREATE),
        sequence_alter_template: Some(SEQ_ALTER),
        sequence_drop_template: Some(SEQ_DROP),
        rule_drop_template: None,
        owner_alter_template: None,
        lock_timeout_sql: Some("SET LOCK_TIMEOUT 3000;"),
        type_map: &[],
    }
}

fn sqlite_family(db: DatabaseType) -> DdlDialectProfile {
    DdlDialectProfile {
        database_type: db,
        quote: QuoteStyle::DoubleQuote,
        auto_inc: AutoIncSyntax::None,
        supports_display_width: false,
        max_varchar_len: None,
        inline_column_comment: false,
        foreign_keys_inline_in_create: true,
        drop_index_uses_on_table: false,
        drop_fk_as_foreign_key: false,
        index_type_placement: IndexTypePlacement::None,
        index_supports_include: false,
        index_supports_filter: true,
        index_supports_comment: false,
        table_comment_via_alter: false,
        column_comment_via_modify_only: false,
        trigger_template: TriggerTemplate::GenericRowBody,
        rename_column: RenameColumnSyntax::RenameColumn,
        prefers_native_source_ddl: false,
        grant_uses_mysql_user_syntax: false,
        warn_fk_needs_table_rebuild: true,
        alter_uses_modify_column: false,
        alter_batches_clauses: false,
        create_table_if_not_exists: true,
        create_index_if_not_exists: true,
        create_function_or_replace: false,
        supports_function_ddl: false,
        supports_sequence_ddl: false,
        supports_rule_ddl: false,
        supports_owner_ddl: false,
        function_create_template: None,
        function_drop_template: None,
        sequence_create_template: None,
        sequence_alter_template: None,
        sequence_drop_template: None,
        rule_drop_template: None,
        owner_alter_template: None,
        lock_timeout_sql: None,
        type_map: SQLITE_TYPE_MAP,
    }
}

fn access_profile() -> DdlDialectProfile {
    DdlDialectProfile {
        database_type: DatabaseType::Access,
        quote: QuoteStyle::DoubleQuote,
        auto_inc: AutoIncSyntax::ReplaceTypeWith("COUNTER"),
        supports_display_width: false,
        max_varchar_len: Some(255),
        inline_column_comment: false,
        foreign_keys_inline_in_create: false,
        drop_index_uses_on_table: false,
        drop_fk_as_foreign_key: false,
        index_type_placement: IndexTypePlacement::None,
        index_supports_include: false,
        index_supports_filter: false,
        index_supports_comment: false,
        table_comment_via_alter: false,
        column_comment_via_modify_only: false,
        trigger_template: TriggerTemplate::GenericRowBody,
        rename_column: RenameColumnSyntax::RenameColumn,
        prefers_native_source_ddl: false,
        grant_uses_mysql_user_syntax: false,
        warn_fk_needs_table_rebuild: false,
        alter_uses_modify_column: false,
        alter_batches_clauses: false,
        create_table_if_not_exists: false,
        create_index_if_not_exists: false,
        create_function_or_replace: false,
        supports_function_ddl: false,
        supports_sequence_ddl: false,
        supports_rule_ddl: false,
        supports_owner_ddl: false,
        function_create_template: None,
        function_drop_template: None,
        sequence_create_template: None,
        sequence_alter_template: None,
        sequence_drop_template: None,
        rule_drop_template: None,
        owner_alter_template: None,
        lock_timeout_sql: None,
        type_map: ACCESS_TYPE_MAP,
    }
}

fn h2_profile() -> DdlDialectProfile {
    DdlDialectProfile {
        database_type: DatabaseType::H2,
        quote: QuoteStyle::DoubleQuote,
        auto_inc: AutoIncSyntax::None,
        supports_display_width: false,
        max_varchar_len: None,
        inline_column_comment: false,
        foreign_keys_inline_in_create: false,
        drop_index_uses_on_table: false,
        drop_fk_as_foreign_key: false,
        index_type_placement: IndexTypePlacement::None,
        index_supports_include: false,
        index_supports_filter: false,
        index_supports_comment: false,
        table_comment_via_alter: false,
        column_comment_via_modify_only: false,
        trigger_template: TriggerTemplate::GenericRowBody,
        rename_column: RenameColumnSyntax::AlterColumnRenameTo,
        prefers_native_source_ddl: false,
        grant_uses_mysql_user_syntax: false,
        warn_fk_needs_table_rebuild: false,
        alter_uses_modify_column: false,
        alter_batches_clauses: false,
        create_table_if_not_exists: false,
        create_index_if_not_exists: false,
        create_function_or_replace: false,
        supports_function_ddl: false,
        supports_sequence_ddl: false,
        supports_rule_ddl: false,
        supports_owner_ddl: false,
        function_create_template: None,
        function_drop_template: None,
        sequence_create_template: None,
        sequence_alter_template: None,
        sequence_drop_template: None,
        rule_drop_template: None,
        owner_alter_template: None,
        lock_timeout_sql: None,
        type_map: &[],
    }
}

fn conservative_ansi(db: DatabaseType) -> DdlDialectProfile {
    DdlDialectProfile {
        database_type: db,
        quote: QuoteStyle::DoubleQuote,
        auto_inc: AutoIncSyntax::None,
        supports_display_width: false,
        max_varchar_len: None,
        inline_column_comment: false,
        foreign_keys_inline_in_create: false,
        drop_index_uses_on_table: false,
        drop_fk_as_foreign_key: false,
        index_type_placement: IndexTypePlacement::None,
        index_supports_include: false,
        index_supports_filter: false,
        index_supports_comment: false,
        table_comment_via_alter: false,
        column_comment_via_modify_only: false,
        trigger_template: TriggerTemplate::GenericRowBody,
        rename_column: RenameColumnSyntax::RenameColumn,
        prefers_native_source_ddl: false,
        grant_uses_mysql_user_syntax: false,
        warn_fk_needs_table_rebuild: false,
        alter_uses_modify_column: false,
        alter_batches_clauses: false,
        create_table_if_not_exists: false,
        create_index_if_not_exists: false,
        create_function_or_replace: false,
        supports_function_ddl: false,
        supports_sequence_ddl: false,
        supports_rule_ddl: false,
        supports_owner_ddl: false,
        function_create_template: None,
        function_drop_template: None,
        sequence_create_template: None,
        sequence_alter_template: None,
        sequence_drop_template: None,
        rule_drop_template: None,
        owner_alter_template: None,
        lock_timeout_sql: None,
        type_map: &[],
    }
}

fn clickhouse_profile() -> DdlDialectProfile {
    let mut p = conservative_ansi(DatabaseType::ClickHouse);
    // ClickHouse supports CREATE TABLE IF NOT EXISTS like MySQL/SQLite.
    p.create_table_if_not_exists = true;
    p.lock_timeout_sql = None;
    p
}

/// Resolve DDL profile for a concrete target database type.
///
/// This is the **only** place that maps [`DatabaseType`] → profile data.
/// Generators must not re-match on individual databases afterward.
pub fn profile_for(db_type: DatabaseType) -> DdlDialectProfile {
    use DatabaseType::*;
    match db_type {
        // MySQL family
        Mysql | Doris | StarRocks | Goldendb | Sundb | Databend | Gbase | ManticoreSearch => mysql_family(db_type),

        // PostgreSQL family
        Postgres | Redshift | Gaussdb | Kingbase | Highgo | Vastbase | OpenGauss | Kwdb | Firebird | Vertica
        | Exasol | Uxdb => postgres_family(db_type),

        // Oracle family
        Oracle | Dameng | OceanbaseOracle | Yashandb | Xugu | Iris => oracle_family(db_type),

        // SQL Server (not Access)
        SqlServer => sqlserver_family(db_type),

        // Access: own profile (must not inherit SqlServer IDENTITY)
        Access => access_profile(),

        // SQLite family
        Sqlite | Rqlite | Turso | CloudflareD1 => sqlite_family(db_type),

        H2 => h2_profile(),

        ClickHouse => clickhouse_profile(),

        DuckDb | Questdb | SapHana | Teradata | Snowflake | Trino | PrestoSql | Hive | Spark | Db2 | Informix
        | Bigquery | Kylin | Oscar | Tdengine | Iotdb | Databricks | Jdbc => conservative_ansi(db_type),

        // Non-tabular / not applicable for relational CREATE TABLE
        Redis | MongoDb | Elasticsearch | Easysearch | Qdrant | Milvus | Weaviate | ChromaDb | Neo4j | Cassandra
        | Etcd | ZooKeeper | Nacos | InfluxDb | VictoriaMetrics | MessageQueue | Mqtt | Hbase => {
            conservative_ansi(db_type)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_profile_is_not_sqlserver_identity() {
        let access = profile_for(DatabaseType::Access);
        let mssql = profile_for(DatabaseType::SqlServer);
        assert!(matches!(access.auto_inc, AutoIncSyntax::ReplaceTypeWith("COUNTER")));
        assert!(matches!(mssql.auto_inc, AutoIncSyntax::Suffix(s) if s.contains("IDENTITY")));
        assert!(access.lookup_type("VARCHAR").is_some());
        assert!(mssql.type_map.is_empty());
        // Access must not inherit SQL Server lock-timeout / idempotent flags.
        assert_eq!(access.lock_timeout_sql, None);
        assert!(mssql.lock_timeout_sql.is_some());
        assert!(!access.create_index_if_not_exists);
        assert!(mssql.create_index_if_not_exists);
    }

    #[test]
    fn oracle_profile_uses_valid_identity_and_ddl_lock_timeout() {
        let oracle = profile_for(DatabaseType::Oracle);
        assert!(matches!(
            oracle.auto_inc,
            AutoIncSyntax::Suffix(s) if s.contains("GENERATED BY DEFAULT AS IDENTITY")
        ));
        assert_eq!(oracle.lock_timeout_sql, Some("ALTER SESSION SET DDL_LOCK_TIMEOUT = 3;"));
    }

    #[test]
    fn quote_styles() {
        assert_eq!(profile_for(DatabaseType::Mysql).quote_ident("a`b"), "`a``b`");
        assert_eq!(profile_for(DatabaseType::Access).quote_ident(r#"a"b"#), "\"a\"\"b\"");
        assert_eq!(profile_for(DatabaseType::Oracle).quote_ident("emp"), "EMP");
        assert_eq!(profile_for(DatabaseType::Oracle).quote_ident("EMP"), "EMP");
        // Mixed-case must preserve spelling via quotes (not EMPMIXED).
        assert_eq!(profile_for(DatabaseType::Oracle).quote_ident("empMixed"), "\"empMixed\"");
        assert_eq!(profile_for(DatabaseType::Oracle).quote_ident("Emp"), "\"Emp\"");
    }

    #[test]
    fn postgres_object_templates_are_populated() {
        let p = profile_for(DatabaseType::Postgres);
        assert!(p.function_create_template.is_some());
        assert!(p.function_drop_template.is_some());
        assert!(p.sequence_create_template.is_some());
        assert!(p.sequence_alter_template.is_some());
        assert!(p.sequence_drop_template.is_some());
        assert!(p.rule_drop_template.is_some());
        assert!(p.owner_alter_template.is_some());
    }

    #[test]
    fn mysql_object_templates_are_absent() {
        let p = profile_for(DatabaseType::Mysql);
        assert!(p.function_create_template.is_none());
        assert!(p.sequence_create_template.is_none());
        assert!(p.rule_drop_template.is_none());
        assert!(p.owner_alter_template.is_none());
    }

    #[test]
    fn render_template_replaces_placeholders() {
        let rendered = DdlDialectProfile::render_template(
            "DROP FUNCTION IF EXISTS {name}{cascade};",
            &[("name", "\"public\".\"f\""), ("cascade", " CASCADE")],
        );
        assert_eq!(rendered, "DROP FUNCTION IF EXISTS \"public\".\"f\" CASCADE;");
    }
}
