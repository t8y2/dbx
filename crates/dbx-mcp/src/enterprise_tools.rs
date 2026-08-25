use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ffi::OsStr,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use dbx_core::table_import::{
    TableImportColumnMapping, TableImportMode, TableImportParseOptions, TableImportPhase, TableImportPreview,
    TableImportProgress, TableImportRequest, TableImportSourceFormat, TableImportStatus, TableImportSummary,
    TableImportTextEncoding,
};
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;
use uuid::Uuid;

pub const FORMAT_VERSION: u8 = 1;
pub const DEFAULT_PLAN_TTL: Duration = Duration::from_secs(30 * 60);
const DEFAULT_IMPORT_FILE_SIZE_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_SEMANTIC_FILE_SIZE_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_PREVIEW_ROWS: usize = 20;
pub const STRUCTURE_PROFILE_ROWS: usize = 100;
const MAX_PREVIEW_ROWS: usize = STRUCTURE_PROFILE_ROWS;
const DEFAULT_CELL_CHAR_LIMIT: usize = 1_000;
const MAX_CELL_CHAR_LIMIT: usize = 4_000;
const DEFAULT_VECTOR_TOP_K: usize = 12;
const HARD_VECTOR_TOP_K: usize = 50;
const DEFAULT_VECTOR_DIMENSION: usize = 1_024;
const DEFAULT_VECTOR_UPSERT_BATCH: usize = 200;
const MAX_VECTOR_UPSERT_BATCH: usize = 500;
const MAX_JSONL_RECORD_BYTES: usize = 512 * 1024;

const IMPORT_EXTENSIONS: &[&str] = &["xlsx", "xlsm", "xls", "csv", "tsv", "json"];
const SEMANTIC_EXTENSIONS: &[&str] = &["jsonl"];
const DEFAULT_VECTOR_FILTER_FIELDS: &[&str] =
    &["business_domain", "dataset_id", "template_version", "card_type", "semantic_batch_id"];
const DEFAULT_VECTOR_OUTPUT_FIELDS: &[&str] = &[
    "card_id",
    "card_type",
    "business_domain",
    "dataset_id",
    "template_version",
    "title",
    "content",
    "aliases",
    "approval_status",
    "effective_from",
    "effective_to",
    "source_uri",
    "source_checksum",
    "semantic_version",
    "embedding_model",
    "semantic_batch_id",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnterpriseToolError {
    pub code: &'static str,
    pub message: String,
}

impl EnterpriseToolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for EnterpriseToolError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum McpImportSourceFormat {
    Csv,
    Tsv,
    Json,
    Excel,
}

impl From<McpImportSourceFormat> for TableImportSourceFormat {
    fn from(value: McpImportSourceFormat) -> Self {
        match value {
            McpImportSourceFormat::Csv => Self::Csv,
            McpImportSourceFormat::Tsv => Self::Tsv,
            McpImportSourceFormat::Json => Self::Json,
            McpImportSourceFormat::Excel => Self::Excel,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, schemars::JsonSchema)]
pub struct McpImportParseOptions {
    #[schemars(extend("type" = "string"))]
    pub delimiter: Option<String>,
    #[schemars(extend("type" = "string"))]
    pub encoding: Option<String>,
    #[schemars(extend("type" = "boolean"))]
    pub has_header: Option<bool>,
    #[schemars(extend("type" = "integer"))]
    pub title_row: Option<usize>,
    #[schemars(extend("type" = "integer"))]
    pub data_start_row: Option<usize>,
    #[schemars(extend("type" = "integer"))]
    pub last_data_row: Option<usize>,
    #[schemars(extend("type" = "boolean"))]
    pub trim_values: Option<bool>,
    #[schemars(extend("type" = "boolean"))]
    pub empty_string_as_null: Option<bool>,
    #[schemars(extend("type" = "string"))]
    pub sheet_name: Option<String>,
    #[schemars(extend("type" = "integer"))]
    pub sheet_index: Option<usize>,
}

impl McpImportParseOptions {
    pub fn into_core(self) -> Result<TableImportParseOptions, EnterpriseToolError> {
        let encoding = match self.encoding.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("auto") => Some(TableImportTextEncoding::Auto),
            Some(value) if value.eq_ignore_ascii_case("utf-8") || value.eq_ignore_ascii_case("utf8") => {
                Some(TableImportTextEncoding::Utf8)
            }
            Some(value) if value.eq_ignore_ascii_case("gbk") || value.eq_ignore_ascii_case("gb18030") => {
                Some(TableImportTextEncoding::Gbk)
            }
            Some(value) if value.eq_ignore_ascii_case("utf-16le") => Some(TableImportTextEncoding::Utf16Le),
            Some(value) if value.eq_ignore_ascii_case("utf-16be") => Some(TableImportTextEncoding::Utf16Be),
            Some(value) => {
                return Err(EnterpriseToolError::new(
                    "IMPORT_ENCODING_UNSUPPORTED",
                    format!("不支持编码 {value}；允许 auto、utf-8、gbk、utf-16le、utf-16be。"),
                ))
            }
        };
        if self.title_row == Some(0) || self.data_start_row == Some(0) || self.last_data_row == Some(0) {
            return Err(EnterpriseToolError::new("IMPORT_ROW_OUT_OF_RANGE", "行号从 1 开始，不能为 0。"));
        }
        Ok(TableImportParseOptions {
            delimiter: self.delimiter,
            encoding,
            has_header: self.has_header,
            title_row: self.title_row,
            data_start_row: self.data_start_row,
            last_data_row: self.last_data_row,
            trim_values: self.trim_values,
            empty_string_as_null: self.empty_string_as_null,
            sheet_name: self.sheet_name,
            sheet_index: self.sheet_index,
            ..Default::default()
        })
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct McpImportColumnMapping {
    pub source_column: String,
    pub target_column: String,
    #[schemars(extend("type" = "string"))]
    pub target_data_type: Option<String>,
}

impl From<McpImportColumnMapping> for TableImportColumnMapping {
    fn from(value: McpImportColumnMapping) -> Self {
        Self {
            source_column: value.source_column,
            target_column: value.target_column,
            target_data_type: value.target_data_type,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct PreviewImportFileRequest {
    pub file_path: String,
    #[schemars(extend("type" = "string"))]
    pub source_format: Option<McpImportSourceFormat>,
    #[serde(default)]
    pub parse_options: McpImportParseOptions,
    #[schemars(extend("type" = "integer"))]
    pub preview_rows: Option<usize>,
    #[schemars(extend("type" = "integer"))]
    pub cell_char_limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct PrepareTableImportRequest {
    #[serde(flatten)]
    pub selector: crate::server::ConnectionSelector,
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    pub schema: String,
    pub table: String,
    pub template_version: String,
    pub file_path: String,
    #[schemars(extend("type" = "string"))]
    pub source_format: Option<McpImportSourceFormat>,
    #[serde(default)]
    pub parse_options: McpImportParseOptions,
    pub mappings: Vec<McpImportColumnMapping>,
    #[serde(default)]
    pub create_table: bool,
    #[schemars(extend("type" = "integer"))]
    pub batch_size: Option<usize>,
    #[schemars(extend("type" = "string"))]
    pub date_time_format: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct StartTableImportRequest {
    pub plan_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct ImportStatusRequest {
    pub import_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct VectorSearchRequest {
    #[serde(flatten)]
    pub selector: crate::server::ConnectionSelector,
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    pub collection: String,
    pub active_at: String,
    #[schemars(extend("type" = "string"))]
    pub semantic_version: Option<String>,
    pub embedding: Vec<f32>,
    #[schemars(extend("type" = "integer"))]
    pub top_k: Option<usize>,
    #[serde(default)]
    pub filters: BTreeMap<String, Value>,
    #[schemars(extend("type" = "array"))]
    pub output_fields: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct VectorUpsertFileRequest {
    #[serde(flatten)]
    pub selector: crate::server::ConnectionSelector,
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    pub collection: String,
    pub semantic_batch_id: String,
    pub file_path: String,
    #[schemars(extend("type" = "integer"))]
    pub batch_size: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
pub struct VectorDeleteByBatchRequest {
    #[serde(flatten)]
    pub selector: crate::server::ConnectionSelector,
    #[schemars(extend("type" = "string"))]
    pub database: Option<String>,
    pub collection: String,
    pub semantic_batch_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub canonical_path: String,
    pub size_bytes: u64,
    pub modified_nanos: u128,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedImportPlan {
    pub plan_id: String,
    pub plan_digest: String,
    pub created_at_ms: u128,
    pub expires_at_ms: u128,
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    pub template_version: String,
    pub file: FileIdentity,
    pub structure_fingerprint: String,
    pub source_format: Option<TableImportSourceFormat>,
    pub parse_options: TableImportParseOptions,
    pub mappings: Vec<TableImportColumnMapping>,
    pub create_table: bool,
    pub batch_size: usize,
    pub date_time_format: Option<String>,
    #[serde(skip)]
    consumed: bool,
}

impl PreparedImportPlan {
    pub fn to_import_request(&self, import_id: String) -> TableImportRequest {
        TableImportRequest {
            import_id,
            connection_id: self.connection_id.clone(),
            database: self.database.clone(),
            schema: self.schema.clone(),
            table: self.table.clone(),
            file_path: self.file.canonical_path.clone(),
            source_ref: Some(self.file.sha256.clone()),
            source_format: self.source_format,
            parse_options: self.parse_options.clone(),
            mappings: self.mappings.clone(),
            mode: TableImportMode::Append,
            create_table: self.create_table,
            batch_size: self.batch_size,
            date_time_format: self.date_time_format.clone(),
            prepared_source: None,
            retain_source: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJobSnapshot {
    pub import_id: String,
    pub plan_id: String,
    pub status: TableImportStatus,
    pub phase: TableImportPhase,
    pub rows_imported: usize,
    pub total_rows: usize,
    pub total_rows_exact: bool,
    pub bytes_read: u64,
    pub total_bytes: u64,
    pub elapsed_ms: u128,
    pub error: Option<String>,
    pub summary: Option<TableImportSummary>,
}

impl ImportJobSnapshot {
    fn initial(import_id: String, plan_id: String, total_bytes: u64) -> Self {
        Self {
            import_id,
            plan_id,
            status: TableImportStatus::Running,
            phase: TableImportPhase::Preparing,
            rows_imported: 0,
            total_rows: 0,
            total_rows_exact: false,
            bytes_read: 0,
            total_bytes,
            elapsed_ms: 0,
            error: None,
            summary: None,
        }
    }

    pub fn apply_progress(&mut self, progress: TableImportProgress) {
        self.status = progress.status;
        self.phase = progress.phase;
        self.rows_imported = progress.rows_imported;
        self.total_rows = progress.total_rows;
        self.total_rows_exact = progress.total_rows_exact;
        self.bytes_read = progress.bytes_read;
        self.total_bytes = progress.total_bytes;
        self.elapsed_ms = progress.elapsed_ms;
        self.error = progress.error;
    }
}

pub struct ImportJob {
    pub snapshot: Mutex<ImportJobSnapshot>,
    pub cancelled: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct EnterpriseRuntime {
    plans: RwLock<HashMap<String, PreparedImportPlan>>,
    jobs: RwLock<HashMap<String, Arc<ImportJob>>>,
}

impl EnterpriseRuntime {
    pub async fn insert_plan(&self, plan: PreparedImportPlan) {
        let now = unix_epoch_millis();
        let mut plans = self.plans.write().await;
        plans.retain(|_, plan| !plan.consumed && plan.expires_at_ms > now);
        plans.insert(plan.plan_id.clone(), plan);
    }

    pub async fn consume_plan(&self, plan_id: &str) -> Result<PreparedImportPlan, EnterpriseToolError> {
        let mut plans = self.plans.write().await;
        let plan = plans
            .get_mut(plan_id)
            .ok_or_else(|| EnterpriseToolError::new("IMPORT_PLAN_NOT_FOUND", "导入计划不存在，或已经被清理。"))?;
        if plan.expires_at_ms <= unix_epoch_millis() {
            return Err(EnterpriseToolError::new("IMPORT_PLAN_EXPIRED", "导入计划已超过 30 分钟有效期。"));
        }
        if plan.consumed {
            return Err(EnterpriseToolError::new("IMPORT_PLAN_ALREADY_USED", "导入计划只能启动一次。"));
        }
        plan.consumed = true;
        Ok(plan.clone())
    }

    pub async fn create_job(&self, plan: &PreparedImportPlan) -> Arc<ImportJob> {
        let import_id = format!("mcp-import-{}", Uuid::new_v4());
        let job = Arc::new(ImportJob {
            snapshot: Mutex::new(ImportJobSnapshot::initial(
                import_id.clone(),
                plan.plan_id.clone(),
                plan.file.size_bytes,
            )),
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        self.jobs.write().await.insert(import_id, job.clone());
        job
    }

    pub async fn job(&self, import_id: &str) -> Option<Arc<ImportJob>> {
        self.jobs.read().await.get(import_id).cloned()
    }

    pub async fn cancel_job(&self, import_id: &str) -> Result<ImportJobSnapshot, EnterpriseToolError> {
        let job = self
            .job(import_id)
            .await
            .ok_or_else(|| EnterpriseToolError::new("IMPORT_JOB_NOT_FOUND", "没有找到指定导入任务。"))?;
        let snapshot = job.snapshot.lock().unwrap_or_else(|error| error.into_inner()).clone();
        if snapshot.status != TableImportStatus::Running {
            return Err(EnterpriseToolError::new("IMPORT_JOB_ALREADY_TERMINAL", "导入任务已经结束，不能再取消。"));
        }
        job.cancelled.store(true, Ordering::Release);
        Ok(snapshot)
    }
}

pub fn configured_import_roots() -> Result<Vec<PathBuf>, EnterpriseToolError> {
    let value = std::env::var_os("DBX_MCP_IMPORT_ROOTS").ok_or_else(|| {
        EnterpriseToolError::new(
            "IMPORT_ROOTS_NOT_CONFIGURED",
            "必须先配置 DBX_MCP_IMPORT_ROOTS，MCP 才能读取本地导入文件。",
        )
    })?;
    let roots = std::env::split_paths(&value)
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .filter(|path| path.parent().is_some())
        .collect::<Vec<_>>();
    if roots.is_empty() {
        return Err(EnterpriseToolError::new("IMPORT_ROOTS_NOT_CONFIGURED", "DBX_MCP_IMPORT_ROOTS 中没有可用目录。"));
    }
    Ok(roots)
}

pub fn validate_import_file(file_path: &str, semantic_jsonl: bool) -> Result<PathBuf, EnterpriseToolError> {
    let roots = configured_import_roots()?;
    let max_bytes = if semantic_jsonl {
        env_u64("DBX_MCP_SEMANTIC_FILE_MAX_BYTES", DEFAULT_SEMANTIC_FILE_SIZE_BYTES)
    } else {
        env_u64("DBX_MCP_IMPORT_FILE_MAX_BYTES", DEFAULT_IMPORT_FILE_SIZE_BYTES)
    };
    validate_import_file_with_roots(file_path, &roots, semantic_jsonl, max_bytes)
}

pub fn validate_import_file_with_roots(
    file_path: &str,
    roots: &[PathBuf],
    semantic_jsonl: bool,
    max_bytes: u64,
) -> Result<PathBuf, EnterpriseToolError> {
    let path = Path::new(file_path);
    if !path.is_absolute() {
        return Err(EnterpriseToolError::new("IMPORT_PATH_NOT_ABSOLUTE", "文件路径必须是绝对路径。"));
    }
    let link_metadata = std::fs::symlink_metadata(path)
        .map_err(|error| EnterpriseToolError::new("IMPORT_FILE_UNAVAILABLE", format!("无法读取文件元数据：{error}")))?;
    if link_metadata.file_type().is_symlink() {
        return Err(EnterpriseToolError::new("IMPORT_SYMLINK_REJECTED", "不允许通过符号链接导入文件。"));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| EnterpriseToolError::new("IMPORT_FILE_UNAVAILABLE", format!("无法解析文件路径：{error}")))?;
    if !roots.iter().filter_map(|root| std::fs::canonicalize(root).ok()).any(|root| canonical.starts_with(root)) {
        return Err(EnterpriseToolError::new(
            "IMPORT_PATH_OUTSIDE_ROOTS",
            "文件不在 DBX_MCP_IMPORT_ROOTS 允许目录中。",
        ));
    }
    let metadata = std::fs::metadata(&canonical)
        .map_err(|error| EnterpriseToolError::new("IMPORT_FILE_UNAVAILABLE", format!("无法读取文件元数据：{error}")))?;
    if !metadata.file_type().is_file() {
        return Err(EnterpriseToolError::new("IMPORT_NOT_REGULAR_FILE", "导入源必须是普通文件。"));
    }
    if metadata.len() > max_bytes {
        return Err(EnterpriseToolError::new(
            "IMPORT_FILE_TOO_LARGE",
            format!("文件大小 {} 字节，超过限制 {} 字节。", metadata.len(), max_bytes),
        ));
    }
    let extension = canonical.extension().and_then(OsStr::to_str).unwrap_or("").to_ascii_lowercase();
    let allowed = if semantic_jsonl { SEMANTIC_EXTENSIONS } else { IMPORT_EXTENSIONS };
    if !allowed.contains(&extension.as_str()) {
        return Err(EnterpriseToolError::new("IMPORT_FILE_TYPE_UNSUPPORTED", format!("不支持 .{extension} 文件。")));
    }
    Ok(canonical)
}

pub async fn file_identity(path: PathBuf) -> Result<FileIdentity, EnterpriseToolError> {
    tokio::task::spawn_blocking(move || file_identity_sync(&path))
        .await
        .map_err(|error| EnterpriseToolError::new("IMPORT_HASH_FAILED", error.to_string()))?
}

fn file_identity_sync(path: &Path) -> Result<FileIdentity, EnterpriseToolError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| EnterpriseToolError::new("IMPORT_FILE_UNAVAILABLE", format!("无法读取文件元数据：{error}")))?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let mut file = std::fs::File::open(path)
        .map_err(|error| EnterpriseToolError::new("IMPORT_HASH_FAILED", format!("无法打开文件：{error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| EnterpriseToolError::new("IMPORT_HASH_FAILED", format!("读取文件失败：{error}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(FileIdentity {
        canonical_path: path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        modified_nanos,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

pub fn preview_limit(value: Option<usize>) -> Result<usize, EnterpriseToolError> {
    let value = value.unwrap_or(DEFAULT_PREVIEW_ROWS);
    if value == 0 || value > MAX_PREVIEW_ROWS {
        return Err(EnterpriseToolError::new(
            "IMPORT_PREVIEW_LIMIT_INVALID",
            format!("preview_rows 必须在 1 到 {MAX_PREVIEW_ROWS} 之间。"),
        ));
    }
    Ok(value)
}

pub fn cell_char_limit(value: Option<usize>) -> Result<usize, EnterpriseToolError> {
    let value = value.unwrap_or(DEFAULT_CELL_CHAR_LIMIT);
    if value == 0 || value > MAX_CELL_CHAR_LIMIT {
        return Err(EnterpriseToolError::new(
            "IMPORT_CELL_LIMIT_INVALID",
            format!("cell_char_limit 必须在 1 到 {MAX_CELL_CHAR_LIMIT} 之间。"),
        ));
    }
    Ok(value)
}

pub fn sanitize_preview(mut preview: TableImportPreview, char_limit: usize) -> TableImportPreview {
    for row in &mut preview.rows {
        for cell in row {
            if let Value::String(value) = cell {
                let mut chars = value.chars();
                let truncated = chars.by_ref().take(char_limit).collect::<String>();
                if chars.next().is_some() {
                    *value = format!("{truncated}…");
                }
            }
        }
    }
    preview
}

pub fn structure_fingerprint(preview: &TableImportPreview, parse_options: &TableImportParseOptions) -> String {
    let value = json!({
        "fileType": preview.file_type,
        "columns": preview.columns,
        "columnTypeHints": column_type_hints(preview),
        "sheets": preview.sheets,
        "parseOptions": parse_options,
    });
    sha256_bytes(value.to_string().as_bytes())
}

pub fn column_type_hints(preview: &TableImportPreview) -> Vec<String> {
    (0..preview.columns.len())
        .map(|index| {
            let kinds = preview
                .rows
                .iter()
                .filter_map(|row| row.get(index))
                .filter_map(|value| match value {
                    Value::Null => None,
                    Value::Bool(_) => Some("boolean"),
                    Value::Number(number) if number.is_i64() || number.is_u64() => Some("integer"),
                    Value::Number(_) => Some("decimal"),
                    Value::String(_) => Some("text"),
                    Value::Array(_) | Value::Object(_) => Some("json"),
                })
                .collect::<std::collections::BTreeSet<_>>();
            if kinds.is_empty() {
                "empty".to_string()
            } else {
                kinds.into_iter().collect::<Vec<_>>().join("|")
            }
        })
        .collect()
}

pub fn validate_staging_target(schema: &str, table: &str) -> Result<(), EnterpriseToolError> {
    validate_identifier(schema, "schema")?;
    validate_identifier(table, "table")?;
    let allowed = comma_list_env("DBX_MCP_IMPORT_STAGING_SCHEMAS", &["staging"]);
    if !allowed.iter().any(|candidate| candidate == schema) {
        return Err(EnterpriseToolError::new(
            "IMPORT_TARGET_NOT_STAGING",
            format!("MCP 导入只能写入隔离 staging schema；当前允许：{}。", allowed.join(", ")),
        ));
    }
    Ok(())
}

pub fn validate_mappings(
    mappings: &[TableImportColumnMapping],
    source_columns: &[String],
) -> Result<(), EnterpriseToolError> {
    if mappings.is_empty() {
        return Err(EnterpriseToolError::new("IMPORT_MAPPING_REQUIRED", "至少需要一个字段映射。"));
    }
    let source = source_columns.iter().collect::<HashSet<_>>();
    let mut targets = HashSet::new();
    for mapping in mappings {
        if !source.contains(&mapping.source_column) {
            return Err(EnterpriseToolError::new(
                "IMPORT_SOURCE_COLUMN_NOT_FOUND",
                format!("源字段 {} 不存在。", mapping.source_column),
            ));
        }
        validate_identifier(&mapping.target_column, "target_column")?;
        if let Some(data_type) = mapping.target_data_type.as_deref() {
            validate_mcp_postgres_type(data_type)?;
        }
        if !targets.insert(mapping.target_column.as_str()) {
            return Err(EnterpriseToolError::new(
                "IMPORT_TARGET_COLUMN_DUPLICATED",
                format!("目标字段 {} 被重复映射。", mapping.target_column),
            ));
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn build_plan(
    connection_id: String,
    connection_name: String,
    database: String,
    schema: String,
    table: String,
    template_version: String,
    file: FileIdentity,
    structure_fingerprint: String,
    source_format: Option<TableImportSourceFormat>,
    parse_options: TableImportParseOptions,
    mappings: Vec<TableImportColumnMapping>,
    create_table: bool,
    batch_size: usize,
    date_time_format: Option<String>,
) -> Result<PreparedImportPlan, EnterpriseToolError> {
    if template_version.trim().is_empty() {
        return Err(EnterpriseToolError::new("IMPORT_TEMPLATE_VERSION_REQUIRED", "必须绑定已批准的模板版本。"));
    }
    let created_at_ms = unix_epoch_millis();
    let expires_at_ms = created_at_ms + DEFAULT_PLAN_TTL.as_millis();
    let plan_id = format!("plan-{}", Uuid::new_v4());
    let digest_source = json!({
        "planId": plan_id,
        "connectionId": connection_id,
        "database": database,
        "schema": schema,
        "table": table,
        "templateVersion": template_version,
        "file": file,
        "structureFingerprint": structure_fingerprint,
        "sourceFormat": source_format,
        "parseOptions": parse_options,
        "mappings": mappings,
        "createTable": create_table,
        "batchSize": batch_size,
        "dateTimeFormat": date_time_format,
        "expiresAtMs": expires_at_ms,
    });
    let plan_digest = sha256_bytes(digest_source.to_string().as_bytes());
    Ok(PreparedImportPlan {
        plan_id,
        plan_digest,
        created_at_ms,
        expires_at_ms,
        connection_id,
        connection_name,
        database,
        schema,
        table,
        template_version,
        file,
        structure_fingerprint,
        source_format,
        parse_options,
        mappings,
        create_table,
        batch_size,
        date_time_format,
        consumed: false,
    })
}

pub async fn revalidate_plan_file(plan: &PreparedImportPlan) -> Result<(), EnterpriseToolError> {
    let canonical = validate_import_file(&plan.file.canonical_path, false)?;
    let current = file_identity(canonical).await?;
    if current != plan.file {
        return Err(EnterpriseToolError::new(
            "IMPORT_FILE_CHANGED",
            "文件在 prepare 与 start 之间发生变化；请重新预览并准备导入计划。",
        ));
    }
    Ok(())
}

pub fn validate_vector_collection(collection: &str) -> Result<(), EnterpriseToolError> {
    validate_identifier(collection, "collection")?;
    let allowed = comma_list_env("DBX_MCP_VECTOR_COLLECTIONS", &["semantic_cards"]);
    if !allowed.iter().any(|candidate| candidate == collection) {
        return Err(EnterpriseToolError::new(
            "VECTOR_COLLECTION_NOT_ALLOWED",
            format!("集合 {collection} 不在允许列表中。"),
        ));
    }
    Ok(())
}

pub fn vector_top_k(top_k: Option<usize>) -> Result<usize, EnterpriseToolError> {
    let configured = env_usize("DBX_MCP_VECTOR_TOP_K_MAX", 20).clamp(1, HARD_VECTOR_TOP_K);
    let top_k = top_k.unwrap_or(DEFAULT_VECTOR_TOP_K);
    if top_k == 0 || top_k > configured {
        return Err(EnterpriseToolError::new("VECTOR_TOP_K_INVALID", format!("top_k 必须在 1 到 {configured} 之间。")));
    }
    Ok(top_k)
}

pub fn validate_embedding(embedding: &[f32]) -> Result<(), EnterpriseToolError> {
    let dimension = env_usize("DBX_MCP_VECTOR_DIMENSION", DEFAULT_VECTOR_DIMENSION).clamp(1, 65_536);
    if embedding.len() != dimension {
        return Err(EnterpriseToolError::new(
            "VECTOR_DIMENSION_MISMATCH",
            format!("向量维度为 {}，预期 {dimension}。", embedding.len()),
        ));
    }
    if embedding.iter().any(|value| !value.is_finite()) {
        return Err(EnterpriseToolError::new("VECTOR_VALUE_INVALID", "向量包含 NaN 或无穷值。"));
    }
    Ok(())
}

pub fn vector_output_fields(requested: Option<Vec<String>>) -> Result<Vec<String>, EnterpriseToolError> {
    let allowed = comma_list_env("DBX_MCP_VECTOR_OUTPUT_FIELDS", DEFAULT_VECTOR_OUTPUT_FIELDS);
    let requested =
        requested.unwrap_or_else(|| DEFAULT_VECTOR_OUTPUT_FIELDS.iter().map(|value| value.to_string()).collect());
    if requested.is_empty() {
        return Err(EnterpriseToolError::new("VECTOR_OUTPUT_FIELDS_REQUIRED", "至少需要一个输出字段。"));
    }
    let mut unique = HashSet::new();
    for field in &requested {
        validate_identifier(field, "output_field")?;
        if field == "embedding" || !allowed.iter().any(|allowed| allowed == field) {
            return Err(EnterpriseToolError::new(
                "VECTOR_OUTPUT_FIELD_NOT_ALLOWED",
                format!("不允许返回字段 {field}。"),
            ));
        }
        if !unique.insert(field) {
            return Err(EnterpriseToolError::new("VECTOR_OUTPUT_FIELD_DUPLICATED", format!("输出字段 {field} 重复。")));
        }
    }
    Ok(requested)
}

pub fn build_milvus_filter(
    active_at: &str,
    semantic_version: Option<&str>,
    filters: &BTreeMap<String, Value>,
) -> Result<String, EnterpriseToolError> {
    if !valid_effective_timestamp(active_at) {
        return Err(EnterpriseToolError::new(
            "VECTOR_ACTIVE_AT_INVALID",
            "active_at 必须是 YYYY-MM-DD 或 RFC 3339 时间。",
        ));
    }
    let allowed = comma_list_env("DBX_MCP_VECTOR_FILTER_FIELDS", DEFAULT_VECTOR_FILTER_FIELDS);
    let mut clauses = vec![
        format!("approval_status == {}", json_string("approved")),
        format!("effective_from <= {}", json_string(active_at)),
        format!("(effective_to == \"\" or effective_to >= {})", json_string(active_at)),
    ];
    if let Some(semantic_version) = semantic_version.map(str::trim).filter(|value| !value.is_empty()) {
        clauses.push(format!("semantic_version == {}", json_string(semantic_version)));
    }
    for (field, value) in filters {
        validate_identifier(field, "filter_field")?;
        if field == "approval_status" || field == "semantic_version" || !allowed.iter().any(|allowed| allowed == field)
        {
            return Err(EnterpriseToolError::new(
                "VECTOR_FILTER_FIELD_NOT_ALLOWED",
                format!("不允许过滤字段 {field}。"),
            ));
        }
        clauses.push(filter_clause(field, value)?);
    }
    Ok(clauses.join(" and "))
}

pub fn read_semantic_jsonl(path: &Path, semantic_batch_id: &str) -> Result<Vec<Value>, EnterpriseToolError> {
    if semantic_batch_id.trim().is_empty() {
        return Err(EnterpriseToolError::new("SEMANTIC_BATCH_ID_REQUIRED", "semantic_batch_id 不能为空。"));
    }
    let source = std::fs::read_to_string(path)
        .map_err(|error| EnterpriseToolError::new("VECTOR_JSONL_READ_FAILED", format!("读取 JSONL 失败：{error}")))?;
    let expected_dimension = env_usize("DBX_MCP_VECTOR_DIMENSION", DEFAULT_VECTOR_DIMENSION);
    let mut records = Vec::new();
    for (index, line) in source.lines().enumerate() {
        let line_number = index + 1;
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_JSONL_RECORD_BYTES {
            return Err(EnterpriseToolError::new(
                "VECTOR_JSONL_RECORD_TOO_LARGE",
                format!("JSONL 第 {line_number} 行超过 {} 字节。", MAX_JSONL_RECORD_BYTES),
            ));
        }
        let mut record = serde_json::from_str::<Value>(line).map_err(|error| {
            EnterpriseToolError::new("VECTOR_JSONL_INVALID", format!("JSONL 第 {line_number} 行无效：{error}"))
        })?;
        let object = record.as_object_mut().ok_or_else(|| {
            EnterpriseToolError::new("VECTOR_JSONL_INVALID", format!("JSONL 第 {line_number} 行必须是对象。"))
        })?;
        for required in ["card_id", "approval_status", "semantic_version", "effective_from", "embedding"] {
            if !object.contains_key(required) {
                return Err(EnterpriseToolError::new(
                    "VECTOR_JSONL_FIELD_MISSING",
                    format!("JSONL 第 {line_number} 行缺少 {required}。"),
                ));
            }
        }
        if object.get("approval_status").and_then(Value::as_str) != Some("approved") {
            return Err(EnterpriseToolError::new(
                "VECTOR_CARD_NOT_APPROVED",
                format!("JSONL 第 {line_number} 行不是 approved 语义卡。"),
            ));
        }
        for field in ["card_id", "semantic_version"] {
            if object.get(field).and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) {
                return Err(EnterpriseToolError::new(
                    "VECTOR_JSONL_FIELD_INVALID",
                    format!("JSONL 第 {line_number} 行的 {field} 必须是非空字符串。"),
                ));
            }
        }
        if object.get("effective_from").and_then(Value::as_str).is_none_or(|value| !valid_effective_timestamp(value)) {
            return Err(EnterpriseToolError::new(
                "VECTOR_JSONL_FIELD_INVALID",
                format!("JSONL 第 {line_number} 行的 effective_from 不是有效日期或 RFC 3339 时间。"),
            ));
        }
        match object.get("effective_to") {
            None | Some(Value::Null) => {
                object.insert("effective_to".to_string(), Value::String(String::new()));
            }
            Some(Value::String(value)) if value.is_empty() || valid_effective_timestamp(value) => {}
            Some(_) => {
                return Err(EnterpriseToolError::new(
                    "VECTOR_JSONL_FIELD_INVALID",
                    format!("JSONL 第 {line_number} 行的 effective_to 必须为 null、空字符串或有效日期/RFC 3339 时间。"),
                ));
            }
        }
        if let Some(existing) = object.get("semantic_batch_id").and_then(Value::as_str) {
            if existing != semantic_batch_id {
                return Err(EnterpriseToolError::new(
                    "SEMANTIC_BATCH_ID_MISMATCH",
                    format!("JSONL 第 {line_number} 行的 semantic_batch_id 不一致。"),
                ));
            }
        }
        object.insert("semantic_batch_id".to_string(), Value::String(semantic_batch_id.to_string()));
        object.entry("effective_to".to_string()).or_insert_with(|| Value::String(String::new()));
        let embedding = object.get("embedding").and_then(Value::as_array).ok_or_else(|| {
            EnterpriseToolError::new(
                "VECTOR_JSONL_EMBEDDING_INVALID",
                format!("JSONL 第 {line_number} 行 embedding 必须是数组。"),
            )
        })?;
        if embedding.len() != expected_dimension
            || embedding.iter().any(|value| value.as_f64().is_none_or(|v| !v.is_finite()))
        {
            return Err(EnterpriseToolError::new(
                "VECTOR_JSONL_EMBEDDING_INVALID",
                format!("JSONL 第 {line_number} 行 embedding 必须是 {expected_dimension} 维有限数值数组。"),
            ));
        }
        records.push(record);
    }
    if records.is_empty() {
        return Err(EnterpriseToolError::new("VECTOR_JSONL_EMPTY", "JSONL 中没有可 upsert 的语义卡。"));
    }
    Ok(records)
}

pub fn vector_upsert_batch_size(value: Option<usize>) -> Result<usize, EnterpriseToolError> {
    let value = value.unwrap_or(DEFAULT_VECTOR_UPSERT_BATCH);
    if value == 0 || value > MAX_VECTOR_UPSERT_BATCH {
        return Err(EnterpriseToolError::new(
            "VECTOR_UPSERT_BATCH_INVALID",
            format!("batch_size 必须在 1 到 {MAX_VECTOR_UPSERT_BATCH} 之间。"),
        ));
    }
    Ok(value)
}

pub fn milvus_search_query(
    database: &str,
    collection: &str,
    embedding: &[f32],
    top_k: usize,
    filter: &str,
    output_fields: &[String],
) -> String {
    format!(
        "POST /v2/vectordb/entities/search\n{}",
        json!({
            "dbName": if database.is_empty() { "default" } else { database },
            "collectionName": collection,
            "data": [embedding],
            "annsField": "embedding",
            "limit": top_k,
            "filter": filter,
            "outputFields": output_fields,
        })
    )
}

pub fn milvus_upsert_query(database: &str, collection: &str, records: &[Value]) -> String {
    format!(
        "POST /v2/vectordb/entities/upsert\n{}",
        json!({
            "dbName": if database.is_empty() { "default" } else { database },
            "collectionName": collection,
            "data": records,
        })
    )
}

pub fn milvus_delete_batch_query(database: &str, collection: &str, semantic_batch_id: &str) -> String {
    format!(
        "POST /v2/vectordb/entities/delete\n{}",
        json!({
            "dbName": if database.is_empty() { "default" } else { database },
            "collectionName": collection,
            "filter": format!("semantic_batch_id == {}", json_string(semantic_batch_id)),
        })
    )
}

pub fn query_result_rows(result: dbx_core::db::QueryResult) -> Vec<Value> {
    result
        .rows
        .into_iter()
        .map(|row| Value::Object(result.columns.iter().cloned().zip(row).collect::<serde_json::Map<String, Value>>()))
        .collect()
}

fn filter_clause(field: &str, value: &Value) -> Result<String, EnterpriseToolError> {
    match value {
        Value::String(value) => Ok(format!("{field} == {}", json_string(value))),
        Value::Number(value) => Ok(format!("{field} == {value}")),
        Value::Bool(value) => Ok(format!("{field} == {value}")),
        Value::Array(values) if !values.is_empty() && values.len() <= 50 => {
            let values = values
                .iter()
                .map(|value| match value {
                    Value::String(value) => Ok(json_string(value)),
                    Value::Number(value) => Ok(value.to_string()),
                    Value::Bool(value) => Ok(value.to_string()),
                    _ => Err(EnterpriseToolError::new(
                        "VECTOR_FILTER_VALUE_INVALID",
                        "过滤数组只允许字符串、数字或布尔值。",
                    )),
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("{field} in [{}]", values.join(", ")))
        }
        _ => Err(EnterpriseToolError::new(
            "VECTOR_FILTER_VALUE_INVALID",
            "过滤值只允许标量，或最多 50 个标量的非空数组。",
        )),
    }
}

fn validate_identifier(value: &str, field: &str) -> Result<(), EnterpriseToolError> {
    let valid = !value.is_empty()
        && value.len() <= 63
        && value
            .chars()
            .enumerate()
            .all(|(index, ch)| ch == '_' || ch.is_ascii_alphanumeric() && (index > 0 || !ch.is_ascii_digit()));
    if !valid {
        return Err(EnterpriseToolError::new(
            "IDENTIFIER_INVALID",
            format!("{field} 只能使用 1～63 位英文字母、数字或下划线，且不能以数字开头。"),
        ));
    }
    Ok(())
}

fn validate_mcp_postgres_type(data_type: &str) -> Result<(), EnterpriseToolError> {
    let normalized = data_type.trim().to_ascii_uppercase().replace(' ', "");
    let simple = matches!(normalized.as_str(), "TEXT" | "TIMESTAMPTZ" | "DATE" | "BOOLEAN" | "JSONB");
    let numeric = normalized
        .strip_prefix("NUMERIC(")
        .and_then(|value| value.strip_suffix(')'))
        .and_then(|value| value.split_once(','))
        .and_then(|(precision, scale)| Some((precision.parse::<u8>().ok()?, scale.parse::<u8>().ok()?)))
        .is_some_and(|(precision, scale)| (1..=100).contains(&precision) && scale <= precision);
    if !simple && !numeric {
        return Err(EnterpriseToolError::new(
            "IMPORT_TARGET_TYPE_NOT_ALLOWED",
            "v1 MCP 导入类型只允许 TEXT、NUMERIC(p,s)、TIMESTAMPTZ、DATE、BOOLEAN 或 JSONB。",
        ));
    }
    Ok(())
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn valid_effective_timestamp(value: &str) -> bool {
    let value = value.trim();
    (10..=40).contains(&value.len())
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, '-' | ':' | 'T' | 'Z' | '+' | '.'))
}

fn sha256_bytes(value: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value);
    format!("{:x}", hasher.finalize())
}

fn unix_epoch_millis() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).filter(|value| *value > 0).unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|value| value.parse().ok()).filter(|value| *value > 0).unwrap_or(default)
}

fn comma_list_env(name: &str, defaults: &[&str]) -> Vec<String> {
    let values = std::env::var(name)
        .ok()
        .map(|value| {
            value.split(',').map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty());
    values.unwrap_or_else(|| defaults.iter().map(|value| value.to_string()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_policy_rejects_outside_root_and_symlink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = root.path().join("input.csv");
        std::fs::write(&source, "id,name\n1,Ada\n").unwrap();
        assert_eq!(
            validate_import_file_with_roots(source.to_str().unwrap(), &[root.path().to_path_buf()], false, 1024)
                .unwrap(),
            std::fs::canonicalize(source).unwrap()
        );

        let outside_file = outside.path().join("outside.csv");
        std::fs::write(&outside_file, "id\n1\n").unwrap();
        assert_eq!(
            validate_import_file_with_roots(outside_file.to_str().unwrap(), &[root.path().to_path_buf()], false, 1024,)
                .unwrap_err()
                .code,
            "IMPORT_PATH_OUTSIDE_ROOTS"
        );

        #[cfg(unix)]
        {
            let link = root.path().join("link.csv");
            std::os::unix::fs::symlink(&outside_file, &link).unwrap();
            assert_eq!(
                validate_import_file_with_roots(link.to_str().unwrap(), &[root.path().to_path_buf()], false, 1024,)
                    .unwrap_err()
                    .code,
                "IMPORT_SYMLINK_REJECTED"
            );
        }
    }

    #[test]
    fn milvus_filter_forces_approval_and_semantic_version() {
        let filters = BTreeMap::from([("business_domain".to_string(), json!("交易"))]);
        let filter = build_milvus_filter("2026-08-25T10:00:00+08:00", Some("semantic-v3"), &filters).unwrap();
        assert!(filter.contains("approval_status == \"approved\""));
        assert!(filter.contains("effective_from <= \"2026-08-25T10:00:00+08:00\""));
        assert!(filter.contains("semantic_version == \"semantic-v3\""));
        assert!(filter.contains("business_domain == \"交易\""));

        let forbidden = BTreeMap::from([("approval_status".to_string(), json!("draft"))]);
        assert_eq!(
            build_milvus_filter("2026-08-25", None, &forbidden).unwrap_err().code,
            "VECTOR_FILTER_FIELD_NOT_ALLOWED"
        );
    }

    #[test]
    fn mappings_reject_missing_and_duplicate_targets() {
        let source = vec!["订单号".to_string(), "金额".to_string()];
        let duplicated = vec![
            TableImportColumnMapping {
                source_column: "订单号".to_string(),
                target_column: "order_id".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "金额".to_string(),
                target_column: "order_id".to_string(),
                target_data_type: None,
            },
        ];
        assert_eq!(validate_mappings(&duplicated, &source).unwrap_err().code, "IMPORT_TARGET_COLUMN_DUPLICATED");

        let unsafe_type = vec![TableImportColumnMapping {
            source_column: "订单号".to_string(),
            target_column: "order_id".to_string(),
            target_data_type: Some("TEXT DEFAULT current_user".to_string()),
        }];
        assert_eq!(validate_mappings(&unsafe_type, &source).unwrap_err().code, "IMPORT_TARGET_TYPE_NOT_ALLOWED");
    }

    #[test]
    fn semantic_jsonl_normalizes_null_effective_to() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cards.jsonl");
        let record = json!({
            "card_id": "metric-order-gmv",
            "approval_status": "approved",
            "semantic_version": "semantic-v1",
            "effective_from": "2026-08-25T00:00:00+08:00",
            "effective_to": null,
            "embedding": vec![0.0_f32; DEFAULT_VECTOR_DIMENSION],
        });
        std::fs::write(&path, format!("{}\n", record)).unwrap();

        let records = read_semantic_jsonl(&path, "semantic-batch-1").unwrap();
        assert_eq!(records[0].get("effective_to"), Some(&json!("")));
        assert_eq!(records[0].get("semantic_batch_id"), Some(&json!("semantic-batch-1")));
    }

    #[tokio::test]
    async fn prepared_plan_is_single_use() {
        let plan = build_plan(
            "connection-1".to_string(),
            "运营组数据写入".to_string(),
            "enterprise".to_string(),
            "staging".to_string(),
            "orders_batch_1".to_string(),
            "orders-v1".to_string(),
            FileIdentity {
                canonical_path: "/allowed/orders.csv".to_string(),
                size_bytes: 42,
                modified_nanos: 1,
                sha256: "a".repeat(64),
            },
            "structure-v1".to_string(),
            Some(TableImportSourceFormat::Csv),
            TableImportParseOptions::default(),
            vec![TableImportColumnMapping {
                source_column: "订单号".to_string(),
                target_column: "order_id".to_string(),
                target_data_type: Some("TEXT".to_string()),
            }],
            true,
            1_000,
            None,
        )
        .unwrap();
        let plan_id = plan.plan_id.clone();
        let runtime = EnterpriseRuntime::default();
        runtime.insert_plan(plan).await;

        assert_eq!(runtime.consume_plan(&plan_id).await.unwrap().plan_id, plan_id);
        assert_eq!(runtime.consume_plan(&plan_id).await.unwrap_err().code, "IMPORT_PLAN_ALREADY_USED");
    }
}
