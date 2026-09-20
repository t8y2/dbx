use crate::db;

pub async fn sqlite_ddl(pool: &db::sqlite::SqliteHandle, schema: &str, table: &str) -> Result<String, String> {
    let pool = pool.clone();
    let schema = schema.to_string();
    let table = table.to_string();
    tokio::task::spawn_blocking(move || {
        pool.with_connection(|conn| {
            let schema = db::sqlite::sqlite_quote_schema_ident_for_connection(conn, &schema)?;
            let sql = format!("SELECT sql FROM {}.sqlite_master WHERE type='table' AND name=?1", schema);
            conn.query_row(&sql, [table], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
