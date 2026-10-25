mod alter_dialect;
pub use alter_dialect::StarRocksAlterOptions;
mod column_alter;
mod column_format;
mod columns;
mod comments;
mod create_dialect;
mod create_options;
mod create_table;
mod dialect;
mod existing_primary_key;
mod foreign_keys;
mod indexes;
mod mysql_engine;
mod mysql_table_charset;
mod oracle_constraints;
mod oracle_foreign_keys;
mod owner;
mod partitions;
mod starrocks_layout;
mod starrocks_partition;
mod transwarp;
mod triggers;
pub(crate) use triggers::oracle_snapshot_trigger_source;
mod types;
mod util;
mod validation;

#[cfg(test)]
mod tests;

pub use column_alter::build_single_column_alter_sql;
pub use create_options::*;
pub use create_table::{
    build_create_table_sql, build_create_table_sql_for_version, build_create_table_sql_plan_with_dialect_options,
    build_create_table_sql_with_dialect_options,
};
pub use mysql_table_charset::{build_mysql_table_charset_change_sql, MysqlTableCharsetChange};
pub use owner::build_table_owner_change_sql;
pub use partitions::{build_create_partitioned_table_sql, build_table_partition_operation_sql};
pub use types::*;

pub use column_alter::{
    build_sqlserver_alter_column_preserving_default_sql, build_sqlserver_drop_default_constraint_sql,
};
pub use comments::{build_sqlserver_column_comment_sql, build_sqlserver_table_comment_sql};
pub use util::{oracle_new_object_reference, sqlserver_unicode_string_literal};

use crate::models::connection::DatabaseType;

use column_format::strip_inherited_mysql_column_charsets;
use columns::{build_column_sql, validate_primary_key_change_scope};
use comments::build_table_comment_sql;
use foreign_keys::build_foreign_key_sql;
use indexes::build_index_sql;
use mysql_engine::{build_mysql_engine_change_sql, validate_mysql_engine};
use triggers::{build_trigger_sql, build_trigger_sql_with_operations};
use validation::validate_concurrent_index_scope;
pub use validation::validate_draft;

pub fn build_table_structure_change_sql(options: TableStructureSqlOptions) -> TableStructureSqlResult {
    build_table_structure_change_sql_with_context(options, None)
}

pub fn build_table_structure_change_sql_with_context(
    options: TableStructureSqlOptions,
    starrocks: Option<StarRocksAlterOptions>,
) -> TableStructureSqlResult {
    build_table_structure_change_sql_plan(options, starrocks).sql
}

pub fn build_table_structure_change_sql_plan(
    mut options: TableStructureSqlOptions,
    starrocks: Option<StarRocksAlterOptions>,
) -> TableStructureSqlPlan {
    if options.oracle_constraint_changes.is_some() {
        return oracle_constraints::build_changes(options).into();
    }
    if options.oracle_foreign_key_changes.is_some() {
        return oracle_foreign_keys::build_changes(options).into();
    }
    if options.primary_key_change.is_some() {
        return existing_primary_key::build_existing_primary_key_change(options).into();
    }
    if alter_dialect::is_starrocks(&options) {
        return alter_dialect::build(&options, starrocks).into();
    }
    let mysql_engine_errors = validate_mysql_engine(&options);
    if !mysql_engine_errors.is_empty() {
        return TableStructureSqlResult { statements: Vec::new(), warnings: mysql_engine_errors }.into();
    }
    // GaussDB M-mode uses MySQL-compatible SQL dialect with backtick quoting.
    // Map to StructureDialect::Mysql so DDL is generated correctly.
    if options.is_gaussdb_m_mode {
        options.database_type = Some(DatabaseType::Mysql);
    }
    strip_inherited_mysql_column_charsets(&mut options);
    let primary_key_errors = validate_primary_key_change_scope(&options);
    if !primary_key_errors.is_empty() {
        return TableStructureSqlResult { statements: Vec::new(), warnings: primary_key_errors }.into();
    }
    // Fail closed: an unsupported concurrent-index request (existing index, or
    // partitioned parent table) must never degrade into blocking index DDL
    // behind the caller's back, so the whole plan is refused up front.
    let concurrent_errors = validate_concurrent_index_scope(&options);
    if !concurrent_errors.is_empty() {
        return TableStructureSqlResult { statements: Vec::new(), warnings: concurrent_errors }.into();
    }
    let mut warnings = validate_draft(&options);
    let mut statements = build_column_sql(&options, &mut warnings);
    statements.extend(build_index_sql(&options, &mut warnings));
    statements.extend(build_foreign_key_sql(&options, &mut warnings));
    let mut trigger_operations = Vec::new();
    let oracle_trigger_contract = options.triggers.iter().any(|trigger| trigger.oracle_exact.is_some()).then_some(1);
    let trigger_sql = if oracle_trigger_contract.is_some() {
        build_trigger_sql_with_operations(
            &options,
            &mut warnings,
            false,
            statements.len(),
            Some(&mut trigger_operations),
        )
    } else {
        build_trigger_sql(&options, &mut warnings)
    };
    statements.extend(trigger_sql);
    statements.extend(build_table_comment_sql(&options, &mut warnings));
    statements.extend(build_mysql_engine_change_sql(&options));
    TableStructureSqlPlan {
        sql: TableStructureSqlResult { statements, warnings },
        trigger_operations,
        oracle_trigger_contract,
    }
}

/// Whether this engine's structure editor can generate `COMMENT ON`/inline
/// comment DDL for tables and columns — a DDL-generation capability, not an
/// introspection one. The documentation collector uses it as a heuristic for
/// "can this engine report comments at all", but the two questions can
/// diverge: IRIS supports `%DESCRIPTION` while *defining* a table or column,
/// but DBX's editor cannot ALTER an existing one, so this returns `false`
/// for IRIS even though IRIS still reports descriptions on introspection.
/// Callers using this as an introspection signal must corroborate it against
/// what was actually collected rather than trust the flag alone.
pub fn supports_comments(database_type: crate::models::connection::DatabaseType) -> bool {
    dialect::capabilities_for(Some(database_type), None).comment
}

/// Whether this engine's structure editor can generate foreign key DDL — a
/// DDL-generation capability, not an introspection one, used here as a
/// heuristic for "does this engine report foreign key metadata at all".
/// Engines like ClickHouse and Doris genuinely report none, so their ER
/// diagrams have no edges by necessity rather than by accident, but a
/// mismatch analogous to the IRIS comment case is possible for any future
/// engine where DDL support and introspection support diverge — callers
/// should corroborate against what was actually collected.
pub fn supports_foreign_keys(database_type: crate::models::connection::DatabaseType) -> bool {
    dialect::capabilities_for(Some(database_type), None).foreign_key
}

/// Canonical display label for a database engine (e.g. `postgres`,
/// `sqlserver`, `mongodb`) — the same identifier already used throughout
/// this module's own warning prose. The documentation collector uses it for
/// `database_type` and its engine-capability warnings instead of the Rust
/// `Debug` spelling (`Postgres`, `SqlServer`, `MongoDb`), which is an
/// implementation detail, not something a consumer like dbdocs/dbdiagram
/// should key off.
pub fn database_type_label(database_type: crate::models::connection::DatabaseType) -> String {
    dialect::database_label(Some(database_type))
}

pub use indexes::has_existing_index_change;
pub use util::{clean, normalize_default, original_comment, original_default};
