use std::sync::Arc;

use super::types::{CacheState, ExternalTableRef, ExternalTableSnapshot};

/// Loads an external table snapshot into an in-memory DuckDB connection.
pub fn load_snapshot_to_duckdb(con: &duckdb::Connection, snapshot: &ExternalTableSnapshot) -> Result<(), String> {
    let table_name = sanitize_table_name(&snapshot.table_ref.table_name);

    con.execute(&format!("DROP TABLE IF EXISTS \"{}\"", table_name), [])
        .map_err(|e| format!("Failed to drop table: {e}"))?;

    let col_defs: Vec<String> = snapshot
        .columns
        .iter()
        .map(|c| {
            format!(
                "\"{}\" {}{}",
                c.name.replace('"', "\"\""),
                &c.duckdb_type,
                if c.is_nullable { "" } else { " NOT NULL" }
            )
        })
        .collect();

    let pk_cols: Vec<&str> = snapshot.columns.iter().filter(|c| c.is_primary_key).map(|c| c.name.as_str()).collect();

    let mut create_sql = format!("CREATE TABLE \"{}\" ({}", table_name, col_defs.join(", "));
    if !pk_cols.is_empty() {
        create_sql.push_str(&format!(
            ", PRIMARY KEY ({})",
            pk_cols.iter().map(|c| format!("\"{}\"", c.replace('"', "\"\""))).collect::<Vec<_>>().join(", ")
        ));
    }
    create_sql.push(')');

    con.execute(&create_sql, []).map_err(|e| format!("Failed to create table: {e}"))?;

    if snapshot.rows.is_empty() {
        return Ok(());
    }

    let placeholders: Vec<&str> = (0..snapshot.columns.len()).map(|_| "?").collect();
    let insert_sql = format!("INSERT INTO \"{}\" VALUES ({})", table_name, placeholders.join(", "));
    let mut stmt = con.prepare(&insert_sql).map_err(|e| format!("Failed to prepare insert: {e}"))?;

    for row in &snapshot.rows {
        let params: Vec<Box<dyn duckdb::ToSql>> = row
            .iter()
            .enumerate()
            .map(|(i, val)| {
                let col_type = snapshot.columns.get(i).map(|c| c.duckdb_type.as_str()).unwrap_or("VARCHAR");
                json_to_duckdb_param(val, col_type)
            })
            .collect();

        let param_refs: Vec<&dyn duckdb::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        stmt.execute(param_refs.as_slice()).map_err(|e| format!("Failed to insert row: {e}"))?;
    }

    Ok(())
}

fn json_to_duckdb_param(val: &serde_json::Value, col_type: &str) -> Box<dyn duckdb::ToSql> {
    match val {
        serde_json::Value::Null => Box::new(None::<String>),
        serde_json::Value::Bool(b) => Box::new(*b),
        serde_json::Value::Number(n) => {
            if col_type.contains("INT") {
                Box::new(n.as_i64().unwrap_or(0))
            } else if col_type.contains("DOUBLE") || col_type.contains("FLOAT") || col_type.contains("DECIMAL") {
                Box::new(n.as_f64().unwrap_or(0.0))
            } else {
                Box::new(n.to_string())
            }
        }
        serde_json::Value::String(s) => Box::new(s.clone()),
        _ => Box::new(val.to_string()),
    }
}

/// Sanitize a source table name into a stable DuckDB table identifier.
pub fn sanitize_table_name(name: &str) -> String {
    let sanitized: String = name.chars().map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' }).collect();

    if sanitized.is_empty() {
        "_unnamed_".to_string()
    } else if sanitized.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("_{sanitized}")
    } else {
        sanitized
    }
}

/// Manages a DuckDB cache for one external source.
pub struct ExternalPool {
    pub source: Arc<dyn super::traits::ExternalTabularSource>,
    pub cache: Arc<std::sync::Mutex<duckdb::Connection>>,
    pub cache_state: std::sync::Mutex<CacheState>,
    pub table_map: std::sync::Mutex<std::collections::HashMap<String, ExternalTableRef>>,
}

impl ExternalPool {
    pub fn new(
        source: Arc<dyn super::traits::ExternalTabularSource>,
        cache: Arc<std::sync::Mutex<duckdb::Connection>>,
    ) -> Self {
        Self {
            source,
            cache,
            cache_state: std::sync::Mutex::new(CacheState::Empty),
            table_map: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub async fn refresh_cache(&self) -> Result<(), String> {
        {
            let mut state = self.cache_state.lock().map_err(|e| e.to_string())?;
            *state = CacheState::Loading;
        }

        let tables = self.source.list_tables().await?;
        let mut new_table_map = std::collections::HashMap::new();

        for table_ref in &tables {
            let snapshot = self.source.load_table(table_ref).await?;
            let mut sanitized_name = sanitize_table_name(&table_ref.table_name);

            if new_table_map.contains_key(&sanitized_name) {
                let base = sanitized_name.clone();
                let mut suffix = 2;
                loop {
                    sanitized_name = format!("{base}_{suffix}");
                    if !new_table_map.contains_key(&sanitized_name) {
                        break;
                    }
                    suffix += 1;
                }
            }

            let cache = self.cache.clone();
            tokio::task::spawn_blocking(move || {
                let con = cache.lock().map_err(|e| e.to_string())?;
                load_snapshot_to_duckdb(&con, &snapshot)
            })
            .await
            .map_err(|e| e.to_string())??;

            new_table_map.insert(sanitized_name, table_ref.clone());
        }

        {
            let mut map = self.table_map.lock().map_err(|e| e.to_string())?;
            *map = new_table_map;
        }
        {
            let mut state = self.cache_state.lock().map_err(|e| e.to_string())?;
            *state = CacheState::Fresh;
        }

        Ok(())
    }
}

impl std::fmt::Debug for ExternalPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalPool")
            .field("source", &self.source.display_name())
            .field("cache_state", &self.cache_state)
            .finish()
    }
}
