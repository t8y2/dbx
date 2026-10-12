//! Table favorites belong to the current data directory, not to a Web account.
use serde::{Deserialize, Serialize};

pub(crate) const TABLE_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS table_favorites (
    id TEXT PRIMARY KEY NOT NULL,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    catalog TEXT NOT NULL DEFAULT '',
    database_name TEXT NOT NULL DEFAULT '',
    schema_name TEXT NOT NULL DEFAULT '',
    object_type TEXT NOT NULL CHECK (object_type = 'table'),
    object_name TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(connection_id, catalog, database_name, schema_name, object_type, object_name)
)";
pub(crate) const SEQUENCE_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS table_favorite_sequence (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_value INTEGER NOT NULL CHECK (next_value >= 1)
)";
pub(crate) const SEQUENCE_SEED: &str = "INSERT OR IGNORE INTO table_favorite_sequence VALUES (1, 1)";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FavoriteTarget {
    pub connection_id: String,
    #[serde(default)]
    pub catalog: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub schema: String,
    pub object_type: String,
    pub object_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFavorite {
    pub id: String,
    pub code: String,
    pub name: String,
    #[serde(flatten)]
    pub target: FavoriteTarget,
    pub revision: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateTableFavorite {
    pub target: FavoriteTarget,
    pub name: String,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedTableFavorite {
    pub item: TableFavorite,
    pub created: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTableFavorite {
    pub name: String,
    pub code: String,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelinkTableFavorite {
    pub target: FavoriteTarget,
    pub expected_revision: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFavorites {
    pub items: Vec<TableFavorite>,
    pub next_code: String,
}

pub(crate) fn validate_target(target: &FavoriteTarget) -> Result<(), String> {
    // Identifiers are opaque: never trim or case-fold database object names.
    if target.connection_id.is_empty()
        || target.object_name.is_empty()
        || target.object_type != "table"
        || [&target.connection_id, &target.catalog, &target.database, &target.schema, &target.object_name]
            .iter()
            .any(|value| value.contains('\0'))
    {
        return Err("INVALID_FAVORITE: invalid table target".into());
    }
    Ok(())
}

pub(crate) fn normalize_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if !(1..=100).contains(&name.chars().count()) || name.contains('\0') {
        return Err("INVALID_FAVORITE: name must contain 1–100 Unicode characters".into());
    }
    Ok(name.to_owned())
}

pub(crate) fn normalize_code(code: &str) -> Result<String, String> {
    let code = code.trim();
    if !(1..=32).contains(&code.len()) || !code.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-') {
        return Err("INVALID_FAVORITE: code must contain 1–32 ASCII letters, digits, underscores or hyphens".into());
    }
    Ok(code.to_ascii_uppercase())
}

pub(crate) fn validate_revision(revision: i64) -> Result<(), String> {
    if revision < 1 || revision == i64::MAX {
        return Err("INVALID_FAVORITE: invalid revision".into());
    }
    Ok(())
}
