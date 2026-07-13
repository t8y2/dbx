use crate::models::connection::DatabaseType;

use super::capabilities::{firebird_rows_clause, table_pagination_strategy, uses_fetch_first, TablePaginationStrategy};
use super::identifiers::{
    normalize_where_input, qualified_table_name, qualified_table_name_with_catalog, quote_table_identifier,
};
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

    // Doris / StarRocks multi-catalog: prefix the catalog for external-catalog tables.
    let table = if database_type == Some(DatabaseType::Kingbase) {
        table_data_qualified_table_name(
            database_type,
            options.schema.as_deref(),
            &options.table_name,
            options.identifier_quote.as_deref(),
        )
    } else {
        qualified_table_name_with_catalog(
            database_type,
            options.catalog.as_deref(),
            options.schema.as_deref(),
            options.database.as_deref(),
            &options.table_name,
        )
    };
    let predicate = normalize_where_input(options.where_input.as_deref());
    let where_clause = if predicate.is_empty() { String::new() } else { format!(" WHERE ({predicate})") };
    let default_order_by = if database_type == Some(DatabaseType::InfluxDb) {
        // InfluxQL only allows sorting of timestamp column
        Some("time DESC".to_string())
    } else {
        None
    };
    let order_by = options.order_by.as_deref().filter(|order| !order.trim().is_empty()).or(default_order_by.as_deref());
    let order = order_by.map(|order_by| format!(" ORDER BY {order_by}")).unwrap_or_default();
    // Oracle join views can raise ORA-01445 when ROWID is selected; keep the
    // synthetic ROWID fallback scoped to base-table reads.
    let include_oracle_row_id = options.include_row_id
        && database_type == Some(DatabaseType::Oracle)
        && !is_view_table_type(options.table_type.as_deref());

    let select_columns = if include_oracle_row_id {
        format!("ROWIDTOCHAR(t.ROWID) AS \"{DBX_ROWID_COLUMN}\", t.*")
    } else {
        build_select_columns(
            database_type,
            &options.columns,
            tdengine_should_include_tbname(database_type, options.table_type.as_deref()),
        )
    };
    let rownum_select_columns = quoted_table_columns_or_star(database_type, &options.columns);
    let page_select_columns = if include_oracle_row_id {
        if options.columns.is_empty() {
            "*".to_string()
        } else {
            format!("\"{DBX_ROWID_COLUMN}\", {rownum_select_columns}")
        }
    } else {
        rownum_select_columns.clone()
    };
    let table_alias =
        if include_oracle_row_id && database_type.is_some_and(uses_fetch_first) { format!("{table} t") } else { table };

    match table_pagination_strategy(database_type) {
        TablePaginationStrategy::IrisTop => {
            format!("SELECT TOP {limit} {select_columns} FROM {table_alias}{where_clause}{order}")
        }
        TablePaginationStrategy::InformixFirst => {
            let row_limit = informix_row_limit_clause(limit, options.offset.unwrap_or(0));
            format!("SELECT {row_limit} {select_columns} FROM {table_alias}{where_clause}{order}")
        }
        TablePaginationStrategy::FirebirdRows => {
            let rows = firebird_rows_clause(limit, options.offset.unwrap_or(0));
            format!("SELECT {select_columns} FROM {table_alias}{where_clause}{order} {rows}")
        }
        TablePaginationStrategy::Db2FetchFirst if options.offset.is_some_and(|offset| offset > 0) => {
            build_db2_table_select_page_sql(
                &table_alias,
                &where_clause,
                order_by,
                &options.columns,
                limit,
                options.offset.unwrap_or(0),
            )
        }
        TablePaginationStrategy::Db2FetchFirst | TablePaginationStrategy::FetchFirst => {
            let offset = options
                .offset
                .filter(|offset| *offset > 0)
                .map(|offset| format!(" OFFSET {offset} ROWS"))
                .unwrap_or_default();
            format!(
                "SELECT {select_columns} FROM {table_alias}{where_clause}{order}{offset} FETCH FIRST {limit} ROWS ONLY"
            )
        }
        TablePaginationStrategy::Rownum => {
            let rownum_inner_select_columns =
                if include_oracle_row_id { &select_columns } else { &rownum_select_columns };
            build_rownum_table_select_sql(
                &table_alias,
                &where_clause,
                &order,
                rownum_inner_select_columns,
                &page_select_columns,
                limit,
                options.offset.unwrap_or(0),
            )
        }
        TablePaginationStrategy::Unbounded => {
            format!("SELECT {select_columns} FROM {table_alias}{where_clause}{order}")
        }
        TablePaginationStrategy::SqlServerTop => build_sqlserver_table_select_sql(
            &table_alias,
            &where_clause,
            order_by.unwrap_or("(SELECT NULL)"),
            &options.columns,
            limit,
            options.offset.unwrap_or(0),
        ),
        TablePaginationStrategy::QuestDbLimit => build_questdb_table_select_sql(
            &table_alias,
            &where_clause,
            &order,
            &options.columns,
            limit,
            options.offset.unwrap_or(0),
        ),
        TablePaginationStrategy::AgentMaxRows => {
            format!("SELECT {select_columns} FROM {table_alias}{where_clause}{order};")
        }
        TablePaginationStrategy::LimitOffset => {
            let offset = options
                .offset
                .filter(|offset| *offset > 0)
                .map(|offset| format!(" OFFSET {offset}"))
                .unwrap_or_default();
            format!("SELECT {select_columns} FROM {table_alias}{where_clause}{order} LIMIT {limit}{offset};")
        }
    }
}

pub(crate) fn table_data_qualified_table_name(
    database_type: Option<DatabaseType>,
    schema: Option<&str>,
    table_name: &str,
    identifier_quote: Option<&str>,
) -> String {
    if database_type != Some(DatabaseType::Kingbase) {
        return qualified_table_name(database_type, schema, table_name);
    }
    let table = quote_table_data_identifier(database_type, table_name, identifier_quote);
    schema
        .map(str::trim)
        .filter(|schema| !schema.is_empty())
        .map(|schema| format!("{}.{}", quote_table_data_identifier(database_type, schema, identifier_quote), table))
        .unwrap_or(table)
}

fn quote_table_data_identifier(
    database_type: Option<DatabaseType>,
    name: &str,
    identifier_quote: Option<&str>,
) -> String {
    if database_type != Some(DatabaseType::Kingbase) {
        return quote_table_identifier(database_type, name);
    }
    let Some(quote) = identifier_quote else {
        return quote_table_identifier(database_type, name);
    };
    if quote.is_empty() {
        return name.to_string();
    }
    format!("{quote}{}{quote}", name.replace(quote, &format!("{quote}{quote}")))
}

fn is_view_table_type(table_type: Option<&str>) -> bool {
    table_type.is_some_and(|value| value.to_ascii_uppercase().contains("VIEW"))
}

pub fn build_table_select_sql(options: TableSelectSqlOptions<'_>) -> String {
    let database_type = options.database_type;
    let table = qualified_table_name(database_type, options.schema, options.table_name);
    let select_columns = quoted_table_columns_or_star(database_type, options.columns);
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

    match table_pagination_strategy(database_type) {
        TablePaginationStrategy::IrisTop => format!("SELECT TOP {limit} {select_columns} FROM {table}{order_by}"),
        TablePaginationStrategy::InformixFirst => {
            format!("SELECT FIRST {limit} {select_columns} FROM {table}{order_by}")
        }
        TablePaginationStrategy::FirebirdRows => {
            let rows = firebird_rows_clause(limit, 0);
            format!("SELECT {select_columns} FROM {table}{order_by} {rows}")
        }
        TablePaginationStrategy::Rownum => {
            build_rownum_table_select_sql(&table, "", &order_by, &select_columns, &select_columns, limit, 0)
        }
        TablePaginationStrategy::Db2FetchFirst | TablePaginationStrategy::FetchFirst => {
            format!("SELECT {select_columns} FROM {table}{order_by} FETCH FIRST {limit} ROWS ONLY")
        }
        TablePaginationStrategy::SqlServerTop => {
            format!("SELECT TOP ({limit}) {select_columns} FROM {table}{order_by}")
        }
        TablePaginationStrategy::AgentMaxRows => format!("SELECT {select_columns} FROM {table}{order_by};"),
        TablePaginationStrategy::Unbounded => format!("SELECT {select_columns} FROM {table}{order_by}"),
        TablePaginationStrategy::QuestDbLimit | TablePaginationStrategy::LimitOffset => {
            format!("SELECT {select_columns} FROM {table}{order_by} LIMIT {limit};")
        }
    }
}

fn informix_row_limit_clause(limit: usize, offset: usize) -> String {
    if offset > 0 {
        format!("SKIP {offset} FIRST {limit}")
    } else {
        format!("FIRST {limit}")
    }
}

fn quoted_table_columns_or_star(database_type: Option<DatabaseType>, columns: &[String]) -> String {
    if columns.is_empty() {
        return "*".to_string();
    }
    columns.iter().map(|column| quote_table_identifier(database_type, column)).collect::<Vec<_>>().join(", ")
}

fn build_rownum_table_select_sql(
    table: &str,
    where_clause: &str,
    order: &str,
    inner_select_columns: &str,
    outer_select_columns: &str,
    limit: usize,
    offset: usize,
) -> String {
    let inner_select = format!("SELECT {inner_select_columns} FROM {table}{where_clause}{order}");
    if offset == 0 {
        return format!("SELECT {outer_select_columns} FROM ({inner_select}) WHERE ROWNUM <= {limit}");
    }

    let row_number_alias = quote_table_identifier(Some(DatabaseType::Oracle), "__dbx_row_num");
    let end = offset + limit;
    format!(
        "SELECT {outer_select_columns} FROM (SELECT dbx_inner.*, ROWNUM AS {row_number_alias} FROM ({inner_select}) dbx_inner WHERE ROWNUM <= {end}) WHERE {row_number_alias} > {offset}"
    )
}

pub(super) fn is_tdengine_tbname(database_type: Option<DatabaseType>, name: &str) -> bool {
    database_type == Some(DatabaseType::Tdengine) && name.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN)
}

fn tdengine_should_include_tbname(database_type: Option<DatabaseType>, table_type: Option<&str>) -> bool {
    if database_type != Some(DatabaseType::Tdengine) {
        return false;
    }
    matches!(
        table_type.map(|value| value.trim().to_ascii_uppercase()),
        Some(value) if value == "STABLE" || value == "SUPER TABLE" || value == "SUPERTABLE"
    )
}

pub(super) fn build_select_columns(
    database_type: Option<DatabaseType>,
    columns: &[String],
    include_tdengine_tbname: bool,
) -> String {
    if columns.is_empty() {
        if database_type == Some(DatabaseType::Tdengine) && include_tdengine_tbname {
            return format!("{DBX_TDENGINE_TBNAME_COLUMN}, *");
        }
        return "*".to_string();
    }
    if database_type == Some(DatabaseType::Tdengine) {
        let mut tdengine_columns = Vec::new();
        if include_tdengine_tbname
            && !columns.iter().any(|column| column.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN))
        {
            tdengine_columns.push(DBX_TDENGINE_TBNAME_COLUMN.to_string());
        }
        tdengine_columns.extend(
            columns
                .iter()
                .filter(|column| include_tdengine_tbname || !column.eq_ignore_ascii_case(DBX_TDENGINE_TBNAME_COLUMN))
                .cloned(),
        );
        if tdengine_columns.is_empty() {
            return "*".to_string();
        }
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
    let order_by = options.order_by.as_deref().filter(|order| !order.trim().is_empty());
    let order = order_by.map(|order_by| format!(" ORDER BY {order_by}")).unwrap_or_default();
    let skip = options.offset.filter(|offset| *offset > 0).map(|offset| format!(" SKIP {offset}")).unwrap_or_default();
    format!("MATCH (n:{label}){where_clause} RETURN {returns}{order}{skip} LIMIT {limit};")
}

pub(super) fn build_questdb_table_select_sql(
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
            .map(|column| quote_table_identifier(Some(DatabaseType::Questdb), column))
            .collect::<Vec<_>>()
            .join(", ")
    };
    if offset == 0 {
        return format!("SELECT {columns_sql} FROM {table}{where_clause}{order_by} LIMIT {limit}");
    }
    let upper_bound = offset + limit;
    format!("SELECT {columns_sql} FROM {table}{where_clause}{order_by} LIMIT {offset}, {upper_bound}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(
        database_type: DatabaseType,
        catalog: Option<&str>,
        database: Option<&str>,
        table: &str,
    ) -> TableDataSelectSqlOptions {
        TableDataSelectSqlOptions {
            database_type: Some(database_type),
            identifier_quote: None,
            schema: None,
            table_name: table.to_string(),
            catalog: catalog.map(|c| c.to_string()),
            database: database.map(|d| d.to_string()),
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: Some(10),
            offset: None,
            where_input: None,
            include_row_id: false,
        }
    }

    #[test]
    fn doris_external_catalog_prefixes_from_clause() {
        let sql =
            build_table_data_select_sql(opts(DatabaseType::Doris, Some("iceberg_catalog"), Some("sales"), "orders"));
        assert!(sql.contains("FROM `iceberg_catalog`.`sales`.`orders`"), "sql was: {sql}");
    }

    #[test]
    fn starrocks_external_catalog_prefixes_from_clause() {
        let sql =
            build_table_data_select_sql(opts(DatabaseType::StarRocks, Some("hive_catalog"), Some("sales"), "orders"));
        assert!(sql.contains("FROM `hive_catalog`.`sales`.`orders`"), "sql was: {sql}");
    }

    #[test]
    fn doris_external_catalog_without_database_degrades_to_two_part() {
        // When neither schema nor database is provided the name degrades to the
        // 2-part `catalog.table` form.
        let sql = build_table_data_select_sql(opts(DatabaseType::Doris, Some("iceberg_catalog"), None, "orders"));
        assert!(sql.contains("FROM `iceberg_catalog`.`orders`"), "sql was: {sql}");
    }

    #[test]
    fn doris_internal_catalog_is_not_prefixed() {
        let sql = build_table_data_select_sql(opts(DatabaseType::Doris, Some("internal"), None, "orders"));
        assert!(!sql.contains("internal"), "sql was: {sql}");
        assert!(sql.contains("FROM `orders`"), "sql was: {sql}");
    }

    #[test]
    fn doris_empty_catalog_is_not_prefixed() {
        let sql = build_table_data_select_sql(opts(DatabaseType::Doris, Some("   "), None, "orders"));
        assert!(sql.contains("FROM `orders`"), "sql was: {sql}");
    }

    #[test]
    fn doris_no_catalog_is_not_prefixed() {
        let sql = build_table_data_select_sql(opts(DatabaseType::Doris, None, None, "orders"));
        assert!(sql.contains("FROM `orders`"), "sql was: {sql}");
    }

    #[test]
    fn external_catalog_is_ignored_for_non_doris_engines() {
        // Postgres does not support the 3-part catalog naming; the catalog
        // must be ignored to avoid emitting an invalid qualified name.
        let sql =
            build_table_data_select_sql(opts(DatabaseType::Postgres, Some("iceberg_catalog"), Some("sales"), "orders"));
        assert!(!sql.contains("iceberg_catalog"), "sql was: {sql}");
        assert!(sql.contains("orders"), "sql was: {sql}");
    }
}
