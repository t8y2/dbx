use crate::db;
use crate::db::{ColumnInfo, IndexInfo, ObjectInfo, QueryResult, TableInfo};
use crate::models::connection::DatabaseType;
use crate::sql_dialect::quote_table_identifier;
use deadpool_postgres::Pool;

pub async fn list_objects(pool: &Pool, schema: &str) -> Result<Vec<ObjectInfo>, String> {
    Ok(list_tables(pool, schema)
        .await?
        .iter()
        .map(|t| ObjectInfo {
            name: t.name.clone(),
            object_type: t.table_type.clone(),
            schema: None,
            comment: t.comment.clone(),
            created_at: None,
            updated_at: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect())
}

/// try query `table`, `view` and `materialized view` using statement supported by the newer version.
/// if there is an error, rollback to the previous version of the statement
pub async fn list_tables(pool: &Pool, _schema: &str) -> Result<Vec<TableInfo>, String> {
    match list_tables_new_version(pool, _schema).await {
        Ok(ddl) => Ok(ddl),
        Err(_) => list_tables_older_version(pool, _schema).await,
    }
}

async fn list_tables_new_version(pool: &Pool, _schema: &str) -> Result<Vec<TableInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;

    let stmt = client.prepare_cached(questdb_tables_sql_new_version()).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let table_type_col = row.get::<_, String>(1);
            let table_type = match table_type_col.as_ref() {
                "V" => "VIEW",
                "M" => "MATERIALIZED_VIEW",
                _ => "TABLE",
            };
            TableInfo {
                name: row.get::<_, String>(0),
                table_type: table_type.to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }
        })
        .collect())
}

fn questdb_tables_sql_new_version() -> &'static str {
    "SELECT table_name, table_type FROM tables"
}

async fn list_tables_older_version(pool: &Pool, _schema: &str) -> Result<Vec<TableInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;

    let stmt = client.prepare_cached(questdb_tables_sql_older_version()).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let mat_view_col = row.get::<_, bool>(1);
            let table_type = if mat_view_col { "MATERIALIZED_VIEW" } else { "TABLE" };
            TableInfo {
                name: row.get::<_, String>(0),
                table_type: table_type.to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            }
        })
        .collect())
}

fn questdb_tables_sql_older_version() -> &'static str {
    "SELECT table_name, matView FROM tables"
}

pub async fn get_columns(pool: &Pool, _schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let sql = format!("SHOW COLUMNS FROM {}", quote_table_identifier(Some(DatabaseType::Questdb), table));
    let stmt = client.prepare_cached(&sql).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[]).await.map_err(|e| e.to_string())?;

    let not_null_types: [&str; 3] = ["boolean", "byte", "short"];

    Ok(rows
        .iter()
        .map(|row| {
            let column_type = row.get::<_, String>(1);
            ColumnInfo {
                name: row.get::<_, String>(0),
                data_type: column_type.clone().to_lowercase(),
                is_nullable: !not_null_types.contains(&column_type.as_str()),
                column_default: None,
                is_primary_key: column_type.eq_ignore_ascii_case("timestamp")
                    || column_type.eq_ignore_ascii_case("symbol"),
                extra: None,
                comment: None,
                numeric_precision: None,
                numeric_scale: None,
                character_maximum_length: None,
            }
        })
        .collect())
}

pub async fn list_indexes(pool: &Pool, _schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let client = pool.get().await.map_err(|e| e.to_string())?;
    let sql = format!("SHOW COLUMNS FROM {}", quote_table_identifier(Some(DatabaseType::Questdb), table));
    let stmt = client.prepare_cached(&sql).await.map_err(|e| e.to_string())?;
    let rows = client.query(&stmt, &[]).await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .filter(|r| r.get::<_, bool>(2))
        .map(|row| {
            let column: String = row.get::<_, String>(0);
            let key_cols = vec![column];
            IndexInfo {
                name: row.get::<_, String>(0),
                columns: key_cols,
                is_unique: false,
                is_primary: true,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
            }
        })
        .collect())
}

pub async fn questdb_object_source(pool: &Pool, name: &str) -> Result<String, String> {
    questdb_view_ddl(pool, name).await.map_err(|e| e.to_string())
}

pub async fn questdb_table_or_view_ddl(pool: &Pool, table_or_view: &str) -> Result<String, String> {
    match questdb_view_ddl(pool, table_or_view).await {
        Ok(ddl) => Ok(ddl),
        Err(_) => questdb_table_ddl(pool, table_or_view).await,
    }
}

async fn questdb_table_ddl(pool: &Pool, table: &str) -> Result<String, String> {
    let sql = format!("SHOW CREATE TABLE {}", quote_table_identifier(Some(DatabaseType::Questdb), table));
    first_string_cell(db::postgres::execute_query(pool, &sql).await?)
}

async fn questdb_view_ddl(pool: &Pool, view: &str) -> Result<String, String> {
    match questdb_mat_view_ddl(pool, view).await {
        Ok(ddl) => Ok(ddl),
        Err(_) => questdb_normal_view_ddl(pool, view).await,
    }
}

async fn questdb_mat_view_ddl(pool: &Pool, view: &str) -> Result<String, String> {
    let sql = format!("SHOW CREATE MATERIALIZED VIEW {}", quote_table_identifier(Some(DatabaseType::Questdb), view));
    first_string_cell(db::postgres::execute_query(pool, &sql).await?)
}

async fn questdb_normal_view_ddl(pool: &Pool, view: &str) -> Result<String, String> {
    let sql = format!("SHOW CREATE VIEW {}", quote_table_identifier(Some(DatabaseType::Questdb), view));
    first_string_cell(db::postgres::execute_query(pool, &sql).await?)
}

fn first_string_cell(result: QueryResult) -> Result<String, String> {
    result
        .rows
        .first()
        .and_then(|row| row.iter().find_map(|value| value.as_str().map(str::to_string)))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Object source not found".to_string())
}
