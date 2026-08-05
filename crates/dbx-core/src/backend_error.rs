//! Stable backend error envelopes and the v1 JDBC Agent catalog.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::db::agent_driver::{
    category_name, stage_name, valid_agent_error_combination, AgentCallError, AgentErrorCategory, AgentErrorContext,
    AgentErrorStage, AgentOperationOutcome, AgentSessionDisposition,
};

const MAX_DETAIL_BYTES: usize = 64 * 1024;

/// The v1 compatibility source of a backend error.
///
/// New code should use `origin` for subsystem/adapter information. This field
/// remains unchanged so older clients can continue to consume v1 envelopes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackendErrorSource {
    JdbcAgent,
    JdbcAgentLegacy,
    LegacyBackend,
}

/// Extensible subsystem metadata for backend errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackendSubsystem {
    Database,
    Tunnel,
    Extension,
    Ai,
    MessageQueue,
    Backend,
}

/// The adapter that produced the error within its subsystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BackendErrorAdapter {
    JdbcAgent,
    JdbcAgentLegacy,
    Native,
    Plugin,
    Http,
    Legacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendErrorOrigin {
    subsystem: BackendSubsystem,
    adapter: BackendErrorAdapter,
    #[serde(skip_serializing_if = "Option::is_none")]
    driver: Option<&'static str>,
}

impl BackendErrorOrigin {
    const fn database(adapter: BackendErrorAdapter) -> Self {
        Self { subsystem: BackendSubsystem::Database, adapter, driver: None }
    }

    const fn database_driver(adapter: BackendErrorAdapter, driver: &'static str) -> Self {
        Self { subsystem: BackendSubsystem::Database, adapter, driver: Some(driver) }
    }

    const fn backend() -> Self {
        Self { subsystem: BackendSubsystem::Backend, adapter: BackendErrorAdapter::Legacy, driver: None }
    }
}

/// Whether the operation definitely had not started or its result is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendOperationOutcome {
    NotStarted,
    Unknown,
}

/// Scalar values permitted in catalog-owned message parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum BackendMessageParam {
    String(String),
    Integer(i64),
    Boolean(bool),
}

/// Allowlisted diagnostics safe for a public error envelope.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendErrorDiagnostics {
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sql_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vendor_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exception_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    adapter_code: Option<String>,
}

/// Public v1 backend error envelope.
///
/// The fields are private on purpose: callers create envelopes through the
/// catalog adapters, so code/messageKey/params cannot drift independently.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendError {
    version: u8,
    code: String,
    message_key: String,
    message_params: BTreeMap<String, BackendMessageParam>,
    source: BackendErrorSource,
    origin: BackendErrorOrigin,
    operation_outcome: BackendOperationOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagnostics: Option<BackendErrorDiagnostics>,
    #[serde(skip_serializing_if = "Option::is_none")]
    help_url: Option<String>,
}

impl BackendError {
    /// Convert a typed Agent error into the stable v1 JDBC catalog envelope.
    pub fn from_agent_call_error(error: &AgentCallError) -> Self {
        match error {
            AgentCallError::Structured { message, context, .. } => {
                let (entry, outcome) = structured_entry(context);
                let detail = match context.category {
                    AgentErrorCategory::Sql => bounded_native_detail(message),
                    _ => bounded_detail(message),
                };
                Self::new(
                    entry,
                    BackendErrorSource::JdbcAgent,
                    BackendErrorOrigin::database(BackendErrorAdapter::JdbcAgent),
                    outcome,
                    stage_param(entry, context.stage),
                    detail,
                    Some(diagnostics_from_context(context)),
                )
            }
            AgentCallError::Legacy { message, hints, .. } => {
                let detail = match hints.category {
                    Some(AgentErrorCategory::Sql) => bounded_native_detail(message),
                    _ => bounded_detail(message),
                };
                Self::new(
                    catalog_entry(CatalogCode::JdbcLegacyFailure),
                    BackendErrorSource::JdbcAgentLegacy,
                    BackendErrorOrigin::database(BackendErrorAdapter::JdbcAgentLegacy),
                    BackendOperationOutcome::Unknown,
                    BTreeMap::new(),
                    detail,
                    None,
                )
            }
            AgentCallError::ContractViolation { message, .. } => Self::new(
                catalog_entry(CatalogCode::ContractInvalid),
                BackendErrorSource::JdbcAgent,
                BackendErrorOrigin::database(BackendErrorAdapter::JdbcAgent),
                BackendOperationOutcome::Unknown,
                BTreeMap::new(),
                bounded_detail(message),
                None,
            ),
            AgentCallError::Transport { message } => Self::new(
                catalog_entry(CatalogCode::ProtocolFailed),
                BackendErrorSource::JdbcAgent,
                BackendErrorOrigin::database(BackendErrorAdapter::JdbcAgent),
                BackendOperationOutcome::Unknown,
                BTreeMap::new(),
                bounded_detail(message),
                None,
            ),
            AgentCallError::Timeout { stage, operation_outcome } => {
                let entry = catalog_entry(match operation_outcome {
                    AgentOperationOutcome::NotStarted => CatalogCode::TimeoutNotStarted,
                    AgentOperationOutcome::Unknown => CatalogCode::TimeoutUnknown,
                });
                Self::new(
                    entry,
                    BackendErrorSource::JdbcAgent,
                    BackendErrorOrigin::database(BackendErrorAdapter::JdbcAgent),
                    map_outcome(*operation_outcome),
                    stage_param(entry, *stage),
                    None,
                    Some(diagnostics_for_local("timeout", *stage)),
                )
            }
            AgentCallError::Canceled { stage, operation_outcome } => Self::new(
                catalog_entry(CatalogCode::Canceled),
                BackendErrorSource::JdbcAgent,
                BackendErrorOrigin::database(BackendErrorAdapter::JdbcAgent),
                map_outcome(*operation_outcome),
                stage_param(catalog_entry(CatalogCode::Canceled), *stage),
                None,
                Some(diagnostics_for_local("canceled", *stage)),
            ),
        }
    }

    /// Adapt a non-Agent legacy backend string without attempting text classification.
    pub fn from_legacy_backend(message: &str) -> Self {
        Self::new(
            catalog_entry(CatalogCode::LegacyBackend),
            BackendErrorSource::LegacyBackend,
            BackendErrorOrigin::backend(),
            BackendOperationOutcome::Unknown,
            BTreeMap::new(),
            bounded_detail(message),
            None,
        )
    }

    /// Create a timeout envelope while retaining the bounded diagnostic detail.
    pub fn from_timeout_detail(message: &str) -> Self {
        let entry = catalog_entry(CatalogCode::TimeoutUnknown);
        Self::new(
            entry,
            BackendErrorSource::JdbcAgent,
            BackendErrorOrigin::database(BackendErrorAdapter::Native),
            BackendOperationOutcome::Unknown,
            stage_param(entry, AgentErrorStage::Execute),
            bounded_detail(message),
            Some(diagnostics_for_local("timeout", AgentErrorStage::Execute)),
        )
    }

    /// Create a SQL failure envelope while retaining bounded native driver detail.
    ///
    /// The caller must pass a typed SQL execution error, not a connection or
    /// transport diagnostic. Native SQL text is intentionally not parsed or
    /// rewritten because the database dialect owns its format.
    pub fn from_sql_detail(message: &str) -> Self {
        let entry = catalog_entry(CatalogCode::SqlFailed);
        Self::new(
            entry,
            BackendErrorSource::JdbcAgent,
            BackendErrorOrigin::database(BackendErrorAdapter::Native),
            BackendOperationOutcome::Unknown,
            stage_param(entry, AgentErrorStage::Execute),
            bounded_native_detail(message),
            Some(diagnostics_for_local("sql", AgentErrorStage::Execute)),
        )
    }

    /// Adapt a DuckDB worker error while retaining both the native detail and
    /// the worker protocol code for diagnostics at the public boundary.
    pub fn from_duckdb_worker_error(code: &str, message: &str) -> Self {
        let is_sql_error = matches!(code, "duckdb_execute_failed" | "duckdb_worker_poisoned");
        let entry = catalog_entry(if is_sql_error { CatalogCode::SqlFailed } else { CatalogCode::LegacyBackend });
        let source = if is_sql_error { BackendErrorSource::JdbcAgent } else { BackendErrorSource::LegacyBackend };
        let category = if is_sql_error { "sql" } else { "backend" };
        Self::new(
            entry,
            source,
            BackendErrorOrigin::database_driver(BackendErrorAdapter::Native, "duckdb"),
            BackendOperationOutcome::Unknown,
            stage_param(entry, AgentErrorStage::Execute),
            if is_sql_error { bounded_native_detail(message) } else { bounded_detail(message) },
            Some(diagnostics_for_local_with_adapter_code(category, AgentErrorStage::Execute, code)),
        )
    }

    /// Create a cancellation envelope for work canceled by the Rust executor.
    pub fn from_canceled(stage: AgentErrorStage, operation_outcome: AgentOperationOutcome) -> Self {
        let entry = catalog_entry(CatalogCode::Canceled);
        Self::new(
            entry,
            BackendErrorSource::LegacyBackend,
            BackendErrorOrigin::database(BackendErrorAdapter::Native),
            map_outcome(operation_outcome),
            stage_param(entry, stage),
            None,
            Some(diagnostics_for_local("canceled", stage)),
        )
    }

    /// Convert a legacy boundary string while preserving Agent data when the
    /// compatibility adapter can prove that the string came from an Agent.
    pub fn from_legacy_string(message: &str) -> Self {
        crate::db::agent_driver::try_agent_error_from_legacy(message)
            .map_or_else(|| Self::from_legacy_backend(message), |error| Self::from_agent_call_error(&error))
    }

    pub fn version(&self) -> u8 {
        self.version
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn message_key(&self) -> &str {
        &self.message_key
    }

    pub fn message_params(&self) -> &BTreeMap<String, BackendMessageParam> {
        &self.message_params
    }

    pub fn source(&self) -> BackendErrorSource {
        self.source
    }

    pub fn origin(&self) -> BackendErrorOrigin {
        self.origin
    }

    pub fn operation_outcome(&self) -> BackendOperationOutcome {
        self.operation_outcome
    }

    pub fn detail(&self) -> Option<&str> {
        self.detail.as_deref()
    }

    pub fn without_detail(mut self) -> Self {
        self.detail = None;
        self
    }

    pub fn diagnostics(&self) -> Option<&BackendErrorDiagnostics> {
        self.diagnostics.as_ref()
    }

    fn new(
        entry: &'static CatalogEntry,
        source: BackendErrorSource,
        origin: BackendErrorOrigin,
        operation_outcome: BackendOperationOutcome,
        message_params: BTreeMap<String, BackendMessageParam>,
        detail: Option<String>,
        diagnostics: Option<BackendErrorDiagnostics>,
    ) -> Self {
        debug_assert_eq!(message_params.len(), entry.params.len());
        debug_assert!(message_params.iter().all(|(key, value)| entry.allows_value(key, value)));
        Self {
            version: 1,
            code: entry.code.to_string(),
            message_key: entry.message_key.to_string(),
            message_params,
            source,
            origin,
            operation_outcome,
            detail,
            diagnostics,
            help_url: entry.help_url.map(str::to_string),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CatalogCode {
    ConnectionFailed,
    ConnectionInterrupted,
    TimeoutNotStarted,
    TimeoutUnknown,
    Canceled,
    BusyRetryLater,
    RuntimeReplaced,
    SqlFailed,
    ProtocolFailed,
    ContractInvalid,
    JdbcLegacyFailure,
    LegacyBackend,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ParamKind {
    String,
    Integer,
    Boolean,
}

#[derive(Debug, Clone, Copy)]
struct ParamSpec {
    name: &'static str,
    kind: ParamKind,
}

#[derive(Debug, Clone, Copy)]
struct CatalogEntry {
    code: &'static str,
    message_key: &'static str,
    params: &'static [ParamSpec],
    help_url: Option<&'static str>,
}

const STAGE_PARAM: &[ParamSpec] = &[ParamSpec { name: "stage", kind: ParamKind::String }];
const NO_PARAMS: &[ParamSpec] = &[];

fn catalog_entry(code: CatalogCode) -> &'static CatalogEntry {
    const ENTRIES: &[(CatalogCode, CatalogEntry)] = &[
        (
            CatalogCode::ConnectionFailed,
            CatalogEntry {
                code: "DBX-JDBC-1001",
                message_key: "backendErrors.jdbc.connectionFailed",
                params: STAGE_PARAM,
                help_url: None,
            },
        ),
        (
            CatalogCode::ConnectionInterrupted,
            CatalogEntry {
                code: "DBX-JDBC-1002",
                message_key: "backendErrors.jdbc.connectionInterrupted",
                params: STAGE_PARAM,
                help_url: None,
            },
        ),
        (
            CatalogCode::TimeoutNotStarted,
            CatalogEntry {
                code: "DBX-JDBC-2001",
                message_key: "backendErrors.jdbc.operationTimedOut",
                params: STAGE_PARAM,
                help_url: None,
            },
        ),
        (
            CatalogCode::TimeoutUnknown,
            CatalogEntry {
                code: "DBX-JDBC-2002",
                message_key: "backendErrors.jdbc.operationTimedOut",
                params: STAGE_PARAM,
                help_url: None,
            },
        ),
        (
            CatalogCode::Canceled,
            CatalogEntry {
                code: "DBX-JDBC-2003",
                message_key: "backendErrors.jdbc.operationCanceled",
                params: STAGE_PARAM,
                help_url: None,
            },
        ),
        (
            CatalogCode::BusyRetryLater,
            CatalogEntry {
                code: "DBX-JDBC-3001",
                message_key: "backendErrors.jdbc.busyRetryLater",
                params: STAGE_PARAM,
                help_url: None,
            },
        ),
        (
            CatalogCode::RuntimeReplaced,
            CatalogEntry {
                code: "DBX-JDBC-3002",
                message_key: "backendErrors.jdbc.runtimeReplaced",
                params: STAGE_PARAM,
                help_url: None,
            },
        ),
        (
            CatalogCode::SqlFailed,
            CatalogEntry {
                code: "DBX-JDBC-4001",
                message_key: "backendErrors.jdbc.sqlFailed",
                params: STAGE_PARAM,
                help_url: None,
            },
        ),
        (
            CatalogCode::ProtocolFailed,
            CatalogEntry {
                code: "DBX-JDBC-5001",
                message_key: "backendErrors.jdbc.protocolFailed",
                params: NO_PARAMS,
                help_url: None,
            },
        ),
        (
            CatalogCode::ContractInvalid,
            CatalogEntry {
                code: "DBX-JDBC-5002",
                message_key: "backendErrors.jdbc.contractInvalid",
                params: NO_PARAMS,
                help_url: None,
            },
        ),
        (
            CatalogCode::JdbcLegacyFailure,
            CatalogEntry {
                code: "DBX-JDBC-9001",
                message_key: "backendErrors.jdbc.legacyFailure",
                params: NO_PARAMS,
                help_url: None,
            },
        ),
        (
            CatalogCode::LegacyBackend,
            CatalogEntry {
                code: "DBX-LEGACY-0001",
                message_key: "backendErrors.legacy",
                params: NO_PARAMS,
                help_url: None,
            },
        ),
    ];
    ENTRIES.iter().find(|(kind, _)| *kind == code).map(|(_, entry)| entry).expect("catalog entry missing")
}

fn structured_entry(context: &AgentErrorContext) -> (&'static CatalogEntry, BackendOperationOutcome) {
    if !valid_agent_error_combination(context) {
        return (catalog_entry(CatalogCode::ContractInvalid), BackendOperationOutcome::Unknown);
    }

    let code = match context.category {
        AgentErrorCategory::Connection => match (context.stage, context.operation_outcome) {
            (
                AgentErrorStage::Request
                | AgentErrorStage::Checkout
                | AgentErrorStage::Connect
                | AgentErrorStage::Validate,
                AgentOperationOutcome::NotStarted,
            ) => CatalogCode::ConnectionFailed,
            (
                AgentErrorStage::Execute | AgentErrorStage::Fetch | AgentErrorStage::Cancel | AgentErrorStage::Close,
                AgentOperationOutcome::Unknown,
            ) => CatalogCode::ConnectionInterrupted,
            _ => CatalogCode::ContractInvalid,
        },
        AgentErrorCategory::Timeout => match context.operation_outcome {
            AgentOperationOutcome::NotStarted => CatalogCode::TimeoutNotStarted,
            AgentOperationOutcome::Unknown => CatalogCode::TimeoutUnknown,
        },
        AgentErrorCategory::Canceled => CatalogCode::Canceled,
        AgentErrorCategory::Resource => {
            if context.session_disposition == AgentSessionDisposition::ReplaceRuntime {
                CatalogCode::RuntimeReplaced
            } else if context.operation_outcome == AgentOperationOutcome::NotStarted {
                CatalogCode::BusyRetryLater
            } else {
                CatalogCode::ContractInvalid
            }
        }
        AgentErrorCategory::Sql => {
            if matches!(
                context.stage,
                AgentErrorStage::Execute | AgentErrorStage::Fetch | AgentErrorStage::Cancel | AgentErrorStage::Close
            ) && context.operation_outcome == AgentOperationOutcome::Unknown
            {
                CatalogCode::SqlFailed
            } else {
                CatalogCode::ContractInvalid
            }
        }
        AgentErrorCategory::Protocol => CatalogCode::ProtocolFailed,
    };
    let entry = catalog_entry(code);
    let outcome = if matches!(code, CatalogCode::ContractInvalid) {
        BackendOperationOutcome::Unknown
    } else {
        map_outcome(context.operation_outcome)
    };
    (entry, outcome)
}

fn map_outcome(outcome: AgentOperationOutcome) -> BackendOperationOutcome {
    match outcome {
        AgentOperationOutcome::NotStarted => BackendOperationOutcome::NotStarted,
        AgentOperationOutcome::Unknown => BackendOperationOutcome::Unknown,
    }
}

fn stage_param(entry: &'static CatalogEntry, stage: AgentErrorStage) -> BTreeMap<String, BackendMessageParam> {
    let mut params = BTreeMap::new();
    let value = BackendMessageParam::String(stage_name(stage).to_string());
    if entry.allows_value("stage", &value) {
        params.insert("stage".to_string(), value);
    }
    params
}

impl CatalogEntry {
    fn allows_value(self, name: &str, value: &BackendMessageParam) -> bool {
        self.params.iter().any(|param| param.name == name && param.kind == value.kind())
    }
}

impl BackendMessageParam {
    fn kind(&self) -> ParamKind {
        match self {
            Self::String(_) => ParamKind::String,
            Self::Integer(_) => ParamKind::Integer,
            Self::Boolean(_) => ParamKind::Boolean,
        }
    }
}

fn diagnostics_from_context(context: &AgentErrorContext) -> BackendErrorDiagnostics {
    BackendErrorDiagnostics {
        category: Some(category_name(context.category).to_string()),
        stage: Some(stage_name(context.stage).to_string()),
        sql_state: context.sql_state.as_deref().map(|value| bounded_ascii(value, 32)),
        vendor_code: context.vendor_code,
        exception_class: context.exception_class.as_deref().map(|value| bounded_ascii(value, 128)),
        ..Default::default()
    }
}

fn diagnostics_for_local(category: &str, stage: AgentErrorStage) -> BackendErrorDiagnostics {
    diagnostics_for_local_with_adapter_code(category, stage, "")
}

fn diagnostics_for_local_with_adapter_code(
    category: &str,
    stage: AgentErrorStage,
    adapter_code: &str,
) -> BackendErrorDiagnostics {
    BackendErrorDiagnostics {
        category: Some(category.to_string()),
        stage: Some(stage_name(stage).to_string()),
        adapter_code: (!adapter_code.is_empty()).then(|| bounded_ascii(adapter_code, 64)),
        ..Default::default()
    }
}

fn bounded_ascii(value: &str, max: usize) -> String {
    value.chars().filter(|ch| ch.is_ascii_graphic() || *ch == ' ').take(max).collect()
}

fn bounded_text(value: &str, max_bytes: usize) -> String {
    let end = value
        .char_indices()
        .map(|(index, ch)| (index, index + ch.len_utf8()))
        .take_while(|(_, next)| *next <= max_bytes)
        .map(|(_, next)| next)
        .last()
        .unwrap_or(0);
    value[..end].to_string()
}

fn bounded_detail(message: &str) -> Option<String> {
    if message.trim().is_empty() {
        return None;
    }
    let detail = safe_detail(message)?;
    let detail = bounded_text(&detail, MAX_DETAIL_BYTES);
    (!detail.is_empty()).then_some(detail)
}

fn bounded_native_detail(message: &str) -> Option<String> {
    // This path is only for typed native SQL failures. Do not infer or rewrite
    // SQL content here; preserving the driver's diagnostic is the contract.
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return None;
    }
    let detail = bounded_text(trimmed, MAX_DETAIL_BYTES);
    (!detail.is_empty()).then_some(detail)
}

fn safe_detail(message: &str) -> Option<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return None;
    }

    let detail = redact_session_identifier(&redact_sensitive_fragments(trimmed));
    if contains_only_redacted_sensitive_tokens(&detail) {
        return None;
    }
    (!detail.is_empty()).then_some(detail)
}

fn contains_only_redacted_sensitive_tokens(value: &str) -> bool {
    let mut has_token = false;
    let all_sensitive = value.split_whitespace().all(|token| {
        has_token = true;
        if token == "[redacted]" || matches!(token, "=" | ":") {
            return true;
        }
        let normalized = token.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '_' && ch != '-');
        if sensitive_key_name(normalized) {
            return true;
        }
        ['=', ':'].iter().any(|separator| {
            token.split_once(*separator).is_some_and(|(key, value)| {
                sensitive_key_name(key)
                    && value.trim_matches(|ch| matches!(ch, ';' | ',' | ']' | ')' | '}')) == "[redacted]"
            })
        })
    });
    has_token && all_sensitive
}

fn redact_sensitive_fragments(value: &str) -> String {
    let redacted_url = redact_url_userinfo(value);
    let mut redacted = String::with_capacity(redacted_url.len());
    let mut cursor = 0;
    while let Some((value_start, value_end)) = next_sensitive_assignment(&redacted_url, cursor) {
        redacted.push_str(&redacted_url[cursor..value_start]);
        redacted.push_str("[redacted]");
        cursor = value_end;
    }
    redacted.push_str(&redacted_url[cursor..]);
    let source_tokens = redacted.split_whitespace().collect::<Vec<_>>();
    let mut tokens = Vec::with_capacity(source_tokens.len());
    let mut redact_next = false;
    let mut changed = false;
    let mut index = 0;
    while index < source_tokens.len() {
        let token = source_tokens[index];
        if redact_next {
            tokens.push("[redacted]");
            redact_next = false;
            changed = true;
        } else if token.eq_ignore_ascii_case("bearer") {
            tokens.push("[redacted]");
            redact_next = true;
            changed = true;
        } else if token.eq_ignore_ascii_case("authorization:") && source_tokens.get(index + 1) == Some(&"[redacted]") {
            tokens.push("[redacted]");
            index += 1;
            changed = true;
        } else {
            tokens.push(token);
        }
        index += 1;
    }
    if changed {
        tokens.join(" ")
    } else {
        redacted
    }
}

fn redact_url_userinfo(value: &str) -> String {
    let mut ranges = Vec::new();
    let mut search_from = 0;
    while let Some(relative_scheme_end) = value[search_from..].find("://") {
        let authority_start = search_from + relative_scheme_end + "://".len();
        let authority_end = value[authority_start..]
            .char_indices()
            .find(|(_, ch)| matches!(ch, '/' | '?' | '#') || ch.is_ascii_whitespace())
            .map(|(offset, _)| authority_start + offset)
            .unwrap_or(value.len());
        let authority = &value[authority_start..authority_end];

        if let Some(user_info_end) = authority.rfind('@') {
            let user_info = &authority[..user_info_end];
            if let Some(password_separator) = user_info.find(':') {
                let password_start = authority_start + password_separator + 1;
                let password_end = authority_start + user_info_end;
                if password_start < password_end {
                    ranges.push((password_start, password_end));
                }
            }
        }

        if authority_end == value.len() {
            break;
        }
        search_from = authority_end;
    }

    if ranges.is_empty() {
        return value.to_string();
    }

    let mut redacted = String::with_capacity(value.len());
    let mut cursor = 0;
    for (start, end) in ranges {
        redacted.push_str(&value[cursor..start]);
        redacted.push_str("[redacted]");
        cursor = end;
    }
    redacted.push_str(&value[cursor..]);
    redacted
}

fn sensitive_key_name(key: &str) -> bool {
    let key = key.chars().filter(|ch| ch.is_ascii_alphanumeric()).map(|ch| ch.to_ascii_lowercase()).collect::<String>();
    matches!(
        key.as_str(),
        "password"
            | "passwd"
            | "pwd"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "secret"
            | "authorization"
            | "apikey"
            | "credential"
            | "auth"
            | "key"
            | "user"
            | "username"
            | "uid"
            | "accesskey"
            | "privatekey"
            | "session"
            | "sessionid"
            | "agentsessionid"
            | "jwt"
            | "cookie"
    )
}

fn next_sensitive_assignment(value: &str, from: usize) -> Option<(usize, usize)> {
    let mut index = from;
    while index < value.len() {
        let ch = value[index..].chars().next()?;
        if !is_sensitive_key_char(ch)
            || (index > 0 && value[..index].chars().next_back().is_some_and(is_sensitive_key_char))
        {
            index += ch.len_utf8();
            continue;
        }

        let key_start = index;
        let mut key_end = index;
        while key_end < value.len() {
            let key_char = value[key_end..].chars().next()?;
            if !is_sensitive_key_char(key_char) {
                break;
            }
            key_end += key_char.len_utf8();
        }
        if !sensitive_key_name(&value[key_start..key_end]) {
            index = key_end;
            continue;
        }

        let mut separator_start = key_end;
        if let Some(quote) = value[..key_start].chars().next_back().filter(|ch| matches!(ch, '\'' | '"')) {
            if value[separator_start..].starts_with(quote) {
                separator_start += quote.len_utf8();
            }
        }
        while separator_start < value.len()
            && value[separator_start..].chars().next().is_some_and(|ch| ch.is_ascii_whitespace())
        {
            separator_start += value[separator_start..].chars().next()?.len_utf8();
        }
        let separator = value[separator_start..].chars().next()?;
        if !matches!(separator, '=' | ':') {
            index = key_end;
            continue;
        }

        let mut value_start = separator_start + separator.len_utf8();
        while value_start < value.len()
            && value[value_start..].chars().next().is_some_and(|ch| ch.is_ascii_whitespace())
        {
            value_start += value[value_start..].chars().next()?.len_utf8();
        }
        let value_end = consume_sensitive_value(value, value_start, &value[key_start..key_end]);
        return Some((value_start, value_end));
    }
    None
}

fn is_sensitive_key_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-')
}

fn consume_sensitive_value(value: &str, start: usize, key: &str) -> usize {
    if start >= value.len() {
        return start;
    }
    let first = value[start..].chars().next().unwrap_or_default();
    if first == '{' {
        return consume_braced_value(value, start);
    }
    if matches!(first, '\'' | '"') {
        let mut escaped = false;
        let mut iter = value[start + first.len_utf8()..].char_indices();
        while let Some((offset, ch)) = iter.next() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == first {
                let end = start + first.len_utf8() + offset + ch.len_utf8();
                if value[end..].starts_with(first) {
                    iter.next();
                    continue;
                }
                return end;
            }
        }
        return value.len();
    }

    let mut end = start;
    while end < value.len() {
        let ch = value[end..].chars().next().unwrap_or_default();
        if ch.is_ascii_whitespace() || matches!(ch, '&' | ';' | ',' | ']' | ')' | '}') {
            break;
        }
        end += ch.len_utf8();
    }

    let normalized_key =
        key.chars().filter(|ch| ch.is_ascii_alphanumeric()).map(|ch| ch.to_ascii_lowercase()).collect::<String>();
    if normalized_key == "authorization" {
        let scheme = value[start..end].to_ascii_lowercase();
        if matches!(scheme.as_str(), "bearer" | "basic" | "digest") {
            let mut token_start = end;
            while token_start < value.len()
                && value[token_start..].chars().next().is_some_and(|ch| ch.is_ascii_whitespace())
            {
                token_start += value[token_start..].chars().next().unwrap().len_utf8();
            }
            let mut token_end = token_start;
            while token_end < value.len() {
                let ch = value[token_end..].chars().next().unwrap_or_default();
                if ch.is_ascii_whitespace() || matches!(ch, '&' | ';' | ',' | ']' | ')' | '}') {
                    break;
                }
                token_end += ch.len_utf8();
            }
            return token_end;
        }
    }
    end
}

fn consume_braced_value(value: &str, start: usize) -> usize {
    let mut index = start + '{'.len_utf8();
    while index < value.len() {
        let ch = value[index..].chars().next().unwrap_or_default();
        if ch == '}' {
            let next = index + ch.len_utf8();
            if value[next..].starts_with('}') {
                index = next + '}'.len_utf8();
                continue;
            }
            return next;
        }
        index += ch.len_utf8();
    }
    value.len()
}

fn redact_session_identifier(value: &str) -> String {
    let lowered = value.to_ascii_lowercase();
    for marker in ["session id", "session_id", "agentsessionid"] {
        if let Some(marker_start) = lowered.find(marker) {
            let value_start = value[marker_start + marker.len()..]
                .char_indices()
                .find(|(_, ch)| !ch.is_ascii_whitespace() && *ch != ':' && *ch != '=')
                .map(|(offset, _)| marker_start + marker.len() + offset);
            if let Some(value_start) = value_start {
                let value_end = value[value_start..]
                    .char_indices()
                    .find(|(_, ch)| ch.is_ascii_whitespace())
                    .map(|(offset, _)| value_start + offset)
                    .unwrap_or(value.len());
                let mut result = value.to_string();
                result.replace_range(value_start..value_end, "[redacted]");
                return result;
            }
        }
    }
    let Some(colon) = value.find(':') else {
        return value.to_string();
    };
    if !lowered[..colon].contains("session") {
        return value.to_string();
    }
    let value_start = value[colon + 1..]
        .char_indices()
        .find(|(_, ch)| !ch.is_ascii_whitespace())
        .map(|(offset, _)| colon + 1 + offset);
    let Some(value_start) = value_start else {
        return value.to_string();
    };
    let value_end = value[value_start..]
        .char_indices()
        .find(|(_, ch)| ch.is_ascii_whitespace())
        .map(|(offset, _)| value_start + offset)
        .unwrap_or(value.len());
    let mut result = value.to_string();
    result.replace_range(value_start..value_end, "[redacted]");
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agent_driver::{AgentErrorStage, AgentSessionDisposition};
    use std::collections::BTreeSet;

    fn context(
        category: AgentErrorCategory,
        stage: AgentErrorStage,
        outcome: AgentOperationOutcome,
    ) -> AgentErrorContext {
        AgentErrorContext {
            contract_version: 1,
            category,
            retryable: true,
            session_disposition: if matches!(category, AgentErrorCategory::Timeout | AgentErrorCategory::Canceled) {
                AgentSessionDisposition::Quarantine
            } else {
                AgentSessionDisposition::Keep
            },
            stage,
            operation_outcome: outcome,
            agent_session_id: Some("private-session".to_string()),
            sql_state: Some("08006".to_string()),
            vendor_code: Some(-7),
            exception_class: Some("java.sql.SQLException".to_string()),
        }
    }

    #[test]
    fn catalog_owns_exact_code_and_message_key_pairs() {
        let cases = [
            (CatalogCode::ConnectionFailed, "DBX-JDBC-1001", "backendErrors.jdbc.connectionFailed"),
            (CatalogCode::ConnectionInterrupted, "DBX-JDBC-1002", "backendErrors.jdbc.connectionInterrupted"),
            (CatalogCode::TimeoutNotStarted, "DBX-JDBC-2001", "backendErrors.jdbc.operationTimedOut"),
            (CatalogCode::TimeoutUnknown, "DBX-JDBC-2002", "backendErrors.jdbc.operationTimedOut"),
            (CatalogCode::Canceled, "DBX-JDBC-2003", "backendErrors.jdbc.operationCanceled"),
            (CatalogCode::BusyRetryLater, "DBX-JDBC-3001", "backendErrors.jdbc.busyRetryLater"),
            (CatalogCode::RuntimeReplaced, "DBX-JDBC-3002", "backendErrors.jdbc.runtimeReplaced"),
            (CatalogCode::SqlFailed, "DBX-JDBC-4001", "backendErrors.jdbc.sqlFailed"),
            (CatalogCode::ProtocolFailed, "DBX-JDBC-5001", "backendErrors.jdbc.protocolFailed"),
            (CatalogCode::ContractInvalid, "DBX-JDBC-5002", "backendErrors.jdbc.contractInvalid"),
            (CatalogCode::JdbcLegacyFailure, "DBX-JDBC-9001", "backendErrors.jdbc.legacyFailure"),
            (CatalogCode::LegacyBackend, "DBX-LEGACY-0001", "backendErrors.legacy"),
        ];
        let mut codes = BTreeSet::new();
        for (kind, expected_code, expected_key) in cases {
            let entry = catalog_entry(kind);
            assert_eq!(entry.code, expected_code);
            assert_eq!(entry.message_key, expected_key);
            assert!(codes.insert(entry.code), "duplicate catalog code: {}", entry.code);
        }
    }

    #[test]
    fn catalog_maps_valid_variants_and_emits_allowlisted_params() {
        let cases = [
            (
                AgentErrorCategory::Connection,
                AgentErrorStage::Request,
                AgentOperationOutcome::NotStarted,
                "DBX-JDBC-1001",
            ),
            (AgentErrorCategory::Connection, AgentErrorStage::Execute, AgentOperationOutcome::Unknown, "DBX-JDBC-1002"),
            (AgentErrorCategory::Timeout, AgentErrorStage::Connect, AgentOperationOutcome::NotStarted, "DBX-JDBC-2001"),
            (AgentErrorCategory::Timeout, AgentErrorStage::Execute, AgentOperationOutcome::Unknown, "DBX-JDBC-2002"),
            (AgentErrorCategory::Canceled, AgentErrorStage::Cancel, AgentOperationOutcome::Unknown, "DBX-JDBC-2003"),
            (
                AgentErrorCategory::Resource,
                AgentErrorStage::Request,
                AgentOperationOutcome::NotStarted,
                "DBX-JDBC-3001",
            ),
            (AgentErrorCategory::Resource, AgentErrorStage::Execute, AgentOperationOutcome::Unknown, "DBX-JDBC-5002"),
            (AgentErrorCategory::Sql, AgentErrorStage::Execute, AgentOperationOutcome::Unknown, "DBX-JDBC-4001"),
            (AgentErrorCategory::Protocol, AgentErrorStage::Request, AgentOperationOutcome::Unknown, "DBX-JDBC-5002"),
        ];
        for (category, stage, outcome, expected_code) in cases {
            let error = AgentCallError::Structured {
                rpc_code: -1,
                message: "safe failure".to_string(),
                context: context(category, stage, outcome),
            };
            let envelope = BackendError::from_agent_call_error(&error);
            assert_eq!(envelope.code(), expected_code);
            assert_eq!(envelope.version(), 1);
            if expected_code != "DBX-JDBC-5002" {
                assert_eq!(
                    envelope.message_params().get("stage"),
                    Some(&BackendMessageParam::String(stage_name(stage).to_string()))
                );
            }
        }
    }

    #[test]
    fn sql_errors_expose_generic_database_origin_without_changing_v1_source() {
        let payload =
            serde_json::to_value(BackendError::from_sql_detail("relation missing_table does not exist")).unwrap();
        assert_eq!(payload["source"], "jdbcAgent");
        assert_eq!(payload["origin"]["subsystem"], "database");
        assert_eq!(payload["origin"]["adapter"], "native");
    }

    #[test]
    fn duckdb_worker_sql_error_preserves_worker_code_detail_and_driver_origin() {
        let payload = serde_json::to_value(BackendError::from_duckdb_worker_error(
            "duckdb_execute_failed",
            "Parser Error: syntax error at or near SELECT",
        ))
        .unwrap();

        assert_eq!(payload["code"], "DBX-JDBC-4001");
        assert_eq!(payload["detail"], "Parser Error: syntax error at or near SELECT");
        assert_eq!(payload["origin"]["subsystem"], "database");
        assert_eq!(payload["origin"]["adapter"], "native");
        assert_eq!(payload["origin"]["driver"], "duckdb");
        assert_eq!(payload["diagnostics"]["adapterCode"], "duckdb_execute_failed");
    }

    #[test]
    fn public_detail_redacts_credentials_and_preserves_native_sql_text() {
        for (message, expected) in [
            ("Incorrect syntax near SELECT", "Incorrect syntax near SELECT"),
            ("ERROR: relation missing_table does not exist", "ERROR: relation missing_table does not exist"),
            ("ORA-00942: table or view does not exist", "ORA-00942: table or view does not exist"),
            (
                "syntax error in statement [UPDATE customers SET ssn='123']",
                "syntax error in statement [UPDATE customers SET ssn='123']",
            ),
            (
                "syntax error at or near 'SELECT email FROM customers WHERE ssn = 123'",
                "syntax error at or near 'SELECT email FROM customers WHERE ssn = 123'",
            ),
            (
                "failed executing SELECT * FROM [Users] WHERE email='literal-secret@example.com'",
                "failed executing SELECT * FROM [Users] WHERE email='literal-secret@example.com'",
            ),
            (
                "connection failed: jdbc:postgresql://host/db?user=alice&password=secret",
                "connection failed: jdbc:postgresql://host/db?user=[redacted]&password=[redacted]",
            ),
            ("connection failed: Authorization: Bearer abc123", "connection failed: [redacted]"),
            ("Agent session not found: 7f51e7f4-7cee-42db-bfeb-76d1199d1afe", "Agent session not found: [redacted]"),
            ("Agent session id private-session", "Agent session id [redacted]"),
        ] {
            assert_eq!(bounded_detail(message).as_deref(), Some(expected), "detail changed unexpectedly: {message}");
        }
        for message in ["DROP TABLE users", "SELECT password FROM users", "CALL refresh_cache()"] {
            assert_eq!(bounded_detail(message).as_deref(), Some(message));
        }
        for message in
            ["Bearer token-value", "Authorization: Bearer token-value", "password = secret", "password: secret"]
        {
            assert!(bounded_detail(message).is_none(), "credential detail leaked: {message}");
        }
        let error = BackendError::from_agent_call_error(&AgentCallError::Structured {
            rpc_code: -1,
            message: "jdbc:postgresql://host/db?password=secret".to_string(),
            context: context(
                AgentErrorCategory::Connection,
                AgentErrorStage::Request,
                AgentOperationOutcome::NotStarted,
            ),
        });
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["source"], "jdbcAgent");
        assert!(value.get("retryable").is_none());
        assert!(value.get("sessionDisposition").is_none());
        assert!(value.get("agentSessionId").is_none());
        assert_eq!(value["detail"], "jdbc:postgresql://host/db?password=[redacted]");
    }

    #[test]
    fn public_detail_redacts_sensitive_key_value_variants() {
        let message = concat!(
            "driver failed: PASSWORD:secret-a passwd = 'secret-b' PWD : \"secret-c\" ",
            "refresh_token=secret-d access-token : secret-e api_key='secret-f' ",
            "apikey : secret-g credential=secret-h private-key:secret-i ",
            "authorization: Bearer secret-j cookie = \"session=secret-k\" ",
            "sessionid:secret-l jwt = secret-m secret:secret-n token = secret-o ",
            "access_token:secret-p session=secret-q private_key='secret-r'"
        );

        let detail = bounded_detail(message).expect("non-sensitive context should remain");
        for secret in [
            "secret-a", "secret-b", "secret-c", "secret-d", "secret-e", "secret-f", "secret-g", "secret-h", "secret-i",
            "secret-j", "secret-k", "secret-l", "secret-m", "secret-n", "secret-o", "secret-p", "secret-q", "secret-r",
        ] {
            assert!(!detail.contains(secret), "sensitive value leaked: {secret}; detail={detail}");
        }
        assert!(detail.contains("driver failed"));
    }

    #[test]
    fn public_detail_redacts_mixed_url_and_dsn_sensitive_fields() {
        let message = concat!(
            "connection failed for jdbc:postgresql://db.example/app?user=alice&password : url-secret&sslmode=require ",
            "host=db.example port=5432 password:\"dsn secret\" session = 'session-secret'"
        );

        let detail = bounded_detail(message).expect("non-sensitive context should remain");
        for secret in ["alice", "url-secret", "dsn secret", "session-secret"] {
            assert!(!detail.contains(secret), "sensitive value leaked: {secret}; detail={detail}");
        }
        assert!(detail.contains("connection failed"));
    }

    #[test]
    fn serialized_native_sql_detail_preserves_url_like_text_and_braced_literals() {
        let cases = [
            (
                "syntax error in statement [SELECT 'jdbc:postgresql://alice:url-secret@db.example/app']",
                "syntax error in statement [SELECT 'jdbc:postgresql://alice:url-secret@db.example/app']",
            ),
            (
                "syntax error in statement [SELECT 'Driver={PostgreSQL};PWD={dsn;secret};SERVER=db.example']",
                "syntax error in statement [SELECT 'Driver={PostgreSQL};PWD={dsn;secret};SERVER=db.example']",
            ),
        ];

        for (message, expected) in cases {
            let payload = serde_json::to_value(BackendError::from_sql_detail(message)).unwrap();
            assert_eq!(payload["detail"].as_str(), Some(expected), "detail changed unexpectedly: {message}");
        }
    }

    #[test]
    fn serialized_public_detail_preserves_nested_sql_and_literals() {
        let message = "syntax error in statement [SELECT * FROM [Users] WHERE email='literal-secret@example.com']";
        let payload = serde_json::to_value(BackendError::from_sql_detail(message)).unwrap();

        assert_eq!(payload["detail"].as_str(), Some(message));
    }

    #[test]
    fn structured_connection_detail_still_redacts_credentials() {
        let error = BackendError::from_agent_call_error(&AgentCallError::Structured {
            rpc_code: -1,
            message: "connection failed: jdbc:postgresql://alice:url-secret@db.example/app".to_string(),
            context: context(
                AgentErrorCategory::Connection,
                AgentErrorStage::Connect,
                AgentOperationOutcome::NotStarted,
            ),
        });

        assert_eq!(error.detail(), Some("connection failed: jdbc:postgresql://alice:[redacted]@db.example/app"));
    }

    #[test]
    fn structured_sql_detail_preserves_native_text() {
        let message = "syntax error in statement [UPDATE users SET password='user-input']";
        let error = BackendError::from_agent_call_error(&AgentCallError::Structured {
            rpc_code: -1,
            message: message.to_string(),
            context: context(AgentErrorCategory::Sql, AgentErrorStage::Execute, AgentOperationOutcome::Unknown),
        });

        assert_eq!(error.detail(), Some(message));
    }

    #[test]
    fn bounded_detail_remains_bounded_after_redaction() {
        let detail = bounded_detail(&format!("ERROR: {}", "x".repeat(MAX_DETAIL_BYTES + 100))).unwrap();
        assert!(detail.len() > 512);
        assert!(detail.len() <= MAX_DETAIL_BYTES);
        assert!(detail.is_char_boundary(MAX_DETAIL_BYTES));
    }

    #[test]
    fn invalid_structured_combinations_use_contract_catalog_code() {
        let invalid = [
            (
                AgentErrorCategory::Timeout,
                AgentErrorStage::Request,
                AgentOperationOutcome::Unknown,
                AgentSessionDisposition::Keep,
            ),
            (
                AgentErrorCategory::Protocol,
                AgentErrorStage::Request,
                AgentOperationOutcome::NotStarted,
                AgentSessionDisposition::ReplaceRuntime,
            ),
            (
                AgentErrorCategory::Resource,
                AgentErrorStage::Execute,
                AgentOperationOutcome::Unknown,
                AgentSessionDisposition::Keep,
            ),
            (
                AgentErrorCategory::Sql,
                AgentErrorStage::Connect,
                AgentOperationOutcome::NotStarted,
                AgentSessionDisposition::Keep,
            ),
        ];
        for (category, stage, outcome, disposition) in invalid {
            let mut ctx = context(category, stage, outcome);
            ctx.session_disposition = disposition;
            let envelope = BackendError::from_agent_call_error(&AgentCallError::Structured {
                rpc_code: -1,
                message: "invalid combination".to_string(),
                context: ctx,
            });
            assert_eq!(envelope.code(), "DBX-JDBC-5002");
            assert_eq!(envelope.operation_outcome(), BackendOperationOutcome::Unknown);
        }
    }

    #[test]
    fn legacy_adapters_use_stable_sources() {
        let legacy = BackendError::from_agent_call_error(&AgentCallError::Legacy {
            rpc_code: None,
            message: "old agent".to_string(),
            hints: Default::default(),
        });
        assert_eq!(legacy.code(), "DBX-JDBC-9001");
        assert_eq!(legacy.source, BackendErrorSource::JdbcAgentLegacy);
        assert_eq!(BackendError::from_legacy_backend("driver failed").code(), "DBX-LEGACY-0001");
    }

    #[test]
    fn legacy_agent_envelope_keeps_multiline_database_detail() {
        let legacy = AgentCallError::Legacy {
            rpc_code: Some(-1),
            message: "ERROR: relation \"dbx_table_that_does_not_exist\" does not exist\n  Position: 15".to_string(),
            hints: Default::default(),
        }
        .into_legacy_string();
        let error = BackendError::from_legacy_string(&legacy);

        assert_eq!(error.code(), "DBX-JDBC-9001");
        assert_eq!(
            error.detail(),
            Some("ERROR: relation \"dbx_table_that_does_not_exist\" does not exist\n  Position: 15")
        );
    }

    #[test]
    fn legacy_agent_envelope_keeps_dm_chinese_database_detail() {
        let legacy = AgentCallError::Legacy {
            rpc_code: Some(-1),
            message: "无效的表或视图名\n错误码: -2106".to_string(),
            hints: Default::default(),
        }
        .into_legacy_string();
        let error = BackendError::from_legacy_string(&legacy);

        assert_eq!(error.code(), "DBX-JDBC-9001");
        assert_eq!(error.detail(), Some("无效的表或视图名\n错误码: -2106"));
    }

    #[test]
    fn strict_marker_round_trip_keeps_catalog_code() {
        let error = AgentCallError::Structured {
            rpc_code: -1,
            message: "connection lost".to_string(),
            context: context(AgentErrorCategory::Connection, AgentErrorStage::Execute, AgentOperationOutcome::Unknown),
        };
        let legacy =
            crate::db::agent_driver::append_legacy_error_context(&error.into_legacy_string(), "SQL text omitted");

        assert_eq!(BackendError::from_legacy_string(&legacy).code(), "DBX-JDBC-1002");
    }
}
