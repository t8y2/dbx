use crate::data_grid_sql::{DataGridCopyInsertMode, DataGridPrimaryKeyMode, DataGridTableMeta};
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
    Raw,
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
    SqlDeletesInserts,
    SqlUpdates,
    SqlSelect,
    WhereClause,
    Markdown,
    Html,
    Xml,
    Pretty,
    Dbunit,
    Php,
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
    Strings,
    AllButNumbers,
    AllIncludingNulls,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridHeaderPosition {
    #[default]
    Legacy,
    None,
    Top,
    Bottom,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridHeaderFormat {
    #[default]
    Name,
    Description,
    Both,
    /// `Both` on two stacked header rows: the description row first, then the
    /// name row, so a two-line header pastes into documents with one row per
    /// line (#13305). Columns without a description leave their description
    /// cell empty.
    NameAndDescriptionTwoRows,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridHeaderCase {
    #[default]
    Preserve,
    Upper,
    Lower,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridArrayFormat {
    #[default]
    Preserve,
    Braces,
    Brackets,
    Parentheses,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridValueFormat {
    #[default]
    Default,
    Legacy,
    Display,
    Edit,
    Native,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridNumberFormat {
    #[default]
    Inherit,
    Native,
    Display,
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
    pub quote_numeric_strings: bool,
    pub include_column_header: bool,
    pub include_row_header: bool,
    pub header_position: DataGridHeaderPosition,
    pub header_format: DataGridHeaderFormat,
    pub header_case: DataGridHeaderCase,
    pub escape_formulas: bool,
    pub line_feed_escape_string: String,
    pub array_format: DataGridArrayFormat,
    pub format_numbers: DataGridNumberFormat,
}

impl Default for DataGridDsvOptions {
    fn default() -> Self {
        Self {
            column_separator: DEFAULT_DSV_COLUMN_SEPARATOR.to_owned(),
            row_separator: DEFAULT_DSV_ROW_SEPARATOR.to_owned(),
            null_text: DEFAULT_DSV_NULL_TEXT.to_owned(),
            quote: DEFAULT_DSV_QUOTE,
            quote_policy: DataGridQuotePolicy::Minimal,
            quote_numeric_strings: false,
            include_column_header: false,
            include_row_header: false,
            header_position: DataGridHeaderPosition::Legacy,
            header_format: DataGridHeaderFormat::Name,
            header_case: DataGridHeaderCase::Preserve,
            escape_formulas: false,
            line_feed_escape_string: String::new(),
            array_format: DataGridArrayFormat::Preserve,
            format_numbers: DataGridNumberFormat::Inherit,
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
    pub primary_key_mode: DataGridPrimaryKeyMode,
    pub include_database_name: bool,
    pub quote_identifiers: bool,
    pub temporal_format: DataGridTemporalFormat,
}

impl Default for DataGridSqlExtractorOptions {
    fn default() -> Self {
        Self {
            skip_computed_columns: DEFAULT_SQL_SKIP_COMPUTED_COLUMNS,
            skip_generated_columns: DEFAULT_SQL_SKIP_GENERATED_COLUMNS,
            insert_mode: DataGridCopyInsertMode::Merged,
            primary_key_mode: DataGridPrimaryKeyMode::Include,
            include_database_name: true,
            quote_identifiers: true,
            temporal_format: DataGridTemporalFormat::Native,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridTemporalFormat {
    #[default]
    Native,
    String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DataGridJsonExtractorOptions {
    pub pretty: bool,
    pub camel_case_field_names: bool,
    /// Emit a bare array of cell values instead of objects. Only honored for
    /// single-column selections; multi-column selections fall back to objects.
    pub values_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DataGridDbUnitOptions {
    pub table_name: String,
    pub upper_case_table_name: bool,
    pub upper_case_column_names: bool,
    pub include_null_values: bool,
    pub null_value_string: String,
}

impl Default for DataGridDbUnitOptions {
    fn default() -> Self {
        Self {
            table_name: String::new(),
            upper_case_table_name: true,
            upper_case_column_names: true,
            include_null_values: true,
            null_value_string: "[NULL]".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "kebab-case")]
pub enum DataGridPhpArraySyntax {
    Legacy,
    #[default]
    Short,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DataGridPhpOptions {
    pub array_syntax: DataGridPhpArraySyntax,
    pub quote_char: char,
    pub format_date_iso: bool,
    pub row_delimiter: String,
    pub variable_name: String,
}

impl Default for DataGridPhpOptions {
    fn default() -> Self {
        Self {
            array_syntax: DataGridPhpArraySyntax::Short,
            quote_char: '"',
            format_date_iso: true,
            row_delimiter: "\n".into(),
            variable_name: String::new(),
        }
    }
}

impl Default for DataGridJsonExtractorOptions {
    fn default() -> Self {
        Self { pretty: DEFAULT_JSON_PRETTY, camel_case_field_names: false, values_only: false }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct DataGridExtractorOptions {
    pub dsv: DataGridDsvOptions,
    pub sql: DataGridSqlExtractorOptions,
    pub json: DataGridJsonExtractorOptions,
    pub dbunit: DataGridDbUnitOptions,
    pub php: DataGridPhpOptions,
    pub value_format: DataGridValueFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DataGridExtractColumn {
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    pub source_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
    pub identifier_quote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_meta: Option<DataGridTableMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_table_name: Option<String>,
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
    PhpDateNotIso,
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
    InvalidRawSelection,
    InvalidSelectSelection,
    InvalidColumnIndex,
    InvalidColumnMapping,
    MissingTableMetadata,
    MissingPrimaryKey,
    NullPrimaryKey,
    NoWritableColumns,
    UnsupportedDatabase,
    InvalidDsvConfiguration,
    InvalidFormatConfiguration,
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
