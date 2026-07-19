use mysql_async::prelude::*;
use std::collections::HashMap;

use crate::types::{ColumnInfo, IndexInfo, ObjectInfo};

use super::mysql::{self, MySqlPool};

fn quote_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn row_get<T, I>(row: &mysql_async::Row, index: I) -> Option<T>
where
    T: mysql_async::prelude::FromValue,
    I: mysql_async::prelude::ColumnIndex,
{
    row.get_opt::<T, I>(index).and_then(|result| result.ok())
}

fn get_str_by_name(row: &mysql_async::Row, name: &str) -> String {
    row_get::<String, _>(row, name)
        .or_else(|| row_get::<Vec<u8>, _>(row, name).map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
        .unwrap_or_default()
}

fn get_opt_str(row: &mysql_async::Row, name: &str) -> Option<String> {
    row_get::<String, _>(row, name)
        .or_else(|| row_get::<Vec<u8>, _>(row, name).map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
}

fn preferred_metadata(primary: Option<String>, fallback: Option<String>) -> Option<String> {
    primary.filter(|value| !value.trim().is_empty()).or_else(|| fallback.filter(|value| !value.trim().is_empty()))
}

pub async fn list_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let (tables, functions) = tokio::join!(mysql::list_tables_show(pool, database), list_udf_objects(pool, database));
    let mut objects: Vec<ObjectInfo> = tables?
        .into_iter()
        .map(|table| ObjectInfo {
            name: table.name,
            object_type: "TABLE".to_string(),
            schema: Some(database.to_string()),
            valid: None,
            signature: None,
            comment: table.comment,
            created_at: None,
            updated_at: None,
            parent_schema: table.parent_schema,
            parent_name: table.parent_name,
        })
        .collect();

    match functions {
        Ok(functions) => objects.extend(functions),
        Err(err) => log::warn!("Skipping UDFs for Manticore Search database `{}` in object browser: {}", database, err),
    }

    Ok(objects)
}

async fn list_udf_objects(pool: &MySqlPool, database: &str) -> Result<Vec<ObjectInfo>, String> {
    let mut conn = pool.get_conn().await.map_err(|err| err.to_string())?;
    let result = conn.query_iter("SHOW PLUGINS").await.map_err(|err| err.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|err| err.to_string())?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            plugin_object(
                &get_str_by_name(row, "Type"),
                &get_str_by_name(row, "Name"),
                get_opt_str(row, "Library").as_deref(),
                get_opt_str(row, "Extra").as_deref(),
                database,
            )
        })
        .collect())
}

fn plugin_object(
    plugin_type: &str,
    name: &str,
    library: Option<&str>,
    extra: Option<&str>,
    database: &str,
) -> Option<ObjectInfo> {
    if !plugin_type.eq_ignore_ascii_case("udf") {
        return None;
    }
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    let mut comment_parts = Vec::new();
    if let Some(library) = library.map(str::trim).filter(|value| !value.is_empty()) {
        comment_parts.push(format!("SONAME {library}"));
    }
    if let Some(return_type) = extra.map(str::trim).filter(|value| !value.is_empty()) {
        comment_parts.push(format!("RETURNS {return_type}"));
    }
    Some(ObjectInfo {
        name: name.to_string(),
        object_type: "FUNCTION".to_string(),
        schema: Some(database.to_string()),
        valid: None,
        signature: None,
        comment: if comment_parts.is_empty() { None } else { Some(comment_parts.join(", ")) },
        created_at: None,
        updated_at: None,
        parent_schema: None,
        parent_name: None,
    })
}

pub async fn get_columns(pool: &MySqlPool, database: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let mut columns = mysql::get_columns_show(pool, database, table).await?;
    let properties = column_properties(pool, database, table).await.unwrap_or_default();
    for column in &mut columns {
        if let Some(property) = properties.get(&column.name.to_lowercase()) {
            column.extra = preferred_metadata(column.extra.take(), Some(property.clone()));
        }
    }
    Ok(columns)
}

async fn column_properties(pool: &MySqlPool, database: &str, table: &str) -> Result<HashMap<String, String>, String> {
    let sql = show_columns_sql(database, table, true);
    let mut conn = pool.get_conn().await.map_err(|err| err.to_string())?;
    let rows: Vec<mysql_async::Row> = match conn.query_iter(&sql).await {
        Ok(result) => result.collect_and_drop().await.map_err(|err| err.to_string())?,
        Err(_) => {
            let sql = show_columns_sql(database, table, false);
            let result = conn.query_iter(&sql).await.map_err(|err| err.to_string())?;
            result.collect_and_drop().await.map_err(|err| err.to_string())?
        }
    };
    Ok(rows
        .iter()
        .filter_map(|row| {
            let name = get_str_by_name(row, "Field").trim().to_string();
            if name.is_empty() {
                return None;
            }
            get_opt_str(row, "Properties")
                .filter(|value| !value.trim().is_empty())
                .map(|properties| (name.to_lowercase(), properties))
        })
        .collect())
}

fn show_columns_sql(database: &str, table: &str, full: bool) -> String {
    let prefix = if full { "SHOW FULL COLUMNS FROM" } else { "SHOW COLUMNS FROM" };
    if database.trim().is_empty() {
        format!("{prefix} {}", quote_identifier(table))
    } else {
        format!("{prefix} {}.{}", quote_identifier(database), quote_identifier(table))
    }
}

pub async fn list_indexes(pool: &MySqlPool, table: &str) -> Result<Vec<IndexInfo>, String> {
    let sql = list_indexes_sql(table);
    let mut conn = pool.get_conn().await.map_err(|err| err.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|err| err.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|err| err.to_string())?;

    Ok(rows.iter().map(index_info_from_row).collect())
}

fn list_indexes_sql(table: &str) -> String {
    format!("SHOW TABLE INDEXES FROM {}", quote_identifier(table))
}

fn index_info_from_row(row: &mysql_async::Row) -> IndexInfo {
    let name = get_str_by_name(row, "Name");
    let enabled = get_str_by_name(row, "Enabled");
    let percent = get_str_by_name(row, "Percent");
    let comment_parts: Vec<String> = [
        (!enabled.is_empty()).then(|| format!("Enabled: {enabled}")),
        (!percent.is_empty()).then(|| format!("Percent: {percent}")),
    ]
    .into_iter()
    .flatten()
    .collect();

    IndexInfo {
        name: name.clone(),
        columns: vec![name],
        is_unique: false,
        is_primary: false,
        filter: None,
        index_type: Some(get_str_by_name(row, "Type")),
        included_columns: None,
        comment: (!comment_parts.is_empty()).then(|| comment_parts.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_metadata_uses_unqualified_table_names_when_database_is_empty() {
        assert_eq!(show_columns_sql("", "idx", true), "SHOW FULL COLUMNS FROM `idx`");
    }

    #[test]
    fn column_extra_falls_back_to_properties() {
        assert_eq!(
            preferred_metadata(Some("auto_increment".to_string()), Some("indexed attribute".to_string())),
            Some("auto_increment".to_string())
        );
        assert_eq!(
            preferred_metadata(Some("  ".to_string()), Some("indexed attribute".to_string())),
            Some("indexed attribute".to_string())
        );
        assert_eq!(preferred_metadata(None, Some("  ".to_string())), None);
    }

    #[test]
    fn indexes_sql_uses_show_table_indexes() {
        assert_eq!(list_indexes_sql("materials"), "SHOW TABLE INDEXES FROM `materials`");
        assert_eq!(list_indexes_sql("odd`name"), "SHOW TABLE INDEXES FROM `odd``name`");
    }

    #[test]
    fn udf_plugin_maps_to_function_object() {
        let object = plugin_object("udf", "sequence", Some("udfexample.dll"), Some("INT"), "app").expect("udf plugin");

        assert_eq!(object.name, "sequence");
        assert_eq!(object.object_type, "FUNCTION");
        assert_eq!(object.schema.as_deref(), Some("app"));
        assert_eq!(object.comment.as_deref(), Some("SONAME udfexample.dll, RETURNS INT"));
    }

    #[test]
    fn non_udf_plugins_are_not_sidebar_functions() {
        assert!(plugin_object("ranker", "bm25", Some("ranker.so"), None, "app").is_none());
        assert!(plugin_object("udf", "   ", Some("udf.so"), Some("INT"), "app").is_none());
    }
}
