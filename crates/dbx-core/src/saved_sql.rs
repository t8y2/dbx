use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSqlFolder {
    pub id: String,
    pub connection_id: String,
    pub name: String,
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
    pub schema: Option<String>,
    pub sql: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSqlLibrary {
    pub folders: Vec<SavedSqlFolder>,
    pub files: Vec<SavedSqlFile>,
}
