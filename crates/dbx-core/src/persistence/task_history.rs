use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::connection::AppState;
use crate::data::transfer::{
    TransferContent, TransferMode, TransferObjectOutcome, TransferOwnershipPolicy, TransferProgress, TransferRequest,
    TransferStatus, TransferTableNameCase,
};
use crate::persistence::storage::Storage;

const HISTORY_STORAGE_UNAVAILABLE: &str = "Task history storage is unavailable.";
const ITEM_FAILED_SUMMARY: &str = "Transfer item failed.";
const ITEM_CANCELLED_SUMMARY: &str = "Transfer item was cancelled.";
const ITEM_INCOMPLETE_SUMMARY: &str = "Transfer item did not complete.";
const RUN_FAILED_SUMMARY: &str = "Transfer failed before completion.";
const RUN_PARTIAL_SUMMARY: &str = "Transfer completed with failed items.";
const RUN_CANCELLED_SUMMARY: &str = "Transfer was cancelled.";

/// A storage failure is deliberately distinct from a duplicate run identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskHistoryStorageError {
    RunIdConflict,
    RunStillRunning,
    StorageUnavailable,
}

impl TaskHistoryStorageError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::RunIdConflict => "TRANSFER_RUN_ID_CONFLICT",
            Self::RunStillRunning => "TASK_RUN_STILL_RUNNING",
            Self::StorageUnavailable => "TASK_HISTORY_STORAGE_UNAVAILABLE",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Transfer,
}

impl TaskType {
    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Transfer => "transfer",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "transfer" => Some(Self::Transfer),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskLifecycleOwner {
    Tauri,
    Web,
}

impl TaskLifecycleOwner {
    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Tauri => "tauri",
            Self::Web => "web",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "tauri" => Some(Self::Tauri),
            "web" => Some(Self::Web),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Running,
    Succeeded,
    PartialFailed,
    Failed,
    Cancelled,
}

impl TaskRunStatus {
    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::PartialFailed => "partial_failed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "partial_failed" => Some(Self::PartialFailed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    pub const fn is_terminal(self) -> bool {
        !matches!(self, Self::Running)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferRunContent {
    StructureAndData,
    StructureOnly,
    DataOnly,
}

impl TransferRunContent {
    fn from_transfer(value: TransferContent) -> Self {
        match value {
            TransferContent::StructureAndData => Self::StructureAndData,
            TransferContent::StructureOnly => Self::StructureOnly,
            TransferContent::DataOnly => Self::DataOnly,
        }
    }

    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::StructureAndData => "structure_and_data",
            Self::StructureOnly => "structure_only",
            Self::DataOnly => "data_only",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "structure_and_data" => Some(Self::StructureAndData),
            "structure_only" => Some(Self::StructureOnly),
            "data_only" => Some(Self::DataOnly),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferRunMode {
    Append,
    Overwrite,
    Upsert,
}

impl TransferRunMode {
    fn from_transfer(value: &TransferMode) -> Self {
        match value {
            TransferMode::Append => Self::Append,
            TransferMode::Overwrite => Self::Overwrite,
            TransferMode::Upsert => Self::Upsert,
        }
    }

    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Append => "append",
            Self::Overwrite => "overwrite",
            Self::Upsert => "upsert",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "append" => Some(Self::Append),
            "overwrite" => Some(Self::Overwrite),
            "upsert" => Some(Self::Upsert),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferRunTargetTableNameCase {
    Preserve,
    Lower,
    Upper,
}

impl TransferRunTargetTableNameCase {
    fn from_transfer(value: &TransferTableNameCase) -> Self {
        match value {
            TransferTableNameCase::Preserve => Self::Preserve,
            TransferTableNameCase::Lower => Self::Lower,
            TransferTableNameCase::Upper => Self::Upper,
        }
    }

    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Preserve => "preserve",
            Self::Lower => "lower",
            Self::Upper => "upper",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "preserve" => Some(Self::Preserve),
            "lower" => Some(Self::Lower),
            "upper" => Some(Self::Upper),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferRunOwnershipPolicy {
    Preserve,
    Skip,
    ReassignMissing,
}

impl TransferRunOwnershipPolicy {
    fn from_transfer(value: &TransferOwnershipPolicy) -> Self {
        match value {
            TransferOwnershipPolicy::Preserve => Self::Preserve,
            TransferOwnershipPolicy::Skip => Self::Skip,
            TransferOwnershipPolicy::ReassignMissing => Self::ReassignMissing,
        }
    }

    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Preserve => "preserve",
            Self::Skip => "skip",
            Self::ReassignMissing => "reassign_missing",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "preserve" => Some(Self::Preserve),
            "skip" => Some(Self::Skip),
            "reassign_missing" => Some(Self::ReassignMissing),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TransferObjectSelectionMode {
    Unspecified,
    Explicit,
}

impl TransferObjectSelectionMode {
    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Unspecified => "unspecified",
            Self::Explicit => "explicit",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "unspecified" => Some(Self::Unspecified),
            "explicit" => Some(Self::Explicit),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskItemKind {
    Table,
    View,
    MaterializedView,
    Procedure,
    Function,
    Trigger,
    Sequence,
    Event,
    Object,
}

impl TaskItemKind {
    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Table => "table",
            Self::View => "view",
            Self::MaterializedView => "materialized_view",
            Self::Procedure => "procedure",
            Self::Function => "function",
            Self::Trigger => "trigger",
            Self::Sequence => "sequence",
            Self::Event => "event",
            Self::Object => "object",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "table" => Some(Self::Table),
            "view" => Some(Self::View),
            "materialized_view" => Some(Self::MaterializedView),
            "procedure" => Some(Self::Procedure),
            "function" => Some(Self::Function),
            "trigger" => Some(Self::Trigger),
            "sequence" => Some(Self::Sequence),
            "event" => Some(Self::Event),
            "object" => Some(Self::Object),
            _ => None,
        }
    }

    fn from_transfer(value: &str) -> (Self, String) {
        let Some((kind, name)) = value.split_once(':') else {
            return (Self::Object, value.to_string());
        };
        let kind = match kind {
            "Table" => Self::Table,
            "View" => Self::View,
            "MaterializedView" => Self::MaterializedView,
            "Procedure" => Self::Procedure,
            "Function" => Self::Function,
            "Trigger" => Self::Trigger,
            "Sequence" => Self::Sequence,
            "Event" => Self::Event,
            _ => return (Self::Object, value.to_string()),
        };
        (kind, name.to_string())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskItemStatus {
    Pending,
    Running,
    Succeeded,
    Skipped,
    Failed,
    Cancelled,
    NotStarted,
    Incomplete,
}

impl TaskItemStatus {
    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::NotStarted => "not_started",
            Self::Incomplete => "incomplete",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "skipped" => Some(Self::Skipped),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "not_started" => Some(Self::NotStarted),
            "incomplete" => Some(Self::Incomplete),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RowCountState {
    NotApplicable,
    Known,
    Unknown,
    Incomplete,
}

impl RowCountState {
    pub(crate) const fn as_storage_str(self) -> &'static str {
        match self {
            Self::NotApplicable => "not_applicable",
            Self::Known => "known",
            Self::Unknown => "unknown",
            Self::Incomplete => "incomplete",
        }
    }

    pub(crate) fn from_storage(value: &str) -> Option<Self> {
        match value {
            "not_applicable" => Some(Self::NotApplicable),
            "known" => Some(Self::Known),
            "unknown" => Some(Self::Unknown),
            "incomplete" => Some(Self::Incomplete),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEndpointSnapshot {
    pub connection_id: String,
    pub database_type: String,
    pub database: String,
    pub schema: String,
    pub catalog: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub run_id: String,
    pub task_type: TaskType,
    pub lifecycle_owner: TaskLifecycleOwner,
    pub status: TaskRunStatus,
    pub created_at: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub owner_instance_id: String,
    pub error_code: Option<String>,
    pub safe_error_summary: Option<String>,
    /// False until a terminal write succeeds; a crash therefore cannot look complete.
    pub history_complete: bool,
    pub source: TaskEndpointSnapshot,
    pub target: TaskEndpointSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TransferRunDetails {
    pub run_id: String,
    pub content: TransferRunContent,
    pub mode: TransferRunMode,
    pub batch_size: i64,
    pub create_table: bool,
    pub drop_target_before_create: bool,
    pub target_table_name_case: TransferRunTargetTableNameCase,
    pub quote_target_column_names: bool,
    pub ownership_policy: TransferRunOwnershipPolicy,
    pub filtered_table_count: i64,
    pub table_total: i64,
    pub object_selection_mode: TransferObjectSelectionMode,
    pub selected_object_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunItem {
    pub run_id: String,
    pub item_index: i64,
    pub item_kind: TaskItemKind,
    pub source_object: String,
    pub target_object: String,
    pub status: TaskItemStatus,
    pub source_row_count: Option<i64>,
    /// Rows moved by this Transfer item, never the target's final row count.
    pub moved_row_count: Option<i64>,
    pub target_row_count: Option<i64>,
    /// Null target_row_count means the target row count was not validated.
    pub row_count_state: RowCountState,
    pub has_table_filter: bool,
    pub safe_error_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunDetail {
    pub run: TaskRun,
    pub transfer: Option<TransferRunDetails>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunCursor {
    pub created_at: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunListQuery {
    pub limit: Option<usize>,
    pub cursor: Option<TaskRunCursor>,
    pub task_type: Option<TaskType>,
    pub status: Option<TaskRunStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunPage {
    pub items: Vec<TaskRun>,
    pub next_cursor: Option<TaskRunCursor>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunItemsQuery {
    pub limit: Option<usize>,
    pub after_item_index: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunItemsPage {
    pub items: Vec<TaskRunItem>,
    pub next_after_item_index: Option<i64>,
}

#[derive(Debug, Clone)]
struct TableSnapshot {
    source_object: String,
    target_object: String,
    has_table_filter: bool,
}

#[derive(Debug, Clone, Copy, Default)]
struct ObservedRows {
    source_row_count: Option<u64>,
    moved_row_count: Option<u64>,
}

/// Per-transfer observer. It persists only request facts and result-boundary updates;
/// raw TransferRequest, table filters, SQL, and driver error strings are never retained.
#[derive(Clone)]
pub struct TransferTaskJournal {
    storage: Storage,
    run_id: String,
    content: TransferRunContent,
    tables: std::sync::Arc<Vec<TableSnapshot>>,
    history_complete: std::sync::Arc<AtomicBool>,
    successful_items: std::sync::Arc<AtomicUsize>,
    observed_rows: std::sync::Arc<Mutex<HashMap<usize, ObservedRows>>>,
}

static UNPERSISTED_RUN_ID_CLAIMS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
static OWNER_INSTANCE_ID: LazyLock<String> =
    LazyLock::new(|| format!("{}-{}", std::process::id(), uuid::Uuid::new_v4()));

impl TransferTaskJournal {
    /// Create the durable acceptance record. Storage errors degrade to an unavailable
    /// observer; ID collisions remain an explicit rejection before any Transfer starts.
    pub async fn accept(
        storage: &Storage,
        app: &AppState,
        request: &TransferRequest,
        lifecycle_owner: TaskLifecycleOwner,
    ) -> Result<Option<Self>, TaskHistoryStorageError> {
        {
            let mut claims = UNPERSISTED_RUN_ID_CLAIMS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if !claims.insert(request.transfer_id.clone()) {
                return Err(TaskHistoryStorageError::RunIdConflict);
            }
        }

        let (source_type, target_type) = {
            let configs = app.configs.read().await;
            (
                configs.get(&request.source_connection_id).map(|config| config.db_type.as_str().to_string()),
                configs.get(&request.target_connection_id).map(|config| config.db_type.as_str().to_string()),
            )
        };
        let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let source = endpoint_snapshot(
            &request.source_connection_id,
            source_type.unwrap_or_else(|| "unknown".to_string()),
            &request.source_database,
            &request.source_schema,
            request.source_catalog.clone(),
        );
        let target = endpoint_snapshot(
            &request.target_connection_id,
            target_type.unwrap_or_else(|| "unknown".to_string()),
            &request.target_database,
            &request.target_schema,
            request.target_catalog.clone(),
        );
        let content = TransferRunContent::from_transfer(request.content);
        let tables = std::sync::Arc::new(
            request
                .tables
                .iter()
                .map(|table| TableSnapshot {
                    source_object: table.clone(),
                    target_object: request.target_table_name(table),
                    has_table_filter: request.table_filters.get(table).is_some_and(|filter| !filter.trim().is_empty()),
                })
                .collect::<Vec<_>>(),
        );
        let run = TaskRun {
            run_id: request.transfer_id.clone(),
            task_type: TaskType::Transfer,
            lifecycle_owner,
            status: TaskRunStatus::Running,
            created_at: now.clone(),
            started_at: now,
            finished_at: None,
            owner_instance_id: OWNER_INSTANCE_ID.clone(),
            error_code: None,
            safe_error_summary: None,
            history_complete: false,
            source,
            target,
        };
        let details = transfer_details(request);
        let items = tables
            .iter()
            .enumerate()
            .map(|(index, table)| TaskRunItem {
                run_id: request.transfer_id.clone(),
                item_index: index as i64,
                item_kind: TaskItemKind::Table,
                source_object: table.source_object.clone(),
                target_object: table.target_object.clone(),
                status: TaskItemStatus::Pending,
                source_row_count: None,
                moved_row_count: None,
                target_row_count: None,
                row_count_state: if content == TransferRunContent::StructureOnly {
                    RowCountState::NotApplicable
                } else {
                    RowCountState::Unknown
                },
                has_table_filter: table.has_table_filter,
                safe_error_summary: None,
            })
            .collect::<Vec<_>>();

        match storage.create_task_run(&run, &details, &items).await {
            Ok(()) => {
                let mut claims = UNPERSISTED_RUN_ID_CLAIMS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                claims.remove(&request.transfer_id);
                Ok(Some(Self {
                    storage: storage.clone(),
                    run_id: request.transfer_id.clone(),
                    content,
                    tables,
                    history_complete: std::sync::Arc::new(AtomicBool::new(true)),
                    successful_items: std::sync::Arc::new(AtomicUsize::new(0)),
                    observed_rows: std::sync::Arc::new(Mutex::new(HashMap::new())),
                }))
            }
            Err(TaskHistoryStorageError::RunIdConflict) => {
                let mut claims = UNPERSISTED_RUN_ID_CLAIMS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                claims.remove(&request.transfer_id);
                Err(TaskHistoryStorageError::RunIdConflict)
            }
            Err(TaskHistoryStorageError::RunStillRunning) => unreachable!("run creation cannot return this error"),
            Err(TaskHistoryStorageError::StorageUnavailable) => {
                log::warn!("[task-history] {HISTORY_STORAGE_UNAVAILABLE} Transfer will continue without a durable history record.");
                // Keep this process-local claim until exit: a second submission with the same
                // ID must not start another Transfer after the initial journal write failed.
                Ok(None)
            }
        }
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    /// Return the stable request-order index for a table after the executor sorts its work.
    pub fn item_index_for_table(&self, source_object: &str) -> Option<usize> {
        self.tables.iter().position(|table| table.source_object == source_object)
    }

    pub async fn start_table(&self, item_index: usize) {
        let Some(table) = self.tables.get(item_index) else {
            self.mark_write_failed("table start");
            return;
        };
        let item = TaskRunItem {
            run_id: self.run_id.clone(),
            item_index: item_index as i64,
            item_kind: TaskItemKind::Table,
            source_object: table.source_object.clone(),
            target_object: table.target_object.clone(),
            status: TaskItemStatus::Running,
            source_row_count: None,
            moved_row_count: None,
            target_row_count: None,
            row_count_state: if self.content == TransferRunContent::StructureOnly {
                RowCountState::NotApplicable
            } else {
                RowCountState::Unknown
            },
            has_table_filter: table.has_table_filter,
            safe_error_summary: None,
        };
        self.persist_item(item).await;
    }

    /// Capture row progress in memory only. It is flushed at the table's result boundary.
    pub fn observe_table_progress(&self, item_index: usize, moved_row_count: u64) {
        if let Ok(mut rows) = self.observed_rows.lock() {
            rows.entry(item_index).or_default().moved_row_count = Some(moved_row_count);
        }
    }

    /// Record the source COUNT result from the Transfer executor without changing its public
    /// progress event contract. `None` means the source count was not obtained.
    pub fn observe_source_count(&self, item_index: usize, source_row_count: Option<u64>) {
        if let Ok(mut rows) = self.observed_rows.lock() {
            rows.entry(item_index).or_default().source_row_count = source_row_count;
        }
    }

    pub async fn finish_table(
        &self,
        item_index: usize,
        status: TaskItemStatus,
        source_row_count: Option<u64>,
        moved_row_count: Option<u64>,
    ) {
        let Some(table) = self.tables.get(item_index) else {
            self.mark_write_failed("table result");
            return;
        };
        let observed =
            self.observed_rows.lock().ok().and_then(|rows| rows.get(&item_index).copied()).unwrap_or_default();
        let source_count = source_row_count.or(observed.source_row_count);
        let moved_count = moved_row_count.or(observed.moved_row_count);
        let (source_row_count, moved_row_count, row_count_state) = if self.content == TransferRunContent::StructureOnly
        {
            (None, None, RowCountState::NotApplicable)
        } else if matches!(status, TaskItemStatus::Succeeded) {
            let source = source_count.and_then(to_sqlite_count);
            let moved = moved_count.and_then(to_sqlite_count);
            let state = if source.is_some() && moved.is_some() { RowCountState::Known } else { RowCountState::Unknown };
            (source, moved, state)
        } else {
            (source_count.and_then(to_sqlite_count), moved_count.and_then(to_sqlite_count), RowCountState::Incomplete)
        };
        self.persist_item(TaskRunItem {
            run_id: self.run_id.clone(),
            item_index: item_index as i64,
            item_kind: TaskItemKind::Table,
            source_object: table.source_object.clone(),
            target_object: table.target_object.clone(),
            status,
            source_row_count,
            moved_row_count,
            target_row_count: None,
            row_count_state,
            has_table_filter: table.has_table_filter,
            safe_error_summary: safe_item_summary(status),
        })
        .await;
    }

    pub async fn record_object_outcome(&self, outcome: &TransferObjectOutcome) {
        let mut next_index = self.tables.len();
        for (items, status) in [
            (&outcome.transferred, TaskItemStatus::Succeeded),
            (&outcome.skipped, TaskItemStatus::Skipped),
            (&outcome.failed, TaskItemStatus::Failed),
        ] {
            for raw in items {
                let (item_kind, source_object) = TaskItemKind::from_transfer(raw);
                self.persist_item(TaskRunItem {
                    run_id: self.run_id.clone(),
                    item_index: next_index as i64,
                    item_kind,
                    source_object: source_object.clone(),
                    target_object: source_object,
                    status,
                    source_row_count: None,
                    moved_row_count: None,
                    target_row_count: None,
                    row_count_state: RowCountState::NotApplicable,
                    has_table_filter: false,
                    safe_error_summary: safe_item_summary(status),
                })
                .await;
                next_index += 1;
            }
        }
    }

    pub async fn record_schema_objects_error(&self, cancelled: bool) {
        let status = if cancelled { TaskItemStatus::Cancelled } else { TaskItemStatus::Failed };
        self.persist_item(TaskRunItem {
            run_id: self.run_id.clone(),
            item_index: self.tables.len() as i64,
            item_kind: TaskItemKind::Object,
            source_object: "schema objects".to_string(),
            target_object: "schema objects".to_string(),
            status,
            source_row_count: None,
            moved_row_count: None,
            target_row_count: None,
            row_count_state: RowCountState::NotApplicable,
            has_table_filter: false,
            safe_error_summary: safe_item_summary(status),
        })
        .await;
    }

    pub async fn finish(&self, progress: &TransferProgress) {
        if !progress.terminal {
            return;
        }
        let (status, error_code, safe_summary) = match &progress.status {
            TransferStatus::Done => (TaskRunStatus::Succeeded, None, None),
            TransferStatus::Cancelled => (
                TaskRunStatus::Cancelled,
                Some("TRANSFER_CANCELLED".to_string()),
                Some(RUN_CANCELLED_SUMMARY.to_string()),
            ),
            TransferStatus::Error => {
                if self.successful_items.load(Ordering::Relaxed) > 0 {
                    (
                        TaskRunStatus::PartialFailed,
                        Some("TRANSFER_PARTIAL_FAILURE".to_string()),
                        Some(RUN_PARTIAL_SUMMARY.to_string()),
                    )
                } else {
                    (TaskRunStatus::Failed, Some("TRANSFER_FAILED".to_string()), Some(RUN_FAILED_SUMMARY.to_string()))
                }
            }
            TransferStatus::Running | TransferStatus::TableDone => return,
        };
        let history_complete = self.history_complete.load(Ordering::Relaxed);
        if self
            .storage
            .finish_task_run(&self.run_id, status, error_code.as_deref(), safe_summary.as_deref(), history_complete)
            .await
            .is_err()
        {
            log::warn!("[task-history] terminal history write failed; transfer result is unchanged and the run remains unconfirmed.");
        }
    }

    async fn persist_item(&self, item: TaskRunItem) {
        if item.status == TaskItemStatus::Succeeded {
            self.successful_items.fetch_add(1, Ordering::Relaxed);
        }
        if self.storage.save_task_run_item(&item).await.is_err() {
            self.mark_write_failed("item result");
        }
    }

    fn mark_write_failed(&self, stage: &'static str) {
        self.history_complete.store(false, Ordering::Relaxed);
        log::warn!("[task-history] {stage} could not be persisted; Transfer continues and history is incomplete.");
    }
}

fn endpoint_snapshot(
    connection_id: &str,
    database_type: String,
    database: &str,
    schema: &str,
    catalog: Option<String>,
) -> TaskEndpointSnapshot {
    TaskEndpointSnapshot {
        connection_id: connection_id.to_string(),
        database_type,
        database: database.to_string(),
        schema: schema.to_string(),
        catalog,
    }
}

fn transfer_details(request: &TransferRequest) -> TransferRunDetails {
    let object_selection_mode = if request.objects.is_some() {
        TransferObjectSelectionMode::Explicit
    } else {
        TransferObjectSelectionMode::Unspecified
    };
    let selected_object_count = request
        .objects
        .as_ref()
        .map(|objects| objects.iter().map(|selection| selection.names.len()).sum::<usize>() as i64);
    TransferRunDetails {
        run_id: request.transfer_id.clone(),
        content: TransferRunContent::from_transfer(request.content),
        mode: TransferRunMode::from_transfer(&request.mode),
        batch_size: i64::try_from(request.batch_size).unwrap_or(i64::MAX),
        create_table: request.create_table,
        drop_target_before_create: request.drop_target_before_create,
        target_table_name_case: TransferRunTargetTableNameCase::from_transfer(&request.target_table_name_case),
        quote_target_column_names: request.quote_target_column_names,
        ownership_policy: TransferRunOwnershipPolicy::from_transfer(&request.ownership_policy),
        filtered_table_count: request
            .tables
            .iter()
            .filter(|table| request.table_filters.get(*table).is_some_and(|filter| !filter.trim().is_empty()))
            .count() as i64,
        table_total: request.tables.len() as i64,
        object_selection_mode,
        selected_object_count,
    }
}

fn safe_item_summary(status: TaskItemStatus) -> Option<String> {
    match status {
        TaskItemStatus::Failed => Some(ITEM_FAILED_SUMMARY.to_string()),
        TaskItemStatus::Cancelled => Some(ITEM_CANCELLED_SUMMARY.to_string()),
        TaskItemStatus::Incomplete => Some(ITEM_INCOMPLETE_SUMMARY.to_string()),
        _ => None,
    }
}

fn to_sqlite_count(value: u64) -> Option<i64> {
    i64::try_from(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::transfer::{
        TransferMode, TransferObjectSelection, TransferOwnershipPolicy, TransferTableNameCase,
    };

    #[tokio::test]
    async fn journal_drops_raw_filters_and_driver_errors_from_persistent_history() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("dbx.db");
        let storage = crate::persistence::test_storage::open_unmigrated(&db_path).await.unwrap();
        let app = AppState::new_with_plugin_dir(storage.clone(), dir.path().join("plugins"));
        let filter_secret = "task_history_filter_secret_marker";
        let driver_secret = "task_history_driver_error_secret_marker";
        let request = TransferRequest {
            transfer_id: format!("task-history-test-{}", uuid::Uuid::new_v4()),
            source_connection_id: "source-id".to_string(),
            source_database: "source-db".to_string(),
            source_schema: "main".to_string(),
            source_catalog: None,
            target_connection_id: "target-id".to_string(),
            target_database: "target-db".to_string(),
            target_schema: "main".to_string(),
            target_catalog: None,
            tables: vec!["orders".to_string()],
            create_table: false,
            content: TransferContent::DataOnly,
            objects: Some(vec![TransferObjectSelection::default()]),
            mode: TransferMode::Append,
            target_table_name_case: TransferTableNameCase::Preserve,
            quote_target_column_names: true,
            ownership_policy: TransferOwnershipPolicy::Preserve,
            batch_size: 500,
            table_filters: HashMap::from([
                ("orders".to_string(), format!("WHERE note = '{filter_secret}'")),
                ("unselected_table".to_string(), format!("WHERE note = '{filter_secret}'")),
            ]),
            drop_target_before_create: false,
            drop_target_confirmed: false,
        };
        let journal =
            TransferTaskJournal::accept(&storage, &app, &request, TaskLifecycleOwner::Web).await.unwrap().unwrap();
        assert!(matches!(
            TransferTaskJournal::accept(&storage, &app, &request, TaskLifecycleOwner::Web).await,
            Err(TaskHistoryStorageError::RunIdConflict)
        ));

        journal.start_table(0).await;
        journal.observe_source_count(0, None);
        journal.observe_table_progress(0, 2);
        journal.finish_table(0, TaskItemStatus::Failed, None, None).await;
        journal
            .finish(&TransferProgress {
                transfer_id: request.transfer_id.clone(),
                table: "orders".to_string(),
                table_index: 0,
                total_tables: 1,
                rows_transferred: 2,
                total_rows: None,
                status: TransferStatus::Error,
                error: Some(driver_secret.to_string()),
                terminal: true,
            })
            .await;

        let detail = storage.get_task_run_detail(&request.transfer_id).await.unwrap().unwrap();
        assert_eq!(detail.run.status, TaskRunStatus::Failed);
        assert!(detail.run.history_complete);
        assert_eq!(detail.run.error_code.as_deref(), Some("TRANSFER_FAILED"));
        assert_eq!(detail.transfer.as_ref().unwrap().filtered_table_count, 1);
        let items = storage.list_task_run_items(&request.transfer_id, TaskRunItemsQuery::default()).await.unwrap();
        assert_eq!(items.items[0].source_row_count, None);
        assert_eq!(items.items[0].moved_row_count, Some(2));
        assert_eq!(items.items[0].target_row_count, None);
        assert_eq!(items.items[0].row_count_state, RowCountState::Incomplete);
        assert_eq!(items.items[0].safe_error_summary.as_deref(), Some(ITEM_FAILED_SUMMARY));

        let serialized = serde_json::to_string(&(detail, items)).unwrap();
        assert!(!serialized.contains(filter_secret));
        assert!(!serialized.contains(driver_secret));
        for path in [db_path.clone(), db_path.with_extension("db-wal"), db_path.with_extension("db-shm")] {
            let bytes = std::fs::read(path).unwrap_or_default();
            assert!(!bytes.windows(filter_secret.len()).any(|window| window == filter_secret.as_bytes()));
            assert!(!bytes.windows(driver_secret.len()).any(|window| window == driver_secret.as_bytes()));
        }
    }
}
