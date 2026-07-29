use std::path::PathBuf;

use dbx_core::sql_dialect::{
    descriptor::DialectKind, dialect_check, dialect_check_all, dialect_yaml::DialectYaml, DialectInfo,
};

#[tauri::command]
#[allow(dead_code)]
pub fn dialect_check_command(kind: String) -> Result<DialectInfo, String> {
    let db_type = match kind.to_ascii_lowercase().as_str() {
        "mysql" => DialectKind::Mysql,
        "postgres" | "postgresql" => DialectKind::Postgres,
        "sqlite" => DialectKind::Sqlite,
        "duckdb" => DialectKind::DuckDb,
        "sqlserver" | "mssql" => DialectKind::SqlServer,
        "oracle" => DialectKind::Oracle,
        "h2" => DialectKind::H2,
        "clickhouse" => DialectKind::ClickHouse,
        "manticore" | "manticoresearch" => DialectKind::ManticoreSearch,
        "informix" => DialectKind::Informix,
        "questdb" => DialectKind::Questdb,
        _ => return Err(format!("Unknown dialect: {kind}")),
    };
    Ok(dialect_check(db_type))
}

#[tauri::command]
#[allow(dead_code)]
pub fn dialect_check_all_command() -> Vec<DialectInfo> {
    dialect_check_all()
}

#[derive(serde::Serialize)]
#[allow(dead_code)]
pub struct DialectExportResult {
    pub files_written: Vec<String>,
    pub errors: Vec<String>,
}

/// Export all hardcoded dialect descriptors to YAML files.
/// Writes to `plugins/dialects/<label>.yaml` for each core dialect.
#[tauri::command]
#[allow(dead_code)]
pub fn dialect_export_command(target_dir: Option<String>) -> DialectExportResult {
    let dir = target_dir.filter(|d| !d.is_empty()).unwrap_or_else(|| "plugins/dialects".to_string());
    let dir_path = PathBuf::from(&dir);

    if let Err(e) = std::fs::create_dir_all(&dir_path) {
        return DialectExportResult {
            files_written: vec![],
            errors: vec![format!("Cannot create directory {dir}: {e}")],
        };
    }

    let kinds = [
        DialectKind::Mysql,
        DialectKind::Postgres,
        DialectKind::Sqlite,
        DialectKind::DuckDb,
        DialectKind::SqlServer,
        DialectKind::Oracle,
        DialectKind::H2,
        DialectKind::ClickHouse,
        DialectKind::ManticoreSearch,
        DialectKind::Informix,
        DialectKind::Questdb,
    ];

    let mut files_written = Vec::new();
    let mut errors = Vec::new();

    for kind in kinds {
        let yaml = DialectYaml::from_descriptor(kind);
        let file_name = format!("{}.yaml", kind.label());
        let file_path = dir_path.join(&file_name);

        match yaml.to_yaml_string() {
            Ok(content) => match std::fs::write(&file_path, &content) {
                Ok(()) => files_written.push(file_path.display().to_string()),
                Err(e) => errors.push(format!("Failed to write {}: {e}", file_path.display())),
            },
            Err(e) => errors.push(format!("Failed to serialize {}: {e}", kind.label())),
        }
    }

    DialectExportResult { files_written, errors }
}

/// Initialize a new dialect YAML descriptor with minimal required fields.
/// This creates a skeleton YAML file at `plugins/dialects/<label>.yaml`.
#[tauri::command]
#[allow(dead_code)]
pub fn dialect_init_command(
    name: String,
    _display_name: Option<String>,
    quote_char: Option<String>,
    max_length: Option<u32>,
    target_dir: Option<String>,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Dialect name is required".to_string());
    }

    let dir = target_dir.filter(|d| !d.is_empty()).unwrap_or_else(|| "plugins/dialects".to_string());
    let dir_path = PathBuf::from(&dir);
    std::fs::create_dir_all(&dir_path).map_err(|e| format!("Cannot create directory: {e}"))?;

    let label = name.to_ascii_lowercase().replace(' ', "_");
    let file_name = format!("dialect_{label}.yaml");
    let file_path = dir_path.join(&file_name);

    let quote = quote_char.unwrap_or_else(|| "\"".to_string());
    let max_len = max_length.unwrap_or(128);

    let content = format!(
        r#"dialect:
  name: "{name}"
  display_name: "{name}"
  versions: ""
identifier_rules:
  quote_char: "{quote}"
  max_length: {max_len}
"#,
    );

    std::fs::write(&file_path, &content).map_err(|e| format!("Failed to write {file_name}: {e}"))?;

    Ok(format!("Created dialect descriptor at {}", file_path.display()))
}

#[tauri::command]
pub async fn list_dialect_data_types(dialect_name: String) -> Vec<String> {
    dbx_core::sql_dialect::dialect_types::list_dialect_type_names(&dialect_name)
}
