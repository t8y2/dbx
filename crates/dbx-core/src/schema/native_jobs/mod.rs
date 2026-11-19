use crate::connection::PoolKind;
use crate::db::agent_driver::{AgentCallError, AgentErrorCategory, AgentSessionDisposition};
use crate::query::{agent_execute_query_params, QueryExecutionOptions};
use dbx_sql::native_jobs::{
    native_job_catalog_queries, NativeJobCatalogCoverage, NativeJobCatalogDialect, NativeJobCatalogPart,
    NativeJobCatalogQuery,
};
use dbx_types::native_jobs::{NativeJobMetadata, NativeJobRef};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::time::Duration;

mod details;
mod operations;
mod references;
mod service;

pub use details::read_native_job_details_with;
pub use operations::{
    native_job_apply_core, native_job_apply_with, native_job_cancel, native_job_prepare_core,
    native_job_prepare_request_with, native_job_prepare_with, native_job_prepare_with_references, native_job_status,
    native_job_status_observed_core, NativeJobDispatchOutcome, NativeJobExecutionRead, NativeJobMutationSession,
    NativeJobStepReceipt,
};
pub use references::{native_job_references_core, native_job_references_with};
pub use service::{
    native_job_list_core, native_job_list_with, native_job_open_context_core, native_job_open_context_with,
    native_job_read_core, native_job_read_with, runtime_identity, NativeJobRegistry, NativeJobRuntimeIdentity,
};

pub type NativeJobCatalogRow = BTreeMap<String, Value>;

// This backend-only token must never enter a page result or diagnostic Debug output.
#[derive(Clone)]
pub(super) struct NativeJobPhysicalSession {
    operation_id: String,
    token: String,
}

impl NativeJobPhysicalSession {
    fn bind(&self, params: &mut Value) {
        let params = params.as_object_mut().expect("native Job RPC parameters");
        params.insert("nativeJobOperationId".into(), Value::String(self.operation_id.clone()));
        params.insert("nativeJobSessionToken".into(), Value::String(self.token.clone()));
    }
}

// These contain SQL bodies and parameter values; do not derive Debug.
pub struct NativeJobCatalogSection {
    pub data: NativeJobMetadata<Vec<NativeJobCatalogRow>>,
    pub source: Option<&'static str>,
    pub coverage: Option<NativeJobCatalogCoverage>,
    pub failures: Vec<NativeJobCatalogAttemptFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeJobCatalogAttemptFailure {
    pub source: &'static str,
    pub failure: NativeJobCatalogFailure,
}

/// Only diagnostics supplied by the driver, never text extracted from SQL or an error row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeJobCatalogFailure {
    Denied(Option<i32>),
    Unavailable(Option<i32>),
    Unsupported(Option<i32>),
    Query(Option<i32>),
    Transport,
    RouteUnavailable,
    Timeout,
    Canceled,
    InvalidResponse,
    IdentityMismatch,
    AmbiguousIdentity,
}

impl NativeJobCatalogFailure {
    pub fn sql(dialect: NativeJobCatalogDialect, vendor_code: Option<i32>, sql_state: Option<&str>) -> Self {
        let oracle_family = dialect != NativeJobCatalogDialect::Dameng;
        if sql_state == Some("42501")
            || oracle_family && vendor_code == Some(1031)
            || !oracle_family && vendor_code == Some(-5669)
        {
            Self::Denied(vendor_code)
        } else if matches!(sql_state, Some("42S02" | "42S22"))
            || oracle_family && matches!(vendor_code, Some(942 | 904))
            || !oracle_family && vendor_code == Some(-2106)
        {
            // A hidden view and a missing view can have the same native code.
            Self::Unavailable(vendor_code)
        } else if sql_state == Some("0A000") {
            Self::Unsupported(vendor_code)
        } else {
            Self::Query(vendor_code)
        }
    }

    fn from_agent(dialect: NativeJobCatalogDialect, error: AgentCallError) -> Self {
        match error {
            AgentCallError::Structured { context, .. }
                if context.category == AgentErrorCategory::Sql
                    && context.session_disposition == AgentSessionDisposition::Keep =>
            {
                Self::sql(dialect, context.vendor_code, context.sql_state.as_deref())
            }
            AgentCallError::Timeout { .. } => Self::Timeout,
            AgentCallError::Canceled { .. } => Self::Canceled,
            AgentCallError::Structured { context, .. } if context.category == AgentErrorCategory::Timeout => {
                Self::Timeout
            }
            AgentCallError::Structured { context, .. } if context.category == AgentErrorCategory::Canceled => {
                Self::Canceled
            }
            AgentCallError::Structured { context, .. } if context.category == AgentErrorCategory::Sql => {
                Self::Query(context.vendor_code)
            }
            AgentCallError::Legacy { hints, .. } if hints.category == Some(AgentErrorCategory::Sql) => {
                Self::Query(None)
            }
            _ => Self::Transport,
        }
    }

    fn permits_fallback(&self) -> bool {
        matches!(self, Self::Denied(_) | Self::Unavailable(_) | Self::Unsupported(_))
    }

    fn metadata<T>(&self) -> NativeJobMetadata<T> {
        let (key, code) = match self {
            Self::Denied(code) => ("native_job_catalog_denied", *code),
            Self::Unavailable(code) => ("native_job_catalog_unavailable", *code),
            Self::Unsupported(code) => ("native_job_catalog_unsupported", *code),
            Self::Query(code) => ("native_job_catalog_query_failed", *code),
            Self::Transport => ("native_job_catalog_transport_failed", None),
            Self::RouteUnavailable => ("native_job_catalog_driver_route_missing", None),
            Self::Timeout => ("native_job_catalog_timeout", None),
            Self::Canceled => ("native_job_catalog_canceled", None),
            Self::InvalidResponse => ("native_job_catalog_invalid_response", None),
            Self::IdentityMismatch => ("native_job_catalog_identity_mismatch", None),
            Self::AmbiguousIdentity => ("native_job_catalog_identity_ambiguous", None),
        };
        let reason = code.map_or_else(|| key.to_string(), |code| format!("{key}:{code}"));
        match self {
            Self::Denied(_) => NativeJobMetadata::Denied { reason },
            Self::Unavailable(_) => NativeJobMetadata::Unknown { reason },
            Self::Unsupported(_) => NativeJobMetadata::Unsupported { reason },
            _ => NativeJobMetadata::Error { reason },
        }
    }
}

/// Read a single partition using the existing driver corridor without query history or body logging.
/// The caller owns the connection lifecycle and the selected target's context binding.
pub async fn read_native_job_catalog_part(
    dialect: NativeJobCatalogDialect,
    target: &NativeJobRef,
    part: NativeJobCatalogPart,
    pool: &PoolKind,
    timeout: Option<Duration>,
) -> Result<NativeJobCatalogSection, &'static str> {
    let database = &target.scope().database;
    read_native_job_catalog_part_with(dialect, target, part, |query| {
        execute_catalog_query(dialect, pool, database, query, timeout)
    })
    .await
}

pub(super) async fn execute_catalog_query(
    dialect: NativeJobCatalogDialect,
    pool: &PoolKind,
    database: &str,
    query: NativeJobCatalogQuery,
    timeout: Option<Duration>,
) -> Result<Value, NativeJobCatalogFailure> {
    execute_catalog_query_in_session(dialect, pool, database, query, timeout, None).await
}

pub(super) async fn execute_catalog_query_in_session(
    dialect: NativeJobCatalogDialect,
    pool: &PoolKind,
    database: &str,
    query: NativeJobCatalogQuery,
    timeout: Option<Duration>,
    physical: Option<&NativeJobPhysicalSession>,
) -> Result<Value, NativeJobCatalogFailure> {
    match pool {
        PoolKind::Agent(client) => {
            let mut client = tokio::time::timeout(crate::connection::METADATA_POOL_ACQUIRE_TIMEOUT, client.lock())
                .await
                .map_err(|_| NativeJobCatalogFailure::Timeout)?;
            let mut params = agent_execute_query_params(
                &query.sql,
                (!database.is_empty()).then_some(database),
                None,
                QueryExecutionOptions {
                    max_rows: Some(query.limit + 1),
                    fetch_size: Some(1_000),
                    ..Default::default()
                },
            );
            if let Some(physical) = physical {
                physical.bind(&mut params);
            }
            client
                .execute_query_typed_with_timeout(params, timeout)
                .await
                .map_err(|error| NativeJobCatalogFailure::from_agent(dialect, error))
        }
        PoolKind::ExternalDriver { config, session, .. } => {
            let mut params = serde_json::json!({ "connection": config.as_ref(), "database": database, "sql": query.sql,
                "maxRows": query.limit + 1, "fetchSize": 1000, "deferLobs": false, "nativeDiagnostics": true });
            if let Some(physical) = physical {
                physical.bind(&mut params);
            }
            session
                .invoke_with_timeout("executeQuery", params, timeout)
                .await
                .map_err(|_| NativeJobCatalogFailure::Transport)
        }
        _ => Err(NativeJobCatalogFailure::RouteUnavailable),
    }
}

/// The callback is the database boundary. All source choice, result validation and identity checks
/// are shared by production reads and tests.
pub async fn read_native_job_catalog_part_with<Q, F>(
    dialect: NativeJobCatalogDialect,
    target: &NativeJobRef,
    part: NativeJobCatalogPart,
    mut query: Q,
) -> Result<NativeJobCatalogSection, &'static str>
where
    Q: FnMut(NativeJobCatalogQuery) -> F,
    F: Future<Output = Result<Value, NativeJobCatalogFailure>>,
{
    let queries = native_job_catalog_queries(dialect, target, part)?;
    read_catalog_candidates_with(
        queries,
        |raw, limit| decode_catalog_rows(dialect, target, part, raw, limit),
        &mut query,
    )
    .await
}

async fn read_catalog_candidates_with<Q, F, D>(
    queries: Vec<NativeJobCatalogQuery>,
    decode: D,
    query: &mut Q,
) -> Result<NativeJobCatalogSection, &'static str>
where
    Q: FnMut(NativeJobCatalogQuery) -> F,
    F: Future<Output = Result<Value, NativeJobCatalogFailure>>,
    D: Fn(Value, usize) -> Result<NativeJobMetadata<Vec<NativeJobCatalogRow>>, NativeJobCatalogFailure>,
{
    let mut failures = Vec::new();
    let mut source = None;
    let mut coverage = None;
    for candidate in queries {
        source = Some(candidate.source);
        coverage = Some(candidate.coverage);
        let limit = candidate.limit;
        let read = query(candidate).await.and_then(|raw| decode(raw, limit));
        match read {
            Ok(data) => return Ok(NativeJobCatalogSection { data, source, coverage, failures }),
            Err(failure) => {
                let retry = failure.permits_fallback();
                failures.push(NativeJobCatalogAttemptFailure { source: source.unwrap(), failure });
                if !retry {
                    break;
                }
            }
        }
    }
    let data = failures.last().map_or_else(
        || NativeJobMetadata::Unsupported { reason: "native_job_catalog_section_not_applicable".into() },
        |attempt| attempt.failure.metadata(),
    );
    Ok(NativeJobCatalogSection { data, source, coverage, failures })
}

fn decode_catalog_rows(
    dialect: NativeJobCatalogDialect,
    target: &NativeJobRef,
    part: NativeJobCatalogPart,
    raw: Value,
    limit: usize,
) -> Result<NativeJobMetadata<Vec<NativeJobCatalogRow>>, NativeJobCatalogFailure> {
    let result = decode_query_result(dialect, raw)?;
    if matches!(
        part,
        NativeJobCatalogPart::Definition | NativeJobCatalogPart::Generation | NativeJobCatalogPart::NativeAttributes
    ) && result.rows.len() > 1
    {
        return Err(NativeJobCatalogFailure::AmbiguousIdentity);
    }
    rows_from_result(result, limit, |row| validate_catalog_identity(dialect, target, part, row))
}

fn decode_query_result(
    dialect: NativeJobCatalogDialect,
    raw: Value,
) -> Result<dbx_types::types::QueryResult, NativeJobCatalogFailure> {
    for flag in ["execution_error", "executionError"] {
        if raw.get(flag).is_some_and(|flag| flag != &Value::Bool(false) && !flag.is_null()) {
            return Err(query_response_failure(dialect, &raw));
        }
    }
    if raw.get("error").is_some_and(|error| !error.is_null()) {
        return Err(query_response_failure(dialect, &raw));
    }
    let result: dbx_types::types::QueryResult =
        serde_json::from_value(raw).map_err(|_| NativeJobCatalogFailure::InvalidResponse)?;
    Ok(result)
}

fn rows_from_result(
    result: dbx_types::types::QueryResult,
    limit: usize,
    validate: impl Fn(&NativeJobCatalogRow) -> Result<(), NativeJobCatalogFailure>,
) -> Result<NativeJobMetadata<Vec<NativeJobCatalogRow>>, NativeJobCatalogFailure> {
    let mut column_names = HashSet::new();
    let columns = result.columns.iter().map(|column| column.to_ascii_uppercase()).collect::<Vec<_>>();
    if columns.is_empty() || columns.iter().any(|column| column.is_empty() || !column_names.insert(column)) {
        return Err(NativeJobCatalogFailure::InvalidResponse);
    }
    if result.rows.iter().any(|row| row.len() != columns.len()) {
        return Err(NativeJobCatalogFailure::InvalidResponse);
    }
    let incomplete = result.truncated || result.has_more || result.rows.len() > limit;
    let mut rows = result
        .rows
        .into_iter()
        .take(limit)
        .map(|row| columns.iter().cloned().zip(row).collect::<NativeJobCatalogRow>())
        .collect::<Vec<_>>();
    for row in &mut rows {
        validate(row)?;
        for value in row.values_mut() {
            *value = dbx_types::json::json_value_for_js(value.take());
        }
    }
    Ok(if incomplete {
        NativeJobMetadata::Truncated { value: rows, limit }
    } else if rows.is_empty() {
        NativeJobMetadata::Empty
    } else {
        NativeJobMetadata::Available { value: rows }
    })
}

fn query_response_failure(dialect: NativeJobCatalogDialect, raw: &Value) -> NativeJobCatalogFailure {
    let diagnostics = &raw["error"]["diagnostics"];
    match diagnostics["category"].as_str() {
        Some("sql") => NativeJobCatalogFailure::sql(
            dialect,
            diagnostics["vendorCode"].as_i64().and_then(|code| i32::try_from(code).ok()),
            diagnostics["sqlState"].as_str(),
        ),
        Some("connection") => NativeJobCatalogFailure::Transport,
        Some("timeout") => NativeJobCatalogFailure::Timeout,
        Some("canceled") => NativeJobCatalogFailure::Canceled,
        _ => NativeJobCatalogFailure::Query(None),
    }
}

fn validate_catalog_identity(
    dialect: NativeJobCatalogDialect,
    target: &NativeJobRef,
    part: NativeJobCatalogPart,
    row: &NativeJobCatalogRow,
) -> Result<(), NativeJobCatalogFailure> {
    let mismatch = NativeJobCatalogFailure::IdentityMismatch;
    if matches!(part, NativeJobCatalogPart::Generation | NativeJobCatalogPart::NativeAttributes) {
        let id = row.get("DBX_JOB_ID").and_then(Value::as_str).ok_or(mismatch.clone())?;
        if id.is_empty() || id.starts_with('0') || !id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(mismatch);
        }
        if matches!(target, NativeJobRef::Legacy { job_id, .. } | NativeJobRef::DamengNative { job_id, .. } if id != job_id)
        {
            return Err(mismatch);
        }
        if !matches!(target, NativeJobRef::Legacy { .. })
            && row.get("DBX_CREATED_AT").and_then(Value::as_str).is_none_or(str::is_empty)
        {
            return Err(mismatch);
        }
    }
    if matches!(part, NativeJobCatalogPart::Definition | NativeJobCatalogPart::NativeAttributes) {
        let valid = match target {
            NativeJobRef::Scheduler { owner, name, .. } => {
                row.get("DBX_OWNER").or_else(|| row.get("OWNER")).and_then(Value::as_str) == Some(owner)
                    && row.get("JOB_NAME").and_then(Value::as_str) == Some(name)
            }
            NativeJobRef::Legacy { job_id, .. } => {
                row.get("DBX_JOB_ID").and_then(Value::as_str) == Some(job_id)
                    && (dialect != NativeJobCatalogDialect::Dameng
                        || part == NativeJobCatalogPart::NativeAttributes
                        || matches!(row.get("SYS_FLAG"), Some(Value::Number(value)) if value.as_i64() == Some(2))
                        || row.get("SYS_FLAG").and_then(Value::as_str) == Some("2"))
            }
            NativeJobRef::DamengNative { job_id, name, .. } => {
                row.get("DBX_JOB_ID").and_then(Value::as_str) == Some(job_id)
                    && row.get("NAME").and_then(Value::as_str) == Some(name)
            }
        };
        if !valid {
            return Err(mismatch);
        }
    }
    Ok(())
}
