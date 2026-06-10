use crate::models::connection::DatabaseType;

use super::capabilities::{is_schema_aware, is_simple_informix_identifier, is_simple_jdbc_identifier};

pub fn qualified_table_name(database_type: Option<DatabaseType>, schema: Option<&str>, table_name: &str) -> String {
    if database_type == Some(DatabaseType::Iotdb) {
        let table_name = quote_table_identifier(database_type, table_name);
        let schema = schema.map(str::trim).filter(|schema| !schema.is_empty());
        if let Some(schema) = schema {
            if table_name == schema || table_name.starts_with(&format!("{schema}.")) {
                return table_name;
            }
            return format!("{}.{}", quote_table_identifier(database_type, schema), table_name);
        }
        return table_name;
    }
    if database_type.is_some_and(is_schema_aware)
        && database_type != Some(DatabaseType::Jdbc)
        && schema.is_some_and(|schema| !schema.trim().is_empty())
    {
        return format!(
            "{}.{}",
            quote_table_identifier(database_type, schema.unwrap()),
            quote_table_identifier(database_type, table_name)
        );
    }
    quote_table_identifier(database_type, table_name)
}

pub fn quote_table_identifier(database_type: Option<DatabaseType>, name: &str) -> String {
    match database_type {
        Some(DatabaseType::Iotdb) => name.to_string(),
        Some(DatabaseType::Jdbc) if is_simple_jdbc_identifier(name) => name.to_string(),
        Some(DatabaseType::Jdbc) => format!("`{}`", name.replace('`', "``")),
        Some(
            DatabaseType::Mysql
            | DatabaseType::Goldendb
            | DatabaseType::StarRocks
            | DatabaseType::Hive
            | DatabaseType::Databend
            | DatabaseType::Tdengine
            | DatabaseType::Access
            | DatabaseType::Bigquery,
        ) => {
            format!("`{}`", name.replace('`', "``"))
        }
        Some(DatabaseType::Informix) if is_simple_informix_identifier(name) => name.to_string(),
        Some(DatabaseType::Neo4j) => format!("`{}`", name.replace('`', "``")),
        Some(DatabaseType::SqlServer) => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

pub fn normalize_where_input(where_input: Option<&str>) -> String {
    let trimmed = where_input.unwrap_or("").trim().trim_end_matches(';').trim();
    let mut chars = trimmed.chars();
    let prefix = chars.by_ref().take(5).collect::<String>();
    if prefix.eq_ignore_ascii_case("where") {
        chars.as_str().trim().to_string()
    } else {
        trimmed.to_string()
    }
}

pub(crate) fn quote_transfer_identifier(name: &str, database_type: &DatabaseType) -> String {
    match database_type {
        DatabaseType::Mysql
        | DatabaseType::ClickHouse
        | DatabaseType::Doris
        | DatabaseType::StarRocks
        | DatabaseType::Hive => format!("`{}`", name.replace('`', "``")),
        DatabaseType::SqlServer => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('\"', "\"\"")),
    }
}

pub(crate) fn qualified_transfer_table(table_name: &str, schema: &str, database_type: &DatabaseType) -> String {
    let table = quote_transfer_identifier(table_name, database_type);
    if schema.is_empty() || matches!(database_type, DatabaseType::Mysql | DatabaseType::MongoDb) {
        table
    } else {
        format!("{}.{}", quote_transfer_identifier(schema, database_type), table)
    }
}
