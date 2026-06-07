use crate::models::connection::DatabaseType;
use serde::{Deserialize, Serialize};

pub const DBX_ROWID_COLUMN: &str = "__DBX_ROWID";
pub const DBX_NEO4J_ELEMENT_ID_COLUMN: &str = "__DBX_ELEMENT_ID";
pub const DBX_TDENGINE_TBNAME_COLUMN: &str = "tbname";

#[derive(Debug, Clone, Copy)]
pub struct TableSelectSqlOptions<'a> {
    pub database_type: Option<DatabaseType>,
    pub schema: Option<&'a str>,
    pub table_name: &'a str,
    pub columns: &'a [String],
    pub order_columns: &'a [String],
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataSelectSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub primary_keys: Vec<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub fallback_order_columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub where_input: Option<String>,
    #[serde(default)]
    pub include_row_id: bool,
}

pub fn build_count_table_sql(database_type: Option<DatabaseType>, schema: Option<&str>, table_name: &str) -> String {
    format!("SELECT COUNT(*) AS row_count FROM {}", qualified_table_name(database_type, schema, table_name))
}

pub fn build_table_data_select_sql(options: TableDataSelectSqlOptions) -> String {
    let database_type = options.database_type;
    let limit = options.limit.unwrap_or(100);
    if database_type == Some(DatabaseType::Neo4j) {
        return build_neo4j_table_select_sql(&options, limit);
    }

    let table = qualified_table_name(database_type, options.schema.as_deref(), &options.table_name);
    let predicate = normalize_where_input(options.where_input.as_deref());
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    let row_id_alias =
        if options.include_row_id && database_type == Some(DatabaseType::Oracle) { Some("t") } else { None };
    let default_order_alias = if database_type == Some(DatabaseType::Jdbc) { Some("dbx_t") } else { row_id_alias };
    let default_order_by = if !options.primary_keys.is_empty() {
        Some(
            options
                .primary_keys
                .iter()
                .map(|pk| format!("{} ASC", quote_order_identifier(database_type, pk, default_order_alias)))
                .collect::<Vec<_>>()
                .join(", "),
        )
    } else if !options.fallback_order_columns.is_empty() {
        Some(
            options
                .fallback_order_columns
                .iter()
                .map(|column| format!("{} ASC", quote_table_identifier(database_type, column)))
                .collect::<Vec<_>>()
                .join(", "),
        )
    } else {
        None
    };
    let order_by = options.order_by.as_deref().filter(|order| !order.trim().is_empty()).or(default_order_by.as_deref());
    let order = order_by.map(|order_by| format!(" ORDER BY {order_by}")).unwrap_or_default();

    let select_columns = if options.include_row_id && database_type == Some(DatabaseType::Oracle) {
        format!("ROWIDTOCHAR(t.ROWID) AS \"{DBX_ROWID_COLUMN}\", t.*")
    } else {
        build_select_columns(database_type, &options.columns)
    };
    let table_alias = if options.include_row_id && database_type.is_some_and(uses_fetch_first) {
        format!("{table} t")
    } else if database_type == Some(DatabaseType::Jdbc) && default_order_by.is_some() {
        format!("{table} dbx_t")
    } else {
        table
    };

    if database_type == Some(DatabaseType::Iris) {
        return format!("SELECT TOP {limit} {select_columns} FROM {table_alias}{where_clause}{order}");
    }

    if database_type.is_some_and(uses_fetch_first) {
        let offset = options
            .offset
            .filter(|offset| *offset > 0)
            .map(|offset| format!(" OFFSET {offset} ROWS"))
            .unwrap_or_default();
        return format!(
            "SELECT {select_columns} FROM {table_alias}{where_clause}{order}{offset} FETCH FIRST {limit} ROWS ONLY"
        );
    }

    if database_type == Some(DatabaseType::SqlServer) {
        return build_sqlserver_table_select_sql(
            &table_alias,
            &where_clause,
            order_by.unwrap_or("(SELECT NULL)"),
            &options.columns,
            limit,
            options.offset.unwrap_or(0),
        );
    }

    let offset =
        options.offset.filter(|offset| *offset > 0).map(|offset| format!(" OFFSET {offset}")).unwrap_or_default();
    format!("SELECT {select_columns} FROM {table_alias}{where_clause}{order} LIMIT {limit}{offset};")
}

pub fn build_table_select_sql(options: TableSelectSqlOptions<'_>) -> String {
    let database_type = options.database_type;
    let table = qualified_table_name(database_type, options.schema, options.table_name);
    let select_columns = if options.columns.is_empty() {
        "*".to_string()
    } else {
        options
            .columns
            .iter()
            .map(|column| quote_table_identifier(database_type, column))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let order_by = if options.order_columns.is_empty() {
        String::new()
    } else {
        format!(
            " ORDER BY {}",
            options
                .order_columns
                .iter()
                .map(|column| format!("{} ASC", quote_table_identifier(database_type, column)))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let limit = options.limit;

    if database_type == Some(DatabaseType::Iris) {
        return format!("SELECT TOP {limit} {select_columns} FROM {table}{order_by}");
    }

    if database_type.is_some_and(uses_fetch_first) {
        return format!("SELECT {select_columns} FROM {table}{order_by} FETCH FIRST {limit} ROWS ONLY");
    }

    if database_type == Some(DatabaseType::SqlServer) {
        return format!("SELECT TOP ({limit}) {select_columns} FROM {table}{order_by}");
    }

    format!("SELECT {select_columns} FROM {table}{order_by} LIMIT {limit};")
}

pub fn qualified_table_name(database_type: Option<DatabaseType>, schema: Option<&str>, table_name: &str) -> String {
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
        Some(DatabaseType::Jdbc) if is_simple_jdbc_identifier(name) => name.to_string(),
        Some(DatabaseType::Jdbc) => format!("`{}`", name.replace('`', "``")),
        Some(
            DatabaseType::Mysql
            | DatabaseType::Hive
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
    if trimmed.len() >= 5 && trimmed[..5].eq_ignore_ascii_case("where") {
        trimmed[5..].trim().to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_oracle_row_id(database_type: Option<DatabaseType>, name: &str) -> bool {
    database_type == Some(DatabaseType::Oracle) && name.eq_ignore_ascii_case(DBX_ROWID_COLUMN)
}

fn is_tdengine_tbname(database_type: Option<DatabaseType>, name: &str) -> bool {
    database_type == Some(DatabaseType::Tdengine) && name.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN)
}

fn quote_order_identifier(database_type: Option<DatabaseType>, name: &str, table_alias: Option<&str>) -> String {
    if is_oracle_row_id(database_type, name) {
        return table_alias.map(|alias| format!("{alias}.ROWID")).unwrap_or_else(|| "ROWID".to_string());
    }
    if is_tdengine_tbname(database_type, name) {
        return DBX_TDENGINE_TBNAME_COLUMN.to_string();
    }
    let quoted = quote_table_identifier(database_type, name);
    table_alias.map(|alias| format!("{alias}.{quoted}")).unwrap_or(quoted)
}

fn build_select_columns(database_type: Option<DatabaseType>, columns: &[String]) -> String {
    if columns.is_empty() {
        return "*".to_string();
    }
    if database_type == Some(DatabaseType::Tdengine) {
        let mut tdengine_columns = Vec::new();
        if !columns.iter().any(|column| column.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN)) {
            tdengine_columns.push(DBX_TDENGINE_TBNAME_COLUMN.to_string());
        }
        tdengine_columns.extend(columns.iter().cloned());
        return tdengine_columns
            .iter()
            .map(|column| {
                if is_tdengine_tbname(database_type, column) {
                    DBX_TDENGINE_TBNAME_COLUMN.to_string()
                } else {
                    let ident = quote_table_identifier(database_type, column);
                    format!("{ident} AS {ident}")
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
    }
    if database_type != Some(DatabaseType::Hive) {
        return "*".to_string();
    }
    columns
        .iter()
        .map(|column| {
            let ident = quote_table_identifier(database_type, column);
            format!("{ident} AS {ident}")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn build_sqlserver_table_select_sql(
    table: &str,
    where_clause: &str,
    order_by: &str,
    columns: &[String],
    limit: usize,
    offset: usize,
) -> String {
    let columns_sql = if columns.is_empty() {
        "*".to_string()
    } else {
        columns
            .iter()
            .map(|column| quote_table_identifier(Some(DatabaseType::SqlServer), column))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let order = if order_by == "(SELECT NULL)" { String::new() } else { format!(" ORDER BY {order_by}") };
    if offset == 0 {
        return format!("SELECT TOP ({limit}) {columns_sql} FROM {table}{where_clause}{order}");
    }

    let page_alias = quote_table_identifier(Some(DatabaseType::SqlServer), "dbx_page");
    let row_number_alias = quote_table_identifier(Some(DatabaseType::SqlServer), "__dbx_row_num");
    let end = offset + limit;
    format!(
        "WITH {page_alias} AS (SELECT {columns_sql}, ROW_NUMBER() OVER (ORDER BY {order_by}) AS {row_number_alias} FROM {table}{where_clause}) SELECT {columns_sql} FROM {page_alias} WHERE {row_number_alias} > {offset} AND {row_number_alias} <= {end} ORDER BY {row_number_alias}"
    )
}

fn build_neo4j_table_select_sql(options: &TableDataSelectSqlOptions, limit: usize) -> String {
    let label = quote_table_identifier(Some(DatabaseType::Neo4j), &options.table_name);
    let predicate = normalize_where_input(options.where_input.as_deref());
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE {predicate}") };
    let returned_columns = if options.columns.is_empty() {
        "n".to_string()
    } else {
        options
            .columns
            .iter()
            .map(|column| {
                let ident = quote_table_identifier(Some(DatabaseType::Neo4j), column);
                format!("n.{ident} AS {ident}")
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let returns = format!(
        "elementId(n) AS {}, {returned_columns}",
        quote_table_identifier(Some(DatabaseType::Neo4j), DBX_NEO4J_ELEMENT_ID_COLUMN)
    );
    let default_order_by = if options.primary_keys.is_empty() {
        None
    } else {
        Some(
            options
                .primary_keys
                .iter()
                .map(|pk| format!("n.{} ASC", quote_table_identifier(Some(DatabaseType::Neo4j), pk)))
                .collect::<Vec<_>>()
                .join(", "),
        )
    };
    let order_by = options.order_by.as_deref().filter(|order| !order.trim().is_empty()).or(default_order_by.as_deref());
    let order = order_by.map(|order_by| format!(" ORDER BY {order_by}")).unwrap_or_default();
    let skip = options.offset.filter(|offset| *offset > 0).map(|offset| format!(" SKIP {offset}")).unwrap_or_default();
    format!("MATCH (n:{label}){where_clause} RETURN {returns}{order}{skip} LIMIT {limit};")
}

pub fn is_schema_aware(database_type: DatabaseType) -> bool {
    matches!(
        database_type,
        DatabaseType::Postgres
            | DatabaseType::SqlServer
            | DatabaseType::Oracle
            | DatabaseType::Redshift
            | DatabaseType::Dameng
            | DatabaseType::Gaussdb
            | DatabaseType::Kwdb
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
            | DatabaseType::Yashandb
            | DatabaseType::Databricks
            | DatabaseType::SapHana
            | DatabaseType::Teradata
            | DatabaseType::Vertica
            | DatabaseType::Exasol
            | DatabaseType::OpenGauss
            | DatabaseType::OceanbaseOracle
            | DatabaseType::Gbase
            | DatabaseType::Jdbc
            | DatabaseType::H2
            | DatabaseType::Snowflake
            | DatabaseType::Trino
            | DatabaseType::Hive
            | DatabaseType::Db2
            | DatabaseType::Tdengine
            | DatabaseType::DuckDb
            | DatabaseType::Iris
    )
}

pub fn uses_fetch_first(database_type: DatabaseType) -> bool {
    matches!(database_type, DatabaseType::Oracle | DatabaseType::Dameng)
}

fn is_simple_informix_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}

fn is_simple_jdbc_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers_by_database_type() {
        assert_eq!(quote_table_identifier(Some(DatabaseType::Mysql), "user`name"), "`user``name`");
        assert_eq!(quote_table_identifier(Some(DatabaseType::SqlServer), "user]name"), "[user]]name]");
        assert_eq!(quote_table_identifier(Some(DatabaseType::Postgres), "user\"name"), "\"user\"\"name\"");
        assert_eq!(quote_table_identifier(Some(DatabaseType::Informix), "users_1"), "users_1");
        assert_eq!(quote_table_identifier(Some(DatabaseType::Jdbc), "users_1"), "users_1");
        assert_eq!(quote_table_identifier(Some(DatabaseType::Jdbc), "user name"), "`user name`");
    }

    #[test]
    fn qualifies_schema_only_for_schema_aware_databases() {
        assert_eq!(qualified_table_name(Some(DatabaseType::Postgres), Some("public"), "users"), "\"public\".\"users\"");
        assert_eq!(qualified_table_name(Some(DatabaseType::Kwdb), Some("public"), "users"), "\"public\".\"users\"");
        assert_eq!(qualified_table_name(Some(DatabaseType::Mysql), Some("public"), "users"), "`users`");
        assert_eq!(qualified_table_name(Some(DatabaseType::Jdbc), Some("cbsdw_dwd"), "dwd_test_df"), "dwd_test_df");
    }

    #[test]
    fn builds_select_sql_with_limit_syntax_for_database_type() {
        let columns = vec!["id".to_string(), "name".to_string()];
        let keys = vec!["id".to_string()];

        assert_eq!(
            build_table_select_sql(TableSelectSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public"),
                table_name: "users",
                columns: &columns,
                order_columns: &keys,
                limit: 100,
            }),
            "SELECT \"id\", \"name\" FROM \"public\".\"users\" ORDER BY \"id\" ASC LIMIT 100;"
        );
        assert_eq!(
            build_table_select_sql(TableSelectSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                schema: Some("dbo"),
                table_name: "users",
                columns: &columns,
                order_columns: &keys,
                limit: 100,
            }),
            "SELECT TOP (100) [id], [name] FROM [dbo].[users] ORDER BY [id] ASC"
        );
        assert_eq!(
            build_table_select_sql(TableSelectSqlOptions {
                database_type: Some(DatabaseType::Jdbc),
                schema: Some("cbsdw_dwd"),
                table_name: "dwd_test_df",
                columns: &[],
                order_columns: &[],
                limit: 100,
            }),
            "SELECT * FROM dwd_test_df LIMIT 100;"
        );
        assert_eq!(
            build_table_select_sql(TableSelectSqlOptions {
                database_type: Some(DatabaseType::Hive),
                schema: Some("test"),
                table_name: "dws_event_analyse",
                columns: &[],
                order_columns: &[],
                limit: 100,
            }),
            "SELECT * FROM `test`.`dws_event_analyse` LIMIT 100;"
        );
        assert_eq!(
            build_table_select_sql(TableSelectSqlOptions {
                database_type: Some(DatabaseType::Iris),
                schema: Some("Ens"),
                table_name: "AlarmResponse",
                columns: &[],
                order_columns: &[],
                limit: 100,
            }),
            "SELECT TOP 100 * FROM \"Ens\".\"AlarmResponse\""
        );
    }

    #[test]
    fn builds_table_data_where_and_schema_queries() {
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Mysql),
                schema: None,
                table_name: "users".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Vec::new(),
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(100),
                offset: None,
                where_input: Some("where status = 'active'".to_string()),
                include_row_id: false,
            }),
            "SELECT * FROM `users` WHERE (status = 'active') ORDER BY `id` ASC LIMIT 100;"
        );
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                table_name: "orders".to_string(),
                primary_keys: Vec::new(),
                columns: Vec::new(),
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(50),
                offset: Some(100),
                where_input: Some("WHERE amount > 10".to_string()),
                include_row_id: false,
            }),
            "SELECT * FROM \"public\".\"orders\" WHERE (amount > 10) LIMIT 50 OFFSET 100;"
        );
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Iris),
                schema: Some("Ens".to_string()),
                table_name: "AlarmResponse".to_string(),
                primary_keys: Vec::new(),
                columns: Vec::new(),
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(100),
                offset: None,
                where_input: None,
                include_row_id: false,
            }),
            "SELECT TOP 100 * FROM \"Ens\".\"AlarmResponse\""
        );
    }

    #[test]
    fn explicit_table_data_order_overrides_default_key_order() {
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Postgres),
                schema: Some("public".to_string()),
                table_name: "country_gdp".to_string(),
                primary_keys: vec!["year".to_string()],
                columns: vec!["iso3".to_string(), "year".to_string(), "gdp_pc".to_string()],
                fallback_order_columns: Vec::new(),
                order_by: Some("\"iso3\" ASC".to_string()),
                limit: Some(100),
                offset: None,
                where_input: None,
                include_row_id: false,
            }),
            "SELECT * FROM \"public\".\"country_gdp\" ORDER BY \"iso3\" ASC LIMIT 100;"
        );
    }

    #[test]
    fn builds_table_data_special_column_queries() {
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Tdengine),
                schema: Some("test_db".to_string()),
                table_name: "meters".to_string(),
                primary_keys: vec!["ts".to_string()],
                columns: vec![
                    "ts".to_string(),
                    "current".to_string(),
                    "voltage".to_string(),
                    "location".to_string(),
                    "groupid".to_string(),
                ],
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(100),
                offset: None,
                where_input: None,
                include_row_id: false,
            }),
            "SELECT tbname, `ts` AS `ts`, `current` AS `current`, `voltage` AS `voltage`, `location` AS `location`, `groupid` AS `groupid` FROM `test_db`.`meters` ORDER BY `ts` ASC LIMIT 100;"
        );
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Hive),
                schema: None,
                table_name: "departments".to_string(),
                primary_keys: Vec::new(),
                columns: vec!["id".to_string(), "name".to_string()],
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(100),
                offset: None,
                where_input: None,
                include_row_id: false,
            }),
            "SELECT `id` AS `id`, `name` AS `name` FROM `departments` LIMIT 100;"
        );
    }

    #[test]
    fn builds_sqlserver_table_data_pages() {
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                schema: Some("dbo".to_string()),
                table_name: "accounts".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: Vec::new(),
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(25),
                offset: None,
                where_input: Some("where id = 1".to_string()),
                include_row_id: false,
            }),
            "SELECT TOP (25) * FROM [dbo].[accounts] WHERE (id = 1) ORDER BY [id] ASC"
        );
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::SqlServer),
                schema: Some("sales".to_string()),
                table_name: "orders".to_string(),
                primary_keys: vec!["order_id".to_string()],
                columns: vec!["order_id".to_string(), "customer".to_string()],
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(50),
                offset: Some(100),
                where_input: None,
                include_row_id: false,
            }),
            "WITH [dbx_page] AS (SELECT [order_id], [customer], ROW_NUMBER() OVER (ORDER BY [order_id] ASC) AS [__dbx_row_num] FROM [sales].[orders]) SELECT [order_id], [customer] FROM [dbx_page] WHERE [__dbx_row_num] > 100 AND [__dbx_row_num] <= 150 ORDER BY [__dbx_row_num]"
        );
    }

    #[test]
    fn builds_oracle_and_neo4j_table_data_queries() {
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Oracle),
                schema: Some("DBXTEST".to_string()),
                table_name: "DBX_LOAD_TABLE_006".to_string(),
                primary_keys: vec![DBX_ROWID_COLUMN.to_string()],
                columns: Vec::new(),
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(100),
                offset: None,
                where_input: None,
                include_row_id: true,
            }),
            "SELECT ROWIDTOCHAR(t.ROWID) AS \"__DBX_ROWID\", t.* FROM \"DBXTEST\".\"DBX_LOAD_TABLE_006\" t ORDER BY t.ROWID ASC FETCH FIRST 100 ROWS ONLY"
        );
        assert_eq!(
            build_table_data_select_sql(TableDataSelectSqlOptions {
                database_type: Some(DatabaseType::Neo4j),
                schema: None,
                table_name: "Employee".to_string(),
                primary_keys: vec!["id".to_string()],
                columns: vec!["id".to_string(), "first name".to_string(), "role".to_string()],
                fallback_order_columns: Vec::new(),
                order_by: None,
                limit: Some(100),
                offset: None,
                where_input: None,
                include_row_id: false,
            }),
            "MATCH (n:`Employee`) RETURN elementId(n) AS `__DBX_ELEMENT_ID`, n.`id` AS `id`, n.`first name` AS `first name`, n.`role` AS `role` ORDER BY n.`id` ASC LIMIT 100;"
        );
    }
}
