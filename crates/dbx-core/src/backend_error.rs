//! Stable, safe backend error envelopes and the v1 JDBC Agent catalog.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::db::agent_driver::{
    category_name, stage_name, valid_agent_error_combination, AgentCallError, AgentErrorCategory, AgentErrorContext,
    AgentErrorStage, AgentOperationOutcome, AgentSessionDisposition,
};

const MAX_DETAIL_BYTES: usize = 512;

/// The origin of a backend error as exposed on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackendErrorSource {
    JdbcAgent,
    JdbcAgentLegacy,
    LegacyBackend,
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
                Self::new(
                    entry,
                    BackendErrorSource::JdbcAgent,
                    outcome,
                    stage_param(entry, context.stage),
                    safe_detail(message),
                    Some(diagnostics_from_context(context)),
                )
            }
            AgentCallError::Legacy { message, .. } => Self::new(
                catalog_entry(CatalogCode::JdbcLegacyFailure),
                BackendErrorSource::JdbcAgentLegacy,
                BackendOperationOutcome::Unknown,
                BTreeMap::new(),
                safe_detail(message),
                None,
            ),
            AgentCallError::ContractViolation { message, .. } => Self::new(
                catalog_entry(CatalogCode::ContractInvalid),
                BackendErrorSource::JdbcAgent,
                BackendOperationOutcome::Unknown,
                BTreeMap::new(),
                safe_detail(message),
                None,
            ),
            AgentCallError::Transport { message } => Self::new(
                catalog_entry(CatalogCode::ProtocolFailed),
                BackendErrorSource::JdbcAgent,
                BackendOperationOutcome::Unknown,
                BTreeMap::new(),
                safe_detail(message),
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
                    map_outcome(*operation_outcome),
                    stage_param(entry, *stage),
                    None,
                    Some(diagnostics_for_local("timeout", *stage)),
                )
            }
            AgentCallError::Canceled { stage, operation_outcome } => Self::new(
                catalog_entry(CatalogCode::Canceled),
                BackendErrorSource::JdbcAgent,
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
            BackendOperationOutcome::Unknown,
            BTreeMap::new(),
            safe_detail(message),
            None,
        )
    }

    /// Create a timeout envelope while retaining the bounded diagnostic detail.
    pub fn from_timeout_detail(message: &str) -> Self {
        let entry = catalog_entry(CatalogCode::TimeoutUnknown);
        Self::new(
            entry,
            BackendErrorSource::JdbcAgent,
            BackendOperationOutcome::Unknown,
            stage_param(entry, AgentErrorStage::Execute),
            safe_detail(message),
            Some(diagnostics_for_local("timeout", AgentErrorStage::Execute)),
        )
    }

    /// Create a SQL failure envelope while retaining the bounded diagnostic detail.
    pub fn from_sql_detail(message: &str) -> Self {
        let entry = catalog_entry(CatalogCode::SqlFailed);
        Self::new(
            entry,
            BackendErrorSource::JdbcAgent,
            BackendOperationOutcome::Unknown,
            stage_param(entry, AgentErrorStage::Execute),
            safe_detail(message),
            Some(diagnostics_for_local("sql", AgentErrorStage::Execute)),
        )
    }

    /// Create a cancellation envelope for work canceled by the Rust executor.
    pub fn from_canceled(stage: AgentErrorStage, operation_outcome: AgentOperationOutcome) -> Self {
        let entry = catalog_entry(CatalogCode::Canceled);
        Self::new(
            entry,
            BackendErrorSource::LegacyBackend,
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
    }
}

fn diagnostics_for_local(category: &str, stage: AgentErrorStage) -> BackendErrorDiagnostics {
    BackendErrorDiagnostics {
        category: Some(category.to_string()),
        stage: Some(stage_name(stage).to_string()),
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

fn safe_detail(message: &str) -> Option<String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.split_ascii_whitespace().collect::<Vec<_>>().join(" ");
    let lowered = normalized.to_ascii_lowercase();
    let sensitive_markers = [
        "://",
        "jdbc:",
        "password",
        "passwd",
        "pwd",
        "token",
        "secret",
        "authorization",
        "bearer",
        "api_key",
        "apikey",
        "credential",
        "auth=",
        "key=",
        "user=",
        "username=",
        "uid=",
        "access_key",
        "private_key",
        "agent session",
        "agentsessionid",
        "session id",
        "session_id",
        "session=",
    ];
    if sensitive_markers.iter().any(|marker| lowered.contains(marker)) {
        return None;
    }
    let sql_verbs = [
        "select", "insert", "update", "delete", "drop", "create", "alter", "truncate", "merge", "call", "with",
        "grant", "revoke", "comment", "explain", "begin", "commit", "rollback",
    ];
    if lowered.split(|ch: char| !ch.is_ascii_alphabetic()).any(|word| sql_verbs.contains(&word)) {
        return None;
    }
    let detail = bounded_text(&normalized, MAX_DETAIL_BYTES);
    (!detail.is_empty()).then_some(detail)
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
    fn unsafe_detail_is_omitted_and_internal_fields_are_not_serialized() {
        for message in [
            "DROP TABLE users",
            "SELECT\tpassword FROM users",
            "postgresql://host/db?user=alice&pwd=secret",
            "Bearer token-value",
            "CALL refresh_cache()",
            "syntax error in statement [UPDATE customers SET ssn='123']",
            "Agent session not found: 7f51e7f4-7cee-42db-bfeb-76d1199d1afe",
        ] {
            assert!(safe_detail(message).is_none(), "detail leaked: {message}");
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
        assert!(value.get("detail").is_none());
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
            Some("ERROR: relation \"dbx_table_that_does_not_exist\" does not exist Position: 15")
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
        assert_eq!(error.detail(), Some("无效的表或视图名 错误码: -2106"));
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
