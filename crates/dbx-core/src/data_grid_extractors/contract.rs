use crate::data_grid_sql::{DataGridCopyInsertMode, DataGridTableMeta};
use crate::models::connection::DatabaseType;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub const DATA_GRID_EXTRACTOR_CONTRACT_VERSION: u16 = 1;

const DEFAULT_DSV_COLUMN_SEPARATOR: &str = ",";
const DEFAULT_DSV_ROW_SEPARATOR: &str = "\n";
const DEFAULT_DSV_NULL_TEXT: &str = "NULL";
const DEFAULT_DSV_QUOTE: char = '"';
const DEFAULT_SQL_SKIP_COMPUTED_COLUMNS: bool = true;
const DEFAULT_SQL_SKIP_GENERATED_COLUMNS: bool = true;
const DEFAULT_JSON_PRETTY: bool = true;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridExtractorId {
    Tsv,
    TsvWithHeaders,
    Csv,
    CsvWithHeaders,
    PipeSeparated,
    Dsv,
    Json,
    JsonLines,
    OneRow,
    SqlInList,
    SqlInserts,
    SqlUpdates,
    WhereClause,
    Markdown,
    Html,
    Xml,
    Pretty,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridSelectionKind {
    #[default]
    Cells,
    Rows,
    Columns,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridQuotePolicy {
    Always,
    #[default]
    Minimal,
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DataGridDsvOptions {
    pub column_separator: String,
    pub row_separator: String,
    pub null_text: String,
    pub quote: char,
    pub quote_policy: DataGridQuotePolicy,
    pub include_column_header: bool,
    pub include_row_header: bool,
}

impl Default for DataGridDsvOptions {
    fn default() -> Self {
        Self {
            column_separator: DEFAULT_DSV_COLUMN_SEPARATOR.to_owned(),
            row_separator: DEFAULT_DSV_ROW_SEPARATOR.to_owned(),
            null_text: DEFAULT_DSV_NULL_TEXT.to_owned(),
            quote: DEFAULT_DSV_QUOTE,
            quote_policy: DataGridQuotePolicy::Minimal,
            include_column_header: false,
            include_row_header: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DataGridSqlExtractorOptions {
    pub skip_computed_columns: bool,
    pub skip_generated_columns: bool,
    pub insert_mode: DataGridCopyInsertMode,
    pub exclude_primary_keys_from_insert: bool,
}

impl Default for DataGridSqlExtractorOptions {
    fn default() -> Self {
        Self {
            skip_computed_columns: DEFAULT_SQL_SKIP_COMPUTED_COLUMNS,
            skip_generated_columns: DEFAULT_SQL_SKIP_GENERATED_COLUMNS,
            insert_mode: DataGridCopyInsertMode::Merged,
            exclude_primary_keys_from_insert: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DataGridJsonExtractorOptions {
    pub pretty: bool,
}

impl Default for DataGridJsonExtractorOptions {
    fn default() -> Self {
        Self { pretty: DEFAULT_JSON_PRETTY }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DataGridExtractorOptions {
    pub dsv: DataGridDsvOptions,
    pub sql: DataGridSqlExtractorOptions,
    pub json: DataGridJsonExtractorOptions,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataGridExtractColumn {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    pub source_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataGridExtractRequest {
    pub version: u16,
    pub extractor: DataGridExtractorId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_type: Option<DatabaseType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_meta: Option<DataGridTableMeta>,
    #[serde(default)]
    pub columns: Vec<DataGridExtractColumn>,
    #[serde(default)]
    pub selected_column_indexes: Vec<usize>,
    #[serde(default)]
    pub rows: Vec<Vec<Value>>,
    #[serde(default)]
    pub selection_kind: DataGridSelectionKind,
    #[serde(default)]
    pub options: DataGridExtractorOptions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridExtractWarningCode {
    OmittedColumns,
    DuplicateJsonColumnNames,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct DataGridExtractWarning {
    pub code: DataGridExtractWarningCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct DataGridExtractResult {
    pub text: String,
    pub mime_type: String,
    pub file_extension: String,
    pub row_count: usize,
    pub column_count: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub omitted_columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<DataGridExtractWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridExtractErrorCode {
    UnsupportedVersion,
    EmptySelection,
    InvalidColumnIndex,
    InvalidColumnMapping,
    MissingTableMetadata,
    MissingPrimaryKey,
    NullPrimaryKey,
    NoWritableColumns,
    UnsupportedDatabase,
    InvalidDsvConfiguration,
    InputTooLarge,
    OutputTooLarge,
    EncodingFailed,
    ExecutionFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase")]
pub struct DataGridExtractError {
    pub code: DataGridExtractErrorCode,
    pub message: String,
}

impl DataGridExtractError {
    pub fn new(code: DataGridExtractErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl fmt::Display for DataGridExtractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for DataGridExtractError {}
