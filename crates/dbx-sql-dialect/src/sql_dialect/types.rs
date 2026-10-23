use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;

pub const DBX_ROWID_COLUMN: &str = "__DBX_ROWID";
pub const DBX_NEO4J_ELEMENT_ID_COLUMN: &str = "__DBX_ELEMENT_ID";
pub const DBX_TDENGINE_TBNAME_COLUMN: &str = "tbname";
/// Prefix shared by every synthetic identifier the grid injects into
/// generated SQL (`__DBX_ROWID`, `__DBX_LARGE_VALUE_BYTES_*`). These keep
/// their quotes regardless of the quote-identifiers opt-out — clients match
/// them by exact column name.
pub const DBX_IDENTIFIER_PREFIX: &str = "__DBX_";

fn default_quote_identifiers() -> bool {
    true
}

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
    pub driver_profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier_quote: Option<String>,
    /// Server version reported by the connection (for example `Neo4j/4.4.44`).
    /// Engines that renamed a built-in function across releases use it to emit
    /// SQL the connected server understands instead of the newest spelling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub table_name: String,
    /// Catalog namespace used in three-part table names. Databricks emits
    /// `<catalog>.<schema>.<table>`; Doris / StarRocks external catalogs emit
    /// `<catalog>.<database>.<table>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog: Option<String>,
    /// Database namespace. For Databricks table nodes this carries the JDBC
    /// catalog when the explicit `catalog` field is unavailable. For Doris /
    /// StarRocks it is the database under an external catalog and is used as
    /// the middle segment when `schema` is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_type: Option<String>,
    #[serde(default)]
    pub primary_keys: Vec<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    /// Database type names parallel to `columns`. Table-data callers can use
    /// these to request bounded server-side projections for variable-length
    /// values without changing arbitrary query execution.
    #[serde(default)]
    pub column_types: Vec<String>,
    /// Maximum characters (text-like values) or bytes (binary values) kept in
    /// a table-data preview. Omitted for exports and ordinary SQL queries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub large_value_preview_size: Option<usize>,
    #[serde(default)]
    pub fallback_order_columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
    /// The JDBC driver advances the ResultSet before collecting the page.
    /// This keeps database-specific identifier rules while avoiding SQL
    /// pagination syntax that the selected driver does not support.
    #[serde(default)]
    pub use_driver_row_offset: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub where_input: Option<String>,
    /// `生成 SQL 时不加引号`: emit table/column identifiers bare when the
    /// dialect's can-unquote rules prove the unquoted spelling resolves to
    /// the same object; anything unsafe (mixed case, reserved words, the
    /// grid's synthetic marker aliases) keeps its quotes. Defaults to true so
    /// older agents that do not know the field keep the historical
    /// always-quoted SQL.
    #[serde(default = "default_quote_identifiers")]
    pub quote_identifiers: bool,
    /// Time-series quick-open ergonomics: inject a rolling `time` window
    /// when no WHERE was supplied. Opt-in so sampling and export callers
    /// keep the historical unbounded scan semantics.
    #[serde(default)]
    pub inject_default_time_series_where: bool,
    #[serde(default)]
    pub include_row_id: bool,
}

impl Default for TableDataSelectSqlOptions {
    fn default() -> Self {
        Self {
            database_type: None,
            driver_profile: None,
            identifier_quote: None,
            server_version: None,
            schema: None,
            table_name: String::new(),
            catalog: None,
            database: None,
            table_type: None,
            primary_keys: Vec::new(),
            columns: Vec::new(),
            column_types: Vec::new(),
            large_value_preview_size: None,
            fallback_order_columns: Vec::new(),
            order_by: None,
            limit: None,
            offset: None,
            use_driver_row_offset: false,
            where_input: None,
            // Mirrors the serde default: Rust-side `..Default::default()`
            // constructors (export, sampling, agent tools) keep the
            // historical always-quoted SQL.
            quote_identifiers: default_quote_identifiers(),
            inject_default_time_series_where: false,
            include_row_id: false,
        }
    }
}
