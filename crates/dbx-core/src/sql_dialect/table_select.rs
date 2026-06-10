use crate::models::connection::DatabaseType;

use super::capabilities::uses_fetch_first;
use super::identifiers::{normalize_where_input, qualified_table_name, quote_table_identifier};
use super::types::{
    TableDataSelectSqlOptions, TableSelectSqlOptions, DBX_NEO4J_ELEMENT_ID_COLUMN, DBX_ROWID_COLUMN,
    DBX_TDENGINE_TBNAME_COLUMN,
};

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
    let default_order_by = if database_type == Some(DatabaseType::InfluxDb) {
        // InfluxQL only allows sorting of timestamp column
        Some("time DESC".to_string())
    } else if !options.primary_keys.is_empty() {
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

    if database_type == Some(DatabaseType::Db2) && options.offset.is_some_and(|offset| offset > 0) {
        return build_db2_table_select_page_sql(
            &table_alias,
            &where_clause,
            order_by,
            &options.columns,
            limit,
            options.offset.unwrap_or(0),
        );
    }

    if database_type == Some(DatabaseType::Oracle) {
        return format!("SELECT {select_columns} FROM {table_alias}{where_clause}{order}");
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

pub(super) fn is_oracle_row_id(database_type: Option<DatabaseType>, name: &str) -> bool {
    database_type == Some(DatabaseType::Oracle) && name.eq_ignore_ascii_case(DBX_ROWID_COLUMN)
}

pub(super) fn is_tdengine_tbname(database_type: Option<DatabaseType>, name: &str) -> bool {
    database_type == Some(DatabaseType::Tdengine) && name.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN)
}

pub(super) fn quote_order_identifier(
    database_type: Option<DatabaseType>,
    name: &str,
    table_alias: Option<&str>,
) -> String {
    if is_oracle_row_id(database_type, name) {
        return table_alias.map(|alias| format!("{alias}.ROWID")).unwrap_or_else(|| "ROWID".to_string());
    }
    if is_tdengine_tbname(database_type, name) {
        return DBX_TDENGINE_TBNAME_COLUMN.to_string();
    }
    let quoted = quote_table_identifier(database_type, name);
    table_alias.map(|alias| format!("{alias}.{quoted}")).unwrap_or(quoted)
}

pub(super) fn build_select_columns(database_type: Option<DatabaseType>, columns: &[String]) -> String {
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

pub(super) fn build_sqlserver_table_select_sql(
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

pub(super) fn build_db2_table_select_page_sql(
    table: &str,
    where_clause: &str,
    order_by: Option<&str>,
    columns: &[String],
    limit: usize,
    offset: usize,
) -> String {
    let columns_sql = if columns.is_empty() {
        "*".to_string()
    } else {
        columns
            .iter()
            .map(|column| quote_table_identifier(Some(DatabaseType::Db2), column))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let inner_columns = if columns.is_empty() {
        "dbx_t.*".to_string()
    } else {
        columns
            .iter()
            .map(|column| format!("dbx_t.{}", quote_table_identifier(Some(DatabaseType::Db2), column)))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let order = order_by.map(|order_by| format!("ORDER BY {order_by}")).unwrap_or_default();
    let row_number = quote_table_identifier(Some(DatabaseType::Db2), "__dbx_row_num");
    let end = offset + limit;

    format!(
        "SELECT {columns_sql} FROM (SELECT {inner_columns}, ROW_NUMBER() OVER ({order}) AS {row_number} FROM {table} dbx_t{where_clause}) dbx_page WHERE {row_number} > {offset} AND {row_number} <= {end} ORDER BY {row_number}"
    )
}

pub(super) fn build_neo4j_table_select_sql(options: &TableDataSelectSqlOptions, limit: usize) -> String {
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
