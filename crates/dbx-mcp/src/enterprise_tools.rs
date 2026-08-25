use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ffi::OsStr,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write as IoWrite},
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
use sysinfo::Disks;
use time::{format_description::well_known::Rfc3339, OffsetDateTime, UtcOffset};
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
use uuid::Uuid;

pub const FORMAT_VERSION: u8 = 1;
pub const DEFAULT_PLAN_TTL: Duration = Duration::from_secs(30 * 60);
const DEFAULT_IMPORT_FILE_SIZE_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_SEMANTIC_FILE_SIZE_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_PREVIEW_ROWS: usize = 20;
const MAX_PREVIEW_ROWS: usize = 100;
const DEFAULT_CELL_CHAR_LIMIT: usize = 1_000;
const MAX_CELL_CHAR_LIMIT: usize = 4_000;
const DEFAULT_VECTOR_TOP_K: usize = 12;
const HARD_VECTOR_TOP_K: usize = 50;
const DEFAULT_VECTOR_DIMENSION: usize = 1_024;
const DEFAULT_VECTOR_UPSERT_BATCH: usize = 200;
const MAX_VECTOR_UPSERT_BATCH: usize = 500;
const MAX_JSONL_RECORD_BYTES: usize = 512 * 1024;
const DEFAULT_PLAN_CAPACITY: usize = 512;
const DEFAULT_JOB_CAPACITY: usize = 256;
const DEFAULT_TERMINAL_JOB_LIMIT: usize = 128;
const JOB_TTL_MS: u128 = 24 * 60 * 60 * 1_000;
const DEFAULT_INSPECTION_CONCURRENCY: usize = 2;
const DEFAULT_INSPECTION_TIMEOUT_SECS: u64 = 30;
const DEFAULT_XLSX_ZIP_ENTRY_LIMIT: usize = 4_096;
const DEFAULT_XLSX_TOTAL_UNCOMPRESSED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const DEFAULT_XLSX_METADATA_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
const DEFAULT_XLSX_SHARED_STRINGS_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_XLSX_WORKSHEET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_XLSX_WORKSHEET_ROWS: usize = 5_000_000;
const DEFAULT_XLSX_WORKSHEET_CELLS: usize = 100_000_000;
const DEFAULT_XLSX_CELL_BYTES: usize = 1024 * 1024;
const DEFAULT_XLSX_BATCH_MEMORY_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_NORMALIZED_OUTPUT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_IMPORT_DISK_RESERVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const ESTIMATED_IMPORT_CELL_BYTES: usize = 512;

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
    "content_checksum",
    "semantic_version",
    "embedding_model",
    "embedding_revision",
    "semantic_batch_id",
];
const RESERVED_STAGING_COLUMNS: &[&str] =
    &["import_id", "plan_id", "source_sha", "source_row_number", "source_row_hash", "loaded_at"];
const SEMANTIC_VARCHAR_LIMITS: &[(&str, usize)] = &[
    ("card_id", 128),
    ("card_type", 32),
    ("business_domain", 128),
    ("dataset_id", 128),
    ("template_version", 64),
    ("title", 512),
    ("content", 8_192),
    ("approval_status", 32),
    ("effective_from", 10),
    ("effective_to", 10),
    ("source_uri", 2_048),
    ("source_checksum", 64),
    ("content_checksum", 64),
    ("semantic_version", 128),
    ("semantic_batch_id", 128),
    ("embedding_model", 128),
    ("embedding_revision", 64),
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize, schemars::JsonSchema)]
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
    #[schemars(description = "1-based source column position returned by dbx_preview_import_file")]
    pub source_position: usize,
    pub raw_source_name: String,
    pub canonical_source_name: String,
    pub target_column: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSourceColumn {
    pub source_position: usize,
    pub raw_source_name: String,
    pub canonical_source_name: String,
    pub dbx_source_name: String,
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
    pub template_version: String,
    pub file_path: String,
    #[schemars(extend("type" = "string"))]
    pub source_format: Option<McpImportSourceFormat>,
    #[serde(default)]
    pub parse_options: McpImportParseOptions,
    pub mappings: Vec<McpImportColumnMapping>,
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
    #[schemars(
        pattern(r"^\d{4}-\d{2}-\d{2}$"),
        description = "Required Asia/Shanghai business date in YYYY-MM-DD format"
    )]
    pub active_at: String,
    #[schemars(
        length(min = 1, max = 128),
        description = "Required exact semantic version; UTF-8 byte length must be 1 to 128"
    )]
    pub semantic_version: String,
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
    #[schemars(extend("type" = "boolean"), description = "Ignored in v1; deletion is disabled server-side")]
    pub published: Option<bool>,
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
    pub relation: String,
    pub created_at_ms: u128,
    pub finished_at_ms: Option<u128>,
    pub cancellation_requested: bool,
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
    fn initial(import_id: String, plan: &PreparedImportPlan) -> Self {
        Self {
            import_id,
            plan_id: plan.plan_id.clone(),
            relation: format!("{}.{}", plan.schema, plan.table),
            created_at_ms: unix_epoch_millis(),
            finished_at_ms: None,
            cancellation_requested: false,
            status: TableImportStatus::Running,
            phase: TableImportPhase::Preparing,
            rows_imported: 0,
            total_rows: 0,
            total_rows_exact: false,
            bytes_read: 0,
            total_bytes: plan.file.size_bytes,
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

pub struct EnterpriseRuntime {
    plans: RwLock<HashMap<String, PreparedImportPlan>>,
    jobs: RwLock<HashMap<String, Arc<ImportJob>>>,
    inspection_slots: Arc<Semaphore>,
    import_slots: Arc<Semaphore>,
    semantic_write_slots: Arc<Semaphore>,
    plan_capacity: usize,
    job_capacity: usize,
    terminal_job_limit: usize,
}

impl Default for EnterpriseRuntime {
    fn default() -> Self {
        Self {
            plans: RwLock::new(HashMap::new()),
            jobs: RwLock::new(HashMap::new()),
            inspection_slots: Arc::new(Semaphore::new(
                env_usize("DBX_MCP_IMPORT_INSPECTION_CONCURRENCY", DEFAULT_INSPECTION_CONCURRENCY).clamp(1, 8),
            )),
            import_slots: Arc::new(Semaphore::new(env_usize("DBX_MCP_IMPORT_CONCURRENCY", 2).clamp(1, 16))),
            semantic_write_slots: Arc::new(Semaphore::new(1)),
            plan_capacity: env_usize("DBX_MCP_IMPORT_PLAN_CAPACITY", DEFAULT_PLAN_CAPACITY).clamp(1, 4_096),
            job_capacity: env_usize("DBX_MCP_IMPORT_JOB_CAPACITY", DEFAULT_JOB_CAPACITY).clamp(1, 2_048),
            terminal_job_limit: env_usize("DBX_MCP_IMPORT_TERMINAL_LIMIT", DEFAULT_TERMINAL_JOB_LIMIT).clamp(1, 1_024),
        }
    }
}

impl EnterpriseRuntime {
    #[cfg(test)]
    fn with_inspection_concurrency(concurrency: usize) -> Self {
        Self { inspection_slots: Arc::new(Semaphore::new(concurrency.max(1))), ..Self::default() }
    }

    pub async fn try_inspection_permit(&self) -> Result<OwnedSemaphorePermit, EnterpriseToolError> {
        self.inspection_slots.clone().try_acquire_owned().map_err(|_| {
            EnterpriseToolError::new("IMPORT_INSPECTION_CONCURRENCY_LIMIT", "文件剖析并发已达到上限，请稍后重试。")
        })
    }

    pub async fn insert_plan(&self, plan: PreparedImportPlan) -> Result<(), EnterpriseToolError> {
        let now = unix_epoch_millis();
        let mut plans = self.plans.write().await;
        plans.retain(|_, plan| !plan.consumed && plan.expires_at_ms > now);
        if plans.len() >= self.plan_capacity {
            return Err(EnterpriseToolError::new(
                "IMPORT_PLAN_CAPACITY_REACHED",
                "待启动导入计划已达到容量上限；请等待计划过期或启动已有计划。",
            ));
        }
        plans.insert(plan.plan_id.clone(), plan);
        Ok(())
    }

    pub async fn consume_plan(&self, plan_id: &str) -> Result<PreparedImportPlan, EnterpriseToolError> {
        let mut plans = self.plans.write().await;
        let plan = plans
            .get_mut(plan_id)
            .ok_or_else(|| EnterpriseToolError::new("IMPORT_PLAN_NOT_FOUND", "导入计划不存在，或已经被清理。"))?;
        if plan.expires_at_ms <= unix_epoch_millis() {
            plans.remove(plan_id);
            return Err(EnterpriseToolError::new("IMPORT_PLAN_EXPIRED", "导入计划已超过 30 分钟有效期。"));
        }
        if plan.consumed {
            return Err(EnterpriseToolError::new("IMPORT_PLAN_ALREADY_USED", "导入计划只能启动一次。"));
        }
        plan.consumed = true;
        Ok(plan.clone())
    }

    pub async fn try_import_permit(&self) -> Result<OwnedSemaphorePermit, EnterpriseToolError> {
        self.import_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| EnterpriseToolError::new("IMPORT_CONCURRENCY_LIMIT", "并发导入已达到上限，请稍后重试。"))
    }

    pub async fn semantic_write_permit(&self) -> Result<OwnedSemaphorePermit, EnterpriseToolError> {
        self.semantic_write_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| EnterpriseToolError::new("VECTOR_WRITE_COORDINATOR_CLOSED", "语义写入协调器不可用。"))
    }

    pub async fn create_job(&self, plan: &PreparedImportPlan) -> Result<Arc<ImportJob>, EnterpriseToolError> {
        let import_id = format!("mcp-import-{}", Uuid::new_v4());
        let job = Arc::new(ImportJob {
            snapshot: Mutex::new(ImportJobSnapshot::initial(import_id.clone(), plan)),
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        let mut jobs = self.jobs.write().await;
        cleanup_jobs(&mut jobs, self.terminal_job_limit);
        if jobs.len() >= self.job_capacity {
            return Err(EnterpriseToolError::new(
                "IMPORT_JOB_CAPACITY_REACHED",
                "导入任务记录已达到容量上限；请等待终态任务过期。",
            ));
        }
        jobs.insert(import_id, job.clone());
        Ok(job)
    }

    pub async fn job(&self, import_id: &str) -> Option<Arc<ImportJob>> {
        let mut jobs = self.jobs.write().await;
        cleanup_jobs(&mut jobs, self.terminal_job_limit);
        jobs.get(import_id).cloned()
    }

    pub async fn cancel_job(&self, import_id: &str) -> Result<(ImportJobSnapshot, bool), EnterpriseToolError> {
        let job = self
            .job(import_id)
            .await
            .ok_or_else(|| EnterpriseToolError::new("IMPORT_JOB_NOT_FOUND", "没有找到指定导入任务。"))?;
        let mut snapshot = job.snapshot.lock().unwrap_or_else(|error| error.into_inner());
        if snapshot.status != TableImportStatus::Running {
            return Err(EnterpriseToolError::new("IMPORT_JOB_ALREADY_TERMINAL", "导入任务已经结束，不能再取消。"));
        }
        let already_requested = job.cancelled.swap(true, Ordering::AcqRel);
        snapshot.cancellation_requested = true;
        Ok((snapshot.clone(), already_requested))
    }
}

fn cleanup_jobs(jobs: &mut HashMap<String, Arc<ImportJob>>, terminal_limit: usize) {
    let now = unix_epoch_millis();
    jobs.retain(|_, job| {
        let snapshot = job.snapshot.lock().unwrap_or_else(|error| error.into_inner());
        snapshot.status == TableImportStatus::Running
            || snapshot.finished_at_ms.is_none_or(|finished| now.saturating_sub(finished) <= JOB_TTL_MS)
    });
    let mut terminal = jobs
        .iter()
        .filter_map(|(id, job)| {
            let snapshot = job.snapshot.lock().unwrap_or_else(|error| error.into_inner());
            (snapshot.status != TableImportStatus::Running)
                .then_some((id.clone(), snapshot.finished_at_ms.unwrap_or(0)))
        })
        .collect::<Vec<_>>();
    terminal.sort_by_key(|(_, finished)| *finished);
    let remove_count = terminal.len().saturating_sub(terminal_limit);
    for (id, _) in terminal.into_iter().take(remove_count) {
        jobs.remove(&id);
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
        .filter(|path| path.parent().is_some() && path.is_dir())
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
    if !roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .filter(|root| root.is_dir())
        .any(|root| canonical.starts_with(root))
    {
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
    let mut file = open_regular_file_nofollow(path)?;
    let metadata = file
        .metadata()
        .map_err(|error| EnterpriseToolError::new("IMPORT_FILE_UNAVAILABLE", format!("无法读取文件元数据：{error}")))?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
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
    let final_metadata = file
        .metadata()
        .map_err(|error| EnterpriseToolError::new("IMPORT_FILE_UNAVAILABLE", format!("无法复核文件元数据：{error}")))?;
    if !same_file_metadata(&metadata, &final_metadata) {
        return Err(EnterpriseToolError::new(
            "IMPORT_FILE_CHANGED_DURING_HASH",
            "文件在计算 SHA-256 期间发生变化；结果已丢弃。",
        ));
    }
    Ok(FileIdentity {
        canonical_path: path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        modified_nanos,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

fn open_regular_file_nofollow(path: &Path) -> Result<File, EnterpriseToolError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|error| EnterpriseToolError::new("IMPORT_FILE_UNAVAILABLE", format!("无法安全打开文件：{error}")))?;
    let metadata = file
        .metadata()
        .map_err(|error| EnterpriseToolError::new("IMPORT_FILE_UNAVAILABLE", format!("无法读取文件描述符：{error}")))?;
    if !metadata.file_type().is_file() {
        return Err(EnterpriseToolError::new("IMPORT_NOT_REGULAR_FILE", "导入源必须是普通文件。"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let path_metadata = std::fs::metadata(path).map_err(|error| {
            EnterpriseToolError::new("IMPORT_FILE_UNAVAILABLE", format!("无法复核文件路径：{error}"))
        })?;
        if metadata.dev() != path_metadata.dev() || metadata.ino() != path_metadata.ino() {
            return Err(EnterpriseToolError::new(
                "IMPORT_FILE_IDENTITY_RACE",
                "文件路径在打开期间指向了不同对象；结果已丢弃。",
            ));
        }
    }
    Ok(file)
}

fn same_file_metadata(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.dev() == after.dev()
            && before.ino() == after.ino()
            && before.len() == after.len()
            && before.mtime() == after.mtime()
            && before.mtime_nsec() == after.mtime_nsec()
            && before.ctime() == after.ctime()
            && before.ctime_nsec() == after.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        before.len() == after.len()
            && before.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok())
                == after.modified().ok().and_then(|value| value.duration_since(UNIX_EPOCH).ok())
    }
}

pub fn ensure_import_disk_budget(snapshot_root: &Path, source_size: u64) -> Result<(), EnterpriseToolError> {
    let canonical = std::fs::canonicalize(snapshot_root).map_err(|error| {
        EnterpriseToolError::new("IMPORT_DISK_BUDGET_UNAVAILABLE", format!("无法解析任务磁盘路径：{error}"))
    })?;
    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .list()
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .ok_or_else(|| EnterpriseToolError::new("IMPORT_DISK_BUDGET_UNAVAILABLE", "无法确定任务磁盘剩余容量。"))?;
    let reserve = env_u64("DBX_MCP_IMPORT_DISK_RESERVE_BYTES", DEFAULT_IMPORT_DISK_RESERVE_BYTES)
        .clamp(512 * 1024 * 1024, 16 * 1024 * 1024 * 1024);
    let required = source_size
        .checked_add(normalized_output_limit())
        .and_then(|value| value.checked_add(reserve))
        .ok_or_else(|| EnterpriseToolError::new("IMPORT_DISK_BUDGET_EXCEEDED", "导入磁盘预算累计溢出。"))?;
    if disk.available_space() < required {
        return Err(EnterpriseToolError::new(
            "IMPORT_DISK_BUDGET_EXCEEDED",
            format!(
                "任务磁盘可用 {} 字节，至少需要 {required} 字节（源文件、规范化上限与安全保留空间）。",
                disk.available_space()
            ),
        ));
    }
    Ok(())
}

pub async fn copy_verified_import_source(
    source: PathBuf,
    destination: PathBuf,
    expected_sha256: String,
    cancelled: Arc<AtomicBool>,
) -> Result<(), EnterpriseToolError> {
    tokio::task::spawn_blocking(move || {
        let result = copy_verified_import_source_sync(&source, &destination, &expected_sha256, &cancelled);
        if result.is_err() {
            let _ = std::fs::remove_file(&destination);
        }
        result
    })
    .await
    .map_err(|error| EnterpriseToolError::new("IMPORT_COPY_FAILED", error.to_string()))?
}

fn copy_verified_import_source_sync(
    source: &Path,
    destination: &Path,
    expected_sha256: &str,
    cancelled: &AtomicBool,
) -> Result<(), EnterpriseToolError> {
    if !is_sha256_hex(expected_sha256) {
        return Err(EnterpriseToolError::new("IMPORT_SOURCE_HASH_REQUIRED", "导入计划缺少合法 SHA-256。"));
    }
    let mut input = open_regular_file_nofollow(source)?;
    let initial = input
        .metadata()
        .map_err(|error| EnterpriseToolError::new("IMPORT_COPY_FAILED", format!("无法读取源文件描述符：{error}")))?;
    let mut output =
        OpenOptions::new().write(true).create_new(true).open(destination).map_err(|error| {
            EnterpriseToolError::new("IMPORT_COPY_FAILED", format!("无法创建任务私有快照：{error}"))
        })?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err(EnterpriseToolError::new("IMPORT_CANCELLED", "复制任务私有快照时收到取消请求。"));
        }
        let read = input
            .read(&mut buffer)
            .map_err(|error| EnterpriseToolError::new("IMPORT_COPY_FAILED", format!("读取源文件失败：{error}")))?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read]).map_err(|error| {
            EnterpriseToolError::new("IMPORT_COPY_FAILED", format!("写入任务私有快照失败：{error}"))
        })?;
        hasher.update(&buffer[..read]);
    }
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|error| EnterpriseToolError::new("IMPORT_COPY_FAILED", format!("落盘任务私有快照失败：{error}")))?;
    let final_metadata = input
        .metadata()
        .map_err(|error| EnterpriseToolError::new("IMPORT_COPY_FAILED", format!("无法复核源文件描述符：{error}")))?;
    if !same_file_metadata(&initial, &final_metadata) {
        return Err(EnterpriseToolError::new(
            "IMPORT_FILE_CHANGED",
            "源文件在复制任务私有快照期间发生变化；未访问数据库。",
        ));
    }
    let actual_sha256 = format!("{:x}", hasher.finalize());
    if actual_sha256 != expected_sha256 {
        return Err(EnterpriseToolError::new("IMPORT_FILE_CHANGED", "源文件在启动导入时发生变化；未访问数据库。"));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub struct ImportInspection {
    pub identity: FileIdentity,
    pub preview: TableImportPreview,
    pub source_columns: Vec<McpSourceColumn>,
}

pub fn inspection_timeout() -> Duration {
    Duration::from_secs(
        env_u64("DBX_MCP_IMPORT_INSPECTION_TIMEOUT_SECS", DEFAULT_INSPECTION_TIMEOUT_SECS).clamp(5, 120),
    )
}

pub async fn inspect_import_source(
    path: PathBuf,
    source_format: Option<TableImportSourceFormat>,
    parse_options: TableImportParseOptions,
    preview_rows: usize,
) -> Result<ImportInspection, EnterpriseToolError> {
    let limits_path = path.clone();
    tokio::task::spawn_blocking(move || validate_source_archive_limits(&limits_path, source_format))
        .await
        .map_err(|error| EnterpriseToolError::new("IMPORT_INSPECTION_FAILED", error.to_string()))??;
    let identity = file_identity(path.clone()).await?;
    let file_path = path.to_string_lossy().to_string();
    let preview = dbx_core::table_import::preview_table_import_file_with_request(
        dbx_core::table_import::TableImportPreviewRequest {
            file_path: file_path.clone(),
            source_ref: Some(identity.sha256.clone()),
            source_format,
            parse_options: parse_options.clone(),
            preview_limit: Some(preview_rows),
        },
    )
    .await
    .map_err(|error| EnterpriseToolError::new("IMPORT_PREVIEW_FAILED", error))?;
    validate_preview_headers(&preview)?;
    let source_columns =
        source_columns_for_preview(&file_path, source_format, &parse_options, &preview.columns).await?;
    let current_identity = file_identity(path).await?;
    if current_identity != identity {
        return Err(EnterpriseToolError::new(
            "IMPORT_FILE_CHANGED_DURING_INSPECTION",
            "文件在剖析期间发生变化；结果已丢弃。",
        ));
    }
    Ok(ImportInspection { identity, preview, source_columns })
}

#[derive(Debug, Clone, Copy)]
struct XlsxArchiveLimits {
    entry_count: usize,
    total_uncompressed_bytes: u64,
    metadata_entry_bytes: u64,
    shared_strings_bytes: u64,
    worksheet_bytes: u64,
}

fn xlsx_archive_limits() -> XlsxArchiveLimits {
    XlsxArchiveLimits {
        entry_count: env_usize("DBX_MCP_XLSX_ZIP_ENTRY_LIMIT", DEFAULT_XLSX_ZIP_ENTRY_LIMIT).clamp(16, 16_384),
        total_uncompressed_bytes: env_u64(
            "DBX_MCP_XLSX_TOTAL_UNCOMPRESSED_MAX_BYTES",
            DEFAULT_XLSX_TOTAL_UNCOMPRESSED_BYTES,
        )
        .clamp(64 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
        metadata_entry_bytes: env_u64("DBX_MCP_XLSX_METADATA_ENTRY_MAX_BYTES", DEFAULT_XLSX_METADATA_ENTRY_BYTES)
            .clamp(1024 * 1024, 64 * 1024 * 1024),
        shared_strings_bytes: env_u64("DBX_MCP_XLSX_SHARED_STRINGS_MAX_BYTES", DEFAULT_XLSX_SHARED_STRINGS_BYTES)
            .clamp(8 * 1024 * 1024, 512 * 1024 * 1024),
        worksheet_bytes: env_u64("DBX_MCP_XLSX_WORKSHEET_MAX_BYTES", DEFAULT_XLSX_WORKSHEET_BYTES)
            .clamp(64 * 1024 * 1024, 4 * 1024 * 1024 * 1024),
    }
}

fn validate_source_archive_limits(
    path: &Path,
    source_format: Option<TableImportSourceFormat>,
) -> Result<(), EnterpriseToolError> {
    let format = dbx_core::table_import::effective_source_format(&path.to_string_lossy(), source_format)
        .map_err(|error| EnterpriseToolError::new("IMPORT_SOURCE_FORMAT_INVALID", error))?;
    let extension = path.extension().and_then(OsStr::to_str).unwrap_or_default();
    if format != TableImportSourceFormat::Excel
        || (!extension.eq_ignore_ascii_case("xlsx") && !extension.eq_ignore_ascii_case("xlsm"))
    {
        return Ok(());
    }
    validate_xlsx_archive_limits(path, xlsx_archive_limits())
}

fn validate_xlsx_archive_limits(path: &Path, limits: XlsxArchiveLimits) -> Result<(), EnterpriseToolError> {
    let mut file = open_regular_file_nofollow(path)?;
    let declared_entries = xlsx_eocd_entry_count(&mut file)?;
    if declared_entries > limits.entry_count {
        return Err(EnterpriseToolError::new(
            "IMPORT_XLSX_ZIP_ENTRY_LIMIT_EXCEEDED",
            format!("XLSX ZIP 包含 {declared_entries} 个条目，超过 {} 个安全上限。", limits.entry_count),
        ));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| EnterpriseToolError::new("IMPORT_XLSX_ZIP_INVALID", error.to_string()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| EnterpriseToolError::new("IMPORT_XLSX_ZIP_INVALID", error.to_string()))?;
    if archive.len() != declared_entries {
        return Err(EnterpriseToolError::new(
            "IMPORT_XLSX_ZIP_ENTRY_COUNT_MISMATCH",
            "XLSX ZIP 中央目录条目数不一致。",
        ));
    }
    let mut names = HashSet::new();
    let mut total_uncompressed = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| EnterpriseToolError::new("IMPORT_XLSX_ZIP_INVALID", error.to_string()))?;
        let name = entry.name().replace('\\', "/");
        if !names.insert(name.clone()) {
            return Err(EnterpriseToolError::new(
                "IMPORT_XLSX_ZIP_DUPLICATE_ENTRY",
                format!("XLSX ZIP 包含重复条目 {name}。"),
            ));
        }
        total_uncompressed = total_uncompressed.checked_add(entry.size()).ok_or_else(|| {
            EnterpriseToolError::new("IMPORT_XLSX_ZIP_BUDGET_EXCEEDED", "XLSX ZIP 解压大小累计溢出。")
        })?;
        if total_uncompressed > limits.total_uncompressed_bytes {
            return Err(EnterpriseToolError::new(
                "IMPORT_XLSX_ZIP_BUDGET_EXCEEDED",
                format!("XLSX ZIP 解压总大小超过 {} 字节。", limits.total_uncompressed_bytes),
            ));
        }
        let metadata_entry = matches!(
            name.as_str(),
            "xl/workbook.xml" | "xl/_rels/workbook.xml.rels" | "xl/styles.xml" | "[Content_Types].xml"
        );
        if metadata_entry && entry.size() > limits.metadata_entry_bytes {
            return Err(EnterpriseToolError::new(
                "IMPORT_XLSX_METADATA_BUDGET_EXCEEDED",
                format!("XLSX 元数据条目 {name} 超过 {} 字节。", limits.metadata_entry_bytes),
            ));
        }
        if name == "xl/sharedStrings.xml" && entry.size() > limits.shared_strings_bytes {
            return Err(EnterpriseToolError::new(
                "IMPORT_XLSX_SHARED_STRINGS_BUDGET_EXCEEDED",
                format!("XLSX sharedStrings 超过 {} 字节。", limits.shared_strings_bytes),
            ));
        }
        if name.starts_with("xl/worksheets/") && name.ends_with(".xml") && entry.size() > limits.worksheet_bytes {
            return Err(EnterpriseToolError::new(
                "IMPORT_XLSX_WORKSHEET_BUDGET_EXCEEDED",
                format!("XLSX 工作表 {name} 超过 {} 字节。", limits.worksheet_bytes),
            ));
        }
    }
    Ok(())
}

fn xlsx_eocd_entry_count(file: &mut File) -> Result<usize, EnterpriseToolError> {
    let length =
        file.metadata().map_err(|error| EnterpriseToolError::new("IMPORT_XLSX_ZIP_INVALID", error.to_string()))?.len();
    let tail_len = length.min(65_557) as usize;
    file.seek(SeekFrom::End(-(tail_len as i64)))
        .map_err(|error| EnterpriseToolError::new("IMPORT_XLSX_ZIP_INVALID", error.to_string()))?;
    let mut tail = vec![0u8; tail_len];
    file.read_exact(&mut tail)
        .map_err(|error| EnterpriseToolError::new("IMPORT_XLSX_ZIP_INVALID", error.to_string()))?;
    let offset = tail
        .windows(4)
        .rposition(|window| window == [0x50, 0x4b, 0x05, 0x06])
        .ok_or_else(|| EnterpriseToolError::new("IMPORT_XLSX_ZIP_INVALID", "XLSX ZIP 缺少 EOCD。"))?;
    if tail.len().saturating_sub(offset) < 22 {
        return Err(EnterpriseToolError::new("IMPORT_XLSX_ZIP_INVALID", "XLSX ZIP EOCD 不完整。"));
    }
    let disk = u16::from_le_bytes([tail[offset + 4], tail[offset + 5]]);
    let central_disk = u16::from_le_bytes([tail[offset + 6], tail[offset + 7]]);
    let disk_entries = u16::from_le_bytes([tail[offset + 8], tail[offset + 9]]);
    let total_entries = u16::from_le_bytes([tail[offset + 10], tail[offset + 11]]);
    if disk != 0 || central_disk != 0 || disk_entries != total_entries {
        return Err(EnterpriseToolError::new("IMPORT_XLSX_ZIP_MULTIDISK_UNSUPPORTED", "不支持多磁盘 XLSX ZIP。"));
    }
    if total_entries == u16::MAX {
        return Err(EnterpriseToolError::new(
            "IMPORT_XLSX_ZIP64_ENTRY_COUNT_UNSUPPORTED",
            "XLSX ZIP64 条目数无法在剖析前安全确定。",
        ));
    }
    Ok(total_entries as usize)
}

fn governed_xlsx_stream_limits() -> dbx_core::table_import::XlsxStreamLimits {
    let archive = xlsx_archive_limits();
    dbx_core::table_import::XlsxStreamLimits {
        max_shared_strings_bytes: archive.shared_strings_bytes,
        max_worksheet_bytes: archive.worksheet_bytes,
        max_worksheet_rows: env_usize("DBX_MCP_XLSX_WORKSHEET_MAX_ROWS", DEFAULT_XLSX_WORKSHEET_ROWS)
            .clamp(1_000, 10_000_000),
        max_worksheet_cells: env_usize("DBX_MCP_XLSX_WORKSHEET_MAX_CELLS", DEFAULT_XLSX_WORKSHEET_CELLS)
            .clamp(1_000, 200_000_000),
        max_cell_bytes: env_usize("DBX_MCP_XLSX_CELL_MAX_BYTES", DEFAULT_XLSX_CELL_BYTES)
            .clamp(4 * 1024, 4 * 1024 * 1024),
        max_batch_bytes: import_batch_memory_bytes(),
    }
}

fn import_batch_memory_bytes() -> usize {
    env_usize("DBX_MCP_IMPORT_BATCH_MEMORY_MAX_BYTES", DEFAULT_XLSX_BATCH_MEMORY_BYTES)
        .clamp(4 * 1024 * 1024, 128 * 1024 * 1024)
}

pub fn governed_import_batch_size(
    requested: Option<usize>,
    source_column_count: usize,
) -> Result<usize, EnterpriseToolError> {
    if source_column_count == 0 {
        return Err(EnterpriseToolError::new("IMPORT_COLUMN_REQUIRED", "源文件没有可导入字段。"));
    }
    let estimated_row_bytes =
        source_column_count.saturating_mul(ESTIMATED_IMPORT_CELL_BYTES).saturating_add(1024).max(1);
    let dynamic_max = import_batch_memory_bytes().checked_div(estimated_row_bytes).unwrap_or(1).clamp(1, 5_000);
    let value = requested.unwrap_or(1_000.min(dynamic_max));
    if value == 0 || value > dynamic_max {
        return Err(EnterpriseToolError::new(
            "IMPORT_BATCH_SIZE_RESOURCE_LIMIT",
            format!(
                "当前 {} 列结构的 batch_size 必须在 1 到 {dynamic_max} 之间，以满足批次内存预算。",
                source_column_count
            ),
        ));
    }
    Ok(value)
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
            sanitize_preview_value(cell, char_limit, 0);
        }
    }
    preview
}

pub fn validate_preview_headers(preview: &TableImportPreview) -> Result<(), EnterpriseToolError> {
    if preview.columns.len() > 1_000 {
        return Err(EnterpriseToolError::new("IMPORT_COLUMN_LIMIT_EXCEEDED", "源文件超过 1000 列，拒绝返回或导入。"));
    }
    if let Some(header) = preview.columns.iter().find(|header| header.chars().count() > MAX_CELL_CHAR_LIMIT) {
        return Err(EnterpriseToolError::new(
            "IMPORT_HEADER_TOO_LONG",
            format!("表头超过 {MAX_CELL_CHAR_LIMIT} 个字符：{}…", truncate_preview_text(header, 80)),
        ));
    }
    Ok(())
}

fn sanitize_preview_value(value: &mut Value, char_limit: usize, depth: usize) {
    if depth >= 4 {
        if value.is_array() || value.is_object() {
            *value = Value::String("[嵌套内容已截断]".to_string());
        }
        return;
    }
    match value {
        Value::String(text) => *text = truncate_preview_text(text, char_limit),
        Value::Array(values) => {
            values.truncate(50);
            for value in values {
                sanitize_preview_value(value, char_limit, depth + 1);
            }
        }
        Value::Object(object) => {
            let was_truncated = object.len() > 50;
            let original = std::mem::take(object);
            for (index, (key, mut value)) in original.into_iter().take(50).enumerate() {
                sanitize_preview_value(&mut value, char_limit, depth + 1);
                let mut key = truncate_preview_text(&key, char_limit);
                if object.contains_key(&key) {
                    key = format!("{key}__{}", index + 1);
                }
                object.insert(key, value);
            }
            if was_truncated {
                object.insert("_dbx_truncated".to_string(), Value::Bool(true));
            }
        }
        _ => {}
    }
}

fn truncate_preview_text(value: &str, char_limit: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(char_limit).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

pub fn structure_fingerprint(
    preview: &TableImportPreview,
    parse_options: &TableImportParseOptions,
    source_columns: &[McpSourceColumn],
) -> String {
    let value = json!({
        "fileType": preview.file_type,
        "columns": preview.columns,
        "sourceColumns": source_columns,
        "sheets": preview.sheets,
        "parseOptions": parse_options,
    });
    sha256_bytes(value.to_string().as_bytes())
}

pub async fn source_columns_for_preview(
    file_path: &str,
    source_format: Option<TableImportSourceFormat>,
    parse_options: &TableImportParseOptions,
    dbx_columns: &[String],
) -> Result<Vec<McpSourceColumn>, EnterpriseToolError> {
    let row_range = dbx_core::table_import::effective_import_row_range(parse_options)
        .map_err(|error| EnterpriseToolError::new("IMPORT_ROW_RANGE_INVALID", error))?;
    let raw_names = if let Some(title_row) = row_range.title_row {
        let header_options = TableImportParseOptions {
            has_header: Some(false),
            title_row: Some(0),
            data_start_row: Some(title_row),
            last_data_row: Some(title_row),
            ..parse_options.clone()
        };
        let header = dbx_core::table_import::preview_table_import_file_with_request(
            dbx_core::table_import::TableImportPreviewRequest {
                file_path: file_path.to_string(),
                source_ref: None,
                source_format,
                parse_options: header_options,
                preview_limit: Some(1),
            },
        )
        .await
        .map_err(|error| EnterpriseToolError::new("IMPORT_HEADER_PREVIEW_FAILED", error))?;
        header.rows.first().cloned().unwrap_or_default().into_iter().map(source_header_text).collect::<Vec<_>>()
    } else {
        dbx_columns.to_vec()
    };
    let normalized = (0..dbx_columns.len())
        .map(|index| {
            let raw = raw_names.get(index).cloned().unwrap_or_default();
            dbx_core::table_import::normalize_header(raw.trim_start_matches('\u{feff}'), index)
        })
        .collect::<Vec<_>>();
    let canonical = canonical_source_names(&normalized);
    Ok((0..dbx_columns.len())
        .map(|index| McpSourceColumn {
            source_position: index + 1,
            raw_source_name: raw_names.get(index).cloned().unwrap_or_default(),
            canonical_source_name: canonical[index].clone(),
            dbx_source_name: dbx_columns[index].clone(),
        })
        .collect())
}

fn source_header_text(value: Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value,
        other => other.to_string(),
    }
}

fn canonical_source_names(normalized: &[String]) -> Vec<String> {
    let counts = normalized.iter().fold(HashMap::<String, usize>::new(), |mut counts, name| {
        *counts.entry(name.to_lowercase()).or_default() += 1;
        counts
    });
    let mut occurrences = HashMap::<String, usize>::new();
    let mut used = HashSet::new();
    normalized
        .iter()
        .map(|name| {
            let key = name.to_lowercase();
            let occurrence = occurrences.entry(key.clone()).or_default();
            *occurrence += 1;
            let base =
                if counts.get(&key).copied().unwrap_or(0) > 1 { format!("{name}__{occurrence}") } else { name.clone() };
            let mut candidate = base.clone();
            let mut suffix = 1usize;
            while !used.insert(candidate.to_lowercase()) {
                candidate = format!("{base}__{suffix}");
                suffix += 1;
            }
            candidate
        })
        .collect()
}

pub fn generated_staging_relation() -> Result<(String, String), EnterpriseToolError> {
    let allowed = comma_list_env("DBX_MCP_IMPORT_STAGING_SCHEMAS", &["staging"]);
    let schema = allowed
        .first()
        .cloned()
        .ok_or_else(|| EnterpriseToolError::new("IMPORT_STAGING_SCHEMA_REQUIRED", "必须配置一个 staging schema。"))?;
    validate_identifier(&schema, "staging_schema")?;
    let table = format!("mcp_{}", Uuid::new_v4().simple());
    Ok((schema, table))
}

pub fn validate_mappings(
    mappings: &[McpImportColumnMapping],
    source_columns: &[McpSourceColumn],
) -> Result<Vec<TableImportColumnMapping>, EnterpriseToolError> {
    if mappings.is_empty() {
        return Err(EnterpriseToolError::new("IMPORT_MAPPING_REQUIRED", "至少需要一个字段映射。"));
    }
    let mut targets = HashSet::new();
    let mut positions = HashSet::new();
    let mut normalized = Vec::with_capacity(mappings.len());
    for mapping in mappings {
        let source_index = mapping.source_position.checked_sub(1).ok_or_else(|| {
            EnterpriseToolError::new("IMPORT_SOURCE_POSITION_INVALID", "source_position 从 1 开始，不能为 0。")
        })?;
        let source = source_columns.get(source_index).ok_or_else(|| {
            EnterpriseToolError::new(
                "IMPORT_SOURCE_POSITION_INVALID",
                format!("源文件没有第 {} 列。", mapping.source_position),
            )
        })?;
        if source.raw_source_name != mapping.raw_source_name
            || source.canonical_source_name != mapping.canonical_source_name
        {
            return Err(EnterpriseToolError::new(
                "IMPORT_SOURCE_NAME_MISMATCH",
                format!(
                    "第 {} 列当前 raw/canonical 名称为 {:?}/{:?}，与请求中的 {:?}/{:?} 不一致。",
                    mapping.source_position,
                    source.raw_source_name,
                    source.canonical_source_name,
                    mapping.raw_source_name,
                    mapping.canonical_source_name
                ),
            ));
        }
        if !positions.insert(mapping.source_position) {
            return Err(EnterpriseToolError::new(
                "IMPORT_SOURCE_POSITION_DUPLICATED",
                format!("源位置 {} 被重复映射。", mapping.source_position),
            ));
        }
        validate_identifier(&mapping.target_column, "target_column")?;
        if RESERVED_STAGING_COLUMNS.contains(&mapping.target_column.as_str()) {
            return Err(EnterpriseToolError::new(
                "IMPORT_TARGET_COLUMN_RESERVED",
                format!("目标字段 {} 是 staging 血缘保留字段。", mapping.target_column),
            ));
        }
        if !targets.insert(mapping.target_column.as_str()) {
            return Err(EnterpriseToolError::new(
                "IMPORT_TARGET_COLUMN_DUPLICATED",
                format!("目标字段 {} 被重复映射。", mapping.target_column),
            ));
        }
        normalized.push(TableImportColumnMapping {
            source_column: source.dbx_source_name.clone(),
            target_column: mapping.target_column.clone(),
            target_data_type: Some("TEXT".to_string()),
        });
    }
    Ok(normalized)
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

pub fn validate_governed_source_v1(
    file_path: &str,
    source_format: Option<TableImportSourceFormat>,
    parse_options: &TableImportParseOptions,
) -> Result<TableImportSourceFormat, EnterpriseToolError> {
    let source_format = dbx_core::table_import::effective_source_format(file_path, source_format)
        .map_err(|error| EnterpriseToolError::new("IMPORT_SOURCE_FORMAT_INVALID", error))?;
    if source_format.is_delimited() {
        if !matches!(parse_options.encoding, Some(TableImportTextEncoding::Utf8)) {
            return Err(EnterpriseToolError::new(
                "IMPORT_GOVERNED_EXPLICIT_UTF8_REQUIRED_V1",
                "v1 流式治理导入要求 prepare 显式指定 utf-8；auto、GBK 与 UTF-16 不创建导入计划。",
            ));
        }
        return Ok(source_format);
    }
    if source_format == TableImportSourceFormat::Excel {
        let extension =
            Path::new(file_path).extension().and_then(OsStr::to_str).unwrap_or_default().to_ascii_lowercase();
        if matches!(extension.as_str(), "xlsx" | "xlsm") {
            return Ok(source_format);
        }
        return Err(EnterpriseToolError::new(
            "IMPORT_GOVERNED_XLS_UNSUPPORTED_V1",
            "旧版 .xls 仅支持有界 preview；正式治理导入要求另存为 .xlsx。",
        ));
    }
    Err(EnterpriseToolError::new(
        "IMPORT_GOVERNED_FORMAT_UNSUPPORTED_V1",
        "JSON 尚未实现流式有界治理快照；不创建导入计划。",
    ))
}

pub async fn build_governed_import_snapshot(
    request: TableImportRequest,
    plan_id: &str,
    source_sha: &str,
    output_path: &Path,
    cancelled: Arc<AtomicBool>,
) -> Result<TableImportRequest, EnterpriseToolError> {
    let source_format = validate_governed_source_v1(&request.file_path, request.source_format, &request.parse_options)?;
    let result = if source_format == TableImportSourceFormat::Excel {
        build_governed_xlsx_snapshot(request, plan_id, source_sha, output_path, cancelled).await
    } else {
        build_governed_delimited_snapshot(request, plan_id, source_sha, output_path, source_format, cancelled).await
    };
    if result.is_err() {
        let _ = tokio::fs::remove_file(output_path).await;
    }
    result
}

async fn build_governed_delimited_snapshot(
    mut request: TableImportRequest,
    plan_id: &str,
    source_sha: &str,
    output_path: &Path,
    source_format: TableImportSourceFormat,
    cancelled: Arc<AtomicBool>,
) -> Result<TableImportRequest, EnterpriseToolError> {
    let config = dbx_core::table_import::effective_delimited_config(source_format, &request.parse_options)
        .map_err(|error| EnterpriseToolError::new("IMPORT_SOURCE_PARSE_FAILED", error))?;
    let offset = UtcOffset::from_hms(8, 0, 0)
        .map_err(|error| EnterpriseToolError::new("IMPORT_LOADED_AT_FAILED", error.to_string()))?;
    let loaded_at = OffsetDateTime::now_utc()
        .to_offset(offset)
        .format(&Rfc3339)
        .map_err(|error| EnterpriseToolError::new("IMPORT_LOADED_AT_FAILED", error.to_string()))?;
    let output = LimitedWriter::create(output_path, normalized_output_limit())?;
    let mut writer = csv::WriterBuilder::new().has_headers(false).from_writer(output);
    let mut headers = request.mappings.iter().map(|mapping| mapping.target_column.clone()).collect::<Vec<_>>();
    headers.extend(RESERVED_STAGING_COLUMNS.iter().map(|column| column.to_string()));
    writer.write_record(&headers).map_err(snapshot_write_error)?;
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(config.delimiter)
        .has_headers(false)
        .flexible(true)
        .from_path(&request.file_path)
        .map_err(|error| EnterpriseToolError::new("IMPORT_SOURCE_PARSE_FAILED", error.to_string()))?;
    let mut source_columns = Vec::new();
    let mut source_indexes: Option<Vec<usize>> = None;
    let mut source_row_count = 0usize;
    let max_cell_bytes = governed_xlsx_stream_limits().max_cell_bytes;
    for (index, record) in reader.records().enumerate() {
        if cancelled.load(Ordering::Acquire) {
            return Err(EnterpriseToolError::new("IMPORT_CANCELLED", "导入已取消。"));
        }
        let source_row_number = index + 1;
        let record = record.map_err(|error| {
            EnterpriseToolError::new(
                "IMPORT_SOURCE_PARSE_FAILED",
                format!("UTF-8 CSV/TSV 第 {source_row_number} 行解析失败：{error}"),
            )
        })?;
        if config.row_range.title_row == Some(source_row_number) {
            source_columns = unique_staging_headers(record.iter().enumerate().map(|(index, value)| {
                let value = if index == 0 { value.trim_start_matches('\u{feff}') } else { value };
                dbx_core::table_import::normalize_header(value, index)
            }));
            continue;
        }
        if source_row_number < config.row_range.data_start_row {
            continue;
        }
        if config.row_range.last_data_row.is_some_and(|last| source_row_number > last) {
            break;
        }
        if source_columns.is_empty() {
            source_columns = (0..record.len()).map(|index| format!("column_{}", index + 1)).collect();
        }
        if record.iter().any(|value| value.len() > max_cell_bytes) {
            return Err(EnterpriseToolError::new(
                "IMPORT_CELL_BUDGET_EXCEEDED",
                format!("UTF-8 CSV/TSV 第 {source_row_number} 行包含超过单元格字节上限的字段。"),
            ));
        }
        if record.len() > source_columns.len()
            && record.iter().skip(source_columns.len()).any(|value| !value.is_empty())
        {
            return Err(EnterpriseToolError::new(
                "IMPORT_SOURCE_ROW_WIDER_THAN_HEADER",
                format!(
                    "UTF-8 CSV/TSV 第 {source_row_number} 行包含表头之外的非空字段；表头 {} 列，数据行 {} 列。",
                    source_columns.len(),
                    record.len()
                ),
            ));
        }
        if source_indexes.is_none() {
            source_indexes = Some(
                request
                    .mappings
                    .iter()
                    .map(|mapping| {
                        source_columns.iter().position(|column| column == &mapping.source_column).ok_or_else(|| {
                            EnterpriseToolError::new(
                                "IMPORT_SOURCE_COLUMN_NOT_FOUND",
                                format!("规范化时找不到源字段 {}。", mapping.source_column),
                            )
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            );
        }
        let indexes = source_indexes
            .as_ref()
            .ok_or_else(|| EnterpriseToolError::new("IMPORT_SOURCE_MAPPING_FAILED", "无法建立源字段位置映射。"))?;
        let parsed_row =
            record.iter().map(|value| dbx_core::table_import::csv_value_with_config(value, config)).collect::<Vec<_>>();
        let mut output = indexes
            .iter()
            .map(|index| staging_text_value(parsed_row.get(*index).unwrap_or(&Value::Null)))
            .collect::<Vec<_>>();
        let row_bytes = serde_json::to_vec(&parsed_row)
            .map_err(|error| EnterpriseToolError::new("IMPORT_SOURCE_ROW_HASH_FAILED", error.to_string()))?;
        output.extend([
            request.import_id.clone(),
            plan_id.to_string(),
            source_sha.to_string(),
            source_row_number.to_string(),
            sha256_bytes(&row_bytes),
            loaded_at.clone(),
        ]);
        writer.write_record(&output).map_err(snapshot_write_error)?;
        source_row_count += 1;
    }
    if source_row_count == 0 {
        return Err(EnterpriseToolError::new("IMPORT_SOURCE_EMPTY", "选择的源范围没有数据行；未写入数据库。"));
    }
    writer.flush().map_err(snapshot_write_error)?;

    let mut mappings = request
        .mappings
        .iter()
        .map(|mapping| TableImportColumnMapping {
            source_column: mapping.target_column.clone(),
            target_column: mapping.target_column.clone(),
            target_data_type: Some("TEXT".to_string()),
        })
        .collect::<Vec<_>>();
    mappings.extend(RESERVED_STAGING_COLUMNS.iter().map(|column| TableImportColumnMapping {
        source_column: column.to_string(),
        target_column: column.to_string(),
        target_data_type: Some("TEXT".to_string()),
    }));
    request.file_path = output_path.to_string_lossy().to_string();
    request.source_format = Some(TableImportSourceFormat::Csv);
    request.parse_options = TableImportParseOptions {
        has_header: Some(true),
        trim_values: Some(false),
        empty_string_as_null: Some(false),
        ..Default::default()
    };
    request.mappings = mappings;
    request.mode = TableImportMode::Append;
    request.create_table = true;
    request.prepared_source = None;
    Ok(request)
}

async fn build_governed_xlsx_snapshot(
    mut request: TableImportRequest,
    plan_id: &str,
    source_sha: &str,
    output_path: &Path,
    cancelled: Arc<AtomicBool>,
) -> Result<TableImportRequest, EnterpriseToolError> {
    if cancelled.load(Ordering::Acquire) {
        return Err(EnterpriseToolError::new("IMPORT_CANCELLED", "导入已取消。"));
    }
    let offset = UtcOffset::from_hms(8, 0, 0)
        .map_err(|error| EnterpriseToolError::new("IMPORT_LOADED_AT_FAILED", error.to_string()))?;
    let loaded_at = OffsetDateTime::now_utc()
        .to_offset(offset)
        .format(&Rfc3339)
        .map_err(|error| EnterpriseToolError::new("IMPORT_LOADED_AT_FAILED", error.to_string()))?;
    let output = LimitedWriter::create(output_path, normalized_output_limit())?;
    let mut writer = csv::WriterBuilder::new().has_headers(false).from_writer(output);
    let mut headers = request.mappings.iter().map(|mapping| mapping.target_column.clone()).collect::<Vec<_>>();
    headers.extend(RESERVED_STAGING_COLUMNS.iter().map(|column| column.to_string()));
    writer.write_record(&headers).map_err(snapshot_write_error)?;

    let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
    let path = request.file_path.clone();
    let options = request.parse_options.clone();
    let batch_size = request.batch_size.max(1);
    let text_source_columns = HashSet::from(["*".to_string()]);
    let producer_cancelled = Arc::new(AtomicBool::new(cancelled.load(Ordering::Acquire)));
    let _producer_cancel_guard = CancelOnDrop(producer_cancelled.clone());
    let producer_cancelled_for_task = producer_cancelled.clone();
    let producer = tokio::task::spawn_blocking(move || {
        dbx_core::table_import::stream_xlsx_rows_to_channel_with_limits(
            &path,
            &options,
            batch_size,
            None,
            text_source_columns,
            true,
            sender,
            producer_cancelled_for_task,
            governed_xlsx_stream_limits(),
        )
    });
    let user_cancelled = cancelled.clone();
    let monitor_cancelled = producer_cancelled.clone();
    let cancellation_monitor = tokio::spawn(async move {
        while !monitor_cancelled.load(Ordering::Acquire) {
            if user_cancelled.load(Ordering::Acquire) {
                monitor_cancelled.store(true, Ordering::Release);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    });
    let mut header_seen = false;
    let mut done_seen = false;
    let mut source_row_count = 0usize;
    let mut source_indexes: Option<Vec<usize>> = None;
    while let Some(message) = receiver.recv().await {
        match message.map_err(|error| xlsx_governed_error(error, cancelled.load(Ordering::Acquire)))? {
            dbx_core::table_import::XlsxStreamMessage::Header(columns) => {
                if columns.len() > 1_000 || columns.iter().any(|column| column.chars().count() > MAX_CELL_CHAR_LIMIT) {
                    return Err(EnterpriseToolError::new(
                        "IMPORT_XLSX_HEADER_LIMIT_EXCEEDED",
                        "XLSX 流式表头超过列数或单列表头长度限制。",
                    ));
                }
                source_indexes = Some(
                    request
                        .mappings
                        .iter()
                        .map(|mapping| {
                            columns.iter().position(|column| column == &mapping.source_column).ok_or_else(|| {
                                EnterpriseToolError::new(
                                    "IMPORT_XLSX_HEADER_CHANGED",
                                    format!("XLSX 流式读取找不到 prepare 字段 {}。", mapping.source_column),
                                )
                            })
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                );
                header_seen = true;
            }
            dbx_core::table_import::XlsxStreamMessage::Rows { rows, source_row_numbers } => {
                if rows.len() != source_row_numbers.len() {
                    return Err(EnterpriseToolError::new(
                        "IMPORT_SOURCE_ROW_LINEAGE_UNAVAILABLE",
                        "XLSX 行批次缺少精确绝对源行号；未访问数据库。",
                    ));
                }
                let source_indexes = source_indexes.as_ref().ok_or_else(|| {
                    EnterpriseToolError::new("IMPORT_XLSX_HEADER_MISSING", "XLSX 数据行先于表头到达。")
                })?;
                for (row, source_row_number) in rows.into_iter().zip(source_row_numbers) {
                    if cancelled.load(Ordering::Acquire) {
                        return Err(EnterpriseToolError::new("IMPORT_CANCELLED", "导入已取消。"));
                    }
                    let mut output = source_indexes
                        .iter()
                        .map(|index| staging_text_value(row.get(*index).unwrap_or(&Value::Null)))
                        .collect::<Vec<_>>();
                    let row_bytes = serde_json::to_vec(&row).map_err(|error| {
                        EnterpriseToolError::new("IMPORT_SOURCE_ROW_HASH_FAILED", error.to_string())
                    })?;
                    output.extend([
                        request.import_id.clone(),
                        plan_id.to_string(),
                        source_sha.to_string(),
                        source_row_number.to_string(),
                        sha256_bytes(&row_bytes),
                        loaded_at.clone(),
                    ]);
                    writer.write_record(&output).map_err(snapshot_write_error)?;
                    source_row_count += 1;
                }
            }
            dbx_core::table_import::XlsxStreamMessage::Progress(_) => {}
            dbx_core::table_import::XlsxStreamMessage::Done => done_seen = true,
        }
    }
    match producer.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => return Err(xlsx_governed_error(error, cancelled.load(Ordering::Acquire))),
        Err(error) => {
            return Err(EnterpriseToolError::new("IMPORT_XLSX_STREAM_FAILED", error.to_string()));
        }
    }
    producer_cancelled.store(true, Ordering::Release);
    cancellation_monitor.abort();
    if !header_seen || !done_seen || source_row_count == 0 {
        return Err(EnterpriseToolError::new(
            "IMPORT_XLSX_STREAM_INCOMPLETE",
            "XLSX 流式治理未完整结束；未访问数据库。",
        ));
    }
    writer.flush().map_err(snapshot_write_error)?;

    let mut mappings = request
        .mappings
        .iter()
        .map(|mapping| TableImportColumnMapping {
            source_column: mapping.target_column.clone(),
            target_column: mapping.target_column.clone(),
            target_data_type: Some("TEXT".to_string()),
        })
        .collect::<Vec<_>>();
    mappings.extend(RESERVED_STAGING_COLUMNS.iter().map(|column| TableImportColumnMapping {
        source_column: column.to_string(),
        target_column: column.to_string(),
        target_data_type: Some("TEXT".to_string()),
    }));
    request.file_path = output_path.to_string_lossy().to_string();
    request.source_format = Some(TableImportSourceFormat::Csv);
    request.parse_options = TableImportParseOptions {
        has_header: Some(true),
        trim_values: Some(false),
        empty_string_as_null: Some(false),
        ..Default::default()
    };
    request.mappings = mappings;
    request.mode = TableImportMode::Append;
    request.create_table = true;
    request.prepared_source = None;
    Ok(request)
}

fn xlsx_governed_error(error: String, cancelled: bool) -> EnterpriseToolError {
    if cancelled || error == "Import cancelled" {
        EnterpriseToolError::new("IMPORT_CANCELLED", "导入已取消。")
    } else {
        EnterpriseToolError::new("IMPORT_XLSX_STREAM_FAILED", error)
    }
}

struct CancelOnDrop(Arc<AtomicBool>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

struct LimitedWriter {
    file: File,
    written: u64,
    max_bytes: u64,
}

impl LimitedWriter {
    fn create(path: &Path, max_bytes: u64) -> Result<Self, EnterpriseToolError> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| EnterpriseToolError::new("IMPORT_SNAPSHOT_WRITE_FAILED", error.to_string()))?;
        Ok(Self { file, written: 0, max_bytes })
    }
}

impl IoWrite for LimitedWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let next = self.written.checked_add(buffer.len() as u64).ok_or_else(|| {
            std::io::Error::other("IMPORT_NORMALIZED_OUTPUT_LIMIT_EXCEEDED: 规范化输出大小累计溢出。")
        })?;
        if next > self.max_bytes {
            return Err(std::io::Error::other(format!(
                "IMPORT_NORMALIZED_OUTPUT_LIMIT_EXCEEDED: 规范化输出超过 {} 字节上限。",
                self.max_bytes
            )));
        }
        let written = self.file.write(buffer)?;
        self.written = self.written.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

fn snapshot_write_error(error: impl ToString) -> EnterpriseToolError {
    let message = error.to_string();
    if message.contains("IMPORT_NORMALIZED_OUTPUT_LIMIT_EXCEEDED") {
        EnterpriseToolError::new("IMPORT_NORMALIZED_OUTPUT_LIMIT_EXCEEDED", message)
    } else {
        EnterpriseToolError::new("IMPORT_SNAPSHOT_WRITE_FAILED", message)
    }
}

fn normalized_output_limit() -> u64 {
    env_u64("DBX_MCP_IMPORT_NORMALIZED_MAX_BYTES", DEFAULT_NORMALIZED_OUTPUT_BYTES)
        .clamp(64 * 1024 * 1024, 4 * 1024 * 1024 * 1024)
}

fn staging_text_value(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn unique_staging_headers(headers: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut next_suffix = HashMap::<String, usize>::new();
    headers
        .into_iter()
        .map(|header| {
            let suffix = next_suffix.entry(header.to_lowercase()).or_default();
            loop {
                let candidate = if *suffix == 0 { header.clone() } else { format!("{header}_{suffix}") };
                *suffix += 1;
                if seen.insert(candidate.to_lowercase()) {
                    break candidate;
                }
            }
        })
        .collect()
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
    let dimension = DEFAULT_VECTOR_DIMENSION;
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
    semantic_version: &str,
    filters: &BTreeMap<String, Value>,
) -> Result<String, EnterpriseToolError> {
    if active_at.len() != 10 || !valid_effective_timestamp(active_at) {
        return Err(EnterpriseToolError::new("VECTOR_ACTIVE_AT_INVALID", "active_at 必须是合法 YYYY-MM-DD 日期。"));
    }
    let allowed = comma_list_env("DBX_MCP_VECTOR_FILTER_FIELDS", DEFAULT_VECTOR_FILTER_FIELDS);
    let semantic_version = validate_semantic_version(semantic_version)?;
    let mut clauses = vec![
        format!("approval_status == {}", json_string("approved")),
        format!("effective_from <= {}", json_string(active_at)),
        format!("(effective_to == \"\" or effective_to >= {})", json_string(active_at)),
        format!("semantic_version == {}", json_string(semantic_version)),
    ];
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

pub fn validate_semantic_version(value: &str) -> Result<&str, EnterpriseToolError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(EnterpriseToolError::new(
            "VECTOR_SEMANTIC_VERSION_REQUIRED",
            "semantic_version 是 v1 必填的精确语义版本。",
        ));
    }
    if value.len() > 128 || value.chars().any(char::is_control) {
        return Err(EnterpriseToolError::new(
            "VECTOR_SEMANTIC_VERSION_INVALID",
            "semantic_version 必须是 1～128 个 UTF-8 字节且不能包含控制字符。",
        ));
    }
    Ok(value)
}

pub fn read_semantic_jsonl(path: &Path, semantic_batch_id: &str) -> Result<Vec<Value>, EnterpriseToolError> {
    if semantic_batch_id.trim().is_empty()
        || semantic_batch_id.len() > 128
        || semantic_batch_id.chars().any(char::is_control)
    {
        return Err(EnterpriseToolError::new(
            "SEMANTIC_BATCH_ID_INVALID",
            "semantic_batch_id 必须是 1～128 个 UTF-8 字节且不能包含控制字符。",
        ));
    }
    let source = std::fs::read_to_string(path)
        .map_err(|error| EnterpriseToolError::new("VECTOR_JSONL_READ_FAILED", format!("读取 JSONL 失败：{error}")))?;
    let expected_dimension = DEFAULT_VECTOR_DIMENSION;
    let mut records = Vec::new();
    let mut card_ids = HashSet::new();
    let mut file_semantic_version: Option<String> = None;
    let allowed_fields = HashSet::from([
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
        "content_checksum",
        "semantic_version",
        "embedding_model",
        "embedding_revision",
        "embedding",
        "semantic_batch_id",
    ]);
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
        if let Some(unknown) = object.keys().find(|field| !allowed_fields.contains(field.as_str())) {
            return Err(EnterpriseToolError::new(
                "VECTOR_JSONL_UNKNOWN_FIELD",
                format!("JSONL 第 {line_number} 行包含未允许字段 {unknown}。"),
            ));
        }
        for required in [
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
            "content_checksum",
            "semantic_version",
            "embedding_model",
            "embedding_revision",
            "embedding",
            "semantic_batch_id",
        ] {
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
        for field in [
            "card_id",
            "card_type",
            "business_domain",
            "dataset_id",
            "template_version",
            "title",
            "content",
            "source_uri",
            "semantic_version",
            "embedding_model",
            "embedding_revision",
        ] {
            if object.get(field).and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) {
                return Err(EnterpriseToolError::new(
                    "VECTOR_JSONL_FIELD_INVALID",
                    format!("JSONL 第 {line_number} 行的 {field} 必须是非空字符串。"),
                ));
            }
        }
        let card_type = object.get("card_type").and_then(Value::as_str).unwrap_or_default();
        if !["dataset", "column", "metric", "join", "example", "sop", "source"].contains(&card_type) {
            return Err(EnterpriseToolError::new(
                "VECTOR_JSONL_FIELD_INVALID",
                format!("JSONL 第 {line_number} 行的 card_type 不在允许枚举中。"),
            ));
        }
        let aliases = object.get("aliases").and_then(Value::as_array).ok_or_else(|| {
            EnterpriseToolError::new(
                "VECTOR_JSONL_FIELD_INVALID",
                format!("JSONL 第 {line_number} 行的 aliases 必须是字符串数组。"),
            )
        })?;
        if aliases.len() > 100
            || aliases.iter().any(|alias| alias.as_str().is_none_or(|value| value.is_empty() || value.len() > 500))
        {
            return Err(EnterpriseToolError::new(
                "VECTOR_JSONL_FIELD_INVALID",
                format!("JSONL 第 {line_number} 行的 aliases 超出限制或包含非字符串。"),
            ));
        }
        for field in ["source_checksum", "content_checksum"] {
            if object.get(field).and_then(Value::as_str).is_none_or(|value| !is_sha256_hex(value)) {
                return Err(EnterpriseToolError::new(
                    "VECTOR_JSONL_FIELD_INVALID",
                    format!("JSONL 第 {line_number} 行的 {field} 必须是 64 位十六进制 SHA-256。"),
                ));
            }
        }
        let content = object.get("content").and_then(Value::as_str).unwrap_or_default();
        if object.get("content_checksum").and_then(Value::as_str) != Some(sha256_bytes(content.as_bytes()).as_str()) {
            return Err(EnterpriseToolError::new(
                "VECTOR_CONTENT_CHECKSUM_MISMATCH",
                format!("JSONL 第 {line_number} 行的 content_checksum 与 content 不一致。"),
            ));
        }
        let card_id = object.get("card_id").and_then(Value::as_str).unwrap_or_default().to_string();
        if !card_ids.insert(card_id.clone()) {
            return Err(EnterpriseToolError::new(
                "VECTOR_CARD_ID_DUPLICATED",
                format!("JSONL 内重复 card_id：{card_id}。"),
            ));
        }
        let semantic_version = object.get("semantic_version").and_then(Value::as_str).unwrap_or_default().to_string();
        if file_semantic_version.as_ref().is_some_and(|version| version != &semantic_version) {
            return Err(EnterpriseToolError::new(
                "VECTOR_SEMANTIC_VERSION_MIXED",
                "同一 JSONL 只能包含一个 semantic_version。",
            ));
        }
        file_semantic_version.get_or_insert(semantic_version);
        if object
            .get("effective_from")
            .and_then(Value::as_str)
            .is_none_or(|value| value.len() != 10 || !valid_effective_timestamp(value))
        {
            return Err(EnterpriseToolError::new(
                "VECTOR_JSONL_FIELD_INVALID",
                format!("JSONL 第 {line_number} 行的 effective_from 不是合法 YYYY-MM-DD 日期。"),
            ));
        }
        match object.get("effective_to") {
            None | Some(Value::Null) => {
                object.insert("effective_to".to_string(), Value::String(String::new()));
            }
            Some(Value::String(value))
                if value.is_empty() || (value.len() == 10 && valid_effective_timestamp(value)) => {}
            Some(_) => {
                return Err(EnterpriseToolError::new(
                    "VECTOR_JSONL_FIELD_INVALID",
                    format!("JSONL 第 {line_number} 行的 effective_to 必须为 null、空字符串或合法 YYYY-MM-DD 日期。"),
                ));
            }
        }
        let effective_from = object.get("effective_from").and_then(Value::as_str).unwrap_or_default();
        let effective_to = object.get("effective_to").and_then(Value::as_str).unwrap_or_default();
        if !effective_to.is_empty() && effective_to < effective_from {
            return Err(EnterpriseToolError::new(
                "VECTOR_EFFECTIVE_RANGE_INVALID",
                format!("JSONL 第 {line_number} 行的 effective_to 早于 effective_from。"),
            ));
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
        validate_semantic_varchar_lengths(object, line_number)?;
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

fn validate_semantic_varchar_lengths(
    object: &serde_json::Map<String, Value>,
    line_number: usize,
) -> Result<(), EnterpriseToolError> {
    for (field, max_bytes) in SEMANTIC_VARCHAR_LIMITS {
        let value = object.get(*field).and_then(Value::as_str).ok_or_else(|| {
            EnterpriseToolError::new(
                "VECTOR_JSONL_FIELD_INVALID",
                format!("JSONL 第 {line_number} 行的 {field} 必须是字符串。"),
            )
        })?;
        if value.len() > *max_bytes {
            return Err(EnterpriseToolError::new(
                "VECTOR_VARCHAR_LENGTH_EXCEEDED",
                format!(
                    "JSONL 第 {line_number} 行的 {field} 为 {} 个 UTF-8 字节，超过 semantic_cards VARCHAR({max_bytes})。",
                    value.len()
                ),
            ));
        }
    }
    Ok(())
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

pub fn milvus_existing_cards_query(database: &str, collection: &str, card_ids: &[String]) -> String {
    let ids = card_ids.iter().map(|card_id| json_string(card_id)).collect::<Vec<_>>().join(", ");
    format!(
        "POST /v2/vectordb/entities/query\n{}",
        json!({
            "dbName": if database.is_empty() { "default" } else { database },
            "collectionName": collection,
            "filter": format!("card_id in [{ids}]"),
            "limit": card_ids.len(),
            "outputFields": ["card_id", "semantic_batch_id", "semantic_version"],
        })
    )
}

pub fn validate_existing_card_ownership(
    rows: &[Value],
    semantic_batch_id: &str,
    semantic_version: &str,
) -> Result<(), EnterpriseToolError> {
    for row in rows {
        let object = row.as_object().ok_or_else(|| {
            EnterpriseToolError::new("VECTOR_EXISTING_CARD_INVALID", "Milvus 返回了无法验证归属的已有语义卡。")
        })?;
        let card_id = object.get("card_id").and_then(Value::as_str).unwrap_or("<unknown>");
        let same_batch = object.get("semantic_batch_id").and_then(Value::as_str) == Some(semantic_batch_id);
        let same_version = object.get("semantic_version").and_then(Value::as_str) == Some(semantic_version);
        if !same_batch || !same_version {
            return Err(EnterpriseToolError::new(
                "VECTOR_CARD_OWNERSHIP_CONFLICT",
                format!("card_id {card_id} 已属于其他 semantic_batch_id 或 semantic_version，禁止覆盖。"),
            ));
        }
    }
    Ok(())
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

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_effective_timestamp(value: &str) -> bool {
    let value = value.trim();
    if value.len() < 10 || value.as_bytes().get(4) != Some(&b'-') || value.as_bytes().get(7) != Some(&b'-') {
        return false;
    }
    let year = value.get(0..4).and_then(|part| part.parse::<u16>().ok()).unwrap_or(0);
    let month = value.get(5..7).and_then(|part| part.parse::<u8>().ok()).unwrap_or(0);
    let day = value.get(8..10).and_then(|part| part.parse::<u8>().ok()).unwrap_or(0);
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0 || day == 0 || day > max_day {
        return false;
    }
    if value.len() == 10 {
        return true;
    }
    if value.len() != 20 && value.len() != 25 {
        return false;
    }
    let bytes = value.as_bytes();
    if bytes.get(10) != Some(&b'T') || bytes.get(13) != Some(&b':') || bytes.get(16) != Some(&b':') {
        return false;
    }
    let hour = value.get(11..13).and_then(|part| part.parse::<u8>().ok()).unwrap_or(24);
    let minute = value.get(14..16).and_then(|part| part.parse::<u8>().ok()).unwrap_or(60);
    let second = value.get(17..19).and_then(|part| part.parse::<u8>().ok()).unwrap_or(60);
    if hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    if value.len() == 20 {
        return bytes.get(19) == Some(&b'Z');
    }
    if !matches!(bytes.get(19), Some(b'+') | Some(b'-')) || bytes.get(22) != Some(&b':') {
        return false;
    }
    let offset_hour = value.get(20..22).and_then(|part| part.parse::<u8>().ok()).unwrap_or(24);
    let offset_minute = value.get(23..25).and_then(|part| part.parse::<u8>().ok()).unwrap_or(60);
    offset_hour <= 23 && offset_minute <= 59
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
    use std::io::Write;

    fn write_xlsx_entry<W: Write + std::io::Seek>(zip: &mut zip::ZipWriter<W>, path: &str, content: &str) {
        zip.start_file(
            path,
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored),
        )
        .unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }

    fn write_governed_test_xlsx(path: &Path) {
        let file = std::fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        write_xlsx_entry(
            &mut zip,
            "[Content_Types].xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#,
        );
        write_xlsx_entry(
            &mut zip,
            "_rels/.rels",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#,
        );
        write_xlsx_entry(
            &mut zip,
            "xl/workbook.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#,
        );
        write_xlsx_entry(
            &mut zip,
            "xl/_rels/workbook.xml.rels",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#,
        );
        write_xlsx_entry(
            &mut zip,
            "xl/worksheets/sheet1.xml",
            r#"<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:A1"/>
  <sheetData>
    <row r="1"><c r="C1" t="inlineStr"><is><t>报告说明</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>商家备注</t></is></c><c r="B2" t="inlineStr"><is><t>商家备注</t></is></c><c r="C2" t="inlineStr"><is><t>金额</t></is></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>A</t></is></c><c r="B3" t="inlineStr"><is><t>B</t></is></c><c r="C3"><v>10</v></c></row>
    <row r="4"/>
    <row r="5"><c r="A5" t="inlineStr"><is><t>C</t></is></c><c r="B5" t="inlineStr"><is><t>D</t></is></c><c r="C5"><v>20</v></c></row>
  </sheetData>
</worksheet>"#,
        );
        zip.finish().unwrap();
    }

    #[test]
    fn file_policy_rejects_outside_root_and_symlink() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let source = root.path().join("input.csv");
        std::fs::write(&source, "id,name\n1,Ada\n").unwrap();
        assert_eq!(
            validate_import_file_with_roots(source.to_str().unwrap(), &[root.path().to_path_buf()], false, 1024)
                .unwrap(),
            std::fs::canonicalize(&source).unwrap()
        );
        assert_eq!(
            validate_import_file_with_roots(source.to_str().unwrap(), &[source.clone()], false, 1024,)
                .unwrap_err()
                .code,
            "IMPORT_PATH_OUTSIDE_ROOTS"
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
    fn xlsx_archive_preflight_enforces_entry_and_uncompressed_budgets() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("budget.xlsx");
        write_governed_test_xlsx(&source);
        let permissive = XlsxArchiveLimits {
            entry_count: 16,
            total_uncompressed_bytes: 1024 * 1024,
            metadata_entry_bytes: 1024 * 1024,
            shared_strings_bytes: 1024 * 1024,
            worksheet_bytes: 1024 * 1024,
        };
        validate_xlsx_archive_limits(&source, permissive).unwrap();
        assert_eq!(
            validate_xlsx_archive_limits(&source, XlsxArchiveLimits { entry_count: 4, ..permissive }).unwrap_err().code,
            "IMPORT_XLSX_ZIP_ENTRY_LIMIT_EXCEEDED"
        );
        assert_eq!(
            validate_xlsx_archive_limits(&source, XlsxArchiveLimits { worksheet_bytes: 16, ..permissive })
                .unwrap_err()
                .code,
            "IMPORT_XLSX_WORKSHEET_BUDGET_EXCEEDED"
        );

        let shared = directory.path().join("shared.xlsx");
        let file = std::fs::File::create(&shared).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        write_xlsx_entry(&mut zip, "xl/sharedStrings.xml", &"x".repeat(128));
        zip.finish().unwrap();
        assert_eq!(
            validate_xlsx_archive_limits(&shared, XlsxArchiveLimits { shared_strings_bytes: 64, ..permissive },)
                .unwrap_err()
                .code,
            "IMPORT_XLSX_SHARED_STRINGS_BUDGET_EXCEEDED"
        );
    }

    #[test]
    fn normalized_writer_and_dynamic_batch_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("limited.csv");
        let mut writer = LimitedWriter::create(&output, 4).unwrap();
        writer.write_all(b"1234").unwrap();
        assert!(writer.write_all(b"5").is_err());

        let safe = governed_import_batch_size(None, 145).unwrap();
        assert!(safe < 1_000);
        assert_eq!(
            governed_import_batch_size(Some(safe + 1), 145).unwrap_err().code,
            "IMPORT_BATCH_SIZE_RESOURCE_LIMIT"
        );
    }

    #[tokio::test]
    async fn private_snapshot_copy_is_hash_verified_and_cancellable() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.csv");
        let destination = directory.path().join("snapshot.csv");
        let bytes = b"id,name\n1,Ada\n";
        std::fs::write(&source, bytes).unwrap();
        copy_verified_import_source(
            source.clone(),
            destination.clone(),
            sha256_bytes(bytes),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), bytes);

        std::fs::remove_file(&destination).unwrap();
        let error = copy_verified_import_source(
            source,
            destination.clone(),
            sha256_bytes(bytes),
            Arc::new(AtomicBool::new(true)),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "IMPORT_CANCELLED");
        assert!(!destination.exists());
    }

    #[test]
    fn recursive_preview_sanitizer_bounds_nested_values_and_keys() {
        let long_key = "键".repeat(20);
        let mut value = json!({
            long_key: (0..100).map(|index| json!({ "value": "内容".repeat(20), "index": index })).collect::<Vec<_>>()
        });
        sanitize_preview_value(&mut value, 8, 0);
        let object = value.as_object().unwrap();
        assert!(object.keys().all(|key| key.chars().count() <= 11));
        let array = object.values().next().unwrap().as_array().unwrap();
        assert_eq!(array.len(), 50);
        assert!(array[0].get("value").and_then(Value::as_str).unwrap().chars().count() <= 9);
    }

    #[test]
    fn milvus_filter_forces_approval_and_semantic_version() {
        let filters = BTreeMap::from([("business_domain".to_string(), json!("交易"))]);
        let filter = build_milvus_filter("2026-08-25", "semantic-v3", &filters).unwrap();
        assert!(filter.contains("approval_status == \"approved\""));
        assert!(filter.contains("effective_from <= \"2026-08-25\""));
        assert!(filter.contains("effective_to == \"\" or effective_to >= \"2026-08-25\""));
        assert!(filter.contains("semantic_version == \"semantic-v3\""));
        assert!(filter.contains("business_domain == \"交易\""));

        let forbidden = BTreeMap::from([("approval_status".to_string(), json!("draft"))]);
        assert_eq!(
            build_milvus_filter("2026-08-25", "semantic-v3", &forbidden).unwrap_err().code,
            "VECTOR_FILTER_FIELD_NOT_ALLOWED"
        );
        let forbidden_version = BTreeMap::from([("semantic_version".to_string(), json!("semantic-v2"))]);
        assert_eq!(
            build_milvus_filter("2026-08-25", "semantic-v3", &forbidden_version).unwrap_err().code,
            "VECTOR_FILTER_FIELD_NOT_ALLOWED"
        );
        assert_eq!(
            build_milvus_filter("2026-08-25", "  ", &BTreeMap::new()).unwrap_err().code,
            "VECTOR_SEMANTIC_VERSION_REQUIRED"
        );
        assert_eq!(
            build_milvus_filter("2026-08-25", &"x".repeat(129), &BTreeMap::new()).unwrap_err().code,
            "VECTOR_SEMANTIC_VERSION_INVALID"
        );
        assert_eq!(
            build_milvus_filter("2026-08-25T00:00:00+08:00", "semantic-v3", &BTreeMap::new()).unwrap_err().code,
            "VECTOR_ACTIVE_AT_INVALID"
        );
    }

    #[test]
    fn mappings_reject_missing_and_duplicate_targets() {
        let source = vec![
            McpSourceColumn {
                source_position: 1,
                raw_source_name: "订单号".to_string(),
                canonical_source_name: "订单号".to_string(),
                dbx_source_name: "订单号".to_string(),
            },
            McpSourceColumn {
                source_position: 2,
                raw_source_name: "金额".to_string(),
                canonical_source_name: "金额".to_string(),
                dbx_source_name: "金额".to_string(),
            },
        ];
        let duplicated = vec![
            McpImportColumnMapping {
                source_position: 1,
                raw_source_name: "订单号".to_string(),
                canonical_source_name: "订单号".to_string(),
                target_column: "order_id".to_string(),
            },
            McpImportColumnMapping {
                source_position: 2,
                raw_source_name: "金额".to_string(),
                canonical_source_name: "金额".to_string(),
                target_column: "order_id".to_string(),
            },
        ];
        assert_eq!(validate_mappings(&duplicated, &source).unwrap_err().code, "IMPORT_TARGET_COLUMN_DUPLICATED");

        let reserved = vec![McpImportColumnMapping {
            source_position: 1,
            raw_source_name: "订单号".to_string(),
            canonical_source_name: "订单号".to_string(),
            target_column: "source_row_hash".to_string(),
        }];
        assert_eq!(validate_mappings(&reserved, &source).unwrap_err().code, "IMPORT_TARGET_COLUMN_RESERVED");

        let duplicate_headers = vec![
            McpSourceColumn {
                source_position: 1,
                raw_source_name: "note".to_string(),
                canonical_source_name: "note__1".to_string(),
                dbx_source_name: "note".to_string(),
            },
            McpSourceColumn {
                source_position: 2,
                raw_source_name: "note".to_string(),
                canonical_source_name: "note__2".to_string(),
                dbx_source_name: "note_1".to_string(),
            },
        ];
        let second = vec![McpImportColumnMapping {
            source_position: 2,
            raw_source_name: "note".to_string(),
            canonical_source_name: "note__2".to_string(),
            target_column: "second_note".to_string(),
        }];
        assert_eq!(validate_mappings(&second, &duplicate_headers).unwrap()[0].source_column, "note_1");
        let wrong_name = vec![McpImportColumnMapping {
            source_position: 2,
            raw_source_name: "note".to_string(),
            canonical_source_name: "note__1".to_string(),
            target_column: "second_note".to_string(),
        }];
        assert_eq!(validate_mappings(&wrong_name, &duplicate_headers).unwrap_err().code, "IMPORT_SOURCE_NAME_MISMATCH");
    }

    #[test]
    fn semantic_jsonl_normalizes_null_effective_to() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cards.jsonl");
        let content = "成交金额定义";
        let record = json!({
            "card_id": "metric-order-gmv",
            "card_type": "metric",
            "business_domain": "交易",
            "dataset_id": "orders",
            "template_version": "orders-v1",
            "title": "成交金额",
            "content": content,
            "aliases": ["GMV"],
            "approval_status": "approved",
            "semantic_batch_id": "semantic-batch-1",
            "semantic_version": "semantic-v1",
            "effective_from": "2026-08-25",
            "effective_to": null,
            "source_uri": "s3://semantic/orders.md",
            "source_checksum": "a".repeat(64),
            "content_checksum": sha256_bytes(content.as_bytes()),
            "embedding_model": "BAAI/bge-m3",
            "embedding_revision": "revision-1",
            "embedding": vec![0.0_f32; DEFAULT_VECTOR_DIMENSION],
        });
        std::fs::write(&path, format!("{}\n", record)).unwrap();

        let records = read_semantic_jsonl(&path, "semantic-batch-1").unwrap();
        assert_eq!(records[0].get("effective_to"), Some(&json!("")));
        assert_eq!(records[0].get("semantic_batch_id"), Some(&json!("semantic-batch-1")));

        let mut invalid_date = record.clone();
        invalid_date.as_object_mut().unwrap().insert("effective_from".to_string(), json!("2026-02-30"));
        std::fs::write(&path, format!("{}\n", invalid_date)).unwrap();
        assert_eq!(read_semantic_jsonl(&path, "semantic-batch-1").unwrap_err().code, "VECTOR_JSONL_FIELD_INVALID");

        let mut invalid_checksum = record.clone();
        invalid_checksum.as_object_mut().unwrap().insert("content_checksum".to_string(), json!("b".repeat(64)));
        std::fs::write(&path, format!("{}\n", invalid_checksum)).unwrap();
        assert_eq!(
            read_semantic_jsonl(&path, "semantic-batch-1").unwrap_err().code,
            "VECTOR_CONTENT_CHECKSUM_MISMATCH"
        );

        for forbidden_field in ["chunk_index", "embedding_dimension"] {
            let mut forbidden = record.clone();
            forbidden.as_object_mut().unwrap().insert(forbidden_field.to_string(), json!(0));
            std::fs::write(&path, format!("{}\n", forbidden)).unwrap();
            assert_eq!(read_semantic_jsonl(&path, "semantic-batch-1").unwrap_err().code, "VECTOR_JSONL_UNKNOWN_FIELD");
        }

        for (field, max_bytes) in [
            ("card_id", 128usize),
            ("business_domain", 128),
            ("dataset_id", 128),
            ("template_version", 64),
            ("title", 512),
            ("content", 8_192),
            ("source_uri", 2_048),
            ("semantic_version", 128),
            ("semantic_batch_id", 128),
            ("embedding_model", 128),
            ("embedding_revision", 64),
        ] {
            let mut boundary = record.clone();
            let value = "x".repeat(max_bytes);
            boundary.as_object_mut().unwrap().insert(field.to_string(), json!(value.clone()));
            if field == "content" {
                boundary
                    .as_object_mut()
                    .unwrap()
                    .insert("content_checksum".to_string(), json!(sha256_bytes(value.as_bytes())));
            }
            let batch = if field == "semantic_batch_id" { value.as_str() } else { "semantic-batch-1" };
            std::fs::write(&path, format!("{}\n", boundary)).unwrap();
            read_semantic_jsonl(&path, batch).unwrap();

            let mut overflow = record.clone();
            let overflow_value = "x".repeat(max_bytes + 1);
            overflow.as_object_mut().unwrap().insert(field.to_string(), json!(overflow_value.clone()));
            if field == "content" {
                overflow
                    .as_object_mut()
                    .unwrap()
                    .insert("content_checksum".to_string(), json!(sha256_bytes(overflow_value.as_bytes())));
            }
            let overflow_batch =
                if field == "semantic_batch_id" { overflow_value.as_str() } else { "semantic-batch-1" };
            std::fs::write(&path, format!("{}\n", overflow)).unwrap();
            let error = read_semantic_jsonl(&path, overflow_batch).unwrap_err();
            assert!(matches!(error.code, "VECTOR_VARCHAR_LENGTH_EXCEEDED" | "SEMANTIC_BATCH_ID_INVALID"));
        }

        let mut multibyte_title = record.clone();
        multibyte_title.as_object_mut().unwrap().insert("card_id".to_string(), json!("metric-order-gmv-2"));
        multibyte_title.as_object_mut().unwrap().insert("title".to_string(), json!("中".repeat(171)));
        std::fs::write(&path, format!("{}\n{}\n", record, multibyte_title)).unwrap();
        assert_eq!(read_semantic_jsonl(&path, "semantic-batch-1").unwrap_err().code, "VECTOR_VARCHAR_LENGTH_EXCEEDED");
    }

    #[test]
    fn existing_card_ownership_prevents_cross_batch_overwrite() {
        let same = vec![json!({
            "card_id": "metric-order-gmv",
            "semantic_batch_id": "batch-1",
            "semantic_version": "semantic-v1"
        })];
        validate_existing_card_ownership(&same, "batch-1", "semantic-v1").unwrap();

        let conflict = vec![json!({
            "card_id": "metric-order-gmv",
            "semantic_batch_id": "batch-0",
            "semantic_version": "semantic-v1"
        })];
        assert_eq!(
            validate_existing_card_ownership(&conflict, "batch-1", "semantic-v1").unwrap_err().code,
            "VECTOR_CARD_OWNERSHIP_CONFLICT"
        );
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
        runtime.insert_plan(plan.clone()).await.unwrap();

        assert_eq!(runtime.consume_plan(&plan_id).await.unwrap().plan_id, plan_id);
        assert_eq!(runtime.consume_plan(&plan_id).await.unwrap_err().code, "IMPORT_PLAN_ALREADY_USED");
        let job = runtime.create_job(&plan).await.unwrap();
        let import_id = job.snapshot.lock().unwrap().import_id.clone();
        assert!(!runtime.cancel_job(&import_id).await.unwrap().1);
        assert!(runtime.cancel_job(&import_id).await.unwrap().1);
    }

    #[tokio::test]
    async fn inspection_semaphore_fails_closed_at_capacity() {
        let runtime = EnterpriseRuntime::with_inspection_concurrency(1);
        let permit = runtime.try_inspection_permit().await.unwrap();
        assert_eq!(runtime.try_inspection_permit().await.unwrap_err().code, "IMPORT_INSPECTION_CONCURRENCY_LIMIT");
        drop(permit);
        let _permit = runtime.try_inspection_permit().await.unwrap();
    }

    #[tokio::test]
    async fn governed_csv_snapshot_preserves_duplicate_position_and_real_row_number() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("duplicate.csv");
        let output = directory.path().join("normalized.csv");
        std::fs::write(&source, "说明行\nnote,note\nA,B\n").unwrap();
        let request = TableImportRequest {
            import_id: "import-1".to_string(),
            connection_id: "postgres-1".to_string(),
            database: "enterprise".to_string(),
            schema: "staging".to_string(),
            table: "mcp_test".to_string(),
            file_path: source.to_string_lossy().to_string(),
            source_ref: Some("a".repeat(64)),
            source_format: Some(TableImportSourceFormat::Csv),
            parse_options: TableImportParseOptions {
                encoding: Some(TableImportTextEncoding::Utf8),
                title_row: Some(2),
                data_start_row: Some(3),
                has_header: Some(true),
                ..Default::default()
            },
            mappings: vec![
                TableImportColumnMapping {
                    source_column: "note".to_string(),
                    target_column: "first_note".to_string(),
                    target_data_type: Some("TEXT".to_string()),
                },
                TableImportColumnMapping {
                    source_column: "note_1".to_string(),
                    target_column: "second_note".to_string(),
                    target_data_type: Some("TEXT".to_string()),
                },
            ],
            mode: TableImportMode::Append,
            create_table: true,
            batch_size: 100,
            date_time_format: None,
            prepared_source: None,
            retain_source: true,
        };

        let governed = build_governed_import_snapshot(
            request,
            "plan-1",
            &"a".repeat(64),
            &output,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert!(governed.create_table);
        assert!(governed.mappings.iter().all(|mapping| mapping.target_data_type.as_deref() == Some("TEXT")));
        let mut reader = csv::Reader::from_path(output).unwrap();
        let headers = reader.headers().unwrap().clone();
        let row = reader.records().next().unwrap().unwrap();
        assert_eq!(headers.get(0), Some("first_note"));
        assert_eq!(headers.get(1), Some("second_note"));
        assert_eq!(row.get(0), Some("A"));
        assert_eq!(row.get(1), Some("B"));
        assert_eq!(row.get(5), Some("3"));
        assert_eq!(row.get(6).map(str::len), Some(64));
    }

    #[tokio::test]
    async fn governed_csv_distinguishes_short_and_trailing_empty_rows_and_blocks_nonempty_overflow() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("width.csv");
        let output = directory.path().join("normalized.csv");
        std::fs::write(&source, "a,b\nshort\nexact,value\ntail,empty,\n").unwrap();
        let request = TableImportRequest {
            import_id: "import-width".to_string(),
            connection_id: "postgres-1".to_string(),
            database: "enterprise".to_string(),
            schema: "staging".to_string(),
            table: "mcp_width".to_string(),
            file_path: source.to_string_lossy().to_string(),
            source_ref: Some("d".repeat(64)),
            source_format: Some(TableImportSourceFormat::Csv),
            parse_options: TableImportParseOptions {
                encoding: Some(TableImportTextEncoding::Utf8),
                ..Default::default()
            },
            mappings: vec![
                TableImportColumnMapping {
                    source_column: "a".to_string(),
                    target_column: "a".to_string(),
                    target_data_type: Some("TEXT".to_string()),
                },
                TableImportColumnMapping {
                    source_column: "b".to_string(),
                    target_column: "b".to_string(),
                    target_data_type: Some("TEXT".to_string()),
                },
            ],
            mode: TableImportMode::Append,
            create_table: true,
            batch_size: 10,
            date_time_format: None,
            prepared_source: None,
            retain_source: true,
        };
        build_governed_import_snapshot(
            request.clone(),
            "plan-width",
            &"d".repeat(64),
            &output,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        let mut reader = csv::Reader::from_path(&output).unwrap();
        let rows = reader.records().map(Result::unwrap).collect::<Vec<_>>();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].get(5), Some("2"));
        assert_eq!(rows[2].get(5), Some("4"));
        assert_ne!(rows[0].get(6), rows[2].get(6));
        assert!(rows.iter().all(|row| row.get(6).is_some_and(|hash| hash.len() == 64)));

        std::fs::write(&source, "a,b\nwide,value,unexpected\n").unwrap();
        let overflow_output = directory.path().join("overflow.csv");
        let error = build_governed_import_snapshot(
            request,
            "plan-overflow",
            &"d".repeat(64),
            &overflow_output,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "IMPORT_SOURCE_ROW_WIDER_THAN_HEADER");
        assert!(error.message.contains("第 2 行"));
        assert!(!overflow_output.exists());
    }

    #[tokio::test]
    async fn governed_snapshot_blocks_legacy_xls_before_database_write() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("input.xls");
        let output = directory.path().join("normalized.csv");
        std::fs::write(&source, b"not-an-xlsx").unwrap();
        let mut request = TableImportRequest {
            import_id: "import-unsupported".to_string(),
            connection_id: "postgres-1".to_string(),
            database: "enterprise".to_string(),
            schema: "staging".to_string(),
            table: "mcp_test".to_string(),
            file_path: source.to_string_lossy().to_string(),
            source_ref: Some("b".repeat(64)),
            source_format: Some(TableImportSourceFormat::Excel),
            parse_options: TableImportParseOptions::default(),
            mappings: Vec::new(),
            mode: TableImportMode::Append,
            create_table: true,
            batch_size: 100,
            date_time_format: None,
            prepared_source: None,
            retain_source: true,
        };
        request.mappings.push(TableImportColumnMapping {
            source_column: "id".to_string(),
            target_column: "id".to_string(),
            target_data_type: Some("TEXT".to_string()),
        });
        assert_eq!(
            build_governed_import_snapshot(
                request,
                "plan-1",
                &"b".repeat(64),
                &output,
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap_err()
            .code,
            "IMPORT_GOVERNED_XLS_UNSUPPORTED_V1"
        );
        assert!(!output.exists());
        assert_eq!(
            validate_governed_source_v1(
                "input.xlsm",
                Some(TableImportSourceFormat::Excel),
                &TableImportParseOptions::default(),
            )
            .unwrap(),
            TableImportSourceFormat::Excel
        );
        assert_eq!(
            validate_governed_source_v1(
                "input.json",
                Some(TableImportSourceFormat::Json),
                &TableImportParseOptions::default(),
            )
            .unwrap_err()
            .code,
            "IMPORT_GOVERNED_FORMAT_UNSUPPORTED_V1"
        );
        for encoding in [TableImportTextEncoding::Auto, TableImportTextEncoding::Gbk] {
            assert_eq!(
                validate_governed_source_v1(
                    "input.csv",
                    Some(TableImportSourceFormat::Csv),
                    &TableImportParseOptions { encoding: Some(encoding), ..Default::default() },
                )
                .unwrap_err()
                .code,
                "IMPORT_GOVERNED_EXPLICIT_UTF8_REQUIRED_V1"
            );
        }
    }

    #[tokio::test]
    async fn governed_xlsx_stream_preserves_absolute_rows_duplicate_positions_and_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("input.xlsx");
        let output = directory.path().join("normalized.csv");
        write_governed_test_xlsx(&source);
        let parse_options =
            TableImportParseOptions { title_row: Some(2), data_start_row: Some(3), ..Default::default() };
        let preview = dbx_core::table_import::preview_table_import_file_with_request(
            dbx_core::table_import::TableImportPreviewRequest {
                file_path: source.to_string_lossy().to_string(),
                source_ref: None,
                source_format: Some(TableImportSourceFormat::Excel),
                parse_options: parse_options.clone(),
                preview_limit: Some(10),
            },
        )
        .await
        .unwrap();
        let source_columns = source_columns_for_preview(
            &source.to_string_lossy(),
            Some(TableImportSourceFormat::Excel),
            &parse_options,
            &preview.columns,
        )
        .await
        .unwrap();
        assert_eq!(source_columns[0].raw_source_name, "商家备注");
        assert_eq!(source_columns[0].canonical_source_name, "商家备注__1");
        assert_eq!(source_columns[1].raw_source_name, "商家备注");
        assert_eq!(source_columns[1].canonical_source_name, "商家备注__2");
        assert_eq!(preview.source_row_numbers, vec![3, 4, 5]);
        let mappings = validate_mappings(
            &[
                McpImportColumnMapping {
                    source_position: 2,
                    raw_source_name: "商家备注".to_string(),
                    canonical_source_name: "商家备注__2".to_string(),
                    target_column: "second_note".to_string(),
                },
                McpImportColumnMapping {
                    source_position: 3,
                    raw_source_name: "金额".to_string(),
                    canonical_source_name: "金额".to_string(),
                    target_column: "amount".to_string(),
                },
            ],
            &source_columns,
        )
        .unwrap();
        let request = TableImportRequest {
            import_id: "xlsx-import".to_string(),
            connection_id: "postgres-1".to_string(),
            database: "enterprise".to_string(),
            schema: "staging".to_string(),
            table: "mcp_xlsx".to_string(),
            file_path: source.to_string_lossy().to_string(),
            source_ref: Some("c".repeat(64)),
            source_format: Some(TableImportSourceFormat::Excel),
            parse_options,
            mappings,
            mode: TableImportMode::Append,
            create_table: true,
            batch_size: 1,
            date_time_format: None,
            prepared_source: None,
            retain_source: true,
        };
        build_governed_import_snapshot(
            request.clone(),
            "plan-xlsx",
            &"c".repeat(64),
            &output,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        let mut reader = csv::Reader::from_path(&output).unwrap();
        let rows = reader.records().map(Result::unwrap).collect::<Vec<_>>();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].get(0), Some("B"));
        assert_eq!(rows[1].get(0), Some("D"));
        assert_eq!(rows[0].get(5), Some("3"));
        assert_eq!(rows[1].get(5), Some("5"));
        assert_eq!(rows[0].get(6).map(str::len), Some(64));

        let cancelled_output = directory.path().join("cancelled.csv");
        assert_eq!(
            build_governed_import_snapshot(
                request,
                "plan-cancelled",
                &"c".repeat(64),
                &cancelled_output,
                Arc::new(AtomicBool::new(true)),
            )
            .await
            .unwrap_err()
            .code,
            "IMPORT_CANCELLED"
        );
        assert!(!cancelled_output.exists());
    }

    #[tokio::test]
    #[ignore = "需要设置 DBX_MCP_REAL_XLSX_FIXTURE，且只执行本地只读治理快照回归"]
    async fn real_xlsx_fixture_prepare_and_governed_snapshot_without_database() {
        let source = PathBuf::from(std::env::var("DBX_MCP_REAL_XLSX_FIXTURE").expect("fixture path"));
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("normalized.csv");
        validate_source_archive_limits(&source, Some(TableImportSourceFormat::Excel)).unwrap();
        let identity = file_identity(source.clone()).await.unwrap();
        let parse_options = TableImportParseOptions::default();
        let preview = dbx_core::table_import::preview_table_import_file_with_request(
            dbx_core::table_import::TableImportPreviewRequest {
                file_path: source.to_string_lossy().to_string(),
                source_ref: Some(identity.sha256.clone()),
                source_format: Some(TableImportSourceFormat::Excel),
                parse_options: parse_options.clone(),
                preview_limit: Some(1),
            },
        )
        .await
        .unwrap();
        validate_preview_headers(&preview).unwrap();
        assert_eq!(preview.columns.len(), 145);
        let source_columns = source_columns_for_preview(
            &source.to_string_lossy(),
            Some(TableImportSourceFormat::Excel),
            &parse_options,
            &preview.columns,
        )
        .await
        .unwrap();
        assert_eq!(source_columns.len(), 145);
        let merchant_notes = source_columns
            .iter()
            .filter(|column| column.raw_source_name == "商家备注")
            .map(|column| column.canonical_source_name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(merchant_notes, vec!["商家备注__1", "商家备注__2"]);
        let requested = source_columns
            .iter()
            .enumerate()
            .map(|(index, column)| McpImportColumnMapping {
                source_position: column.source_position,
                raw_source_name: column.raw_source_name.clone(),
                canonical_source_name: column.canonical_source_name.clone(),
                target_column: format!("source_column_{}", index + 1),
            })
            .collect::<Vec<_>>();
        let mappings = validate_mappings(&requested, &source_columns).unwrap();
        let batch_size = governed_import_batch_size(None, source_columns.len()).unwrap();
        let plan = build_plan(
            "fixture-postgres".to_string(),
            "fixture".to_string(),
            "enterprise".to_string(),
            "staging".to_string(),
            format!("mcp_{}", Uuid::new_v4().simple()),
            "fixture-v1".to_string(),
            identity.clone(),
            structure_fingerprint(&preview, &parse_options, &source_columns),
            Some(TableImportSourceFormat::Excel),
            parse_options,
            mappings,
            true,
            batch_size,
            None,
        )
        .unwrap();
        let request = plan.to_import_request("fixture-import".to_string());
        let governed = build_governed_import_snapshot(
            request,
            &plan.plan_id,
            &identity.sha256,
            &output,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        assert!(governed.mappings.iter().all(|mapping| mapping.target_data_type.as_deref() == Some("TEXT")));
        let mut reader = csv::Reader::from_path(output).unwrap();
        let headers = reader.headers().unwrap().clone();
        assert_eq!(headers.len(), source_columns.len() + RESERVED_STAGING_COLUMNS.len());
        assert!(headers.iter().any(|header| header == "source_row_number"));
        assert!(headers.iter().any(|header| header == "source_row_hash"));
        let mut non_empty_columns = vec![false; source_columns.len()];
        let mut previous_source_row = 0usize;
        let mut row_count = 0usize;
        for record in reader.records() {
            let record = record.unwrap();
            assert_eq!(record.len(), source_columns.len() + RESERVED_STAGING_COLUMNS.len());
            for (index, value) in record.iter().take(source_columns.len()).enumerate() {
                let normalized = value.trim();
                non_empty_columns[index] |= !normalized.is_empty() && !matches!(normalized, "-" | "--");
            }
            let source_row = record.get(source_columns.len() + 3).unwrap().parse::<usize>().unwrap();
            assert!(source_row > previous_source_row);
            previous_source_row = source_row;
            let row_hash = record.get(source_columns.len() + 4).unwrap();
            assert!(is_sha256_hex(row_hash));
            row_count += 1;
        }
        assert!(row_count > 0);
        let empty_positions = non_empty_columns
            .iter()
            .enumerate()
            .filter_map(|(index, non_empty)| (!*non_empty).then_some(index + 1))
            .collect::<Vec<_>>();
        assert_eq!(
            empty_positions,
            vec![
                2, 3, 8, 9, 13, 14, 20, 22, 25, 26, 28, 29, 30, 31, 36, 37, 38, 39, 40, 41, 42, 46, 47, 48, 53, 54, 58,
                59, 60, 61, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96,
                97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117,
                134, 135, 136, 137, 140, 141, 145,
            ]
        );
    }
}
