use dbx_core::connection::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn prepare_schema_diff(
    options: dbx_core::schema_diff::SchemaDiffPreparationOptions,
) -> Result<dbx_core::schema_diff::SchemaDiffPreparation, String> {
    Ok(dbx_core::schema_diff::prepare_schema_diff(options))
}

#[tauri::command]
pub fn parse_schema_diff_sql_file(
    sql: String,
    database: Option<String>,
    db_type: Option<String>,
) -> Result<dbx_core::schema_diff::SchemaDiffSqlFileSnapshot, String> {
    // Only MySQL dumps are understood so far; fail loudly instead of silently
    // comparing an empty source snapshot.
    if let Some(db_type) = db_type.as_deref() {
        let supported = ["mysql", "mariadb", "tidb", "goldendb"].iter().any(|name| db_type.eq_ignore_ascii_case(name));
        if !supported {
            return Err(format!("Schema files are not supported for {db_type} comparisons yet"));
        }
    }
    Ok(dbx_core::schema_diff::parse_mysql_schema_sql_file(&sql, database.as_deref()))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn generate_schema_sync_sql(
    diffs: Vec<dbx_core::schema_diff::TableDiff>,
    function_diffs: Option<Vec<dbx_core::schema_diff::FunctionDiff>>,
    sequence_diffs: Option<Vec<dbx_core::schema_diff::SequenceDiff>>,
    rule_diffs: Option<Vec<dbx_core::schema_diff::RuleDiff>>,
    owner_diffs: Option<Vec<dbx_core::schema_diff::OwnerDiff>>,
    database_type: dbx_core::models::connection::DatabaseType,
    target_schema: Option<String>,
    cascade_delete: Option<bool>,
    source_dialect: Option<dbx_core::sql_dialect::descriptor::DialectKind>,
    field_mappings: Option<Vec<dbx_core::schema_diff::FieldMapping>>,
    compare_charset: Option<bool>,
) -> Result<String, String> {
    Ok(dbx_core::schema_diff::generate_schema_sync_sql_plan_with_charset(
        &diffs,
        function_diffs.as_deref().unwrap_or_default(),
        sequence_diffs.as_deref().unwrap_or_default(),
        rule_diffs.as_deref().unwrap_or_default(),
        owner_diffs.as_deref().unwrap_or_default(),
        database_type,
        target_schema.as_deref(),
        cascade_delete.unwrap_or(false),
        source_dialect,
        &field_mappings.unwrap_or_default(),
        false,
        false,
        None,
        compare_charset.unwrap_or(true),
    )
    .sync_sql)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_schema_sync_plan(
    state: State<'_, Arc<AppState>>,
    diffs: Vec<dbx_core::schema_diff::TableDiff>,
    function_diffs: Option<Vec<dbx_core::schema_diff::FunctionDiff>>,
    sequence_diffs: Option<Vec<dbx_core::schema_diff::SequenceDiff>>,
    rule_diffs: Option<Vec<dbx_core::schema_diff::RuleDiff>>,
    owner_diffs: Option<Vec<dbx_core::schema_diff::OwnerDiff>>,
    database_type: dbx_core::models::connection::DatabaseType,
    target_schema: Option<String>,
    cascade_delete: Option<bool>,
    source_dialect: Option<dbx_core::sql_dialect::descriptor::DialectKind>,
    field_mappings: Option<Vec<dbx_core::schema_diff::FieldMapping>>,
    enable_rollback: Option<bool>,
    // Wrap the generated forward and rollback scripts in MySQL's FOREIGN_KEY_CHECKS
    // toggle. Ignored for targets that are not MySQL.
    ignore_foreign_key_checks: Option<bool>,
    oracle_ddl: Option<dbx_core::schema_diff::OracleSchemaSyncDdlOptions>,
    compare_charset: Option<bool>,
) -> Result<dbx_core::schema_diff::SchemaSyncSqlPlan, String> {
    let oracle_ddl = if let Some(options) = oracle_ddl.as_ref().filter(|options| options.separate_indexes) {
        if options.target.as_ref().is_none_or(|target| Some(target.schema.as_str()) != target_schema.as_deref())
            || !matches!(
                database_type,
                dbx_core::models::connection::DatabaseType::Oracle
                    | dbx_core::models::connection::DatabaseType::OceanbaseOracle
            )
        {
            return Err("Independent indexes require the fixed Oracle target schema".into());
        }
        Some(
            dbx_core::schema::prepare_schema_sync_oracle_ddl_core(
                &state,
                &diffs,
                enable_rollback.unwrap_or(false),
                options,
            )
            .await,
        )
    } else {
        None
    };
    Ok(dbx_core::schema_diff::generate_schema_sync_sql_plan_with_charset(
        &diffs,
        function_diffs.as_deref().unwrap_or_default(),
        sequence_diffs.as_deref().unwrap_or_default(),
        rule_diffs.as_deref().unwrap_or_default(),
        owner_diffs.as_deref().unwrap_or_default(),
        database_type,
        target_schema.as_deref(),
        cascade_delete.unwrap_or(false),
        source_dialect,
        &field_mappings.unwrap_or_default(),
        enable_rollback.unwrap_or(false),
        ignore_foreign_key_checks.unwrap_or(false),
        oracle_ddl.as_ref(),
        compare_charset.unwrap_or(true),
    ))
}
