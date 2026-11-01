use serde::{Deserialize, Serialize};

use super::dialect::StructureDialect;
use super::types::{TableStructureSqlOptions, TableStructureSqlResult};
use super::util::qualified_table;
use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MysqlTableCharsetChange {
    pub charset: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
}

fn valid_mysql_charset_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.chars().all(|character| character.is_ascii_alphanumeric() || character == '_')
}

pub fn build_mysql_table_charset_change_sql(
    options: &TableStructureSqlOptions,
    change: MysqlTableCharsetChange,
) -> TableStructureSqlResult {
    if options.database_type != Some(DatabaseType::Mysql) || options.is_gaussdb_m_mode {
        return TableStructureSqlResult {
            statements: Vec::new(),
            warnings: vec![
                "Changing the table character set is supported only for native MySQL connections.".to_string()
            ],
        };
    }

    let charset = change.charset.trim();
    if !valid_mysql_charset_identifier(charset) {
        return TableStructureSqlResult {
            statements: Vec::new(),
            warnings: vec!["MySQL table character set contains invalid characters.".to_string()],
        };
    }

    let collation = change.collation.as_deref().map(str::trim).filter(|value| !value.is_empty());
    if let Some(collation) = collation {
        if !valid_mysql_charset_identifier(collation) {
            return TableStructureSqlResult {
                statements: Vec::new(),
                warnings: vec!["MySQL table collation contains invalid characters.".to_string()],
            };
        }
        let charset_prefix = collation.split_once('_').map(|(prefix, _)| prefix);
        if charset_prefix.is_some_and(|prefix| !prefix.eq_ignore_ascii_case(charset)) {
            return TableStructureSqlResult {
                statements: Vec::new(),
                warnings: vec![format!("MySQL collation {collation} does not belong to character set {charset}.")],
            };
        }
    }

    let table = qualified_table(StructureDialect::Mysql, options.schema.as_deref(), &options.table_name);
    let mut statement = format!("ALTER TABLE {table} DEFAULT CHARACTER SET {charset}");
    if let Some(collation) = collation {
        statement.push_str(" COLLATE ");
        statement.push_str(collation);
    }
    statement.push(';');

    TableStructureSqlResult { statements: vec![statement], warnings: Vec::new() }
}
