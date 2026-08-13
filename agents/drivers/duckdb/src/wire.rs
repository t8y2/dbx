use serde::{de::DeserializeOwned, Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub table_type: String,
    pub comment: Option<String>,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ObjectSourceKind {
    View,
    MaterializedView,
    Procedure,
    Function,
    Trigger,
    Sequence,
    Package,
    PackageBody,
    Type,
    TypeBody,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub column_default: Option<String>,
    pub is_primary_key: bool,
    pub extra: Option<String>,
    pub comment: Option<String>,
    pub numeric_precision: Option<i32>,
    pub numeric_scale: Option<i32>,
    pub character_maximum_length: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_set: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionAssistantObjectKind {
    Database,
    Schema,
    Table,
    View,
    Routine,
    Procedure,
    Function,
    Column,
    Sequence,
}

impl CompletionAssistantObjectKind {
    pub fn is_table_like(&self) -> bool {
        matches!(self, Self::Table | Self::View)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionAssistantCandidateKind {
    Database,
    Schema,
    Table,
    View,
    Procedure,
    Function,
    Column,
    Sequence,
    Object,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionAssistantMatchMode {
    Prefix,
    Contains,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionAssistantRequest {
    pub connection_id: String,
    pub database: String,
    pub schema: Option<String>,
    #[serde(default)]
    pub object_kinds: Vec<CompletionAssistantObjectKind>,
    #[serde(default)]
    pub mask: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub global_search: bool,
    pub max_results: Option<usize>,
    #[serde(default)]
    pub search_in_comments: bool,
    #[serde(default)]
    pub search_in_definitions: bool,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
    pub match_mode: Option<CompletionAssistantMatchMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionAssistantCandidate {
    pub name: String,
    pub kind: CompletionAssistantCandidateKind,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub parent_schema: Option<String>,
    pub parent_name: Option<String>,
    pub comment: Option<String>,
    pub data_type: Option<String>,
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionAssistantResponse {
    pub candidates: Vec<CompletionAssistantCandidate>,
    pub incomplete: bool,
    pub fallback_used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    #[serde(default)]
    pub column_types: Vec<String>,
    #[serde(default)]
    pub column_sortables: Vec<bool>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_time_ms: u128,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub has_more: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elasticsearch_raw_body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachedDatabaseConfig {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DuckDbWorkerRequest {
    pub id: String,
    pub method: DuckDbWorkerMethod,
    #[serde(default)]
    pub params: serde_json::Value,
}

impl DuckDbWorkerRequest {
    #[cfg(test)]
    pub fn new(id: impl Into<String>, method: DuckDbWorkerMethod, params: impl Serialize) -> Result<Self, String> {
        let params = serde_json::to_value(params).map_err(|error| error.to_string())?;
        Ok(Self { id: id.into(), method, params })
    }

    pub fn parse_params<T: DeserializeOwned>(&self) -> Result<T, DuckDbWorkerError> {
        serde_json::from_value(self.params.clone()).map_err(|error| {
            DuckDbWorkerError::new("invalid_params", format!("Invalid params for {:?}: {error}", self.method))
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DuckDbWorkerMethod {
    Connect,
    Execute,
    ListDatabases,
    ListSchemas,
    ListTables,
    ListColumns,
    GetTableDdl,
    CompletionAssistant,
    GetObjectSource,
    AttachDatabase,
    Cancel,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DuckDbWorkerResponse {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<DuckDbWorkerError>,
}

impl DuckDbWorkerResponse {
    pub fn ok(id: impl Into<String>, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self { id: id.into(), ok: true, result: Some(result), error: None },
            Err(error) => Self::err(id, DuckDbWorkerError::new("serialization_failed", error.to_string())),
        }
    }

    pub fn ok_empty(id: impl Into<String>) -> Self {
        Self { id: id.into(), ok: true, result: None, error: None }
    }

    pub fn err(id: impl Into<String>, error: DuckDbWorkerError) -> Self {
        Self { id: id.into(), ok: false, result: None, error: Some(error) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DuckDbWorkerError {
    pub code: String,
    pub message: String,
}

impl DuckDbWorkerError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    pub fn from_message(code: &'static str, error: impl ToString) -> Self {
        Self::new(code, error.to_string())
    }
}

impl From<String> for DuckDbWorkerError {
    fn from(message: String) -> Self {
        Self::new("duckdb_worker_error", message)
    }
}

impl From<&str> for DuckDbWorkerError {
    fn from(message: &str) -> Self {
        Self::new("duckdb_worker_error", message)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerConnectParams {
    pub path: String,
    #[serde(default)]
    pub attached_databases: Vec<AttachedDatabaseConfig>,
    #[serde(default)]
    pub init_script: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerExecuteParams {
    pub sql: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub max_rows: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerDatabaseParams {
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerTableParams {
    pub database: String,
    pub schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerColumnParams {
    pub database: String,
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DuckDbWorkerObjectSourceParams {
    pub database: String,
    pub schema: String,
    pub name: String,
    pub object_type: ObjectSourceKind,
}
