use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::io::Write;
use tokio::sync::RwLock;

use crate::models::connection::DatabaseType;
use crate::sql_dialect::{qualified_table_name, quote_table_identifier};
use crate::transfer::{format_ch_array_sql_literal, format_pg_array_sql_literal, quote_identifier};

static EXPORT_CANCELLED: std::sync::LazyLock<RwLock<HashSet<String>>> =
    std::sync::LazyLock::new(|| RwLock::new(HashSet::new()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseExportRequest {
    pub export_id: String,
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub file_path: String,
    #[serde(default)]
    pub selected_tables: Vec<String>,
    pub include_structure: bool,
    pub include_data: bool,
    pub include_objects: bool,
    #[serde(default)]
    pub drop_table_if_exists: bool,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub export_id: String,
    pub current_object: String,
    pub object_index: usize,
    pub total_objects: usize,
    pub rows_exported: u64,
    pub total_rows: Option<u64>,
    pub status: ExportStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ExportStatus {
    Running,
    Writing,
    Done,
    Error,
    Cancelled,
}

pub const DATABASE_EXPORT_ROW_LIMIT: usize = 10_000;
pub const DATABASE_EXPORT_PAGE_SIZE: usize = 500;
pub const DATABASE_EXPORT_INSERT_BATCH_SIZE: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
struct PostgresExportSequence {
    name: String,
    data_type: String,
    start_value: String,
    min_value: String,
    max_value: String,
    increment: String,
    cycle: bool,
    cache_value: String,
    last_value: Option<String>,
    owner_table: Option<String>,
    owner_column: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedTableSql {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualified_table_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ddl: Option<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub column_types: Vec<Option<String>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExportInsertStatementsOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualified_table_name: Option<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub column_types: Vec<Option<String>>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildExportSqlInsertOptions {
    #[serde(flatten)]
    pub insert: BuildExportInsertStatementsOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildDatabaseSqlExportOptions {
    pub database_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_at: Option<String>,
    #[serde(default)]
    pub tables: Vec<ExportedTableSql>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_limit_per_table: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insert_batch_size: Option<usize>,
    /// Optional connection info for FK-aware table ordering.
    /// When set, the caller should sort tables by dependency before passing them
    /// to `build_database_sql_export`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
}

pub fn format_export_sql_literal(value: &Value) -> String {
    if value.is_null() {
        return "NULL".to_string();
    }
    if let Some(number) = value.as_number() {
        return number.to_string();
    }
    if let Some(value) = value.as_bool() {
        return if value { "TRUE" } else { "FALSE" }.to_string();
    }
    if let Some(arr) = value.as_array() {
        return format_pg_array_sql_literal(arr);
    }
    let text = value.as_str().map_or_else(|| value.to_string(), ToString::to_string);
    format!("'{}'", text.replace('\\', "\\\\").replace('\'', "''"))
}

fn format_export_sql_literal_typed(
    value: &Value,
    database_type: Option<DatabaseType>,
    column_type: Option<&str>,
) -> String {
    if matches!(database_type, Some(DatabaseType::Mysql)) && column_type.is_some_and(is_mysql_bit_type) {
        return format_mysql_bit_literal(value);
    }
    if let Some(arr) = value.as_array() {
        if matches!(database_type, Some(DatabaseType::ClickHouse) | Some(DatabaseType::Databend)) {
            return format_ch_array_sql_literal(arr);
        }
    }
    format_export_sql_literal(value)
}

fn is_mysql_bit_type(column_type: &str) -> bool {
    let trimmed = column_type.trim();
    let lower = trimmed.to_ascii_lowercase();
    lower == "bit" || lower.starts_with("bit(") || lower.starts_with("bit ")
}

fn format_mysql_bit_literal(value: &Value) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(value) => {
            if *value {
                "b'1'".to_string()
            } else {
                "b'0'".to_string()
            }
        }
        Value::Number(value) => {
            let s = value.to_string();
            if s == "0" || s == "1" {
                format!("b'{s}'")
            } else {
                s
            }
        }
        Value::String(value) => {
            let trimmed = value.trim();
            if trimmed.eq_ignore_ascii_case("true") {
                return "b'1'".to_string();
            }
            if trimmed.eq_ignore_ascii_case("false") {
                return "b'0'".to_string();
            }
            if trimmed == "0" || trimmed == "1" {
                return format!("b'{trimmed}'");
            }
            if !trimmed.is_empty() && trimmed.bytes().all(|byte| byte == b'0' || byte == b'1') {
                return format!("b'{trimmed}'");
            }
            format!("b'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
        }
        other => format_export_sql_literal(other),
    }
}

pub fn build_export_insert_statements(options: BuildExportInsertStatementsOptions) -> Result<Vec<String>, String> {
    if options.columns.is_empty() || options.rows.is_empty() {
        return Ok(Vec::new());
    }

    let table = export_qualified_table_name(
        options.database_type,
        options.schema.as_deref(),
        options.table_name.as_deref(),
        options.qualified_table_name.as_deref(),
    )?;
    let insert_columns = options
        .columns
        .iter()
        .enumerate()
        .filter(|(index, _)| {
            !is_postgres_tsvector_export_column(
                options.database_type,
                options.column_types.get(*index).and_then(|value| value.as_deref()),
            )
        })
        .collect::<Vec<_>>();
    if insert_columns.is_empty() {
        return Ok(Vec::new());
    }
    let batch_size = options.batch_size.unwrap_or(DATABASE_EXPORT_INSERT_BATCH_SIZE).max(1);
    let columns = insert_columns
        .iter()
        .map(|(_, column)| quote_table_identifier(options.database_type, column))
        .collect::<Vec<_>>()
        .join(", ");
    let mut statements = Vec::new();

    for rows in options.rows.chunks(batch_size) {
        let values = rows
            .iter()
            .map(|row| {
                let values = insert_columns
                    .iter()
                    .map(|(index, _)| {
                        let value = row.get(*index).unwrap_or(&Value::Null);
                        format_export_sql_literal_typed(
                            value,
                            options.database_type,
                            options.column_types.get(*index).and_then(|value| value.as_deref()),
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("({values})")
            })
            .collect::<Vec<_>>()
            .join(", ");
        statements.push(format!("INSERT INTO {table} ({columns}) VALUES {values};"));
    }

    Ok(statements)
}

fn is_postgres_tsvector_export_column(database_type: Option<DatabaseType>, column_type: Option<&str>) -> bool {
    database_type == Some(DatabaseType::Postgres)
        && column_type
            .map(|column_type| {
                let normalized = column_type.trim().trim_matches('"').to_ascii_lowercase();
                normalized == "tsvector" || normalized.ends_with(".tsvector")
            })
            .unwrap_or(false)
}

pub fn build_export_sql_insert(options: BuildExportSqlInsertOptions) -> Result<String, String> {
    build_export_insert_statements(options.insert).map(|statements| statements.join("\n"))
}

pub fn build_database_sql_export(options: BuildDatabaseSqlExportOptions) -> Result<String, String> {
    let exported_at = options.exported_at.unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let row_limit = options.row_limit_per_table.unwrap_or(DATABASE_EXPORT_ROW_LIMIT);
    let insert_batch_size = options.insert_batch_size.unwrap_or(DATABASE_EXPORT_INSERT_BATCH_SIZE);
    let mut lines = vec![
        "-- DBX database export".to_string(),
        format!("-- Database: {}", options.database_name),
        format!("-- Exported at: {exported_at}"),
        format!("-- Row limit per table: {row_limit}"),
        String::new(),
    ];

    for table in options.tables {
        if let Some(ddl) = table.ddl.as_ref().map(|ddl| ddl.trim()).filter(|ddl| !ddl.is_empty()) {
            let ddl = normalize_export_table_ddl(ddl, table.database_type);
            lines.push(format!("-- Structure for {}", table.display_name));
            lines.push(format!("{};", ddl.trim_end_matches(';')));
            lines.push(String::new());
        }

        lines.push(format!("-- Data for {}", table.display_name));
        if table.truncated {
            lines.push(format!("-- Exported rows: {} (truncated at {row_limit})", table.rows.len()));
        } else {
            lines.push(format!("-- Exported rows: {}", table.rows.len()));
        }

        let inserts = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: table.database_type,
            schema: table.schema,
            table_name: table.table_name,
            qualified_table_name: table.qualified_table_name,
            columns: table.columns,
            column_types: table.column_types,
            rows: table.rows,
            batch_size: Some(insert_batch_size),
        })?;
        if inserts.is_empty() {
            lines.push("-- No rows".to_string());
        } else {
            lines.extend(inserts);
        }
        lines.push(String::new());
    }

    Ok(lines.join("\n"))
}

fn export_qualified_table_name(
    database_type: Option<DatabaseType>,
    schema: Option<&str>,
    table_name: Option<&str>,
    qualified_name: Option<&str>,
) -> Result<String, String> {
    if let Some(name) = qualified_name.filter(|name| !name.trim().is_empty()) {
        return Ok(name.to_string());
    }
    let table_name = table_name
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "tableName is required when qualifiedTableName is not provided".to_string())?;
    Ok(qualified_table_name(database_type, schema, table_name))
}

fn normalize_export_table_ddl(ddl: &str, database_type: Option<DatabaseType>) -> String {
    if database_type != Some(DatabaseType::Mysql) {
        return ddl.to_string();
    }

    static LEGACY_MYSQL_ROW_FORMAT_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)\bROW_FORMAT\s*=\s*(COMPACT|REDUNDANT)\b").unwrap());

    LEGACY_MYSQL_ROW_FORMAT_RE.replace_all(ddl, "ROW_FORMAT=DYNAMIC").into_owned()
}

fn postgres_sequence_qualified_name(schema: &str, sequence_name: &str) -> String {
    let db_type = DatabaseType::Postgres;
    if schema.trim().is_empty() {
        quote_identifier(sequence_name, &db_type)
    } else {
        format!("{}.{}", quote_identifier(schema, &db_type), quote_identifier(sequence_name, &db_type))
    }
}

fn postgres_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn generate_postgres_sequence_create_ddl(sequence: &PostgresExportSequence, schema: &str) -> String {
    let qualified_name = postgres_sequence_qualified_name(schema, &sequence.name);
    let cycle = if sequence.cycle { "CYCLE" } else { "NO CYCLE" };
    format!(
        "CREATE SEQUENCE IF NOT EXISTS {qualified_name}\n  AS {data_type}\n  START WITH {start_value}\n  INCREMENT BY {increment}\n  MINVALUE {min_value}\n  MAXVALUE {max_value}\n  CACHE {cache_value}\n  {cycle}",
        data_type = sequence.data_type,
        start_value = sequence.start_value,
        increment = sequence.increment,
        min_value = sequence.min_value,
        max_value = sequence.max_value,
        cache_value = sequence.cache_value,
    )
}

fn generate_postgres_sequence_owner_ddl(sequence: &PostgresExportSequence, schema: &str) -> Option<String> {
    let owner_table = sequence.owner_table.as_deref()?;
    let owner_column = sequence.owner_column.as_deref()?;
    Some(format!(
        "ALTER SEQUENCE {} OWNED BY {}.{}",
        postgres_sequence_qualified_name(schema, &sequence.name),
        crate::transfer::qualified_table(owner_table, schema, &DatabaseType::Postgres),
        quote_identifier(owner_column, &DatabaseType::Postgres)
    ))
}

fn generate_postgres_sequence_setval_sql(sequence: &PostgresExportSequence, schema: &str) -> Option<String> {
    let last_value = sequence.last_value.as_deref()?.trim();
    if last_value.is_empty() {
        return None;
    }

    let sequence_literal = postgres_string_literal(&postgres_sequence_qualified_name(schema, &sequence.name));
    match (sequence.owner_table.as_deref(), sequence.owner_column.as_deref()) {
        (Some(owner_table), Some(owner_column)) => {
            let owner_table = crate::transfer::qualified_table(owner_table, schema, &DatabaseType::Postgres);
            let owner_column = quote_identifier(owner_column, &DatabaseType::Postgres);
            Some(format!(
                "SELECT setval({sequence_literal}, GREATEST(COALESCE(MAX({owner_column}), {last_value}), {last_value}), true) FROM {owner_table}"
            ))
        }
        _ => Some(format!("SELECT setval({sequence_literal}, {last_value}, true)")),
    }
}

async fn list_postgres_export_sequences(
    state: &crate::connection::AppState,
    pool_key: &str,
    schema: &str,
    selected_tables: &[String],
    include_objects: bool,
) -> Result<Vec<PostgresExportSequence>, String> {
    let pool = {
        let connections = state.connections.read().await;
        match connections.get(pool_key) {
            Some(crate::connection::PoolKind::Postgres(pool)) => pool.clone(),
            _ => return Ok(Vec::new()),
        }
    };
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let rows = client
        .query(
            "SELECT c.relname, \
              COALESCE(format_type(s.seqtypid, NULL), 'bigint'), \
              COALESCE(s.seqstart::text, '1'), \
              COALESCE(s.seqmin::text, '1'), \
              COALESCE(s.seqmax::text, '9223372036854775807'), \
              COALESCE(s.seqincrement::text, '1'), \
              COALESCE(s.seqcycle, false), \
              COALESCE(s.seqcache::text, '1'), \
              t.relname, \
              a.attname \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_sequence s ON s.seqrelid = c.oid \
             LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass \
               AND d.objid = c.oid \
               AND d.refclassid = 'pg_class'::regclass \
               AND d.deptype IN ('a', 'i') \
             LEFT JOIN pg_class t ON t.oid = d.refobjid \
             LEFT JOIN pg_namespace tn ON tn.oid = t.relnamespace AND tn.nspname = n.nspname \
             LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid \
             WHERE c.relkind = 'S' AND n.nspname = $1 \
             ORDER BY c.relname",
            &[&schema],
        )
        .await
        .map_err(|e| e.to_string())?;

    let selected: HashSet<&str> = selected_tables.iter().map(String::as_str).collect();
    let mut sequences = rows
        .iter()
        .map(|row| PostgresExportSequence {
            name: row.get::<_, String>(0),
            data_type: row.get::<_, String>(1),
            start_value: row.get::<_, String>(2),
            min_value: row.get::<_, String>(3),
            max_value: row.get::<_, String>(4),
            increment: row.get::<_, String>(5),
            cycle: row.get::<_, bool>(6),
            cache_value: row.get::<_, String>(7),
            last_value: None,
            owner_table: row.get::<_, Option<String>>(8),
            owner_column: row.get::<_, Option<String>>(9),
        })
        .filter(|sequence| {
            selected.is_empty()
                || sequence.owner_table.as_deref().map(|owner_table| selected.contains(owner_table)).unwrap_or(false)
        })
        .filter(|sequence| sequence.owner_table.is_some() || (include_objects && selected.is_empty()))
        .collect::<Vec<_>>();

    if sequences.is_empty() {
        return Ok(sequences);
    }

    if let Ok(rows) = client
        .query(
            "SELECT c.relname, pg_sequence_last_value(c.oid)::text \
             FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind = 'S' AND n.nspname = $1",
            &[&schema],
        )
        .await
    {
        for row in rows {
            let name: String = row.get(0);
            let last_value: Option<String> = row.get(1);
            if let Some(sequence) = sequences.iter_mut().find(|sequence| sequence.name == name) {
                sequence.last_value = last_value;
            }
        }
    }

    Ok(sequences)
}

pub async fn is_export_cancelled(export_id: &str) -> bool {
    EXPORT_CANCELLED.read().await.contains(export_id)
}

pub async fn set_export_cancelled(export_id: &str) {
    EXPORT_CANCELLED.write().await.insert(export_id.to_string());
}

pub async fn clear_export_cancelled(export_id: &str) {
    EXPORT_CANCELLED.write().await.remove(export_id);
}

pub async fn export_database_sql_core(
    state: &crate::connection::AppState,
    request: &DatabaseExportRequest,
    on_progress: impl Fn(ExportProgress),
) -> Result<(), String> {
    // 1. Get database type
    let db_type = state
        .configs
        .read()
        .await
        .get(&request.connection_id)
        .map(|c| c.db_type)
        .ok_or_else(|| format!("Connection config not found: {}", request.connection_id))?;

    // 2. Get pool
    let pool_key = state.get_or_create_pool(&request.connection_id, Some(&request.database)).await?;

    // 3. List tables
    let all_tables = crate::schema::list_tables_core(
        state,
        &request.connection_id,
        &request.database,
        &request.schema,
        None,
        None,
        None,
        None,
    )
    .await?;
    let all_tables = filter_selected_table_infos(all_tables, &request.selected_tables);

    // 4. Create file
    let mut file = std::fs::File::create(&request.file_path).map_err(|e| format!("Failed to write file: {e}"))?;

    // 5. Write header
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    writeln!(file, "-- Database export: {}", request.database).map_err(|e| format!("Failed to write file: {e}"))?;
    writeln!(file, "-- Date: {timestamp}").map_err(|e| format!("Failed to write file: {e}"))?;
    writeln!(file, "-- Generated by DBX").map_err(|e| format!("Failed to write file: {e}"))?;
    writeln!(file).map_err(|e| format!("Failed to write file: {e}"))?;

    // 6. For MySQL: disable foreign key checks
    if matches!(db_type, DatabaseType::Mysql) {
        writeln!(file, "SET FOREIGN_KEY_CHECKS = 0;\n").map_err(|e| format!("Failed to write file: {e}"))?;
    }

    // 7. Separate tables and views
    let mut tables: Vec<_> = all_tables.iter().filter(|t| !t.table_type.contains("VIEW")).collect();
    let views: Vec<_> = all_tables.iter().filter(|t| t.table_type.contains("VIEW")).collect();
    let postgres_sequences = if request.include_structure && matches!(db_type, DatabaseType::Postgres) {
        match list_postgres_export_sequences(
            state,
            &pool_key,
            &request.schema,
            &request.selected_tables,
            request.include_objects,
        )
        .await
        {
            Ok(sequences) => sequences,
            Err(e) => {
                writeln!(file, "-- ERROR exporting sequences: {e}")
                    .map_err(|e| format!("Failed to write file: {e}"))?;
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    // Sort tables by foreign key dependency so referenced (parent) tables are
    // exported before referencing (child) tables.
    if tables.len() > 1 {
        let table_names: Vec<String> = tables.iter().map(|t| t.name.clone()).collect();
        if let Ok(sorted_names) = crate::transfer::sort_tables_by_fk_dependency(
            state,
            &request.connection_id,
            &request.database,
            &request.schema,
            &table_names,
            true,
        )
        .await
        {
            tables.sort_by_key(|t| sorted_names.iter().position(|n| n == &t.name).unwrap_or(usize::MAX));
        }
    }

    // 8. Calculate total objects
    let mut total_objects = tables.len() + views.len() + postgres_sequences.len();

    // We'll add procedures/functions count later if include_objects
    let mut procedures: Vec<String> = Vec::new();
    let mut functions: Vec<String> = Vec::new();

    if request.include_objects && request.selected_tables.is_empty() {
        if let Ok(objects) =
            crate::schema::list_objects_core(state, &request.connection_id, &request.database, &request.schema).await
        {
            for obj in &objects {
                let ot = obj.object_type.to_uppercase();
                if ot.contains("PROCEDURE") {
                    procedures.push(obj.name.clone());
                } else if ot.contains("FUNCTION") {
                    functions.push(obj.name.clone());
                }
            }
        }
        total_objects += procedures.len() + functions.len();
    }

    let mut object_index: usize = 0;

    // Export tables
    let batch_size = if request.batch_size == 0 { 1000 } else { request.batch_size };

    for sequence in postgres_sequences.iter().filter(|sequence| sequence.owner_table.is_none()) {
        if is_export_cancelled(&request.export_id).await {
            return Err("Export cancelled".to_string());
        }

        on_progress(ExportProgress {
            export_id: request.export_id.clone(),
            current_object: sequence.name.clone(),
            object_index,
            total_objects,
            rows_exported: 0,
            total_rows: None,
            status: ExportStatus::Running,
            error: None,
        });

        writeln!(file, "{};\n", generate_postgres_sequence_create_ddl(sequence, &request.schema))
            .map_err(|e| format!("Failed to write file: {e}"))?;
        object_index += 1;
    }

    for table_info in &tables {
        // Check cancellation
        if is_export_cancelled(&request.export_id).await {
            on_progress(ExportProgress {
                export_id: request.export_id.clone(),
                current_object: table_info.name.clone(),
                object_index,
                total_objects,
                rows_exported: 0,
                total_rows: None,
                status: ExportStatus::Cancelled,
                error: None,
            });
            return Ok(());
        }

        let table_name = &table_info.name;

        // Emit Running progress
        on_progress(ExportProgress {
            export_id: request.export_id.clone(),
            current_object: table_name.clone(),
            object_index,
            total_objects,
            rows_exported: 0,
            total_rows: None,
            status: ExportStatus::Running,
            error: None,
        });

        // Export structure
        if request.include_structure {
            if request.drop_table_if_exists {
                writeln!(file, "{}\n", drop_table_if_exists_sql(table_name, &request.schema, &db_type))
                    .map_err(|e| format!("Failed to write file: {e}"))?;
            }
            for sequence in postgres_sequences
                .iter()
                .filter(|sequence| sequence.owner_table.as_deref() == Some(table_name.as_str()))
            {
                on_progress(ExportProgress {
                    export_id: request.export_id.clone(),
                    current_object: sequence.name.clone(),
                    object_index,
                    total_objects,
                    rows_exported: 0,
                    total_rows: None,
                    status: ExportStatus::Running,
                    error: None,
                });

                writeln!(file, "{};\n", generate_postgres_sequence_create_ddl(sequence, &request.schema))
                    .map_err(|e| format!("Failed to write file: {e}"))?;
                object_index += 1;
            }
            match crate::schema::get_table_ddl_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                table_name,
                None,
            )
            .await
            {
                Ok(ddl) => {
                    let ddl = normalize_export_table_ddl(&ddl, Some(db_type));
                    writeln!(file, "{};\n", ddl).map_err(|e| format!("Failed to write file: {e}"))?;
                }
                Err(e) => {
                    writeln!(file, "-- ERROR exporting table {table_name}: {e}")
                        .map_err(|e| format!("Failed to write file: {e}"))?;
                }
            }
        }

        // Export data
        if request.include_data {
            // Get columns
            let columns = match crate::schema::get_columns_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                table_name,
            )
            .await
            {
                Ok(cols) => cols,
                Err(e) => {
                    writeln!(file, "-- ERROR exporting table {table_name}: {e}")
                        .map_err(|e| format!("Failed to write file: {e}"))?;
                    object_index += 1;
                    continue;
                }
            };
            let col_names = columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>();
            let col_types = columns.iter().map(|c| Some(c.data_type.clone())).collect::<Vec<_>>();

            if !col_names.is_empty() {
                // Get row count
                let count_query = crate::transfer::count_sql(table_name, &request.schema, &db_type);
                let total_rows = match crate::transfer::execute_on_pool(state, &pool_key, &count_query).await {
                    Ok(result) => result.rows.first().and_then(|r| r.first()).and_then(|v| match v {
                        serde_json::Value::Number(n) => n.as_u64(),
                        serde_json::Value::String(s) => s.parse::<u64>().ok(),
                        _ => None,
                    }),
                    Err(_) => None,
                };

                // Loop batches
                let mut offset: u64 = 0;
                let mut rows_exported: u64 = 0;

                loop {
                    // Check cancellation between batches
                    if is_export_cancelled(&request.export_id).await {
                        on_progress(ExportProgress {
                            export_id: request.export_id.clone(),
                            current_object: table_name.clone(),
                            object_index,
                            total_objects,
                            rows_exported,
                            total_rows,
                            status: ExportStatus::Cancelled,
                            error: None,
                        });
                        return Ok(());
                    }

                    let sql = crate::transfer::pagination_sql(
                        &col_names,
                        table_name,
                        &request.schema,
                        &db_type,
                        offset,
                        batch_size,
                    );

                    let result = match crate::transfer::execute_on_pool(state, &pool_key, &sql).await {
                        Ok(r) => r,
                        Err(e) => {
                            writeln!(file, "-- ERROR exporting data for table {table_name}: {e}")
                                .map_err(|e| format!("Failed to write file: {e}"))?;
                            break;
                        }
                    };

                    let row_count = result.rows.len();
                    if row_count == 0 {
                        break;
                    }

                    let insert_sql = crate::transfer::generate_insert_typed(
                        &col_names,
                        &col_types,
                        &result.rows,
                        table_name,
                        &request.schema,
                        &db_type,
                    );

                    if !insert_sql.is_empty() {
                        writeln!(file, "{};\n", insert_sql).map_err(|e| format!("Failed to write file: {e}"))?;
                    }

                    rows_exported += row_count as u64;
                    offset += row_count as u64;

                    on_progress(ExportProgress {
                        export_id: request.export_id.clone(),
                        current_object: table_name.clone(),
                        object_index,
                        total_objects,
                        rows_exported,
                        total_rows,
                        status: ExportStatus::Running,
                        error: None,
                    });

                    if row_count < batch_size {
                        break;
                    }
                }
            }
        }

        object_index += 1;
    }

    if request.include_structure && !postgres_sequences.is_empty() {
        for sequence in &postgres_sequences {
            if let Some(sql) = generate_postgres_sequence_owner_ddl(sequence, &request.schema) {
                writeln!(file, "{};\n", sql).map_err(|e| format!("Failed to write file: {e}"))?;
            }
        }
        for sequence in &postgres_sequences {
            if let Some(sql) = generate_postgres_sequence_setval_sql(sequence, &request.schema) {
                writeln!(file, "{};\n", sql).map_err(|e| format!("Failed to write file: {e}"))?;
            }
        }
    }

    // Export views (if include_objects)
    if request.include_objects {
        for view_info in &views {
            if is_export_cancelled(&request.export_id).await {
                return Err("Export cancelled".to_string());
            }

            let view_name = &view_info.name;

            on_progress(ExportProgress {
                export_id: request.export_id.clone(),
                current_object: view_name.clone(),
                object_index,
                total_objects,
                rows_exported: 0,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
            });

            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                view_name,
                crate::db::ObjectSourceKind::View,
            )
            .await
            {
                Ok(obj_source) => {
                    if !obj_source.source.is_empty() {
                        writeln!(file, "{};\n", obj_source.source).map_err(|e| format!("Failed to write file: {e}"))?;
                    }
                }
                Err(e) => {
                    writeln!(file, "-- ERROR exporting view {view_name}: {e}")
                        .map_err(|e| format!("Failed to write file: {e}"))?;
                }
            }

            object_index += 1;
        }

        // Export procedures
        for proc_name in &procedures {
            if is_export_cancelled(&request.export_id).await {
                return Err("Export cancelled".to_string());
            }

            on_progress(ExportProgress {
                export_id: request.export_id.clone(),
                current_object: proc_name.clone(),
                object_index,
                total_objects,
                rows_exported: 0,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
            });

            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                proc_name,
                crate::db::ObjectSourceKind::Procedure,
            )
            .await
            {
                Ok(obj_source) => {
                    if !obj_source.source.is_empty() {
                        writeln!(file, "{};\n", obj_source.source).map_err(|e| format!("Failed to write file: {e}"))?;
                    }
                }
                Err(e) => {
                    writeln!(file, "-- ERROR exporting procedure {proc_name}: {e}")
                        .map_err(|e| format!("Failed to write file: {e}"))?;
                }
            }

            object_index += 1;
        }

        // Export functions
        for func_name in &functions {
            if is_export_cancelled(&request.export_id).await {
                return Err("Export cancelled".to_string());
            }

            on_progress(ExportProgress {
                export_id: request.export_id.clone(),
                current_object: func_name.clone(),
                object_index,
                total_objects,
                rows_exported: 0,
                total_rows: None,
                status: ExportStatus::Running,
                error: None,
            });

            match crate::schema::get_object_source_core(
                state,
                &request.connection_id,
                &request.database,
                &request.schema,
                func_name,
                crate::db::ObjectSourceKind::Function,
            )
            .await
            {
                Ok(obj_source) => {
                    if !obj_source.source.is_empty() {
                        writeln!(file, "{};\n", obj_source.source).map_err(|e| format!("Failed to write file: {e}"))?;
                    }
                }
                Err(e) => {
                    writeln!(file, "-- ERROR exporting function {func_name}: {e}")
                        .map_err(|e| format!("Failed to write file: {e}"))?;
                }
            }

            object_index += 1;
        }
    }

    // For MySQL: re-enable foreign key checks
    if matches!(db_type, DatabaseType::Mysql) {
        writeln!(file, "SET FOREIGN_KEY_CHECKS = 1;").map_err(|e| format!("Failed to write file: {e}"))?;
    }

    // Emit Done progress
    on_progress(ExportProgress {
        export_id: request.export_id.clone(),
        current_object: String::new(),
        object_index,
        total_objects,
        rows_exported: 0,
        total_rows: None,
        status: ExportStatus::Done,
        error: None,
    });

    Ok(())
}

fn filter_selected_table_infos(
    tables: Vec<crate::types::TableInfo>,
    selected_tables: &[String],
) -> Vec<crate::types::TableInfo> {
    if selected_tables.is_empty() {
        return tables;
    }
    let selected: HashSet<&str> = selected_tables.iter().map(String::as_str).collect();
    tables.into_iter().filter(|table| selected.contains(table.name.as_str())).collect()
}

fn drop_table_if_exists_sql(table_name: &str, schema: &str, db_type: &DatabaseType) -> String {
    format!("DROP TABLE IF EXISTS {};", crate::transfer::qualified_table(table_name, schema, db_type))
}

#[cfg(test)]
mod tests {
    use super::{
        build_database_sql_export, build_export_insert_statements, drop_table_if_exists_sql,
        filter_selected_table_infos, format_export_sql_literal, generate_postgres_sequence_create_ddl,
        generate_postgres_sequence_owner_ddl, generate_postgres_sequence_setval_sql, normalize_export_table_ddl,
        BuildDatabaseSqlExportOptions, BuildExportInsertStatementsOptions, ExportedTableSql, PostgresExportSequence,
        DATABASE_EXPORT_INSERT_BATCH_SIZE, DATABASE_EXPORT_ROW_LIMIT,
    };
    use crate::models::connection::DatabaseType;
    use crate::types::TableInfo;
    use serde_json::{json, Value};

    fn table(name: &str, table_type: &str) -> TableInfo {
        TableInfo {
            name: name.to_string(),
            table_type: table_type.to_string(),
            comment: None,
            parent_schema: None,
            parent_name: None,
        }
    }

    #[test]
    fn filters_export_tables_by_selected_names() {
        let tables = vec![table("users", "TABLE"), table("orders", "TABLE"), table("active_users", "VIEW")];

        let filtered = filter_selected_table_infos(tables, &["active_users".to_string(), "users".to_string()]);

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["users", "active_users"]);
    }

    #[test]
    fn keeps_all_export_tables_when_selection_is_empty() {
        let tables = vec![table("users", "TABLE"), table("orders", "TABLE")];

        let filtered = filter_selected_table_infos(tables.clone(), &[]);

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["users", "orders"]);
    }

    #[test]
    fn builds_drop_table_if_exists_with_qualified_mysql_name() {
        let sql = drop_table_if_exists_sql("users", "app", &DatabaseType::Mysql);

        assert_eq!(sql, "DROP TABLE IF EXISTS `users`;");
    }

    #[test]
    fn builds_drop_table_if_exists_without_empty_schema() {
        let sql = drop_table_if_exists_sql("users", "", &DatabaseType::Postgres);

        assert_eq!(sql, "DROP TABLE IF EXISTS \"users\";");
    }

    #[test]
    fn formats_sql_literals_for_export_inserts() {
        assert_eq!(format_export_sql_literal(&Value::Null), "NULL");
        assert_eq!(format_export_sql_literal(&json!(42)), "42");
        assert_eq!(format_export_sql_literal(&json!(true)), "TRUE");
        assert_eq!(format_export_sql_literal(&json!("O'Hara")), "'O''Hara'");
    }

    #[test]
    fn builds_batched_insert_statements_for_export() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: Some("users".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "name".to_string()],
            column_types: Vec::new(),
            rows: vec![vec![json!(1), json!("Ada")], vec![json!(2), json!("O'Hara")], vec![json!(3), json!("Linus")]],
            batch_size: Some(2),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec![
                "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Ada'), (2, 'O''Hara');",
                "INSERT INTO `users` (`id`, `name`) VALUES (3, 'Linus');",
            ]
        );
    }

    #[test]
    fn mysql_bit_columns_export_without_quoted_string_values() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Mysql),
            schema: None,
            table_name: Some("flags".to_string()),
            qualified_table_name: None,
            columns: vec!["enabled".to_string(), "mask".to_string(), "label".to_string()],
            column_types: vec![Some("bit(1)".to_string()), Some("BIT(4)".to_string()), Some("varchar(20)".to_string())],
            rows: vec![vec![json!("1"), json!("1010"), json!("1010")], vec![json!(false), json!(3), json!("off")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(
            statements,
            vec!["INSERT INTO `flags` (`enabled`, `mask`, `label`) VALUES (b'1', b'1010', '1010'), (b'0', 3, 'off');"]
        );
    }

    #[test]
    fn postgres_tsvector_columns_are_omitted_from_sql_insert_export() {
        let statements = build_export_insert_statements(BuildExportInsertStatementsOptions {
            database_type: Some(DatabaseType::Postgres),
            schema: Some("public".to_string()),
            table_name: Some("articles".to_string()),
            qualified_table_name: None,
            columns: vec!["id".to_string(), "title".to_string(), "search_vector".to_string()],
            column_types: vec![Some("integer".to_string()), Some("text".to_string()), Some("tsvector".to_string())],
            rows: vec![vec![json!(1), json!("Hello"), json!("'hello':1A")]],
            batch_size: Some(10),
        })
        .unwrap();

        assert_eq!(statements, vec!["INSERT INTO \"public\".\"articles\" (\"id\", \"title\") VALUES (1, 'Hello');"]);
    }

    #[test]
    fn builds_database_sql_export_with_ddl_before_data() {
        let sql = build_database_sql_export(BuildDatabaseSqlExportOptions {
            database_name: "app".to_string(),
            exported_at: Some("2026-05-02T00:00:00.000Z".to_string()),
            tables: vec![ExportedTableSql {
                display_name: "users".to_string(),
                database_type: Some(DatabaseType::Mysql),
                schema: None,
                table_name: Some("users".to_string()),
                qualified_table_name: None,
                ddl: Some("CREATE TABLE `users` (`id` int);".to_string()),
                columns: vec!["id".to_string()],
                column_types: Vec::new(),
                rows: vec![vec![json!(1)]],
                truncated: true,
            }],
            row_limit_per_table: Some(DATABASE_EXPORT_ROW_LIMIT),
            insert_batch_size: Some(DATABASE_EXPORT_INSERT_BATCH_SIZE),
            connection_id: None,
            database: None,
            schema: None,
        })
        .unwrap();

        assert_eq!(
            sql,
            [
                "-- DBX database export".to_string(),
                "-- Database: app".to_string(),
                "-- Exported at: 2026-05-02T00:00:00.000Z".to_string(),
                format!("-- Row limit per table: {DATABASE_EXPORT_ROW_LIMIT}"),
                String::new(),
                "-- Structure for users".to_string(),
                "CREATE TABLE `users` (`id` int);".to_string(),
                String::new(),
                "-- Data for users".to_string(),
                format!("-- Exported rows: 1 (truncated at {DATABASE_EXPORT_ROW_LIMIT})"),
                "INSERT INTO `users` (`id`) VALUES (1);".to_string(),
                String::new(),
            ]
            .join("\n")
        );
    }

    #[test]
    fn normalizes_legacy_mysql_row_format_for_export_compatibility() {
        let ddl = "CREATE TABLE `wide_table` (\n  `payload` varchar(4096) DEFAULT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=COMPACT";

        let normalized = normalize_export_table_ddl(ddl, Some(DatabaseType::Mysql));

        assert_eq!(
            normalized,
            "CREATE TABLE `wide_table` (\n  `payload` varchar(4096) DEFAULT NULL\n) ENGINE=InnoDB DEFAULT CHARSET=utf8 ROW_FORMAT=DYNAMIC"
        );
    }

    #[test]
    fn normalizes_lowercase_redundant_mysql_row_format_for_export_compatibility() {
        let ddl = "CREATE TABLE `wide_table` (`payload` varchar(4096)) engine=InnoDB row_format = redundant";

        let normalized = normalize_export_table_ddl(ddl, Some(DatabaseType::Mysql));

        assert_eq!(normalized, "CREATE TABLE `wide_table` (`payload` varchar(4096)) engine=InnoDB ROW_FORMAT=DYNAMIC");
    }

    #[test]
    fn preserves_non_legacy_or_non_mysql_row_formats() {
        let mysql_ddl = "CREATE TABLE `ok` (`payload` text) ENGINE=InnoDB ROW_FORMAT=COMPRESSED";
        let postgres_ddl = "CREATE TABLE users (payload text) ROW_FORMAT=COMPACT";

        assert_eq!(normalize_export_table_ddl(mysql_ddl, Some(DatabaseType::Mysql)), mysql_ddl);
        assert_eq!(normalize_export_table_ddl(postgres_ddl, Some(DatabaseType::Postgres)), postgres_ddl);
    }

    fn postgres_sequence(name: &str) -> PostgresExportSequence {
        PostgresExportSequence {
            name: name.to_string(),
            data_type: "integer".to_string(),
            start_value: "1".to_string(),
            min_value: "1".to_string(),
            max_value: "2147483647".to_string(),
            increment: "1".to_string(),
            cycle: false,
            cache_value: "1".to_string(),
            last_value: Some("42".to_string()),
            owner_table: Some("permissions".to_string()),
            owner_column: Some("id".to_string()),
        }
    }

    #[test]
    fn postgres_sequence_create_ddl_is_importable_before_table_ddl() {
        let ddl = generate_postgres_sequence_create_ddl(&postgres_sequence("permissions_id_seq"), "public");

        assert_eq!(
            ddl,
            [
                "CREATE SEQUENCE IF NOT EXISTS \"public\".\"permissions_id_seq\"",
                "  AS integer",
                "  START WITH 1",
                "  INCREMENT BY 1",
                "  MINVALUE 1",
                "  MAXVALUE 2147483647",
                "  CACHE 1",
                "  NO CYCLE",
            ]
            .join("\n")
        );
    }

    #[test]
    fn postgres_sequence_owner_and_setval_sql_are_qualified() {
        let sequence = postgres_sequence("permissions_id_seq");

        assert_eq!(
            generate_postgres_sequence_owner_ddl(&sequence, "public").as_deref(),
            Some("ALTER SEQUENCE \"public\".\"permissions_id_seq\" OWNED BY \"public\".\"permissions\".\"id\"")
        );
        assert_eq!(
            generate_postgres_sequence_setval_sql(&sequence, "public").as_deref(),
            Some(
                "SELECT setval('\"public\".\"permissions_id_seq\"', GREATEST(COALESCE(MAX(\"id\"), 42), 42), true) FROM \"public\".\"permissions\""
            )
        );
    }
}
