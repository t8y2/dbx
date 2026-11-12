use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeJobEngine {
    Oracle,
    OceanbaseOracle,
    Dameng,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeJobKind {
    Scheduler,
    Legacy,
    DamengNative,
}

pub type NativeJobRow = BTreeMap<String, serde_json::Value>;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobScope {
    pub connection_id: String,
    pub database: String,
    pub context_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum NativeJobRef {
    Scheduler {
        scope: NativeJobScope,
        owner: String,
        name: String,
    },
    Legacy {
        scope: NativeJobScope,
        #[serde(rename = "jobId")]
        job_id: String,
    },
    DamengNative {
        scope: NativeJobScope,
        #[serde(rename = "jobId")]
        job_id: String,
        name: String,
    },
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum NativeJobMetadata<T> {
    Available { value: T },
    Truncated { value: T, limit: usize },
    Empty,
    Denied { reason: String },
    Unsupported { reason: String },
    Error { reason: String },
    Unknown { reason: String },
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeJobArgumentValue {
    Unset,
    Inherit,
    Null,
    Value { value: serde_json::Value },
    Opaque { value: serde_json::Value },
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobArgument {
    pub position: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub data_type: String,
    pub value: NativeJobArgumentValue,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<NativeJobMetadata<NativeJobArgumentValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata_attribute: Option<String>,
    pub editable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// Definitions and argument values deliberately do not implement Debug.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeJobSnapshot {
    #[serde(rename = "ref")]
    pub job_ref: NativeJobRef,
    pub revision: String,
    pub definition: NativeJobMetadata<BTreeMap<String, serde_json::Value>>,
    pub arguments: NativeJobMetadata<Vec<NativeJobArgument>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobContext {
    pub scope: NativeJobScope,
    pub engine: NativeJobEngine,
    pub session_user: String,
    pub actual_database: Option<String>,
    pub product_version: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeJobCatalogCoverage {
    Database,
    Accessible,
    CurrentUser,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct NativeJobCatalogSource {
    pub source: Option<String>,
    pub coverage: Option<NativeJobCatalogCoverage>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobSummary {
    #[serde(rename = "ref")]
    pub job_ref: NativeJobRef,
    pub name: String,
    pub owner: Option<String>,
    pub enabled: Option<bool>,
    pub job_type: Option<String>,
    pub state: Option<String>,
    pub next_run: Option<serde_json::Value>,
    pub comments: Option<String>,
    pub aliases: Vec<NativeJobRef>,
    pub log_user: Option<String>,
    pub priv_user: Option<String>,
    pub schema_user: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobList {
    pub jobs: NativeJobMetadata<Vec<NativeJobSummary>>,
    pub source: NativeJobCatalogSource,
    pub offset: usize,
    pub limit: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobListRequest {
    pub scope: NativeJobScope,
    pub kind: NativeJobKind,
    pub schema: Option<String>,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "native_job_page_size")]
    pub limit: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeJobReferenceKind {
    Program,
    ProgramArguments,
    Schedule,
    Chain,
    Credential,
    Destination,
    Window,
    WindowGroup,
    FileWatcher,
    DestinationGroup,
    DestinationGroupMembers,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobReferenceListRequest {
    pub scope: NativeJobScope,
    pub kind: NativeJobReferenceKind,
    pub schema: Option<String>,
    pub name: Option<String>,
    #[serde(default)]
    pub filter: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "native_job_page_size")]
    pub limit: usize,
}

// Program actions and defaults stay outside diagnostic Debug, like Job definitions.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobReferenceCatalog {
    pub objects: NativeJobMetadata<Vec<NativeJobRow>>,
    pub source: NativeJobCatalogSource,
    pub offset: usize,
    pub limit: usize,
}

fn native_job_page_size() -> usize {
    100
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeJobFieldChange {
    Keep,
    Set { value: serde_json::Value },
    Clear,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeJobAttributeChange {
    pub name: String,
    pub change: NativeJobFieldChange,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeJobArgumentChange {
    pub position: usize,
    pub value: NativeJobArgumentValue,
}

// The COMMAND_INPUT field is the native configuration input, not a generated catalog COMMAND.
// Keep bodies and parameter values outside Debug, including children retained in a preview.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NativeJobDamengChildChange {
    Add {
        name: String,
        #[serde(default)]
        attributes: Vec<NativeJobAttributeChange>,
    },
    Update {
        name: String,
        #[serde(default)]
        attributes: Vec<NativeJobAttributeChange>,
    },
    Drop {
        name: String,
    },
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobDamengConfiguration {
    #[serde(default)]
    pub attributes: Vec<NativeJobAttributeChange>,
    #[serde(default)]
    pub steps: Vec<NativeJobDamengChildChange>,
    #[serde(default)]
    pub schedules: Vec<NativeJobDamengChildChange>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum NativeJobChange {
    Update {
        #[serde(default, rename = "finalEnabled", skip_serializing_if = "Option::is_none")]
        final_enabled: Option<bool>,
        #[serde(default, rename = "argumentTarget", skip_serializing_if = "Option::is_none")]
        argument_target: Option<NativeJobArgumentTarget>,
        #[serde(default)]
        attributes: Vec<NativeJobAttributeChange>,
        #[serde(default)]
        arguments: Vec<NativeJobArgumentChange>,
    },
    ConfigureDameng {
        configuration: NativeJobDamengConfiguration,
    },
    Enable,
    Disable,
    Run,
    Stop {
        #[serde(default)]
        force: bool,
    },
    Drop {
        #[serde(default)]
        force: bool,
    },
    ClearHistory,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeJobMutation {
    pub target: NativeJobRef,
    pub baseline: String,
    #[serde(flatten)]
    pub change: NativeJobChange,
}

// Bodies remain outside Debug, including creation and the retained immutable request.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobLegacyCreate {
    pub what: String,
    pub next_date: String,
    pub interval: String,
    pub enabled: bool,
    #[serde(default)]
    pub instance: i64,
    #[serde(default)]
    pub schema: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zone: Option<String>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeJobObjectReference {
    pub owner: String,
    pub name: String,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobCreateArgument {
    pub position: usize,
    pub data_type: String,
    pub value: NativeJobArgumentValue,
}

/// A complete replacement context, retained across partial conversions. Ordinary argument edits
/// continue to use their original delta contract.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobArgumentTarget {
    pub program: Option<NativeJobObjectReference>,
    pub arguments: Vec<NativeJobCreateArgument>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum NativeJobEventSource {
    Queue {
        owner: String,
        name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
    },
    FileWatcher {
        reference: NativeJobObjectReference,
    },
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobSchedulerCreate {
    pub owner: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<NativeJobObjectReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_action: Option<String>,
    #[serde(default)]
    pub number_of_arguments: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<NativeJobObjectReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_interval: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_source: Option<NativeJobEventSource>,
    pub enabled: bool,
    #[serde(default = "native_job_auto_drop_default")]
    pub auto_drop: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_class: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_style: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attributes: Vec<NativeJobAttributeChange>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub arguments: Vec<NativeJobCreateArgument>,
}

fn native_job_auto_drop_default() -> bool {
    true
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct NativeJobDamengCreate {
    pub name: String,
    pub enabled: bool,
    pub configuration: NativeJobDamengConfiguration,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum NativeJobCreateDefinition {
    Legacy(NativeJobLegacyCreate),
    Scheduler(Box<NativeJobSchedulerCreate>),
    DamengNative(NativeJobDamengCreate),
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum NativeJobRequest {
    Create {
        scope: NativeJobScope,
        definition: NativeJobCreateDefinition,
    },
    #[serde(untagged)]
    Mutation(NativeJobMutation),
}

impl From<NativeJobMutation> for NativeJobRequest {
    fn from(mutation: NativeJobMutation) -> Self {
        Self::Mutation(mutation)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeJobLegacyPhase {
    NotStarted,
    Submitting,
    Configuring,
    Prepared,
    CommitSent,
    Committed,
    RolledBack,
    Unknown,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobLegacyReceipt {
    pub operation_id: String,
    pub phase: NativeJobLegacyPhase,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub vendor_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disposal_confirmed: Option<bool>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct NativeJobStepPreview {
    pub id: String,
    pub label: String,
    pub sql: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobPreparedPlan {
    pub plan_id: String,
    pub operation_id: String,
    pub scope: NativeJobScope,
    /// A traditional job has no native ID until SUBMIT returns; never invent one for preview.
    pub target: Option<NativeJobRef>,
    pub steps: Vec<NativeJobStepPreview>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeJobOperationState {
    Prepared,
    Queued,
    Running,
    Finished,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeJobOperationOutcome {
    NotStarted,
    NotApplied,
    Partial,
    Unknown,
    Verified,
    Accepted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeJobStepState {
    Pending,
    Dispatching,
    Applied,
    Accepted,
    Failed,
    Unknown,
    Skipped,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobStepStatus {
    pub id: String,
    pub state: NativeJobStepState,
    pub reason: Option<String>,
    pub vendor_code: Option<i32>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobDamengCreatedChild {
    pub partition: String,
    pub name: String,
    pub id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobOperationStatus {
    pub operation_id: String,
    pub target: Option<NativeJobRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_identity: Option<NativeJobRow>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub created_children: Vec<NativeJobDamengCreatedChild>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_observation: Option<NativeJobExecutionObservation>,
    pub state: NativeJobOperationState,
    pub outcome: NativeJobOperationOutcome,
    pub cancel_requested: bool,
    pub steps: Vec<NativeJobStepStatus>,
    pub reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobExecutionObservation {
    pub observed_at: String,
    pub association: String,
    pub reason: String,
    pub running: NativeJobMetadata<Vec<NativeJobRow>>,
    pub history: NativeJobMetadata<Vec<NativeJobRow>>,
    pub sources: BTreeMap<String, NativeJobCatalogSource>,
    pub candidates: Vec<NativeJobExecutionCandidate>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobExecutionCandidate {
    pub native_key: String,
    pub phase: String,
    pub evidence: String,
    pub row: NativeJobRow,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeJobDetails {
    pub snapshot: NativeJobSnapshot,
    pub native_identity: NativeJobMetadata<NativeJobRow>,
    pub consistency: NativeJobMetadata<()>,
    pub parameter_metadata: NativeJobMetadata<Vec<NativeJobRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<NativeJobMetadata<NativeJobRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program_arguments: Option<NativeJobMetadata<Vec<NativeJobRow>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_definition: Option<NativeJobMetadata<NativeJobRow>>,
    pub steps: NativeJobMetadata<Vec<NativeJobRow>>,
    pub schedules: NativeJobMetadata<Vec<NativeJobRow>>,
    pub running: NativeJobMetadata<Vec<NativeJobRow>>,
    pub history: NativeJobMetadata<Vec<NativeJobRow>>,
    pub sources: BTreeMap<String, NativeJobCatalogSource>,
}

impl NativeJobScope {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !valid_identity_part(&self.connection_id)
            || !valid_identity_part(&self.context_id)
            || self.database.contains('\0')
        {
            return Err("native_job_identity_invalid");
        }
        Ok(())
    }
}

impl NativeJobRef {
    pub fn scope(&self) -> &NativeJobScope {
        match self {
            Self::Scheduler { scope, .. } | Self::Legacy { scope, .. } | Self::DamengNative { scope, .. } => scope,
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        self.scope().validate()?;
        match self {
            Self::Scheduler { owner, name, .. } => {
                if !valid_identity_part(owner) || !valid_identity_part(name) {
                    return Err("native_job_identity_invalid");
                }
            }
            Self::Legacy { job_id, .. } | Self::DamengNative { job_id, .. } => {
                if job_id.starts_with('0') || job_id.is_empty() || !job_id.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err("native_job_id_invalid");
                }
                if let Self::DamengNative { name, .. } = self {
                    if !valid_identity_part(name) {
                        return Err("native_job_identity_invalid");
                    }
                }
            }
        }
        Ok(())
    }
}

fn valid_identity_part(value: &str) -> bool {
    !value.is_empty() && !value.contains('\0')
}
