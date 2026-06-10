use crate::connection::AppState;
use crate::db;

pub fn duckdb_query_tables(con: &duckdb::Connection) -> Result<Vec<db::TableInfo>, String> {
    duckdb_query_tables_in_database(con, "main", "main")
}

pub fn duckdb_query_tables_in_database(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
) -> Result<Vec<db::TableInfo>, String> {
    duckdb_query_tables_in_database_with_attached(con, database, schema, &[])
}

pub fn duckdb_query_tables_in_database_with_attached(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    attached_names: &[String],
) -> Result<Vec<db::TableInfo>, String> {
    let database = duckdb_catalog_name(con, database, attached_names)?;
    let mut stmt = con
        .prepare(
            "SELECT table_name, table_type FROM information_schema.tables WHERE table_catalog = ? AND table_schema = ? ORDER BY table_name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), schema), |row| {
            Ok(db::TableInfo {
                name: row.get::<_, String>(0)?,
                table_type: row.get::<_, String>(1)?,
                comment: None,
                parent_schema: None,
                parent_name: None,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn duckdb_attach_database(con: &duckdb::Connection, name: &str, path: &str) -> Result<(), String> {
    let name = name.trim();
    let path = path.trim();
    if name.is_empty() || path.is_empty() {
        return Err("DuckDB attached database name and path are required".to_string());
    }
    let sql = format!("ATTACH {} AS {}", duckdb_quote_string(path), duckdb_quote_ident(name));
    con.execute_batch(&sql).map_err(|e| e.to_string())
}

pub fn duckdb_list_databases(con: &duckdb::Connection) -> Result<Vec<db::DatabaseInfo>, String> {
    duckdb_list_databases_with_attached(con, &[])
}

pub fn duckdb_list_databases_with_attached(
    con: &duckdb::Connection,
    attached_names: &[String],
) -> Result<Vec<db::DatabaseInfo>, String> {
    let primary = duckdb_primary_catalog(con, attached_names)?;
    let mut stmt = con.prepare("SHOW DATABASES").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let name = row.get::<_, String>(0)?;
            Ok(db::DatabaseInfo { name: if name == primary { "main".to_string() } else { name } })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

pub fn duckdb_list_schemas(con: &duckdb::Connection, database: &str) -> Result<Vec<String>, String> {
    duckdb_list_schemas_with_attached(con, database, &[])
}

pub fn duckdb_list_schemas_with_attached(
    con: &duckdb::Connection,
    database: &str,
    attached_names: &[String],
) -> Result<Vec<String>, String> {
    let database = duckdb_catalog_name(con, database, attached_names)?;
    let mut stmt = con
        .prepare(
            "SELECT schema_name FROM information_schema.schemata WHERE catalog_name = ? AND schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY schema_name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([database.as_str()], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn duckdb_catalog_name(con: &duckdb::Connection, database: &str, attached_names: &[String]) -> Result<String, String> {
    if database.trim().is_empty() || database == "main" {
        return duckdb_primary_catalog(con, attached_names);
    }
    Ok(database.to_string())
}

pub fn duckdb_primary_catalog(con: &duckdb::Connection, attached_names: &[String]) -> Result<String, String> {
    if attached_names.is_empty() {
        return duckdb_current_database(con);
    }
    let attached: std::collections::HashSet<String> = attached_names.iter().map(|name| name.to_lowercase()).collect();
    let mut stmt = con.prepare("SHOW DATABASES").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    for row in rows {
        let name = row.map_err(|e| e.to_string())?;
        if !attached.contains(&name.to_lowercase()) {
            return Ok(name);
        }
    }
    duckdb_current_database(con)
}

fn duckdb_current_database(con: &duckdb::Connection) -> Result<String, String> {
    con.query_row("SELECT current_database()", [], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())
}

fn duckdb_quote_ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn duckdb_quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub fn duckdb_query_columns(con: &duckdb::Connection, table: &str) -> Result<Vec<db::ColumnInfo>, String> {
    duckdb_query_columns_in_database(con, "main", "main", table)
}

pub fn duckdb_query_columns_in_database(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<db::ColumnInfo>, String> {
    duckdb_query_columns_in_database_with_attached(con, database, schema, table, &[])
}

pub fn duckdb_query_columns_in_database_with_attached(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    table: &str,
    attached_names: &[String],
) -> Result<Vec<db::ColumnInfo>, String> {
    let database = duckdb_catalog_name(con, database, attached_names)?;
    let mut pk_stmt = con
        .prepare(
            "SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_catalog = ?
           AND tc.table_schema = ?
           AND tc.table_name = ?
         ORDER BY kcu.ordinal_position",
        )
        .map_err(|e| e.to_string())?;
    let pk_rows = pk_stmt
        .query_map((database.as_str(), schema, table), |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let primary_keys: std::collections::HashSet<String> = pk_rows.filter_map(|r| r.ok()).collect();

    let mut stmt = con
        .prepare(
            "SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_catalog = ? AND table_schema = ? AND table_name = ?
         ORDER BY ordinal_position",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), schema, table), |row| {
            let name = row.get::<_, String>(0)?;
            Ok(db::ColumnInfo {
                is_primary_key: primary_keys.contains(&name),
                name,
                data_type: row.get::<_, String>(1)?,
                is_nullable: row.get::<_, String>(2).unwrap_or_default() == "YES",
                column_default: row.get::<_, Option<String>>(3)?,
                extra: None,
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub(super) async fn duckdb_attached_database_names(state: &AppState, connection_id: &str) -> Vec<String> {
    state
        .configs
        .read()
        .await
        .get(connection_id)
        .map(|config| config.attached_databases.iter().map(|database| database.name.clone()).collect())
        .unwrap_or_default()
}
