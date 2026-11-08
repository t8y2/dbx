//! Complete, identity-bound routine reads for schema comparison and write readback.
//! Ordinary object lists keep their existing visibility and source contracts.

use super::{agent_metadata_timeout, connection_config, is_oracle_external_driver_config, managed_object_source};
use crate::connection::{AppState, PoolKind};
use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::query::{agent_execute_query_params, QueryExecutionOptions};
use dbx_sql::object_source_sql::{validate_oracle_executable_object_source, OracleObjectSourceValidationInput};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

const PAGE_SIZE: usize = 256;

mod execution;
mod transfer;
pub(crate) use transfer::{
    capture_routine_transfer_context, claim_transfer_packages, prepare_transfer_packages, transfer_oracle_routine_core,
    PackageTransferPreflightError, RoutineTransferContext, RoutineTransferInput,
};
pub use transfer::{OraclePackageTransferPreview, OraclePackageTransferRequest};
mod operations;
mod plan;
mod readback;
mod references;
pub use execution::{
    execute_oracle_routine_operation_core, observe_oracle_routine_operation_core, prepare_oracle_routine_save_core,
    OracleRoutineSaveInput,
};
pub use operations::{
    RoutineOperationLifecycle, RoutineOperationObservation, RoutineOperationRecord, RoutineOperationRegistry,
};
pub use plan::{
    prepare_oracle_routine_plan_core, prepare_oracle_routine_recovery_core, OracleRoutinePlan, OracleRoutinePlanInput,
    OracleRoutinePlanStep, PackageBodySource, PackageContractChoice, PackageGrant, PackageGrantSnapshot,
    PackagePlanImpact, RoutinePlanAction, RoutinePlanDraft,
};
pub use readback::{
    read_oracle_routine_core, RoutineCompilerMessage, RoutineReadback, RoutineReadbackGoal, RoutineReadbackState,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineEndpoint {
    pub connection_id: String,
    pub database: String,
    pub schema: String,
    pub database_type: DatabaseType,
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineIdentity {
    pub owner: String,
    pub name: String,
    pub kind: db::ObjectSourceKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSelection {
    pub name: String,
    pub kind: db::ObjectSourceKind,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineReadOptions {
    pub object_kinds: Option<Vec<db::ObjectSourceKind>>,
    pub selected_objects: Option<Vec<RoutineSelection>>,
    pub selected_routines: Option<Vec<String>>,
}

impl RoutineReadOptions {
    fn kinds(&self) -> &[db::ObjectSourceKind] {
        self.object_kinds.as_deref().unwrap_or(&[db::ObjectSourceKind::Procedure, db::ObjectSourceKind::Function])
    }

    fn inventory_kinds(&self) -> Vec<db::ObjectSourceKind> {
        let mut kinds = self.kinds().to_vec();
        if kinds.iter().any(|kind| matches!(kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody)) {
            for kind in [db::ObjectSourceKind::Package, db::ObjectSourceKind::PackageBody] {
                if !kinds.contains(&kind) {
                    kinds.push(kind);
                }
            }
        }
        kinds
    }

    fn validate(&self) -> Result<(), String> {
        if self.kinds().iter().any(|kind| {
            !matches!(
                kind,
                db::ObjectSourceKind::Procedure
                    | db::ObjectSourceKind::Function
                    | db::ObjectSourceKind::Package
                    | db::ObjectSourceKind::PackageBody
            )
        }) {
            return Err("Strict program inventory supports only procedures, functions and packages".into());
        }
        if self.selected_routines.is_some()
            && (self.selected_objects.is_some()
                || self
                    .kinds()
                    .iter()
                    .any(|kind| matches!(kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody)))
        {
            return Err("Package selection requires exact selected objects instead of legacy routine names".into());
        }
        if self.selected_objects.as_ref().is_some_and(|objects| {
            objects.iter().any(|object| object.name.is_empty() || !self.kinds().contains(&object.kind))
        }) {
            return Err("Selected program identities must belong to the requested object kinds".into());
        }
        Ok(())
    }

    fn reads(&self, identity: &RoutineIdentity) -> bool {
        if let Some(objects) = &self.selected_objects {
            return objects.iter().any(|object| object.name == identity.name);
        }
        self.selected_routines.as_ref().is_none_or(|names| names.contains(&identity.name))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineVersion {
    pub identity: RoutineIdentity,
    // Decimal strings preserve Oracle NUMBER identities across JS transports.
    pub object_id: String,
    pub status: String,
    pub last_ddl_time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineDependency {
    pub owner: String,
    pub name: String,
    pub kind: String,
    pub database_link: Option<String>,
    pub dependency_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineReadIssue {
    pub stage: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoutineReadState {
    Complete,
    Partial,
    Failed,
    PermissionDenied,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineObjectSnapshot {
    pub version: RoutineVersion,
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_origin: Option<SourceOrigin>,
    pub source_complete: bool,
    pub dependencies: Vec<RoutineDependency>,
    pub dependencies_complete: bool,
    pub issues: Vec<RoutineReadIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSnapshot {
    pub endpoint: RoutineEndpoint,
    pub state: RoutineReadState,
    pub enumeration_complete: bool,
    pub objects: Vec<RoutineObjectSnapshot>,
    pub issues: Vec<RoutineReadIssue>,
}

#[derive(Debug, Default, Deserialize)]
struct ReadFlags {
    #[serde(default, alias = "executionError")]
    execution_error: bool,
    #[serde(default)]
    truncated: bool,
    #[serde(default, alias = "hasMore")]
    has_more: bool,
    #[serde(default, alias = "largeValueCells")]
    large_value_cells: Vec<Value>,
    #[serde(default)]
    messages: Vec<db::QueryMessage>,
}

impl ReadFlags {
    fn check(&self) -> Result<(), String> {
        if self.execution_error || self.messages.iter().any(|message| message.severity.eq_ignore_ascii_case("ERROR")) {
            return Err("Routine metadata query reported an execution error".into());
        }
        if self.truncated || self.has_more || !self.large_value_cells.is_empty() {
            return Err("Routine metadata response is incomplete (row or large-value limit)".into());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct CatalogReply {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    #[serde(flatten)]
    flags: ReadFlags,
}

impl CatalogReply {
    fn cell<'a>(&self, row: &'a [Value], column: &str) -> Result<&'a Value, String> {
        let index = self
            .columns
            .iter()
            .position(|name| name.eq_ignore_ascii_case(column))
            .ok_or_else(|| format!("Routine metadata is missing column {column}"))?;
        row.get(index).ok_or_else(|| format!("Routine metadata row is missing {column}"))
    }

    fn text(&self, row: &[Value], column: &str) -> Result<String, String> {
        match self.cell(row, column)? {
            Value::String(value) if !value.is_empty() => Ok(value.clone()),
            Value::Number(value) => Ok(value.to_string()),
            _ => Err(format!("Routine metadata has no {column}")),
        }
    }

    fn integer(&self, row: &[Value], column: &str) -> Result<u64, String> {
        self.text(row, column)?.parse().map_err(|_| format!("Routine metadata has invalid {column}"))
    }
}

#[derive(Debug, Deserialize)]
struct SourceReply {
    #[serde(flatten)]
    object: db::ObjectSource,
    #[serde(flatten)]
    flags: ReadFlags,
    #[serde(default, alias = "sourceOrigin")]
    source_origin: Option<SourceOrigin>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceOrigin {
    OracleDictionary,
    #[serde(rename = "oceanbase-dictionary")]
    OceanBaseDictionary,
    OracleMetadata,
}

#[async_trait::async_trait]
trait RoutineCatalog: Sync {
    async fn query(&self, sql: &str) -> Result<CatalogReply, String>;
    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String>;
}

struct LiveCatalog<'a> {
    state: &'a AppState,
    endpoint: &'a RoutineEndpoint,
    config: &'a ConnectionConfig,
}

impl LiveCatalog<'_> {
    async fn check_endpoint(&self) -> Result<(), String> {
        let lifecycle = self.state.connection_lifecycle_snapshot(&self.endpoint.connection_id);
        let current = connection_config(self.state, &self.endpoint.connection_id)
            .await
            .ok_or("Original routine connection is unavailable")?;
        if lifecycle.generation() != self.endpoint.generation
            || lifecycle.cancellation().is_cancelled()
            || !crate::connection::connection_configs_session_credentials_compatible(&current, self.config)
        {
            return Err("Original routine connection changed; read a new preview before writing".into());
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl RoutineCatalog for LiveCatalog<'_> {
    async fn query(&self, sql: &str) -> Result<CatalogReply, String> {
        self.check_endpoint().await?;
        let key = self
            .state
            .get_or_create_metadata_pool_for_session(&self.endpoint.connection_id, Some(&self.endpoint.database), None)
            .await?;
        let pool = self.state.pool_handle(&key).await.ok_or("Pool not found")?;
        self.check_endpoint().await?;
        let mut params = agent_execute_query_params(
            sql,
            Some(&self.endpoint.database),
            Some(&self.endpoint.schema),
            QueryExecutionOptions { max_rows: Some(PAGE_SIZE + 1), ..Default::default() },
        );
        let timeout = agent_metadata_timeout(Some(self.config));
        match pool {
            PoolKind::Agent(client) => client.lock().await.execute_query_with_timeout(params, timeout).await,
            PoolKind::ExternalDriver { config, session, .. } => {
                params["connection"] = serde_json::to_value(config.as_ref()).map_err(|error| error.to_string())?;
                session.invoke_with_timeout("executeQuery", params, timeout).await
            }
            _ => Err("Oracle routine metadata requires its managed driver".into()),
        }
    }

    async fn source(&self, identity: &RoutineIdentity) -> Result<SourceReply, String> {
        self.check_endpoint().await?;
        let key = self
            .state
            .get_or_create_metadata_pool_for_session(&self.endpoint.connection_id, Some(&self.endpoint.database), None)
            .await?;
        let pool = self.state.pool_handle(&key).await.ok_or("Pool not found")?;
        self.check_endpoint().await?;
        managed_object_source(
            &pool,
            &self.endpoint.database,
            &identity.owner,
            &identity.name,
            &identity.kind,
            None,
            None,
            &dbx_types::oracle_trigger::MetadataReadOptions::default(),
            true,
            agent_metadata_timeout(Some(self.config)),
        )
        .await
    }
}

pub async fn load_schema_diff_routines_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
) -> Result<RoutineSnapshot, String> {
    load_selected_schema_diff_routines_core(state, connection_id, database, schema, None).await
}

pub async fn load_selected_schema_diff_routines_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    selected_routines: Option<&[String]>,
) -> Result<RoutineSnapshot, String> {
    load_schema_diff_routines_with_options_core(
        state,
        connection_id,
        database,
        schema,
        RoutineReadOptions { selected_routines: selected_routines.map(<[String]>::to_vec), ..Default::default() },
    )
    .await
}

pub async fn load_schema_diff_routines_with_options_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
    schema: &str,
    options: RoutineReadOptions,
) -> Result<RoutineSnapshot, String> {
    options.validate()?;
    if schema.is_empty() {
        return Err("Select an exact Oracle routine owner".into());
    }
    let config = connection_config(state, connection_id).await.ok_or("Connection not found")?;
    let (database_type, origin) = routine_source_origin(&config)?;
    let lifecycle = state.connection_lifecycle_snapshot(connection_id);
    let endpoint = RoutineEndpoint {
        connection_id: connection_id.into(),
        database: database.into(),
        schema: schema.into(),
        database_type,
        generation: lifecycle.generation(),
    };
    let catalog = LiveCatalog { state, endpoint: &endpoint, config: &config };
    let mut snapshot = collect_snapshot_with_options(&catalog, endpoint.clone(), origin, &options).await;
    if !state.connection_lifecycle_is_current(connection_id, &lifecycle) {
        invalidate_snapshot_endpoint(&mut snapshot);
    }
    Ok(snapshot)
}

fn invalidate_snapshot_endpoint(snapshot: &mut RoutineSnapshot) {
    snapshot.enumeration_complete = false;
    snapshot.state = RoutineReadState::Partial;
    snapshot.issues.push(issue("endpoint", "Connection changed while reading routine metadata"));
    for object in &mut snapshot.objects {
        object.source_complete = false;
        object.dependencies_complete = false;
    }
}

fn routine_source_origin(config: &ConnectionConfig) -> Result<(DatabaseType, SourceOrigin), String> {
    Ok(match config.db_type {
        DatabaseType::Oracle => (DatabaseType::Oracle, SourceOrigin::OracleDictionary),
        DatabaseType::OceanbaseOracle => (DatabaseType::OceanbaseOracle, SourceOrigin::OceanBaseDictionary),
        DatabaseType::Jdbc if is_oracle_external_driver_config(config) => {
            (DatabaseType::Oracle, SourceOrigin::OracleMetadata)
        }
        _ => return Err("Strict routine metadata requires Oracle or OceanBase Oracle".into()),
    })
}

fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn kind_name(kind: &db::ObjectSourceKind) -> &'static str {
    match kind {
        db::ObjectSourceKind::Procedure => "PROCEDURE",
        db::ObjectSourceKind::Function => "FUNCTION",
        db::ObjectSourceKind::Package => "PACKAGE",
        db::ObjectSourceKind::PackageBody => "PACKAGE BODY",
        _ => unreachable!("routine identities are validated on collection"),
    }
}

fn object_key(identity: &RoutineIdentity) -> (String, String, &'static str) {
    (identity.owner.clone(), identity.name.clone(), kind_name(&identity.kind))
}

fn issue(stage: &str, message: impl Into<String>) -> RoutineReadIssue {
    let message = message.into();
    let code = if message.contains("ORA-00942") || message.contains("ORA-01031") {
        "permission-denied"
    } else {
        "read-incomplete"
    };
    RoutineReadIssue { stage: stage.into(), code: code.into(), message }
}

fn inventory_sql(owner: &str, dba: bool, after_id: u64, kinds: &[db::ObjectSourceKind]) -> String {
    let view = if dba { "SYS.DBA_OBJECTS" } else { "ALL_OBJECTS" };
    let kinds = kinds.iter().map(|kind| literal(kind_name(kind))).collect::<Vec<_>>().join(", ");
    format!(
        "SELECT * FROM (SELECT OWNER, OBJECT_NAME, OBJECT_TYPE, OBJECT_ID, STATUS, \
         TO_CHAR(LAST_DDL_TIME, 'YYYY-MM-DD\"T\"HH24:MI:SS') LAST_DDL_TIME \
         FROM {view} WHERE OWNER = {} AND OBJECT_TYPE IN ({kinds}) \
         AND OBJECT_ID > {after_id} ORDER BY OBJECT_ID) WHERE ROWNUM <= {PAGE_SIZE}",
        literal(owner),
    )
}

struct InventoryRead {
    objects: Vec<RoutineVersion>,
    error: Option<String>,
}

async fn inventory(
    catalog: &impl RoutineCatalog,
    owner: &str,
    dba: bool,
    kinds: &[db::ObjectSourceKind],
) -> InventoryRead {
    if kinds.is_empty() {
        return InventoryRead { objects: Vec::new(), error: None };
    }
    let mut objects = Vec::new();
    let mut after_id = 0;
    let mut names = std::collections::BTreeSet::new();
    let read: Result<(), String> = async {
        loop {
            let reply = catalog.query(&inventory_sql(owner, dba, after_id, kinds)).await?;
            if reply.rows.len() > PAGE_SIZE {
                return Err("Routine inventory exceeded its page size".into());
            }
            for row in &reply.rows {
                let object_id = reply.integer(row, "OBJECT_ID")?;
                let kind = match reply.text(row, "OBJECT_TYPE")?.as_str() {
                    "PROCEDURE" => db::ObjectSourceKind::Procedure,
                    "FUNCTION" => db::ObjectSourceKind::Function,
                    "PACKAGE" => db::ObjectSourceKind::Package,
                    "PACKAGE BODY" => db::ObjectSourceKind::PackageBody,
                    _ => return Err("Routine inventory returned a different object kind".into()),
                };
                let identity =
                    RoutineIdentity { owner: reply.text(row, "OWNER")?, name: reply.text(row, "OBJECT_NAME")?, kind };
                if !kinds.contains(&identity.kind)
                    || identity.owner != owner
                    || object_id <= after_id
                    || !names.insert(object_key(&identity))
                {
                    return Err("Routine inventory has duplicate, unordered or mismatched identities".into());
                }
                after_id = object_id;
                objects.push(RoutineVersion {
                    identity,
                    object_id: object_id.to_string(),
                    status: reply.text(row, "STATUS")?,
                    last_ddl_time: reply.text(row, "LAST_DDL_TIME")?,
                });
            }
            reply.flags.check()?;
            if reply.rows.len() < PAGE_SIZE {
                return Ok(());
            }
        }
    }
    .await;
    InventoryRead { objects, error: read.err() }
}

fn identity_filter(identity: &RoutineIdentity) -> String {
    format!(
        "OWNER = {} AND NAME = {} AND TYPE = {}",
        literal(&identity.owner),
        literal(&identity.name),
        literal(kind_name(&identity.kind))
    )
}

fn source_integrity_sql(identity: &RoutineIdentity, origin: SourceOrigin) -> String {
    if matches!(origin, SourceOrigin::OracleMetadata) {
        let metadata_kind = match identity.kind {
            db::ObjectSourceKind::Package => "PACKAGE_SPEC".into(),
            _ => kind_name(&identity.kind).replace(' ', "_"),
        };
        return format!(
            "SELECT LENGTH(DBMS_METADATA.GET_DDL({}, {}, {})) SOURCE_CHARS FROM DUAL",
            literal(&metadata_kind),
            literal(&identity.name),
            literal(&identity.owner)
        );
    }
    // Native ALL_SOURCE.TEXT is VARCHAR2: LENGTH4 fixes the codepoint unit even
    // on legacy UTF8 databases. OB exposes CLOB here and LENGTH4 rejects CLOB.
    let length = if matches!(origin, SourceOrigin::OracleDictionary) { "LENGTH4" } else { "LENGTH" };
    let filter = identity_filter(identity);
    let whitespace = "CHR(9)||CHR(10)||CHR(11)||CHR(12)||CHR(13)||' '";
    format!(
        "SELECT COUNT(*) SOURCE_ROWS, MIN(LINE) FIRST_LINE, MAX(LINE) LAST_LINE, \
         SUM({length}(TEXT)) SOURCE_CHARS, \
         SUM(CASE WHEN LINE = 1 THEN {length}(TEXT)-NVL({length}(LTRIM(TEXT, {whitespace})),0) ELSE 0 END) HEAD_TRIM, \
         SUM(CASE WHEN LINE = (SELECT MAX(LINE) FROM ALL_SOURCE WHERE {filter}) \
         THEN {length}(TEXT)-NVL({length}(RTRIM(TEXT, {whitespace})),0) ELSE 0 END) TAIL_TRIM \
         , MAX(CASE WHEN LINE = 1 THEN CAST(SUBSTR(LTRIM(TEXT, {whitespace}), 1, 18) AS VARCHAR2(72)) END) SOURCE_HEAD \
         FROM ALL_SOURCE WHERE {filter}"
    )
}

async fn check_source(
    catalog: &impl RoutineCatalog,
    endpoint: &RoutineEndpoint,
    identity: &RoutineIdentity,
    reply: &SourceReply,
    origin: SourceOrigin,
) -> Result<(), String> {
    reply.flags.check()?;
    let origin = match reply.source_origin {
        Some(SourceOrigin::OracleDictionary) if endpoint.database_type != DatabaseType::Oracle => {
            return Err("Routine source origin does not match the database product".into());
        }
        Some(SourceOrigin::OceanBaseDictionary) if endpoint.database_type != DatabaseType::OceanbaseOracle => {
            return Err("Routine source origin does not match the database product".into());
        }
        Some(actual) => actual,
        None if matches!(identity.kind, db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody) => {
            return Err("Strict package source requires the getter's actual source origin".into());
        }
        None => origin,
    };
    if reply.object.name != identity.name
        || reply.object.schema.as_deref() != Some(&identity.owner)
        || reply.object.object_type != identity.kind
    {
        return Err("Routine source returned a different owner, name or kind".into());
    }
    validate_oracle_executable_object_source(OracleObjectSourceValidationInput {
        database_type: endpoint.database_type,
        object_type: identity.kind.clone(),
        schema: Some(identity.owner.clone()),
        name: identity.name.clone(),
        source: reply.object.source.clone(),
    })?;
    let lengths = catalog.query(&source_integrity_sql(identity, origin)).await?;
    lengths.flags.check()?;
    if lengths.rows.len() != 1 {
        return Err("Routine source length is unavailable or ambiguous".into());
    }
    let row = &lengths.rows[0];
    let mut expected = lengths.integer(row, "SOURCE_CHARS")?;
    let actual = match origin {
        SourceOrigin::OracleMetadata if endpoint.database_type == DatabaseType::OceanbaseOracle => {
            reply.object.source.chars().count() as u64
        }
        SourceOrigin::OracleMetadata => reply.object.source.encode_utf16().count() as u64,
        SourceOrigin::OracleDictionary => reply.object.source.chars().count() as u64,
        SourceOrigin::OceanBaseDictionary => {
            let head = lengths.integer(row, "HEAD_TRIM")?;
            let tail = lengths.integer(row, "TAIL_TRIM")?;
            expected = expected.checked_sub(head + tail).ok_or("Routine source trim length is inconsistent")?;
            let head = lengths.text(row, "SOURCE_HEAD")?;
            let body = if head.get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case("CREATE ")) {
                reply.object.source.as_str()
            } else {
                reply
                    .object
                    .source
                    .strip_prefix("CREATE OR REPLACE ")
                    .ok_or("OceanBase routine source has an unverified dictionary representation")?
            };
            body.chars().count() as u64
        }
    };
    if !matches!(origin, SourceOrigin::OracleMetadata) {
        let count = lengths.integer(row, "SOURCE_ROWS")?;
        if count == 0 || lengths.integer(row, "FIRST_LINE")? != 1 || lengths.integer(row, "LAST_LINE")? != count {
            return Err("Routine dictionary source has missing or duplicate lines".into());
        }
    }
    if actual != expected || actual == 0 {
        return Err("Routine source does not match the complete source-origin character length".into());
    }
    Ok(())
}

async fn dependencies(
    catalog: &impl RoutineCatalog,
    identity: &RoutineIdentity,
) -> Result<Vec<RoutineDependency>, String> {
    let mut result = Vec::new();
    let mut offset = 0;
    loop {
        let sql = format!(
            "SELECT * FROM (SELECT REFERENCED_OWNER, REFERENCED_NAME, REFERENCED_TYPE, \
             REFERENCED_LINK_NAME, DEPENDENCY_TYPE, ROW_NUMBER() OVER (ORDER BY REFERENCED_OWNER, \
             REFERENCED_NAME, REFERENCED_TYPE, REFERENCED_LINK_NAME, DEPENDENCY_TYPE) RN \
             FROM ALL_DEPENDENCIES WHERE {}) WHERE RN > {offset} AND RN <= {} ORDER BY RN",
            identity_filter(identity),
            offset + PAGE_SIZE,
        );
        let reply = catalog.query(&sql).await?;
        reply.flags.check()?;
        if reply.rows.len() > PAGE_SIZE {
            return Err("Routine dependencies exceeded their page size".into());
        }
        for row in &reply.rows {
            if reply.integer(row, "RN")? != (result.len() + 1) as u64 {
                return Err("Routine dependency pagination is incomplete".into());
            }
            result.push(RoutineDependency {
                owner: reply.text(row, "REFERENCED_OWNER")?,
                name: reply.text(row, "REFERENCED_NAME")?,
                kind: reply.text(row, "REFERENCED_TYPE")?,
                database_link: match reply.cell(row, "REFERENCED_LINK_NAME")? {
                    Value::Null => None,
                    Value::String(value) if value.is_empty() => None,
                    Value::String(value) => Some(value.clone()),
                    _ => return Err("Routine dependency has an invalid database link".into()),
                },
                dependency_type: reply.text(row, "DEPENDENCY_TYPE")?,
            });
        }
        if reply.rows.len() < PAGE_SIZE {
            result.sort();
            return Ok(result);
        }
        offset += PAGE_SIZE;
    }
}

#[cfg(test)]
#[cfg(test)]
async fn collect_snapshot(
    catalog: &impl RoutineCatalog,
    endpoint: RoutineEndpoint,
    origin: SourceOrigin,
) -> RoutineSnapshot {
    collect_selected_snapshot(catalog, endpoint, origin, None).await
}

#[cfg(test)]
async fn collect_selected_snapshot(
    catalog: &impl RoutineCatalog,
    endpoint: RoutineEndpoint,
    origin: SourceOrigin,
    selected_routines: Option<&[String]>,
) -> RoutineSnapshot {
    collect_snapshot_with_options(
        catalog,
        endpoint,
        origin,
        &RoutineReadOptions { selected_routines: selected_routines.map(<[String]>::to_vec), ..Default::default() },
    )
    .await
}

async fn collect_snapshot_with_options(
    catalog: &impl RoutineCatalog,
    endpoint: RoutineEndpoint,
    origin: SourceOrigin,
    options: &RoutineReadOptions,
) -> RoutineSnapshot {
    let kinds = options.inventory_kinds();
    let mut snapshot = RoutineSnapshot {
        endpoint,
        state: RoutineReadState::Failed,
        enumeration_complete: false,
        objects: Vec::new(),
        issues: Vec::new(),
    };
    let login = match catalog.query("SELECT USER AS LOGIN_OWNER FROM DUAL").await.and_then(|reply| {
        reply.flags.check()?;
        if reply.rows.len() != 1 {
            return Err("Routine owner visibility is unknown".into());
        }
        reply.text(&reply.rows[0], "LOGIN_OWNER")
    }) {
        Ok(login) => login,
        Err(error) => {
            snapshot.issues.push(issue("visibility", error));
            return snapshot;
        }
    };
    let mut dba = login != snapshot.endpoint.schema;
    let mut initial_read = inventory(catalog, &snapshot.endpoint.schema, dba, &kinds).await;
    snapshot.enumeration_complete = initial_read.error.is_none();
    if let Some(error) = initial_read.error {
        snapshot.issues.push(issue(if dba { "visibility" } else { "inventory" }, error));
        if dba {
            dba = false;
            let visible = inventory(catalog, &snapshot.endpoint.schema, false, &kinds).await;
            for object in visible.objects {
                if !initial_read.objects.iter().any(|known| object_key(&known.identity) == object_key(&object.identity))
                {
                    initial_read.objects.push(object);
                }
            }
            if let Some(error) = visible.error {
                snapshot.issues.push(issue("inventory", error));
            }
        }
    }
    let initial = initial_read.objects;
    for version in initial.iter().cloned() {
        let mut object = RoutineObjectSnapshot {
            version,
            source: None,
            source_origin: None,
            source_complete: false,
            dependencies: Vec::new(),
            dependencies_complete: false,
            issues: Vec::new(),
        };
        if !options.reads(&object.version.identity) {
            snapshot.objects.push(object);
            continue;
        }
        match catalog.source(&object.version.identity).await {
            Ok(reply) => {
                object.source = Some(reply.object.source.clone());
                if matches!(
                    object.version.identity.kind,
                    db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody
                ) {
                    object.source_origin = reply.source_origin;
                }
                match check_source(catalog, &snapshot.endpoint, &object.version.identity, &reply, origin).await {
                    Ok(())
                        if matches!(
                            object.version.identity.kind,
                            db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody
                        ) =>
                    {
                        object.source_complete = true;
                    }
                    Ok(()) => {
                        // A second full read also detects replacement within LAST_DDL_TIME's second.
                        match catalog.source(&object.version.identity).await {
                            Ok(second)
                                if second.flags.check().is_ok()
                                    && second.object.name == reply.object.name
                                    && second.object.schema == reply.object.schema
                                    && second.object.object_type == reply.object.object_type
                                    && second.source_origin == reply.source_origin
                                    && second.object.source == reply.object.source =>
                            {
                                object.source_complete = true
                            }
                            Ok(_) => object
                                .issues
                                .push(issue("source", "Routine source changed or became incomplete during collection")),
                            Err(error) => object.issues.push(issue("source", error)),
                        }
                    }
                    Err(error) => object.issues.push(issue("source", error)),
                }
            }
            Err(error) => object.issues.push(issue("source", error)),
        }
        match dependencies(catalog, &object.version.identity).await {
            Ok(values) => {
                object.dependencies = values;
                object.dependencies_complete = true;
            }
            Err(error) => object.issues.push(issue("dependencies", error)),
        }
        snapshot.objects.push(object);
    }
    for object in &mut snapshot.objects {
        if !object.source_complete
            || !matches!(
                object.version.identity.kind,
                db::ObjectSourceKind::Package | db::ObjectSourceKind::PackageBody
            )
        {
            continue;
        }
        match catalog.source(&object.version.identity).await {
            Ok(second)
                if second.flags.check().is_ok()
                    && second.object.name == object.version.identity.name
                    && second.object.schema.as_deref() == Some(object.version.identity.owner.as_str())
                    && second.object.object_type == object.version.identity.kind
                    && second.source_origin == object.source_origin
                    && object.source.as_deref() == Some(second.object.source.as_str()) => {}
            Ok(_) => {
                object.source_complete = false;
                object
                    .issues
                    .push(issue("source", "Package source changed or became incomplete while collecting its pair"));
            }
            Err(error) => {
                object.source_complete = false;
                object.issues.push(issue("source", error));
            }
        }
    }
    let after_read = inventory(catalog, &snapshot.endpoint.schema, dba, &kinds).await;
    if let Some(error) = after_read.error {
        snapshot.enumeration_complete = false;
        snapshot.issues.push(issue("inventory", error));
    } else {
        let after = after_read.objects;
        let after_by_name =
            after.iter().map(|version| (object_key(&version.identity), version)).collect::<BTreeMap<_, _>>();
        for object in &mut snapshot.objects {
            if after_by_name.get(&object_key(&object.version.identity)).copied() != Some(&object.version) {
                object.source_complete = false;
                object.dependencies_complete = false;
                object
                    .issues
                    .push(issue("version", "Routine identity, state or DDL version changed during collection"));
            }
        }
        if initial != after {
            snapshot.enumeration_complete = false;
            snapshot.issues.push(issue(
                "inventory",
                "Routine inventory changed during collection; refresh before inferring absence",
            ));
            for version in after {
                if !initial.iter().any(|before| object_key(&before.identity) == object_key(&version.identity)) {
                    snapshot.objects.push(RoutineObjectSnapshot {
                        version,
                        source: None,
                        source_origin: None,
                        source_complete: false,
                        dependencies: Vec::new(),
                        dependencies_complete: false,
                        issues: vec![issue(
                            "source",
                            "Routine appeared after the initial inventory; refresh to read its definition",
                        )],
                    });
                }
            }
        }
    }
    snapshot.state = if snapshot.enumeration_complete
        && snapshot.objects.iter().all(|object| object.source_complete && object.dependencies_complete)
    {
        RoutineReadState::Complete
    } else if snapshot.objects.is_empty() && snapshot.issues.iter().any(|issue| issue.code == "permission-denied") {
        RoutineReadState::PermissionDenied
    } else if snapshot.objects.is_empty() && !snapshot.enumeration_complete {
        RoutineReadState::Failed
    } else {
        RoutineReadState::Partial
    };
    snapshot
}

#[cfg(test)]
mod tests;
