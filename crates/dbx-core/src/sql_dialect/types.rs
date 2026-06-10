use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;

pub const DBX_ROWID_COLUMN: &str = "__DBX_ROWID";
pub const DBX_NEO4J_ELEMENT_ID_COLUMN: &str = "__DBX_ELEMENT_ID";
pub const DBX_TDENGINE_TBNAME_COLUMN: &str = "tbname";

#[derive(Debug, Clone, Copy)]
pub struct TableSelectSqlOptions<'a> {
    pub database_type: Option<DatabaseType>,
    pub schema: Option<&'a str>,
    pub table_name: &'a str,
    pub columns: &'a [String],
    pub order_columns: &'a [String],
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDataSelectSqlOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    #[serde(default)]
    pub primary_keys: Vec<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub fallback_order_columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub where_input: Option<String>,
    #[serde(default)]
    pub include_row_id: bool,
}
