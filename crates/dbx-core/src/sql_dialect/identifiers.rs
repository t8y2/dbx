use crate::models::connection::DatabaseType;
use percent_encoding::percent_decode_str;

use super::capabilities::{is_schema_aware, is_simple_informix_identifier};

pub const SQLSERVER_LINKED_SCHEMA_PREFIX: &str = "__dbx_sqlserver_linked__:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlServerLinkedSchemaRef {
    pub server: String,
    pub catalog: String,
    pub schema: String,
}

pub fn parse_sqlserver_linked_schema_ref(schema: &str) -> Option<SqlServerLinkedSchemaRef> {
    let payload = schema.strip_prefix(SQLSERVER_LINKED_SCHEMA_PREFIX)?;
    let mut parts = payload.split('|');
    let server = decode_linked_schema_part(parts.next()?)?;
    let catalog = decode_linked_schema_part(parts.next()?)?;
    let schema = decode_linked_schema_part(parts.next()?)?;
    if parts.next().is_some() || server.trim().is_empty() || catalog.trim().is_empty() || schema.trim().is_empty() {
        return None;
    }
    Some(SqlServerLinkedSchemaRef { server, catalog, schema })
}

pub fn sqlserver_linked_table_name(linked: &SqlServerLinkedSchemaRef, table_name: &str) -> String {
    [linked.server.as_str(), linked.catalog.as_str(), linked.schema.as_str(), table_name]
        .into_iter()
        .map(|part| quote_table_identifier(Some(DatabaseType::SqlServer), part))
        .collect::<Vec<_>>()
        .join(".")
}

fn decode_linked_schema_part(value: &str) -> Option<String> {
    percent_decode_str(value).decode_utf8().ok().map(|value| value.into_owned())
}

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
    let supports_qualifier = database_type.is_some_and(is_schema_aware)
        || matches!(
            database_type,
            Some(DatabaseType::Mysql | DatabaseType::Goldendb | DatabaseType::StarRocks | DatabaseType::Doris)
        );
    if supports_qualifier
        && database_type != Some(DatabaseType::Jdbc)
        && schema.is_some_and(|schema| !schema.trim().is_empty())
    {
        if database_type == Some(DatabaseType::SqlServer) {
            if let Some(linked) = schema.and_then(parse_sqlserver_linked_schema_ref) {
                return sqlserver_linked_table_name(&linked, table_name);
            }
        }
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
        // JDBC connections use the driver-reported identifier quote string
        // (DatabaseMetaData.getIdentifierQuoteString()) inside the JDBC agent,
        // so the Rust layer passes identifiers through unquoted.
        Some(DatabaseType::Jdbc) => name.to_string(),
        Some(
            DatabaseType::Mysql
            | DatabaseType::ClickHouse
            | DatabaseType::Doris
            | DatabaseType::Goldendb
            | DatabaseType::StarRocks
            | DatabaseType::ManticoreSearch
            | DatabaseType::Hive
            | DatabaseType::Spark
            | DatabaseType::Databend
            | DatabaseType::Tdengine
            | DatabaseType::Access
            | DatabaseType::Bigquery
            | DatabaseType::Questdb,
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
        | DatabaseType::Hive
        | DatabaseType::Spark
        | DatabaseType::Questdb => format!("`{}`", name.replace('`', "``")),
        DatabaseType::SqlServer => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('\"', "\"\"")),
    }
}

pub(crate) fn qualified_transfer_table(table_name: &str, schema: &str, database_type: &DatabaseType) -> String {
    let table = quote_transfer_identifier(table_name, database_type);
    if schema.is_empty() || matches!(database_type, DatabaseType::Mysql | DatabaseType::MongoDb | DatabaseType::Questdb)
    {
        table
    } else {
        format!("{}.{}", quote_transfer_identifier(schema, database_type), table)
    }
}
