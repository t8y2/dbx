use serde::{Deserialize, Serialize};

fn default_sql_loaded() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSqlFolder {
    pub id: String,
    pub connection_id: String,
    pub parent_folder_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub order_index: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSqlFile {
    pub id: String,
    pub connection_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub database: String,
    /// `None` is the built-in/default catalog and preserves legacy saved SQL scope.
    #[serde(default)]
    pub catalog: Option<String>,
    pub schema: Option<String>,
    pub sql: String,
    #[serde(default = "default_sql_loaded")]
    pub sql_loaded: bool,
    #[serde(default)]
    pub order_index: i64,
    #[serde(default)]
    pub open_count: i64,
    pub opened_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSqlLibrary {
    pub folders: Vec<SavedSqlFolder>,
    pub files: Vec<SavedSqlFile>,
}

#[cfg(test)]
mod tests {
    use super::SavedSqlFile;

    #[test]
    fn saved_sql_file_deserializes_legacy_json_without_catalog() {
        let file: SavedSqlFile = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "connectionId": "conn-1",
            "folderId": null,
            "name": "legacy.sql",
            "database": "analytics",
            "schema": null,
            "sql": "SELECT 1;",
            "createdAt": "2026-08-12",
            "updatedAt": "2026-08-12"
        }))
        .unwrap();

        assert_eq!(file.catalog, None);
    }
}
