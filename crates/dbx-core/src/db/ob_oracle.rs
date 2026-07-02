use mysql_async::prelude::*;

use crate::types::{ColumnInfo, DatabaseInfo, ForeignKeyInfo, IndexInfo, ObjectInfo, TableInfo, TriggerInfo};

fn row_get<T, I>(row: &mysql_async::Row, index: I) -> Option<T>
where
    T: mysql_async::prelude::FromValue,
    I: mysql_async::prelude::ColumnIndex,
{
    row.get_opt::<T, I>(index).and_then(|result| result.ok())
}

fn quote_value(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn get_str(row: &mysql_async::Row, idx: usize) -> String {
    row_get::<String, _>(row, idx)
        .or_else(|| row_get::<Vec<u8>, _>(row, idx).map(|b| String::from_utf8_lossy(&b).to_string()))
        .unwrap_or_default()
}

fn get_opt_str(row: &mysql_async::Row, idx: usize) -> Option<String> {
    row_get::<String, _>(row, idx)
        .or_else(|| row_get::<Vec<u8>, _>(row, idx).map(|b| String::from_utf8_lossy(&b).to_string()))
}

fn get_opt_i32(row: &mysql_async::Row, idx: usize) -> Option<i32> {
    row_get::<i32, _>(row, idx).or_else(|| row_get::<i64, _>(row, idx).and_then(|v| i32::try_from(v).ok()))
}

fn list_user_schemas_sql() -> &'static str {
    "SELECT USERNAME FROM ALL_USERS \
     WHERE USERNAME NOT IN ('SYS','LBACSYS','__public') \
     ORDER BY USERNAME"
}

pub async fn list_databases(pool: &mysql_async::Pool) -> Result<Vec<DatabaseInfo>, String> {
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(list_user_schemas_sql()).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows.iter().map(|row| DatabaseInfo { name: get_str(row, 0) }).collect())
}

pub async fn list_schemas(pool: &mysql_async::Pool) -> Result<Vec<String>, String> {
    list_databases(pool).await.map(|databases| databases.into_iter().map(|database| database.name).collect())
}

pub async fn list_tables(pool: &mysql_async::Pool, schema: &str) -> Result<Vec<TableInfo>, String> {
    let sql = format!(
        "SELECT TABLE_NAME, 'TABLE' AS TABLE_TYPE FROM ALL_TABLES WHERE OWNER = {s} \
         UNION ALL \
         SELECT VIEW_NAME, 'VIEW' AS TABLE_TYPE FROM ALL_VIEWS WHERE OWNER = {s} \
         ORDER BY 1",
        s = quote_value(schema),
    );
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: get_str(row, 0),
            table_type: get_str(row, 1),
            comment: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect())
}

fn list_objects_sql(schema: &str) -> String {
    format!(
        "SELECT TABLE_NAME AS OBJECT_NAME, 'TABLE' AS OBJECT_TYPE, 0 AS SORT_ORDER \
         FROM ALL_TABLES WHERE OWNER = {s} \
         UNION ALL \
         SELECT VIEW_NAME AS OBJECT_NAME, 'VIEW' AS OBJECT_TYPE, 1 AS SORT_ORDER \
         FROM ALL_VIEWS WHERE OWNER = {s} \
         UNION ALL \
         SELECT OBJECT_NAME, OBJECT_TYPE, CASE WHEN OBJECT_TYPE = 'PROCEDURE' THEN 2 ELSE 3 END AS SORT_ORDER \
         FROM ALL_PROCEDURES \
         WHERE OWNER = {s} AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION') AND PROCEDURE_NAME IS NULL \
         UNION ALL \
         SELECT OBJECT_NAME, CASE OBJECT_TYPE WHEN 'PACKAGE BODY' THEN 'PACKAGE_BODY' ELSE OBJECT_TYPE END AS OBJECT_TYPE, \
                CASE WHEN OBJECT_TYPE = 'PACKAGE' THEN 4 ELSE 5 END AS SORT_ORDER \
         FROM ALL_OBJECTS \
         WHERE OWNER = {s} AND OBJECT_TYPE IN ('PACKAGE', 'PACKAGE BODY') \
         ORDER BY SORT_ORDER, OBJECT_NAME",
        s = quote_value(schema),
    )
}

pub async fn list_objects(pool: &mysql_async::Pool, schema: &str) -> Result<Vec<ObjectInfo>, String> {
    let sql = list_objects_sql(schema);
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ObjectInfo {
            name: get_str(row, 0),
            object_type: get_str(row, 1),
            schema: Some(schema.to_string()),
            signature: None,
            comment: None,
            created_at: None,
            updated_at: None,
            parent_schema: None,
            parent_name: None,
        })
        .collect())
}

pub async fn get_columns(pool: &mysql_async::Pool, schema: &str, table: &str) -> Result<Vec<ColumnInfo>, String> {
    let sql = format!(
        "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_DEFAULT, \
         c.DATA_LENGTH, c.DATA_PRECISION, c.DATA_SCALE, c.COLUMN_ID, \
         CASE WHEN cc.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK \
         FROM ALL_TAB_COLUMNS c \
         LEFT JOIN ( \
           SELECT cols.OWNER, cols.TABLE_NAME, cols.COLUMN_NAME \
           FROM ALL_CONS_COLUMNS cols \
           JOIN ALL_CONSTRAINTS con ON con.CONSTRAINT_NAME = cols.CONSTRAINT_NAME AND con.OWNER = cols.OWNER \
           WHERE con.CONSTRAINT_TYPE = 'P' \
         ) cc ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME \
         WHERE c.OWNER = {s} AND c.TABLE_NAME = {t} \
         ORDER BY c.COLUMN_ID",
        s = quote_value(schema),
        t = quote_value(table),
    );
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let data_type = get_str(row, 1);
            let precision = get_opt_i32(row, 5);
            let scale = get_opt_i32(row, 6);
            let length = get_opt_i32(row, 4);
            let display_type = format_oracle_type(&data_type, precision, scale, length);
            ColumnInfo {
                name: get_str(row, 0),
                data_type: display_type,
                is_nullable: get_str(row, 2) == "Y",
                column_default: get_opt_str(row, 3).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
                is_primary_key: row_get::<i32, _>(row, 8).unwrap_or(0) == 1,
                extra: None,
                comment: None,
                numeric_precision: precision,
                numeric_scale: scale,
                character_maximum_length: length,
            }
        })
        .collect())
}

fn format_oracle_type(data_type: &str, precision: Option<i32>, scale: Option<i32>, length: Option<i32>) -> String {
    match data_type.to_uppercase().as_str() {
        "NUMBER" => match (precision, scale) {
            (Some(p), Some(s)) if s > 0 => format!("NUMBER({p},{s})"),
            (Some(p), _) => format!("NUMBER({p})"),
            _ => "NUMBER".to_string(),
        },
        "VARCHAR2" | "NVARCHAR2" | "CHAR" | "NCHAR" | "RAW" => match length {
            Some(l) => format!("{data_type}({l})"),
            None => data_type.to_string(),
        },
        _ => data_type.to_string(),
    }
}

pub async fn list_indexes(pool: &mysql_async::Pool, schema: &str, table: &str) -> Result<Vec<IndexInfo>, String> {
    let sql = format!(
        "SELECT ai.INDEX_NAME, \
         LISTAGG(aic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY aic.COLUMN_POSITION) AS COLUMNS, \
         ai.UNIQUENESS, \
         CASE WHEN ac.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS IS_PRIMARY \
         FROM ALL_INDEXES ai \
         JOIN ALL_IND_COLUMNS aic ON ai.INDEX_NAME = aic.INDEX_NAME AND ai.TABLE_OWNER = aic.TABLE_OWNER \
         LEFT JOIN ALL_CONSTRAINTS ac ON ac.INDEX_NAME = ai.INDEX_NAME AND ac.OWNER = ai.TABLE_OWNER AND ac.CONSTRAINT_TYPE = 'P' \
         WHERE ai.TABLE_OWNER = {s} AND ai.TABLE_NAME = {t} \
         GROUP BY ai.INDEX_NAME, ai.UNIQUENESS, ac.CONSTRAINT_TYPE \
         ORDER BY ai.INDEX_NAME",
        s = quote_value(schema),
        t = quote_value(table),
    );
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let cols_str = get_str(row, 1);
            IndexInfo {
                name: get_str(row, 0),
                columns: cols_str.split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect(),
                is_unique: get_str(row, 2) == "UNIQUE",
                is_primary: row_get::<i32, _>(row, 3).unwrap_or(0) == 1,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
            }
        })
        .collect())
}

pub async fn list_foreign_keys(
    pool: &mysql_async::Pool,
    schema: &str,
    table: &str,
) -> Result<Vec<ForeignKeyInfo>, String> {
    let sql = format!(
        "SELECT ac.CONSTRAINT_NAME, acc.COLUMN_NAME, \
         ac2.OWNER AS R_OWNER, ac2.TABLE_NAME AS R_TABLE, acc2.COLUMN_NAME AS R_COLUMN \
         FROM ALL_CONSTRAINTS ac \
         JOIN ALL_CONS_COLUMNS acc ON ac.CONSTRAINT_NAME = acc.CONSTRAINT_NAME AND ac.OWNER = acc.OWNER \
         JOIN ALL_CONSTRAINTS ac2 ON ac.R_CONSTRAINT_NAME = ac2.CONSTRAINT_NAME AND ac.R_OWNER = ac2.OWNER \
         JOIN ALL_CONS_COLUMNS acc2 ON ac2.CONSTRAINT_NAME = acc2.CONSTRAINT_NAME AND ac2.OWNER = acc2.OWNER \
           AND acc.POSITION = acc2.POSITION \
         WHERE ac.CONSTRAINT_TYPE = 'R' AND ac.OWNER = {s} AND ac.TABLE_NAME = {t} \
         ORDER BY ac.CONSTRAINT_NAME, acc.POSITION",
        s = quote_value(schema),
        t = quote_value(table),
    );
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| ForeignKeyInfo {
            name: get_str(row, 0),
            column: get_str(row, 1),
            ref_schema: Some(get_str(row, 2)),
            ref_table: get_str(row, 3),
            ref_column: get_str(row, 4),
            on_update: None,
            on_delete: None,
        })
        .collect())
}

pub async fn list_triggers(pool: &mysql_async::Pool, schema: &str, table: &str) -> Result<Vec<TriggerInfo>, String> {
    let sql = format!(
        "SELECT TRIGGER_NAME, TRIGGERING_EVENT, TRIGGER_TYPE \
         FROM ALL_TRIGGERS \
         WHERE TABLE_OWNER = {s} AND TABLE_NAME = {t} \
         ORDER BY TRIGGER_NAME",
        s = quote_value(schema),
        t = quote_value(table),
    );
    let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
    let result = conn.query_iter(&sql).await.map_err(|e| e.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|e| e.to_string())?;

    Ok(rows
        .iter()
        .map(|row| {
            let trigger_type = get_str(row, 2);
            let timing = if trigger_type.contains("BEFORE") {
                "BEFORE"
            } else if trigger_type.contains("AFTER") {
                "AFTER"
            } else {
                "INSTEAD OF"
            };
            TriggerInfo { name: get_str(row, 0), event: get_str(row, 1), timing: timing.to_string(), statement: None }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ob_oracle_list_objects_sql_includes_routines() {
        let sql = list_objects_sql("DLJPM");

        assert!(sql.contains("ALL_TABLES"));
        assert!(sql.contains("ALL_VIEWS"));
        assert!(sql.contains("ALL_PROCEDURES"));
        assert!(sql.contains("'PROCEDURE'"));
        assert!(sql.contains("'FUNCTION'"));
        assert!(sql.contains("ALL_OBJECTS"));
        assert!(sql.contains("'PACKAGE'"));
        assert!(sql.contains("'PACKAGE BODY'"));
    }

    #[test]
    fn ob_oracle_user_schema_sql_keeps_auditor_schema_available() {
        assert!(!list_user_schemas_sql().contains("ORAAUDITOR"));
    }
}
