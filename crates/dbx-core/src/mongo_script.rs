use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rquickjs::{CatchResultExt, Context, Ctx, Exception, Function, Runtime, Value as JsValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore, TryAcquireError};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::connection::AppState;
use crate::mongo_ops::execute_mongo_command_core;
use crate::mongo_shell::{
    apply_mongo_find_cursor, build_mongo_collection_command, build_mongo_database_command,
    build_mongo_find_explain_command, MongoCollectionMethod, MongoDatabaseMethod, MongoFindCursor,
};
use crate::production_safety::mongo_command_targets_production_database;
use crate::query_cancel::RunningTaskMetadata;
use crate::types::QueryResult;

const DEFAULT_MEMORY_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_STACK_LIMIT_BYTES: usize = 512 * 1024;
const DEFAULT_MAX_SOURCE_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_OPERATIONS: usize = 10_000;
const DEFAULT_MAX_OUTPUT_ITEMS: usize = 1_000;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const DEFAULT_MAX_VALUE_DEPTH: usize = 64;
const DEFAULT_MAX_VALUE_NODES: usize = 100_000;
const DEFAULT_MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_MAX_ROWS: usize = crate::query::MAX_ROWS;
const DEFAULT_SAFETY_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_CONCURRENT_RUNTIMES: usize = 2;
const DEFAULT_MAX_QUEUED_RUNTIMES: usize = 8;

const RAW_HOST_CALL_GLOBAL: &str = "__dbxRawHostCall";
const OUTPUT_GLOBAL: &str = "__dbxCaptureOutput";
const INITIAL_DATABASE_GLOBAL: &str = "__dbxInitialDatabase";
const FINALIZE_GLOBAL: &str = "__dbxFinalize";

const RUNTIME_BOOTSTRAP: &str = r#"
(() => {
  function ObjectId(value) {
    if (!(this instanceof ObjectId)) return new ObjectId(value);
    if (typeof value !== "string" || !/^[0-9a-fA-F]{24}$/.test(value)) {
      throw new TypeError("ObjectId requires a 24-character hexadecimal string");
    }
    Object.defineProperty(this, "$oid", {
      value: value.toLowerCase(),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  ObjectId.prototype.toString = function () {
    return `ObjectId("${this.$oid}")`;
  };
  ObjectId.prototype.valueOf = function () { return this.$oid; };

  function ISODate(value) {
    if (!(this instanceof ISODate)) return new ISODate(value);
    const date = value === undefined ? new Date() : new Date(value);
    if (Number.isNaN(date.valueOf())) {
      throw new TypeError("ISODate requires a valid date value");
    }
    Object.defineProperty(this, "$date", {
      value: date.toISOString(),
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  ISODate.prototype.toISOString = function () { return this.$date; };
  ISODate.prototype.toString = function () {
    return `ISODate("${this.$date}")`;
  };
  ISODate.prototype.valueOf = function () { return this.$date; };

  function reviveExtendedJson(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(reviveExtendedJson);

    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$oid === "string") {
      return ObjectId(value.$oid);
    }
    if (keys.length === 1 && Object.prototype.hasOwnProperty.call(value, "$date")) {
      if (typeof value.$date === "string") return ISODate(value.$date);
      if (value.$date && typeof value.$date.$numberLong === "string") {
        return ISODate(Number(value.$date.$numberLong));
      }
    }
    for (const key of keys) value[key] = reviveExtendedJson(value[key]);
    return value;
  }

  function printable(value) {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    try {
      const encoded = JSON.stringify(value);
      return encoded === undefined ? String(value) : encoded;
    } catch (_) {
      return String(value);
    }
  }

  const cursorMarker = Symbol("dbxMongoCursor");
  const databaseMarker = Symbol("dbxMongoDatabase");
  const databaseMethods = new Set(["version", "runCommand", "createUser"]);
  const collectionMethods = new Set([
    "find", "findOne", "countDocuments", "count", "aggregate", "distinct", "getIndexes",
    "stats", "dataSize", "storageSize", "totalIndexSize", "insertOne", "insertMany", "insert",
    "updateOne", "updateMany", "update", "deleteOne", "deleteMany", "createIndex", "dropIndex",
    "dropIndexes", "drop", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete",
  ]);

  function normalizeArguments(values) {
    return Array.from(values, (value) => value === undefined ? null : value);
  }

  class MongoCursor {
    constructor(database, collection, method, args) {
      this[cursorMarker] = true;
      this.database = database;
      this.collection = collection;
      this.method = method;
      this.args = normalizeArguments(args);
      this.cursor = method === "find" ? { skip: 0, limit: 0 } : null;
      this.materialized = null;
    }

    sort(value) {
      if (this.method !== "find") throw new TypeError("sort() is only supported for find() cursors");
      this.cursor.sort = value;
      return this;
    }

    collation(value) {
      if (this.method !== "find") throw new TypeError("collation() is only supported for find() cursors");
      this.cursor.collation = value;
      return this;
    }

    skip(value) {
      if (this.method !== "find" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("skip() requires a non-negative safe integer on a find() cursor");
      }
      this.cursor.skip = value;
      return this;
    }

    limit(value) {
      if (this.method !== "find" || !Number.isSafeInteger(value)) {
        throw new TypeError("limit() requires a safe integer on a find() cursor");
      }
      this.cursor.limit = value;
      return this;
    }

    count() {
      if (this.method !== "find") throw new TypeError("count() is only supported for find() cursors");
      return __dbxHostCall({
        kind: "collectionCall",
        database: this.database,
        collection: this.collection,
        method: "count",
        args: [this.args[0] === undefined || this.args[0] === null ? {} : this.args[0]],
      });
    }

    explain(verbosity = "queryPlanner") {
      if (this.method !== "find") throw new TypeError("explain() is only supported for find() cursors");
      if (!["queryPlanner", "executionStats", "allPlansExecution"].includes(verbosity)) {
        throw new TypeError("MongoDB explain() verbosity must be queryPlanner, executionStats, or allPlansExecution");
      }
      return __dbxHostCall({
        kind: "collectionCall",
        database: this.database,
        collection: this.collection,
        method: "findExplain",
        args: this.args,
        cursor: { ...this.cursor, explainVerbosity: verbosity },
      });
    }

    toArray() {
      if (this.materialized === null) {
        this.materialized = __dbxHostCall({
          kind: "collectionCall",
          database: this.database,
          collection: this.collection,
          method: this.method,
          args: this.args,
          cursor: this.cursor,
        });
      }
      return this.materialized;
    }

    forEach(callback) {
      if (typeof callback !== "function") throw new TypeError("forEach() requires a callback function");
      this.toArray().forEach(callback);
    }
  }

  function createCollection(database, collection) {
    if (typeof collection !== "string" || collection.length === 0) {
      throw new TypeError("MongoDB collection name must be a non-empty string");
    }
    return new Proxy(Object.create(null), {
      get(_target, property) {
        if (property === "then") return undefined;
        if (property === "getName") return () => collection;
        if (property === "toString") return () => `${database}.${collection}`;
        if (typeof property !== "string" || !collectionMethods.has(property)) {
          throw new TypeError(`Unsupported MongoDB collection method: ${String(property)}`);
        }
        if (property === "find" || property === "aggregate") {
          return (...args) => new MongoCursor(database, collection, property, args);
        }
        return (...args) => __dbxHostCall({
          kind: "collectionCall",
          database,
          collection,
          method: property,
          args: normalizeArguments(args),
        });
      },
    });
  }

  function createDatabase(database) {
    if (typeof database !== "string" || database.length === 0) {
      throw new TypeError("MongoDB database name must be a non-empty string");
    }
    return new Proxy(Object.create(null), {
      get(_target, property) {
        if (property === "then") return undefined;
        if (property === databaseMarker) return database;
        if (property === "getName") return () => database;
        if (property === "toString") return () => database;
        if (property === "getCollection") return (name) => createCollection(database, name);
        if (property === "getSiblingDB") return (name) => createDatabase(name);
        if (typeof property === "string" && databaseMethods.has(property)) {
          return (...args) => __dbxHostCall({
            kind: "databaseCall",
            database,
            method: property,
            args: normalizeArguments(args),
          });
        }
        if (typeof property === "string") return createCollection(database, property);
        return undefined;
      },
    });
  }

  let currentDatabase = createDatabase(__dbxInitialDatabase);

  Object.defineProperties(globalThis, {
    ObjectId: { value: ObjectId, writable: false, configurable: false },
    ISODate: { value: ISODate, writable: false, configurable: false },
    __dbxReviveExtendedJson: { value: reviveExtendedJson, writable: false, configurable: false },
    __dbxHostCall: {
      value: (operation) => reviveExtendedJson(JSON.parse(__dbxRawHostCall(operation))),
      writable: false,
      configurable: false,
    },
    __dbxFinalize: {
      value: (value) => value && value[cursorMarker] === true ? value.toArray() : value,
      writable: false,
      configurable: false,
    },
    db: {
      get: () => currentDatabase,
      set: (value) => {
        const database = value && value[databaseMarker];
        if (typeof database !== "string" || database.length === 0) {
          throw new TypeError("db can only be assigned a DBX MongoDB database handle");
        }
        __dbxHostCall({ kind: "selectDatabase", database });
        currentDatabase = value;
      },
      configurable: false,
    },
    print: {
      value: (...values) => __dbxCaptureOutput({ kind: "text", value: values.map(printable).join(" ") }),
      writable: false,
      configurable: false,
    },
    printjson: {
      value: (value) => __dbxCaptureOutput({ kind: "json", value }),
      writable: false,
      configurable: false,
    },
  });
})();
"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoScriptRequest {
    pub connection_id: String,
    pub database: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    pub max_rows: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub dangerous_operation_confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MongoScriptOperation {
    SelectDatabase {
        database: String,
    },
    DatabaseCall {
        database: String,
        method: MongoDatabaseMethod,
        #[serde(default)]
        args: Vec<Value>,
    },
    CollectionCall {
        database: String,
        collection: String,
        method: MongoCollectionMethod,
        #[serde(default)]
        args: Vec<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cursor: Option<Box<MongoFindCursor>>,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum MongoScriptOutput {
    Text(String),
    Json(Value),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MongoScriptResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_value: Option<Value>,
    pub output: Vec<MongoScriptOutput>,
    pub operation_count: usize,
    pub succeeded_operation_count: usize,
    pub current_database: String,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MongoScriptErrorKind {
    Cancelled,
    Host,
    InvalidRequest,
    ResourceLimit,
    Runtime,
    Safety,
    Serialization,
    Timeout,
}

impl MongoScriptErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Host => "host",
            Self::InvalidRequest => "invalid_request",
            Self::ResourceLimit => "resource_limit",
            Self::Runtime => "runtime",
            Self::Safety => "safety",
            Self::Serialization => "serialization",
            Self::Timeout => "timeout",
        }
    }
}

pub fn mongo_script_error_kind(error: &str) -> Option<MongoScriptErrorKind> {
    let code = error.strip_prefix("[mongo_script.")?.split_once(']')?.0;
    match code {
        "cancelled" => Some(MongoScriptErrorKind::Cancelled),
        "host" => Some(MongoScriptErrorKind::Host),
        "invalid_request" => Some(MongoScriptErrorKind::InvalidRequest),
        "resource_limit" => Some(MongoScriptErrorKind::ResourceLimit),
        "runtime" => Some(MongoScriptErrorKind::Runtime),
        "safety" => Some(MongoScriptErrorKind::Safety),
        "serialization" => Some(MongoScriptErrorKind::Serialization),
        "timeout" => Some(MongoScriptErrorKind::Timeout),
        _ => None,
    }
}

fn script_error(kind: MongoScriptErrorKind, message: impl AsRef<str>) -> String {
    format!("[mongo_script.{}] {}", kind.code(), message.as_ref())
}

#[derive(Clone, Debug)]
pub struct MongoScriptLimits {
    pub max_source_bytes: usize,
    pub memory_limit_bytes: usize,
    pub stack_limit_bytes: usize,
    pub max_operations: usize,
    pub max_output_items: usize,
    pub max_output_bytes: usize,
    pub max_value_depth: usize,
    pub max_value_nodes: usize,
    pub max_value_bytes: usize,
    pub max_rows: usize,
    pub safety_timeout: Duration,
}

impl Default for MongoScriptLimits {
    fn default() -> Self {
        Self {
            max_source_bytes: DEFAULT_MAX_SOURCE_BYTES,
            memory_limit_bytes: DEFAULT_MEMORY_LIMIT_BYTES,
            stack_limit_bytes: DEFAULT_STACK_LIMIT_BYTES,
            max_operations: DEFAULT_MAX_OPERATIONS,
            max_output_items: DEFAULT_MAX_OUTPUT_ITEMS,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
            max_value_depth: DEFAULT_MAX_VALUE_DEPTH,
            max_value_nodes: DEFAULT_MAX_VALUE_NODES,
            max_value_bytes: DEFAULT_MAX_VALUE_BYTES,
            max_rows: DEFAULT_MAX_ROWS,
            safety_timeout: DEFAULT_SAFETY_TIMEOUT,
        }
    }
}

impl MongoScriptLimits {
    fn validate(&self) -> Result<(), String> {
        let values = [
            ("max_source_bytes", self.max_source_bytes),
            ("memory_limit_bytes", self.memory_limit_bytes),
            ("stack_limit_bytes", self.stack_limit_bytes),
            ("max_operations", self.max_operations),
            ("max_output_items", self.max_output_items),
            ("max_output_bytes", self.max_output_bytes),
            ("max_value_depth", self.max_value_depth),
            ("max_value_nodes", self.max_value_nodes),
            ("max_value_bytes", self.max_value_bytes),
            ("max_rows", self.max_rows),
        ];
        if let Some((name, _)) = values.into_iter().find(|(_, value)| *value == 0) {
            return Err(script_error(
                MongoScriptErrorKind::InvalidRequest,
                format!("{name} must be greater than zero"),
            ));
        }
        if self.safety_timeout.is_zero() {
            return Err(script_error(MongoScriptErrorKind::InvalidRequest, "safety_timeout must be greater than zero"));
        }
        Ok(())
    }

    fn clamp_max_rows(&self, requested: usize) -> usize {
        requested.min(self.max_rows)
    }
}

#[derive(Clone)]
pub struct MongoScriptRuntimeAdmission {
    running: Arc<Semaphore>,
    admitted: Arc<Semaphore>,
    max_queued: usize,
}

impl Default for MongoScriptRuntimeAdmission {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_CONCURRENT_RUNTIMES, DEFAULT_MAX_QUEUED_RUNTIMES)
            .expect("default MongoDB script admission limits must be positive")
    }
}

impl MongoScriptRuntimeAdmission {
    pub fn new(max_running: usize, max_queued: usize) -> Result<Self, String> {
        if max_running == 0 {
            return Err(script_error(MongoScriptErrorKind::InvalidRequest, "max_running must be greater than zero"));
        }
        let max_admitted = max_running.checked_add(max_queued).ok_or_else(|| {
            script_error(MongoScriptErrorKind::InvalidRequest, "MongoDB JavaScript admission capacity is too large")
        })?;
        Ok(Self {
            running: Arc::new(Semaphore::new(max_running)),
            admitted: Arc::new(Semaphore::new(max_admitted)),
            max_queued,
        })
    }

    async fn acquire(
        &self,
        cancellation: &CancellationToken,
        deadline: Instant,
        state: &ExecutionState,
    ) -> Result<MongoScriptRuntimePermit, String> {
        let admitted = match self.admitted.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(TryAcquireError::NoPermits) => {
                return Err(script_error(
                    MongoScriptErrorKind::ResourceLimit,
                    format!("MongoDB JavaScript execution queue is full (max {})", self.max_queued),
                ));
            }
            Err(TryAcquireError::Closed) => {
                return Err(script_error(
                    MongoScriptErrorKind::Runtime,
                    "MongoDB JavaScript execution admission is unavailable",
                ));
            }
        };

        let running = tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                state.interrupt(InterruptReason::Cancelled);
                return Err(interrupt_error_with_progress(InterruptReason::Cancelled, state, false));
            }
            _ = tokio::time::sleep_until(deadline) => {
                state.interrupt(InterruptReason::TimedOut);
                return Err(interrupt_error_with_progress(InterruptReason::TimedOut, state, false));
            }
            permit = self.running.clone().acquire_owned() => permit.map_err(|_| {
                script_error(
                    MongoScriptErrorKind::Runtime,
                    "MongoDB JavaScript execution admission is unavailable",
                )
            })?,
        };
        Ok(MongoScriptRuntimePermit { _running: running, _admitted: admitted })
    }
}

struct MongoScriptRuntimePermit {
    _running: OwnedSemaphorePermit,
    _admitted: OwnedSemaphorePermit,
}

#[async_trait]
pub trait MongoScriptHost: Send + Sync {
    async fn execute(&self, operation: MongoScriptOperation) -> Result<Value, String>;
}

struct MongoScriptCommandHost {
    state: Arc<AppState>,
    connection_id: String,
    max_rows: usize,
}

#[async_trait]
impl MongoScriptHost for MongoScriptCommandHost {
    async fn execute(&self, operation: MongoScriptOperation) -> Result<Value, String> {
        let (database, command) = match operation {
            MongoScriptOperation::SelectDatabase { database } => {
                return Ok(serde_json::json!({ "database": database }));
            }
            MongoScriptOperation::DatabaseCall { database, method, args } => {
                let command = build_mongo_database_command(method, &args)?;
                (database, command)
            }
            MongoScriptOperation::CollectionCall { database, collection, method, args, cursor } => {
                let mut command = if method == MongoCollectionMethod::FindExplain {
                    build_mongo_find_explain_command(
                        &collection,
                        &args,
                        cursor.as_deref().ok_or("MongoDB findExplain requires cursor options.")?,
                    )?
                } else {
                    build_mongo_collection_command(&collection, method, &args)?
                };
                if method != MongoCollectionMethod::FindExplain {
                    if let Some(cursor) = cursor.as_deref() {
                        apply_mongo_find_cursor(&mut command, cursor)?;
                    }
                }
                (database, command)
            }
        };
        let result = {
            let config = self.state.configs.read().await.get(&self.connection_id).cloned().ok_or_else(|| {
                script_error(
                    MongoScriptErrorKind::Safety,
                    format!(
                        "MongoDB shell JavaScript could not verify production safety for connection '{}'",
                        self.connection_id
                    ),
                )
            })?;
            if mongo_command_targets_production_database(&config, &database, &command) {
                return Err(script_error(
                    MongoScriptErrorKind::Safety,
                    format!(
                        "MongoDB shell JavaScript cannot mutate protected production scope from database '{database}'"
                    ),
                ));
            }
            execute_mongo_command_core(&self.state, &self.connection_id, &database, &command, self.max_rows).await?
        };
        mongo_command_result_for_script(&command, result)
    }
}

pub async fn execute_mongo_script_core(
    state: Arc<AppState>,
    request: MongoScriptRequest,
    limits: MongoScriptLimits,
    cancellation: CancellationToken,
) -> Result<MongoScriptResult, String> {
    let max_rows = limits.clamp_max_rows(request.max_rows);
    let admission = state.mongo_script_admission.clone();
    let host = Arc::new(MongoScriptCommandHost { state, connection_id: request.connection_id.clone(), max_rows });
    execute_mongo_script(request, limits, admission, host, cancellation).await
}

/// Execute one user-confirmed MongoDB shell script under the shared query
/// cancellation and connection safety policies used by both transports.
pub async fn execute_mongo_script_managed_core(
    state: Arc<AppState>,
    request: MongoScriptRequest,
    limits: MongoScriptLimits,
) -> Result<MongoScriptResult, String> {
    if !request.dangerous_operation_confirmed {
        return Err(script_error(
            MongoScriptErrorKind::Safety,
            "MongoDB shell JavaScript requires explicit dangerous-operation confirmation",
        ));
    }
    if let Some(name) = crate::query::connection_readonly_name(&state, &request.connection_id).await {
        return Err(script_error(
            MongoScriptErrorKind::Safety,
            format!(
                "Read-only mode: connection '{name}' has read-only protection enabled. Run MongoDB shell JavaScript blocked."
            ),
        ));
    }

    let registered =
        request.execution_id.as_ref().filter(|execution_id| !execution_id.trim().is_empty()).map(|execution_id| {
            state.running_queries.register_task(
                execution_id.clone(),
                RunningTaskMetadata::query(request.connection_id.clone(), request.database.clone(), None),
            )
        });
    let cancellation = registered.as_ref().map(|query| query.token()).unwrap_or_default();
    if let Some(execution_id) = request.execution_id.as_ref().filter(|execution_id| !execution_id.trim().is_empty()) {
        let runtime_cancellation = cancellation.clone();
        state.running_queries.register_interrupt(execution_id, move || runtime_cancellation.cancel());
    }

    execute_mongo_script_core(state, request, limits, cancellation).await
}

fn mongo_command_result_value(
    command: &crate::mongo_shell::MongoCommand,
    result: QueryResult,
) -> Result<Value, String> {
    use crate::mongo_shell::MongoCommand;

    let documents = query_result_documents(&result);
    match command {
        MongoCommand::Version => Ok(first_query_cell(&result).unwrap_or(Value::Null)),
        MongoCommand::Use { database } => Ok(Value::String(database.clone())),
        MongoCommand::RunCommand { .. } => Ok(documents.into_iter().next().unwrap_or(Value::Null)),
        MongoCommand::CollectionStats { metric, .. } if metric == "stats" => {
            Ok(documents.into_iter().next().unwrap_or(Value::Null))
        }
        MongoCommand::ShowDatabases
        | MongoCommand::Find { .. }
        | MongoCommand::Aggregate { .. }
        | MongoCommand::GetIndexes { .. } => Ok(Value::Array(documents)),
        MongoCommand::FindExplain { .. } => Ok(documents.into_iter().next().unwrap_or(Value::Null)),
        MongoCommand::FindOne { .. }
        | MongoCommand::FindOneAndUpdate { .. }
        | MongoCommand::FindOneAndReplace { .. }
        | MongoCommand::FindOneAndDelete { .. } => Ok(documents.into_iter().next().unwrap_or(Value::Null)),
        MongoCommand::Count { .. } | MongoCommand::CollectionStats { .. } => {
            Ok(first_query_cell(&result).unwrap_or(Value::Null))
        }
        MongoCommand::Distinct { .. } => {
            Ok(Value::Array(result.rows.into_iter().filter_map(|row| row.into_iter().next()).collect()))
        }
        MongoCommand::CreateIndex { .. } => Ok(serde_json::json!({
            "acknowledged": true,
            "name": first_query_cell(&result).unwrap_or(Value::Null),
        })),
        MongoCommand::Insert { .. }
        | MongoCommand::Update { .. }
        | MongoCommand::Delete { .. }
        | MongoCommand::CreateUser { .. }
        | MongoCommand::DropIndexes { .. }
        | MongoCommand::DropCollection { .. } => Ok(serde_json::json!({
            "acknowledged": true,
            "affectedRows": result.affected_rows,
        })),
    }
}

fn mongo_command_result_for_script(
    command: &crate::mongo_shell::MongoCommand,
    result: QueryResult,
) -> Result<Value, String> {
    mongo_command_result_value(command, result).map(crate::db::json_value_for_js)
}

fn first_query_cell(result: &QueryResult) -> Option<Value> {
    result.rows.first().and_then(|row| row.first()).cloned()
}

fn query_result_documents(result: &QueryResult) -> Vec<Value> {
    result
        .rows
        .iter()
        .map(|row| {
            if result.columns.len() == 1 && result.columns[0] == "value" {
                return row.first().cloned().unwrap_or(Value::Null);
            }
            Value::Object(
                result
                    .columns
                    .iter()
                    .enumerate()
                    .map(|(index, column)| (column.clone(), row.get(index).cloned().unwrap_or(Value::Null)))
                    .collect(),
            )
        })
        .collect()
}

struct HostRequest {
    operation: MongoScriptOperation,
    reply: oneshot::Sender<Result<Value, String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum InterruptReason {
    Running = 0,
    Cancelled = 1,
    TimedOut = 2,
}

struct ExecutionState {
    interrupt_reason: AtomicU8,
    operation_count: AtomicUsize,
    succeeded_operation_count: AtomicUsize,
}

impl ExecutionState {
    fn new() -> Self {
        Self {
            interrupt_reason: AtomicU8::new(InterruptReason::Running as u8),
            operation_count: AtomicUsize::new(0),
            succeeded_operation_count: AtomicUsize::new(0),
        }
    }

    fn interrupt(&self, reason: InterruptReason) {
        let _ = self.interrupt_reason.compare_exchange(
            InterruptReason::Running as u8,
            reason as u8,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }

    fn reason(&self) -> InterruptReason {
        match self.interrupt_reason.load(Ordering::SeqCst) {
            value if value == InterruptReason::Cancelled as u8 => InterruptReason::Cancelled,
            value if value == InterruptReason::TimedOut as u8 => InterruptReason::TimedOut,
            _ => InterruptReason::Running,
        }
    }

    fn try_start_operation(&self, limit: usize) -> Result<(), String> {
        self.operation_count
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| (count < limit).then_some(count + 1))
            .map(|_| ())
            .map_err(|_| {
                script_error(
                    MongoScriptErrorKind::ResourceLimit,
                    format!("MongoDB shell operation limit of {limit} exceeded"),
                )
            })
    }
}

#[derive(Default)]
struct OutputState {
    items: Vec<MongoScriptOutput>,
    bytes: usize,
    truncated: bool,
}

impl OutputState {
    fn capture(&mut self, output: MongoScriptOutput, limits: &MongoScriptLimits) -> Result<(), String> {
        let output_value = serde_json::to_value(&output)
            .map_err(|error| script_error(MongoScriptErrorKind::Serialization, error.to_string()))?;
        validate_json_shape(&output_value, limits)?;
        let bytes = serde_json::to_vec(&output)
            .map_err(|error| script_error(MongoScriptErrorKind::Serialization, error.to_string()))?
            .len();
        if self.items.len() >= limits.max_output_items || self.bytes.saturating_add(bytes) > limits.max_output_bytes {
            self.truncated = true;
            return Ok(());
        }
        self.bytes += bytes;
        self.items.push(output);
        Ok(())
    }
}

struct WorkerResult {
    final_value: Option<Value>,
}

struct InterruptOnDrop(Arc<ExecutionState>);

impl Drop for InterruptOnDrop {
    fn drop(&mut self) {
        self.0.interrupt(InterruptReason::Cancelled);
    }
}

pub async fn execute_mongo_script(
    request: MongoScriptRequest,
    limits: MongoScriptLimits,
    admission: Arc<MongoScriptRuntimeAdmission>,
    host: Arc<dyn MongoScriptHost>,
    cancellation: CancellationToken,
) -> Result<MongoScriptResult, String> {
    validate_request(&request, &limits)?;

    let timeout = request
        .timeout_secs
        .filter(|seconds| *seconds > 0)
        .map(Duration::from_secs)
        .map(|requested| requested.min(limits.safety_timeout))
        .unwrap_or(limits.safety_timeout);
    let deadline = Instant::now() + timeout;
    let state = Arc::new(ExecutionState::new());
    let _interrupt_on_drop = InterruptOnDrop(Arc::clone(&state));
    let _runtime_permit = admission.acquire(&cancellation, deadline, &state).await?;
    let output = Arc::new(Mutex::new(OutputState::default()));
    let current_database = Arc::new(Mutex::new(request.database.clone()));
    let (operation_tx, mut operation_rx) = mpsc::channel::<HostRequest>(1);

    let mut worker = spawn_runtime_worker(
        request.source,
        request.database,
        limits.clone(),
        Arc::clone(&state),
        Arc::clone(&output),
        operation_tx,
    );
    let mut operation_channel_open = true;

    loop {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                state.interrupt(InterruptReason::Cancelled);
                drop(operation_rx);
                let _ = worker.await;
                return Err(interrupt_error_with_progress(InterruptReason::Cancelled, &state, false));
            }
            _ = tokio::time::sleep_until(deadline) => {
                state.interrupt(InterruptReason::TimedOut);
                drop(operation_rx);
                let _ = worker.await;
                return Err(interrupt_error_with_progress(InterruptReason::TimedOut, &state, false));
            }
            worker_result = &mut worker => {
                return finish_worker(
                    worker_result,
                    &state,
                    &output,
                    &current_database,
                );
            }
            host_request = operation_rx.recv(), if operation_channel_open => {
                let Some(host_request) = host_request else {
                    operation_channel_open = false;
                    continue;
                };
                let operation = host_request.operation.clone();
                let mut interrupted = None;
                let host_result = tokio::select! {
                    biased;
                    result = host.execute(host_request.operation) => match result {
                        Ok(value) => {
                            state.succeeded_operation_count.fetch_add(1, Ordering::SeqCst);
                            validate_json_value(&value, &limits).map(|()| value)
                        }
                        Err(error) => Err(error),
                    },
                    _ = cancellation.cancelled() => {
                        state.interrupt(InterruptReason::Cancelled);
                        interrupted = Some(InterruptReason::Cancelled);
                        Err(interrupt_error_with_progress(InterruptReason::Cancelled, &state, true))
                    }
                    _ = tokio::time::sleep_until(deadline) => {
                        state.interrupt(InterruptReason::TimedOut);
                        interrupted = Some(InterruptReason::TimedOut);
                        Err(interrupt_error_with_progress(InterruptReason::TimedOut, &state, true))
                    }
                };

                if host_result.is_ok() {
                    if let MongoScriptOperation::SelectDatabase { database } = operation {
                        let mut current = current_database.lock().map_err(|_| {
                            script_error(MongoScriptErrorKind::Runtime, "MongoDB script database state is unavailable")
                        })?;
                        *current = database;
                    }
                }
                let _ = host_request.reply.send(host_result);

                if let Some(reason) = interrupted {
                    drop(operation_rx);
                    let _ = worker.await;
                    return Err(interrupt_error_with_progress(reason, &state, true));
                }
            }
        }
    }
}

fn validate_request(request: &MongoScriptRequest, limits: &MongoScriptLimits) -> Result<(), String> {
    limits.validate()?;
    if request.connection_id.trim().is_empty() {
        return Err(script_error(MongoScriptErrorKind::InvalidRequest, "connection_id must not be empty"));
    }
    if request.database.trim().is_empty() {
        return Err(script_error(MongoScriptErrorKind::InvalidRequest, "database must not be empty"));
    }
    if request.source.trim().is_empty() {
        return Err(script_error(MongoScriptErrorKind::InvalidRequest, "source must not be empty"));
    }
    if request.source.len() > limits.max_source_bytes {
        return Err(script_error(
            MongoScriptErrorKind::ResourceLimit,
            format!("MongoDB JavaScript source size limit of {} bytes exceeded", limits.max_source_bytes),
        ));
    }
    if request.max_rows == 0 {
        return Err(script_error(MongoScriptErrorKind::InvalidRequest, "max_rows must be greater than zero"));
    }
    Ok(())
}

fn spawn_runtime_worker(
    source: String,
    initial_database: String,
    limits: MongoScriptLimits,
    state: Arc<ExecutionState>,
    output: Arc<Mutex<OutputState>>,
    operation_tx: mpsc::Sender<HostRequest>,
) -> JoinHandle<Result<WorkerResult, String>> {
    tokio::task::spawn_blocking(move || run_runtime(source, initial_database, limits, state, output, operation_tx))
}

fn run_runtime(
    source: String,
    initial_database: String,
    limits: MongoScriptLimits,
    state: Arc<ExecutionState>,
    output: Arc<Mutex<OutputState>>,
    operation_tx: mpsc::Sender<HostRequest>,
) -> Result<WorkerResult, String> {
    let runtime = Runtime::new().map_err(|error| {
        script_error(MongoScriptErrorKind::Runtime, format!("Could not create JavaScript runtime: {error}"))
    })?;
    runtime.set_memory_limit(limits.memory_limit_bytes);
    runtime.set_max_stack_size(limits.stack_limit_bytes);
    let interrupt_state = Arc::clone(&state);
    runtime.set_interrupt_handler(Some(Box::new(move || interrupt_state.reason() != InterruptReason::Running)));

    let context = Context::full(&runtime).map_err(|error| {
        script_error(MongoScriptErrorKind::Runtime, format!("Could not create JavaScript context: {error}"))
    })?;
    context.with(|context| {
        install_host_call(context.clone(), Arc::clone(&state), &limits, operation_tx)?;
        install_output_capture(context.clone(), Arc::clone(&output), &limits)?;
        context
            .globals()
            .set(INITIAL_DATABASE_GLOBAL, initial_database)
            .map_err(|error| script_error(MongoScriptErrorKind::Runtime, error.to_string()))?;
        context
            .eval::<(), _>(RUNTIME_BOOTSTRAP)
            .catch(&context)
            .map_err(|error| script_error_from_js(error.to_string()))?;

        let value = context
            .eval::<JsValue<'_>, _>(source)
            .catch(&context)
            .map_err(|error| script_error_from_js(error.to_string()))?;
        let value = if let Some(promise) = value.as_promise() {
            promise.finish::<JsValue<'_>>().catch(&context).map_err(|error| script_error_from_js(error.to_string()))?
        } else {
            value
        };
        let finalize = context
            .globals()
            .get::<_, Function<'_>>(FINALIZE_GLOBAL)
            .map_err(|error| script_error(MongoScriptErrorKind::Runtime, error.to_string()))?;
        let value = finalize
            .call::<_, JsValue<'_>>((value,))
            .catch(&context)
            .map_err(|error| script_error_from_js(error.to_string()))?;
        let final_value = if value.is_undefined() {
            None
        } else {
            let value = rquickjs_serde::from_value::<Value>(value)
                .map_err(|error| script_error(MongoScriptErrorKind::Serialization, error.to_string()))?;
            validate_json_value(&value, &limits)?;
            Some(value)
        };
        Ok(WorkerResult { final_value })
    })
}

fn install_host_call(
    context: Ctx<'_>,
    state: Arc<ExecutionState>,
    limits: &MongoScriptLimits,
    operation_tx: mpsc::Sender<HostRequest>,
) -> Result<(), String> {
    let limits = limits.clone();
    let host_call = Function::new(context.clone(), move |context: Ctx<'_>, value: JsValue<'_>| {
        let operation = rquickjs_serde::from_value::<MongoScriptOperation>(value)
            .map_err(|error| Exception::throw_type(&context, &format!("Invalid MongoDB host operation: {error}")))?;
        let operation_value = serde_json::to_value(&operation).map_err(|error| {
            Exception::throw_internal(&context, &format!("Could not serialize host operation: {error}"))
        })?;
        validate_json_value(&operation_value, &limits).map_err(|error| Exception::throw_range(&context, &error))?;
        state.try_start_operation(limits.max_operations).map_err(|error| Exception::throw_range(&context, &error))?;

        let (reply, response) = oneshot::channel();
        operation_tx
            .blocking_send(HostRequest { operation, reply })
            .map_err(|_| Exception::throw_internal(&context, "MongoDB script host coordinator is unavailable"))?;
        let result = response
            .blocking_recv()
            .map_err(|_| Exception::throw_internal(&context, "MongoDB script host response channel closed"))?
            .map_err(|error| Exception::throw_message(&context, &host_error_for_script(error)))?;
        serde_json::to_string(&result).map_err(|error| {
            Exception::throw_internal(&context, &format!("Could not encode MongoDB host result: {error}"))
        })
    })
    .map_err(|error| script_error(MongoScriptErrorKind::Runtime, error.to_string()))?;
    context
        .globals()
        .set(RAW_HOST_CALL_GLOBAL, host_call)
        .map_err(|error| script_error(MongoScriptErrorKind::Runtime, error.to_string()))
}

fn install_output_capture(
    context: Ctx<'_>,
    output: Arc<Mutex<OutputState>>,
    limits: &MongoScriptLimits,
) -> Result<(), String> {
    let limits = limits.clone();
    let capture = Function::new(context.clone(), move |context: Ctx<'_>, value: JsValue<'_>| {
        let output_item = rquickjs_serde::from_value::<MongoScriptOutput>(value)
            .map_err(|error| Exception::throw_type(&context, &format!("Invalid script output: {error}")))?;
        output
            .lock()
            .map_err(|_| Exception::throw_internal(&context, "MongoDB script output state is unavailable"))?
            .capture(output_item, &limits)
            .map_err(|error| Exception::throw_range(&context, &error))
    })
    .map_err(|error| script_error(MongoScriptErrorKind::Runtime, error.to_string()))?;
    context
        .globals()
        .set(OUTPUT_GLOBAL, capture)
        .map_err(|error| script_error(MongoScriptErrorKind::Runtime, error.to_string()))
}

fn finish_worker(
    worker_result: Result<Result<WorkerResult, String>, tokio::task::JoinError>,
    state: &ExecutionState,
    output: &Mutex<OutputState>,
    current_database: &Mutex<String>,
) -> Result<MongoScriptResult, String> {
    let reason = state.reason();
    if reason != InterruptReason::Running {
        return Err(interrupt_error(reason));
    }
    let worker_result = worker_result.map_err(|error| {
        script_error(MongoScriptErrorKind::Runtime, format!("JavaScript runtime worker failed: {error}"))
    })?;
    let worker_result = worker_result.map_err(|error| with_operation_progress(error, state, false))?;
    let output = output
        .lock()
        .map_err(|_| script_error(MongoScriptErrorKind::Runtime, "MongoDB script output state is unavailable"))?;
    let current_database = current_database
        .lock()
        .map_err(|_| script_error(MongoScriptErrorKind::Runtime, "MongoDB script database state is unavailable"))?;
    Ok(MongoScriptResult {
        final_value: worker_result.final_value,
        output: output.items.clone(),
        operation_count: state.operation_count.load(Ordering::SeqCst),
        succeeded_operation_count: state.succeeded_operation_count.load(Ordering::SeqCst),
        current_database: current_database.clone(),
        truncated: output.truncated,
    })
}

fn with_operation_progress(error: String, state: &ExecutionState, unknown_outcome: bool) -> String {
    let attempted = state.operation_count.load(Ordering::SeqCst);
    if attempted == 0 && !unknown_outcome {
        return error;
    }
    let succeeded = state.succeeded_operation_count.load(Ordering::SeqCst);
    let unknown = if unknown_outcome { "; in-flight operation outcome unknown" } else { "" };
    format!(
        "{error} (MongoDB shell progress: {succeeded} confirmed completed of {attempted} attempted operations{unknown})"
    )
}

fn interrupt_error_with_progress(reason: InterruptReason, state: &ExecutionState, unknown_outcome: bool) -> String {
    with_operation_progress(interrupt_error(reason), state, unknown_outcome)
}

fn interrupt_error(reason: InterruptReason) -> String {
    match reason {
        InterruptReason::Cancelled => {
            script_error(MongoScriptErrorKind::Cancelled, "MongoDB shell execution cancelled")
        }
        InterruptReason::TimedOut => script_error(MongoScriptErrorKind::Timeout, "MongoDB shell execution timed out"),
        InterruptReason::Running => script_error(MongoScriptErrorKind::Runtime, "MongoDB shell execution interrupted"),
    }
}

fn host_error_for_script(error: String) -> String {
    if mongo_script_error_kind(&error).is_some() {
        error
    } else {
        script_error(MongoScriptErrorKind::Host, error)
    }
}

fn script_error_from_js(message: String) -> String {
    for kind in [MongoScriptErrorKind::Host, MongoScriptErrorKind::ResourceLimit, MongoScriptErrorKind::Safety] {
        let marker = format!("[mongo_script.{}]", kind.code());
        if let Some(index) = message.find(&marker) {
            return message[index..].to_string();
        }
    }
    script_error(MongoScriptErrorKind::Runtime, message)
}

fn validate_json_shape(value: &Value, limits: &MongoScriptLimits) -> Result<(), String> {
    let mut stack = vec![(value, 1_usize)];
    let mut nodes = 0_usize;
    while let Some((value, depth)) = stack.pop() {
        nodes = nodes.saturating_add(1);
        if nodes > limits.max_value_nodes {
            return Err(script_error(
                MongoScriptErrorKind::ResourceLimit,
                format!("MongoDB script value node limit of {} exceeded", limits.max_value_nodes),
            ));
        }
        if depth > limits.max_value_depth {
            return Err(script_error(
                MongoScriptErrorKind::ResourceLimit,
                format!("MongoDB script value depth limit of {} exceeded", limits.max_value_depth),
            ));
        }
        match value {
            Value::Array(values) => stack.extend(values.iter().map(|value| (value, depth + 1))),
            Value::Object(values) => stack.extend(values.values().map(|value| (value, depth + 1))),
            _ => {}
        }
    }
    Ok(())
}

fn validate_json_value(value: &Value, limits: &MongoScriptLimits) -> Result<(), String> {
    validate_json_shape(value, limits)?;
    let bytes = serde_json::to_vec(value)
        .map_err(|error| script_error(MongoScriptErrorKind::Serialization, error.to_string()))?
        .len();
    if bytes > limits.max_value_bytes {
        return Err(script_error(
            MongoScriptErrorKind::ResourceLimit,
            format!("MongoDB script value size limit of {} bytes exceeded", limits.max_value_bytes),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mongo_shell::MongoCommand;

    fn query_result(columns: &[&str], rows: Vec<Vec<Value>>, affected_rows: u64) -> QueryResult {
        QueryResult {
            columns: columns.iter().map(|column| (*column).to_string()).collect(),
            column_types: Vec::new(),
            column_sortables: Vec::new(),
            spatial_columns: Vec::new(),
            spatial_values: Vec::new(),
            rows,
            affected_rows,
            execution_time_ms: 0,
            truncated: false,
            session_id: None,
            has_more: false,
            elasticsearch_raw_body: None,
            messages: Vec::new(),
        }
    }

    #[test]
    fn command_result_mapping_preserves_nested_documents_and_scalar_shapes() {
        let find = MongoCommand::Find {
            collection: "items".to_string(),
            filter: "{}".to_string(),
            projection: None,
            sort: None,
            collation: None,
            skip: 0,
            limit: 10,
        };
        let nested = serde_json::json!({ "tags": ["one", "two"], "owner": { "id": 7 } });
        let value = mongo_command_result_value(
            &find,
            query_result(&["_id", "nested"], vec![vec![serde_json::json!(1), nested.clone()]], 0),
        )
        .unwrap();
        assert_eq!(value, serde_json::json!([{ "_id": 1, "nested": nested }]));

        let count = MongoCommand::Count { collection: "items".to_string(), filter: "{}".to_string(), accurate: true };
        assert_eq!(
            mongo_command_result_value(&count, query_result(&["count"], vec![vec![serde_json::json!(12)]], 0)).unwrap(),
            serde_json::json!(12)
        );
        assert_eq!(
            mongo_command_result_for_script(
                &count,
                query_result(&["count"], vec![vec![serde_json::json!(9_007_199_254_740_992_u64)]], 0),
            )
            .unwrap(),
            serde_json::json!("9007199254740992")
        );

        assert_eq!(
            mongo_command_result_value(
                &MongoCommand::ShowDatabases,
                query_result(
                    &["name", "sizeOnDisk", "empty"],
                    vec![
                        vec![serde_json::json!("admin"), serde_json::json!(40960), serde_json::json!(false)],
                        vec![serde_json::json!("app"), serde_json::json!(8192), serde_json::json!(true)],
                    ],
                    2,
                ),
            )
            .unwrap(),
            serde_json::json!([
                { "name": "admin", "sizeOnDisk": 40960, "empty": false },
                { "name": "app", "sizeOnDisk": 8192, "empty": true },
            ])
        );
    }

    #[test]
    fn command_result_mapping_returns_distinct_arrays_and_write_acknowledgements() {
        let distinct =
            MongoCommand::Distinct { collection: "items".to_string(), field: "status".to_string(), filter: None };
        assert_eq!(
            mongo_command_result_value(
                &distinct,
                query_result(&["value"], vec![vec![serde_json::json!("open")], vec![serde_json::json!("closed")]], 0,),
            )
            .unwrap(),
            serde_json::json!(["open", "closed"])
        );

        let insert = MongoCommand::Insert { collection: "items".to_string(), documents: "{\"_id\":1}".to_string() };
        assert_eq!(
            mongo_command_result_value(&insert, query_result(&[], Vec::new(), 1)).unwrap(),
            serde_json::json!({ "acknowledged": true, "affectedRows": 1 })
        );
    }

    #[test]
    fn script_limits_clamp_client_rows_to_the_server_hard_cap() {
        let limits = MongoScriptLimits::default();
        assert_eq!(limits.max_rows, crate::query::MAX_ROWS);
        assert_eq!(limits.clamp_max_rows(250), 250);
        assert_eq!(limits.clamp_max_rows(usize::MAX), crate::query::MAX_ROWS);

        let invalid = MongoScriptLimits { max_rows: 0, ..limits };
        assert!(invalid.validate().unwrap_err().contains("max_rows must be greater than zero"));
    }
}
