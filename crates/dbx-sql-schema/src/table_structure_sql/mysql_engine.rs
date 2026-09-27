use super::dialect::StructureDialect;
use super::types::TableStructureSqlOptions;
use super::util::qualified_table;
use crate::models::connection::DatabaseType;

pub(super) fn validate_mysql_engine(options: &TableStructureSqlOptions) -> Vec<String> {
    let Some(engine) = options.mysql_engine.as_deref() else {
        return Vec::new();
    };
    let engine = engine.trim();
    if options.database_type != Some(DatabaseType::Mysql) || options.is_gaussdb_m_mode {
        return vec!["Changing the table engine is supported only for native MySQL connections.".to_string()];
    }
    if engine.is_empty() {
        return vec!["MySQL table engine is required.".to_string()];
    }
    if engine.len() > 64 || !engine.chars().all(|character| character.is_ascii_alphanumeric() || character == '_') {
        return vec!["MySQL table engine contains invalid characters.".to_string()];
    }
    Vec::new()
}

pub(super) fn build_mysql_engine_change_sql(options: &TableStructureSqlOptions) -> Vec<String> {
    let Some(engine) = options.mysql_engine.as_deref().map(str::trim).filter(|engine| !engine.is_empty()) else {
        return Vec::new();
    };
    let table = qualified_table(StructureDialect::Mysql, options.schema.as_deref(), &options.table_name);
    vec![format!("ALTER TABLE {table} ENGINE = {engine};")]
}

pub(super) fn append_mysql_table_option(statement: &mut String, option: &str) {
    if statement.ends_with(';') {
        statement.pop();
    }
    statement.push(' ');
    statement.push_str(option);
    statement.push(';');
}
