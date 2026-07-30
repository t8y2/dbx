use std::collections::HashMap;

use crate::wire as db;

#[cfg(test)]
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
    let mut stmt = con.prepare(
        "SELECT table_name, table_type FROM information_schema.tables WHERE table_catalog = ? AND table_schema = ? ORDER BY table_name"
    ).map_err(|e| e.to_string())?;
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
    let tables: Vec<db::TableInfo> = rows.filter_map(|r| r.ok()).collect();
    if tables.is_empty() && duckdb_is_quack_catalog(con, &database) {
        if let Some(remote) = duckdb_quack_remote_tables(con, &database, schema) {
            return Ok(remote);
        }
    }
    Ok(tables)
}

pub fn duckdb_attach_database(con: &duckdb::Connection, name: &str, path: &str) -> Result<(), String> {
    let name = name.trim();
    let path = path.trim();
    if name.is_empty() || path.is_empty() {
        return Err("DuckDB attached database name and path are required".to_string());
    }
    let sql = format!("ATTACH {} AS {}", duckdb_quote_string(path), duckdb_quote_ident(name));
    con.execute_batch(&sql).map_err(|e| format!("Failed to attach database \"{name}\": {e}"))
}

#[cfg(test)]
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
    let schemas: Vec<String> = rows.filter_map(|r| r.ok()).collect();
    if schemas.is_empty() && duckdb_is_quack_catalog(con, &database) {
        if let Some(remote) = duckdb_quack_remote_schemas(con, &database) {
            return Ok(remote);
        }
    }
    Ok(schemas)
}

pub fn duckdb_object_source_with_attached(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    name: &str,
    object_type: &db::ObjectSourceKind,
    attached_names: &[String],
) -> Result<String, String> {
    if !matches!(object_type, db::ObjectSourceKind::View) {
        return Err("DuckDB object source only supports views".to_string());
    }

    let database = duckdb_catalog_name(con, database, attached_names)?;
    let mut stmt = con
        .prepare("SELECT sql FROM duckdb_views() WHERE database_name = ? AND schema_name = ? AND view_name = ?")
        .map_err(|e| e.to_string())?;
    let mut rows =
        stmt.query_map((database.as_str(), schema, name), |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;

    match rows.next() {
        Some(row) => row.map_err(|e| e.to_string()),
        None => Err(format!("DuckDB view source not found: {database}.{schema}.{name}")),
    }
}

pub fn duckdb_table_ddl_with_attached(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    table: &str,
    attached_names: &[String],
) -> Result<String, String> {
    let database = duckdb_catalog_name(con, database, attached_names)?;
    let mut stmt = con
        .prepare("SELECT sql FROM duckdb_tables() WHERE database_name = ? AND schema_name = ? AND table_name = ?")
        .map_err(|e| e.to_string())?;
    let mut rows =
        stmt.query_map((database.as_str(), schema, table), |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;

    match rows.next() {
        Some(row) => row.map_err(|e| e.to_string()),
        None => Err(format!("DuckDB table not found: {database}.{schema}.{table}")),
    }
}

/// Identifies quack catalogs by the storage-extension `type` that
/// `duckdb_databases()` reports, rather than by the attach aliases parsed from
/// the init script: `ATTACH 'quack:host:port'` without an `AS` alias gets a
/// derived catalog name (e.g. `localhost:9494`) that no parser sees.
fn duckdb_is_quack_catalog(con: &duckdb::Connection, database: &str) -> bool {
    con.query_row("SELECT type FROM duckdb_databases() WHERE lower(database_name) = lower(?)", [database], |row| {
        row.get::<_, String>(0)
    })
    .map(|catalog_type| catalog_type.eq_ignore_ascii_case("quack"))
    .unwrap_or(false)
}

/// Quack-attached catalogs expose no metadata on the client side (the beta
/// extension implements name resolution and streaming scans, but not catalog
/// enumeration: `information_schema`, `duckdb_tables()` and `SHOW ALL TABLES`
/// all skip the remote catalog). The extension's `quack_query_by_name` table
/// function runs SQL on the remote server, so when a metadata query for an
/// attached catalog comes back empty we ask the remote for its own
/// information_schema. For non-quack catalogs (or when the extension is not
/// loaded) the function call errors and the fallback quietly yields `None`.
fn duckdb_quack_remote_query<T>(
    con: &duckdb::Connection,
    alias: &str,
    remote_sql: &str,
    map_row: impl Fn(&duckdb::Row<'_>) -> Result<T, duckdb::Error>,
) -> Option<Vec<T>> {
    let sql = format!(
        "SELECT * FROM quack_query_by_name({}, {})",
        duckdb_quote_string(alias),
        duckdb_quote_string(remote_sql)
    );
    let mut stmt = match con.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(e) => {
            log::debug!("quack metadata fallback unavailable for catalog {alias}: {e}");
            return None;
        }
    };
    let rows = match stmt.query_map([], |row| map_row(row)) {
        Ok(rows) => rows,
        Err(e) => {
            log::debug!("quack metadata fallback query failed for catalog {alias}: {e}");
            return None;
        }
    };
    Some(rows.filter_map(|r| r.ok()).collect())
}

fn duckdb_quack_remote_schemas(con: &duckdb::Connection, alias: &str) -> Option<Vec<String>> {
    duckdb_quack_remote_query(
        con,
        alias,
        "SELECT DISTINCT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY schema_name",
        |row| row.get::<_, String>(0),
    )
}

fn duckdb_quack_remote_tables(con: &duckdb::Connection, alias: &str, schema: &str) -> Option<Vec<db::TableInfo>> {
    let remote_sql = format!(
        "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = {} ORDER BY table_name",
        duckdb_quote_string(schema)
    );
    duckdb_quack_remote_query(con, alias, &remote_sql, |row| {
        Ok(db::TableInfo {
            name: row.get::<_, String>(0)?,
            table_type: row.get::<_, String>(1)?,
            comment: None,
            parent_schema: None,
            parent_name: None,
        })
    })
}

fn duckdb_quack_remote_columns(
    con: &duckdb::Connection,
    alias: &str,
    schema: &str,
    table: &str,
) -> Option<Vec<db::ColumnInfo>> {
    let pk_sql = format!(
        "SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = {schema}
           AND tc.table_name = {table}
         ORDER BY kcu.ordinal_position",
        schema = duckdb_quote_string(schema),
        table = duckdb_quote_string(table),
    );
    let primary_keys: std::collections::HashSet<String> =
        duckdb_quack_remote_query(con, alias, &pk_sql, |row| row.get::<_, String>(0))
            .map(|names| names.into_iter().collect())
            .unwrap_or_default();

    let columns_sql = format!(
        "SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = {schema} AND table_name = {table}
         ORDER BY ordinal_position",
        schema = duckdb_quote_string(schema),
        table = duckdb_quote_string(table),
    );
    duckdb_quack_remote_query(con, alias, &columns_sql, |row| {
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
            enum_values: None,
            ..Default::default()
        })
    })
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

#[cfg(test)]
pub fn duckdb_query_columns(con: &duckdb::Connection, table: &str) -> Result<Vec<db::ColumnInfo>, String> {
    duckdb_query_columns_in_database(con, "main", "main", table)
}

#[cfg(test)]
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
    let column_comments = duckdb_column_comments(con, &database, schema, table);

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
            let comment = column_comments.get(&name).cloned().flatten();
            Ok(db::ColumnInfo {
                is_primary_key: primary_keys.contains(&name),
                name,
                data_type: row.get::<_, String>(1)?,
                is_nullable: row.get::<_, String>(2).unwrap_or_default() == "YES",
                column_default: row.get::<_, Option<String>>(3)?,
                extra: None,
                comment,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
                enum_values: None,
                ..Default::default()
            })
        })
        .map_err(|e| e.to_string())?;
    let columns: Vec<db::ColumnInfo> = rows.filter_map(|r| r.ok()).collect();
    if columns.is_empty() && duckdb_is_quack_catalog(con, &database) {
        if let Some(remote) = duckdb_quack_remote_columns(con, &database, schema, table) {
            return Ok(remote);
        }
    }
    Ok(columns)
}

fn duckdb_column_comments(
    con: &duckdb::Connection,
    database: &str,
    schema: &str,
    table: &str,
) -> HashMap<String, Option<String>> {
    let Ok(mut stmt) = con.prepare(
        "SELECT column_name, comment FROM duckdb_columns() \
         WHERE database_name = ? AND schema_name = ? AND table_name = ?",
    ) else {
        // Older DuckDB versions may not expose the comment column; keep metadata browsing functional.
        return HashMap::new();
    };
    let Ok(rows) = stmt
        .query_map((database, schema, table), |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))
    else {
        return HashMap::new();
    };
    rows.filter_map(Result::ok).collect()
}

pub fn duckdb_completion_assistant_search(
    con: &duckdb::Connection,
    request: &db::CompletionAssistantRequest,
    attached_names: &[String],
) -> Result<db::CompletionAssistantResponse, String> {
    let limit = request.max_results.unwrap_or(100).clamp(1, 1000);
    let kinds = if request.object_kinds.is_empty() {
        vec![db::CompletionAssistantObjectKind::Table, db::CompletionAssistantObjectKind::View]
    } else {
        request.object_kinds.clone()
    };
    let mut candidates = Vec::new();

    if kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::Schema)) {
        candidates.extend(duckdb_completion_schemas(con, request, attached_names, limit)?);
        if candidates.len() >= limit {
            return Ok(db::CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
        }
    }

    if kinds.iter().any(db::CompletionAssistantObjectKind::is_table_like) {
        candidates.extend(duckdb_completion_tables(con, request, &kinds, attached_names, limit - candidates.len())?);
        if candidates.len() >= limit {
            return Ok(db::CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
        }
    }

    if kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::Column)) {
        candidates.extend(duckdb_completion_columns(con, request, attached_names, limit - candidates.len())?);
        if candidates.len() >= limit {
            return Ok(db::CompletionAssistantResponse { candidates, incomplete: true, fallback_used: false });
        }
    }

    Ok(db::CompletionAssistantResponse { candidates, incomplete: false, fallback_used: false })
}

fn duckdb_completion_schemas(
    con: &duckdb::Connection,
    request: &db::CompletionAssistantRequest,
    attached_names: &[String],
    limit: usize,
) -> Result<Vec<db::CompletionAssistantCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let database = duckdb_catalog_name(con, &request.database, attached_names)?;
    let pattern = duckdb_completion_like_pattern(request);
    let mut stmt = con
        .prepare(
            "SELECT schema_name
             FROM information_schema.schemata
             WHERE catalog_name = ?
               AND schema_name NOT IN ('information_schema', 'pg_catalog')
               AND lower(schema_name) LIKE lower(?) ESCAPE '\\'
             ORDER BY schema_name
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), pattern.as_str(), limit as i64), |row| {
            let schema = row.get::<_, String>(0)?;
            Ok(db::CompletionAssistantCandidate {
                name: schema.clone(),
                kind: db::CompletionAssistantCandidateKind::Schema,
                database: Some(request.database.clone()),
                schema: Some(schema),
                parent_schema: None,
                parent_name: None,
                comment: None,
                data_type: None,
                signature: None,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn duckdb_completion_tables(
    con: &duckdb::Connection,
    request: &db::CompletionAssistantRequest,
    kinds: &[db::CompletionAssistantObjectKind],
    attached_names: &[String],
    limit: usize,
) -> Result<Vec<db::CompletionAssistantCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let database = duckdb_catalog_name(con, &request.database, attached_names)?;
    let schema = request.parent_schema.as_deref().or(request.schema.as_deref()).unwrap_or("main");
    let include_tables = kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::Table));
    let include_views = kinds.iter().any(|kind| matches!(kind, db::CompletionAssistantObjectKind::View));
    let pattern = duckdb_completion_like_pattern(request);
    let mut stmt = con
        .prepare(
            "SELECT table_name, table_type
             FROM information_schema.tables
             WHERE table_catalog = ?
               AND table_schema = ?
               AND ((? AND table_type = 'BASE TABLE') OR (? AND table_type = 'VIEW'))
               AND lower(table_name) LIKE lower(?) ESCAPE '\\'
             ORDER BY table_name
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), schema, include_tables, include_views, pattern.as_str(), limit as i64), |row| {
            let table_type = row.get::<_, String>(1)?;
            Ok(db::CompletionAssistantCandidate {
                name: row.get(0)?,
                kind: if table_type.eq_ignore_ascii_case("VIEW") {
                    db::CompletionAssistantCandidateKind::View
                } else {
                    db::CompletionAssistantCandidateKind::Table
                },
                database: Some(request.database.clone()),
                schema: Some(schema.to_string()),
                parent_schema: None,
                parent_name: None,
                comment: None,
                data_type: None,
                signature: None,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn duckdb_completion_columns(
    con: &duckdb::Connection,
    request: &db::CompletionAssistantRequest,
    attached_names: &[String],
    limit: usize,
) -> Result<Vec<db::CompletionAssistantCandidate>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let Some(table) = request.parent_name.as_deref().filter(|table| !table.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let database = duckdb_catalog_name(con, &request.database, attached_names)?;
    let schema = request.parent_schema.as_deref().or(request.schema.as_deref()).unwrap_or("main");
    let pattern = duckdb_completion_like_pattern(request);
    let mut stmt = con
        .prepare(
            "SELECT column_name, data_type
             FROM information_schema.columns
             WHERE table_catalog = ?
               AND table_schema = ?
               AND table_name = ?
               AND lower(column_name) LIKE lower(?) ESCAPE '\\'
             ORDER BY ordinal_position
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((database.as_str(), schema, table, pattern.as_str(), limit as i64), |row| {
            Ok(db::CompletionAssistantCandidate {
                name: row.get(0)?,
                kind: db::CompletionAssistantCandidateKind::Column,
                database: Some(request.database.clone()),
                schema: Some(schema.to_string()),
                parent_schema: Some(schema.to_string()),
                parent_name: Some(table.to_string()),
                comment: None,
                data_type: Some(row.get(1)?),
                signature: None,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|row| row.ok()).collect())
}

fn duckdb_completion_like_pattern(request: &db::CompletionAssistantRequest) -> String {
    let mask = request.mask.trim().trim_matches('%');
    let escaped = mask.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    match request.match_mode.as_ref().unwrap_or(&db::CompletionAssistantMatchMode::Prefix) {
        db::CompletionAssistantMatchMode::Prefix => format!("{escaped}%"),
        db::CompletionAssistantMatchMode::Contains => format!("%{escaped}%"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::models::connection::DatabaseType;
    #[test]
    fn duckdb_list_databases_includes_attached_database() {
        let unique = uuid::Uuid::new_v4();
        let path = std::env::temp_dir().join(format!("dbx-attached-{unique}.duckdb"));
        let _ = std::fs::remove_file(&path);
        let con = duckdb::Connection::open_in_memory().unwrap();

        duckdb_attach_database(&con, "analytics", path.to_str().unwrap()).unwrap();
        let databases = duckdb_list_databases(&con).unwrap();

        assert!(databases.iter().any(|database| database.name == "main"));
        assert!(databases.iter().any(|database| database.name == "analytics"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn duckdb_query_tables_filters_by_attached_database() {
        let unique = uuid::Uuid::new_v4();
        let path = std::env::temp_dir().join(format!("dbx-attached-tables-{unique}.duckdb"));
        let _ = std::fs::remove_file(&path);
        let con = duckdb::Connection::open_in_memory().unwrap();

        con.execute_batch("CREATE TABLE main_table(id INTEGER);").unwrap();
        duckdb_attach_database(&con, "analytics", path.to_str().unwrap()).unwrap();
        con.execute_batch("CREATE TABLE analytics.attached_table(id INTEGER);").unwrap();

        let main_tables = duckdb_query_tables_in_database(&con, "main", "main").unwrap();
        let attached_tables = duckdb_query_tables_in_database(&con, "analytics", "main").unwrap();

        assert!(main_tables.iter().any(|table| table.name == "main_table"));
        assert!(!main_tables.iter().any(|table| table.name == "attached_table"));
        assert!(attached_tables.iter().any(|table| table.name == "attached_table"));
        assert!(!attached_tables.iter().any(|table| table.name == "main_table"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn duckdb_query_columns_includes_column_comments() {
        let con = duckdb::Connection::open_in_memory().unwrap();
        con.execute_batch(
            "CREATE TABLE users (id INTEGER, name VARCHAR); \
             COMMENT ON COLUMN users.name IS 'Display name';",
        )
        .unwrap();

        let columns = duckdb_query_columns(&con, "users").unwrap();
        let name = columns.iter().find(|column| column.name == "name").unwrap();

        assert_eq!(name.comment.as_deref(), Some("Display name"));
    }

    #[test]
    fn duckdb_table_ddl_filters_by_database_schema_and_table_name() {
        let unique = uuid::Uuid::new_v4();
        let path = std::env::temp_dir().join(format!("dbx-attached-ddl-{unique}.duckdb"));
        let _ = std::fs::remove_file(&path);
        let con = duckdb::Connection::open_in_memory().unwrap();

        con.execute_batch(
            "CREATE SCHEMA reporting; \
             CREATE TABLE main.orders(main_id INTEGER); \
             CREATE TABLE reporting.orders(reporting_id INTEGER);",
        )
        .unwrap();
        duckdb_attach_database(&con, "analytics", path.to_str().unwrap()).unwrap();
        con.execute_batch("CREATE TABLE analytics.orders(attached_id INTEGER);").unwrap();

        let main_ddl =
            duckdb_table_ddl_with_attached(&con, "main", "main", "orders", &["analytics".to_string()]).unwrap();
        let reporting_ddl =
            duckdb_table_ddl_with_attached(&con, "main", "reporting", "orders", &["analytics".to_string()]).unwrap();
        let attached_ddl =
            duckdb_table_ddl_with_attached(&con, "analytics", "main", "orders", &["analytics".to_string()]).unwrap();

        assert!(main_ddl.contains("main_id"));
        assert!(reporting_ddl.contains("reporting_id"));
        assert!(attached_ddl.contains("attached_id"));

        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn duckdb_completion_assistant_searches_catalog_metadata_with_limit() {
        let con = duckdb::Connection::open_in_memory().unwrap();
        con.execute_batch(
            "CREATE TABLE account(id INTEGER, display_name VARCHAR); \
             CREATE VIEW account_view AS SELECT id FROM account;",
        )
        .unwrap();

        let request = db::CompletionAssistantRequest {
            connection_id: "c1".to_string(),
            database: "main".to_string(),
            schema: Some("main".to_string()),
            object_kinds: vec![db::CompletionAssistantObjectKind::Table, db::CompletionAssistantObjectKind::View],
            mask: "account".to_string(),
            case_sensitive: false,
            global_search: false,
            max_results: Some(1),
            search_in_comments: false,
            search_in_definitions: false,
            parent_schema: Some("main".to_string()),
            parent_name: None,
            match_mode: Some(db::CompletionAssistantMatchMode::Prefix),
        };

        let tables = duckdb_completion_assistant_search(&con, &request, &[]).unwrap();
        assert_eq!(tables.candidates.len(), 1);
        assert!(tables.incomplete);
        assert!(!tables.fallback_used);
        assert_eq!(tables.candidates[0].name, "account");

        let columns = duckdb_completion_assistant_search(
            &con,
            &db::CompletionAssistantRequest {
                object_kinds: vec![db::CompletionAssistantObjectKind::Column],
                mask: "name".to_string(),
                max_results: Some(10),
                parent_name: Some("account".to_string()),
                match_mode: Some(db::CompletionAssistantMatchMode::Contains),
                ..request
            },
            &[],
        )
        .unwrap();
        assert_eq!(columns.candidates.len(), 1);
        assert_eq!(columns.candidates[0].name, "display_name");
    }

    #[test]
    fn duckdb_object_source_filters_by_schema_and_view_name() {
        let con = duckdb::Connection::open_in_memory().unwrap();
        con.execute_batch(
            "CREATE SCHEMA reporting; \
             CREATE VIEW main.active_orders AS SELECT 'main' AS origin; \
             CREATE VIEW reporting.active_orders AS SELECT 'reporting' AS origin;",
        )
        .unwrap();

        let main_source =
            duckdb_object_source_with_attached(&con, "main", "main", "active_orders", &db::ObjectSourceKind::View, &[])
                .unwrap();
        let reporting_source = duckdb_object_source_with_attached(
            &con,
            "main",
            "reporting",
            "active_orders",
            &db::ObjectSourceKind::View,
            &[],
        )
        .unwrap();

        assert!(main_source.contains("'main'"));
        assert!(reporting_source.contains("'reporting'"));
    }

    #[test]
    fn duckdb_object_source_rejects_unsupported_or_missing_objects() {
        let con = duckdb::Connection::open_in_memory().unwrap();

        let unsupported = duckdb_object_source_with_attached(
            &con,
            "main",
            "main",
            "calculate_total",
            &db::ObjectSourceKind::Function,
            &[],
        )
        .unwrap_err();
        let missing =
            duckdb_object_source_with_attached(&con, "main", "main", "missing_view", &db::ObjectSourceKind::View, &[])
                .unwrap_err();

        assert_eq!(unsupported, "DuckDB object source only supports views");
        assert!(missing.contains("DuckDB view source not found"));
    }

    #[test]
    fn duckdb_catalog_view_source_can_replace_existing_view() {
        let con = duckdb::Connection::open_in_memory().unwrap();
        con.execute_batch("CREATE VIEW active_orders AS SELECT 1 AS value;").unwrap();
        let source =
            duckdb_object_source_with_attached(&con, "main", "main", "active_orders", &db::ObjectSourceKind::View, &[])
                .unwrap();
        let edited_source = source.replace("SELECT 1", "SELECT 2");
        assert_ne!(edited_source, source);

        let statements = dbx_core::object_source_sql::build_executable_object_source_statements(
            dbx_core::object_source_sql::EditableObjectSourceSqlInput {
                database_type: DatabaseType::DuckDb,
                object_type: dbx_core::db::ObjectSourceKind::View,
                schema: Some("main".to_string()),
                name: "active_orders".to_string(),
                source: edited_source,
            },
        )
        .unwrap();
        con.execute_batch(&statements.join("\n")).unwrap();

        let value = con.query_row("SELECT value FROM active_orders", [], |row| row.get::<_, i32>(0)).unwrap();
        assert_eq!(value, 2);
    }
}
