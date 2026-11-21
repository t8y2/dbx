use serde::{Deserialize, Serialize};

/// The database is the scope in the dump, not the destination selected in the UI.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlFileTable {
    pub database: Option<String>,
    pub name: String,
}
