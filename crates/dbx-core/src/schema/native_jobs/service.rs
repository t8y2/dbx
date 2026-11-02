use super::*;
use crate::connection::{AppState, ConnectionLifecycleSnapshot};
use crate::models::connection::{
    database_info_from_protocol_value, ConnectionConfig, DatabaseConnectionInfo, DatabaseType,
};
use crate::session_credentials::current_credential_owner;
use dbx_sql::native_jobs::native_job_list_queries;
use dbx_types::native_jobs::{
    NativeJobCatalogSource, NativeJobContext, NativeJobEngine, NativeJobKind, NativeJobList, NativeJobListRequest,
    NativeJobScope, NativeJobSummary,
};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;

const MAX_CONTEXTS: usize = 256;
const MAX_BASELINES: usize = 512;

// Authentication owners can be session tokens. Neither these records nor definitions are Debug.
#[derive(Clone)]
pub(super) struct BoundContext {
    pub(super) context: NativeJobContext,
    actor: Option<String>,
    pub(super) lifecycle: ConnectionLifecycleSnapshot,
}

#[derive(Clone)]
struct Baseline {
    revision: String,
    target: NativeJobRef,
    identity: Option<NativeJobCatalogRow>,
    partitions: BTreeMap<String, String>,
    legacy_next_date: Option<Value>,
}

#[derive(Default)]
struct Registry {
    contexts: VecDeque<BoundContext>,
    baselines: VecDeque<Baseline>,
}

#[derive(Default)]
pub struct NativeJobRegistry(std::sync::Mutex<Registry>, super::operations::NativeJobOperations);

pub struct NativeJobRuntimeIdentity {
    pub database_info: Option<DatabaseConnectionInfo>,
    pub session_user: String,
}

impl NativeJobRegistry {
    pub(super) fn operations(&self) -> &super::operations::NativeJobOperations {
        &self.1
    }
    fn bind(
        &self,
        state: &AppState,
        context: NativeJobContext,
        lifecycle: ConnectionLifecycleSnapshot,
    ) -> NativeJobContext {
        let actor = current_credential_owner();
        let mut registry = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(existing) = registry.contexts.iter().find(|bound| {
            bound.actor == actor
                && bound.context.scope.connection_id == context.scope.connection_id
                && bound.context.scope.database == context.scope.database
                && bound.context.engine == context.engine
                && bound.context.session_user == context.session_user
                && bound.context.actual_database == context.actual_database
                && bound.context.product_version == context.product_version
                && state.connection_lifecycle_is_current(&context.scope.connection_id, &bound.lifecycle)
        }) {
            return existing.context.clone();
        }
        registry.contexts.retain(|bound| {
            !(bound.actor == actor
                && bound.context.scope.connection_id == context.scope.connection_id
                && bound.context.scope.database == context.scope.database)
        });
        registry.contexts.push_back(BoundContext { context: context.clone(), actor, lifecycle });
        if registry.contexts.len() > MAX_CONTEXTS {
            registry.contexts.pop_front();
        }
        context
    }

    pub(super) fn context(&self, state: &AppState, scope: &NativeJobScope) -> Result<BoundContext, &'static str> {
        let actor = current_credential_owner();
        let bound = self
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .contexts
            .iter()
            .find(|bound| &bound.context.scope == scope && bound.actor == actor)
            .cloned()
            .ok_or("native_job_context_expired")?;
        if !state.connection_lifecycle_is_current(&scope.connection_id, &bound.lifecycle) {
            return Err("native_job_context_changed");
        }
        Ok(bound)
    }

    pub(super) fn remember(&self, engine: NativeJobEngine, details: &mut dbx_types::native_jobs::NativeJobDetails) {
        let identity = match (&details.native_identity, &details.consistency) {
            (NativeJobMetadata::Available { value }, NativeJobMetadata::Available { .. }) => Some(value.clone()),
            _ => None,
        };
        let mut partitions = BTreeMap::new();
        if let NativeJobMetadata::Available { value } = &details.snapshot.definition {
            let mut stable = value.clone();
            stable.retain(|name, _| {
                !super::details::generated_definition_column(engine, &details.snapshot.job_ref, value, name)
            });
            for volatile in [
                "STATE",
                "RUN_COUNT",
                "FAILURE_COUNT",
                "RETRY_COUNT",
                "LAST_START_DATE",
                "LAST_RUN_DATE",
                "LAST_RUN_DURATION",
                "NEXT_RUN_DATE",
                "LAST_DATE",
                "LAST_SEC",
                "THIS_DATE",
                "THIS_SEC",
                "NEXT_DATE",
                "NEXT_SEC",
                "TOTAL_TIME",
                "FAILURES",
                "GMT_MODIFIED",
            ] {
                stable.remove(volatile);
            }
            partitions.insert("definition".into(), fingerprint(&stable));
        }
        for (name, data) in [
            ("steps", &details.steps),
            ("schedules", &details.schedules),
            ("argument-inventory", &details.parameter_metadata),
        ] {
            match data {
                NativeJobMetadata::Available { value } => {
                    if name == "argument-inventory" && engine == NativeJobEngine::Oracle {
                        let canonical: Vec<_> = value
                            .iter()
                            .map(|row| dbx_sql::native_job_arguments::canonical_argument_row(row, false))
                            .collect();
                        partitions.insert(name.into(), fingerprint(&canonical));
                    } else {
                        partitions.insert(name.into(), fingerprint(value));
                    }
                }
                NativeJobMetadata::Empty => {
                    partitions.insert(name.into(), fingerprint(&Vec::<NativeJobCatalogRow>::new()));
                }
                _ => {}
            }
        }
        if let Some(NativeJobMetadata::Available { value }) = &details.legacy_definition {
            let mut stable = value.clone();
            for volatile in
                ["LAST_DATE", "LAST_SEC", "THIS_DATE", "THIS_SEC", "NEXT_DATE", "NEXT_SEC", "TOTAL_TIME", "FAILURES"]
            {
                stable.remove(volatile);
            }
            partitions.insert("legacyDefinition".into(), fingerprint(&stable));
        }
        if let NativeJobMetadata::Available { value } = &details.snapshot.arguments {
            let canonical = |argument: &dbx_types::native_jobs::NativeJobArgument| {
                let mut argument = argument.clone();
                if engine == NativeJobEngine::Oracle {
                    if let NativeJobMetadata::Available { value } = &details.parameter_metadata {
                        if let Some(row) = value.iter().find(|row| {
                            super::details::integer(row.get("ARGUMENT_POSITION")) == Some(argument.position as i64)
                        }) {
                            argument.value =
                                dbx_sql::native_job_arguments::decode_argument(row, false).editable_value();
                        }
                    }
                    if matches!(argument.default_value, Some(NativeJobMetadata::Available { .. })) {
                        if let Some(NativeJobMetadata::Available { value }) = &details.program_arguments {
                            if let Some(row) = value.iter().find(|row| {
                                super::details::integer(row.get("ARGUMENT_POSITION")) == Some(argument.position as i64)
                            }) {
                                argument.default_value = Some(NativeJobMetadata::Available {
                                    value: dbx_sql::native_job_arguments::decode_argument(row, true).editable_value(),
                                });
                            }
                        }
                    }
                }
                let native = |metadata: &NativeJobMetadata<Vec<NativeJobCatalogRow>>, default_value| match metadata {
                    NativeJobMetadata::Available { value } if engine == NativeJobEngine::Oracle => value
                        .iter()
                        .find(|row| {
                            super::details::integer(row.get("ARGUMENT_POSITION")) == Some(argument.position as i64)
                        })
                        .map(|row| {
                            dbx_sql::native_job_arguments::decode_argument(row, default_value).canonical_value()
                        }),
                    _ => None,
                };
                serde_json::json!([
                    argument,
                    native(&details.parameter_metadata, false),
                    details.program_arguments.as_ref().and_then(|rows| native(rows, true))
                ])
            };
            for argument in value.iter().filter(|argument| argument.editable) {
                partitions.insert(format!("argument:{}", argument.position), fingerprint(&canonical(argument)));
            }
            if value.iter().all(|argument| argument.editable) {
                partitions.insert("arguments".into(), fingerprint(&value.iter().map(canonical).collect::<Vec<_>>()));
            }
        }
        let revision = uuid::Uuid::new_v4().to_string();
        let legacy_next_date = if matches!(details.snapshot.job_ref, NativeJobRef::Legacy { .. }) {
            if engine == NativeJobEngine::Dameng {
                match &details.legacy_definition {
                    Some(NativeJobMetadata::Available { value }) => value
                        .get("NEXT_DATE")
                        .zip(value.get("NEXT_SEC"))
                        .map(|(date, seconds)| serde_json::json!([date, seconds])),
                    _ => None,
                }
            } else {
                match &details.snapshot.definition {
                    NativeJobMetadata::Available { value } => value.get("NEXT_DATE").cloned(),
                    _ => None,
                }
            }
        } else {
            None
        };
        let baseline = Baseline {
            revision: revision.clone(),
            target: details.snapshot.job_ref.clone(),
            identity,
            partitions,
            legacy_next_date,
        };
        let mut registry = self.0.lock().unwrap_or_else(|error| error.into_inner());
        registry.baselines.push_back(baseline);
        if registry.baselines.len() > MAX_BASELINES {
            registry.baselines.pop_front();
        }
        details.snapshot.revision = revision;
    }

    pub(super) fn legacy_definition_recorded(
        &self,
        state: &AppState,
        target: &NativeJobRef,
        revision: &str,
    ) -> Result<bool, &'static str> {
        self.context(state, target.scope())?;
        let registry = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let baseline = registry
            .baselines
            .iter()
            .find(|baseline| baseline.revision == revision && &baseline.target == target)
            .ok_or("native_job_preview_stale")?;
        Ok(baseline.partitions.contains_key("legacyDefinition"))
    }

    /// Validate only the partitions the pending change needs. Runtime/history availability is unrelated.
    pub fn compare_baseline(
        &self,
        state: &AppState,
        target: &NativeJobRef,
        previous: &str,
        current: &str,
        required_partitions: &[&str],
        compare_legacy_next_date: bool,
    ) -> Result<(), &'static str> {
        self.context(state, target.scope())?;
        let registry = self.0.lock().unwrap_or_else(|error| error.into_inner());
        let find = |revision: &str| {
            registry.baselines.iter().find(|baseline| baseline.revision == revision && &baseline.target == target)
        };
        let before = find(previous).ok_or("native_job_preview_stale")?;
        let after = find(current).ok_or("native_job_preview_stale")?;
        if before.identity.is_none() || after.identity.is_none() {
            return Err("native_job_identity_unverified");
        }
        if before.identity != after.identity {
            return Err("native_job_replaced");
        }
        for part in required_partitions {
            let initial = before.partitions.get(*part).ok_or("native_job_metadata_incomplete")?;
            let latest = after.partitions.get(*part).ok_or("native_job_metadata_incomplete")?;
            if initial != latest {
                return Err("native_job_definition_changed");
            }
        }
        if compare_legacy_next_date {
            if before.legacy_next_date.is_none() || after.legacy_next_date.is_none() {
                return Err("native_job_metadata_incomplete");
            }
            if before.legacy_next_date != after.legacy_next_date {
                return Err("native_job_definition_changed");
            }
        }
        Ok(())
    }
}

fn fingerprint(value: &impl serde::Serialize) -> String {
    // This fingerprint is for optimistic database conflict detection, not file-integrity bookkeeping.
    let bytes = serde_json::to_vec(value).expect("native Job metadata is JSON");
    format!("{:x}", Sha256::digest(bytes))
}

fn resolve_engine(
    config: &ConnectionConfig,
    info: Option<&DatabaseConnectionInfo>,
) -> Result<NativeJobEngine, &'static str> {
    let product = info.and_then(|info| info.product_name.as_deref()).unwrap_or("").to_ascii_lowercase();
    let mode = info.and_then(|info| info.compatibility_mode.as_deref()).unwrap_or("");
    if product.contains("oceanbase") {
        return if mode.eq_ignore_ascii_case("oracle") || config.db_type == DatabaseType::OceanbaseOracle {
            Ok(NativeJobEngine::OceanbaseOracle)
        } else {
            Err("native_job_engine_unresolved")
        };
    }
    match config.db_type {
        DatabaseType::Oracle => Ok(NativeJobEngine::Oracle),
        DatabaseType::OceanbaseOracle => Ok(NativeJobEngine::OceanbaseOracle),
        DatabaseType::Dameng => Ok(NativeJobEngine::Dameng),
        DatabaseType::Jdbc if product == "oracle" || product.starts_with("oracle database") => {
            Ok(NativeJobEngine::Oracle)
        }
        DatabaseType::Jdbc if product == "dm dbms" || product == "dameng" => Ok(NativeJobEngine::Dameng),
        _ => Err("native_job_engine_unresolved"),
    }
}

pub async fn native_job_open_context_with<Q, F>(
    state: &AppState,
    connection_id: &str,
    database: &str,
    read_identity: Q,
) -> Result<NativeJobContext, &'static str>
where
    Q: FnOnce(ConnectionConfig) -> F,
    F: Future<Output = Result<NativeJobRuntimeIdentity, &'static str>>,
{
    if connection_id.is_empty() || connection_id.contains('\0') || database.contains('\0') {
        return Err("native_job_identity_invalid");
    }
    let lifecycle = state.connection_lifecycle_snapshot(connection_id);
    let config = state.configs.read().await.get(connection_id).cloned().ok_or("native_job_connection_missing")?;
    let identity = read_identity(config.clone()).await?;
    if identity.session_user.is_empty() || identity.session_user.contains('\0') {
        return Err("native_job_runtime_identity_invalid");
    }
    if !state.connection_lifecycle_is_current(connection_id, &lifecycle) {
        return Err("native_job_context_changed");
    }
    let context = NativeJobContext {
        scope: NativeJobScope {
            connection_id: connection_id.into(),
            database: database.into(),
            context_id: uuid::Uuid::new_v4().to_string(),
        },
        engine: resolve_engine(&config, identity.database_info.as_ref())?,
        session_user: identity.session_user,
        actual_database: identity.database_info.as_ref().and_then(|info| info.current_database.clone()),
        product_version: identity.database_info.and_then(|info| info.product_version),
    };
    Ok(state.native_jobs.bind(state, context, lifecycle))
}

pub(super) async fn open_pool(
    state: &AppState,
    scope: &NativeJobScope,
) -> Result<(super::super::EphemeralAgentMetadataSession, PoolKind), &'static str> {
    let database = (!scope.database.is_empty()).then_some(scope.database.as_str());
    let session =
        super::super::EphemeralAgentMetadataSession::open(state, &scope.connection_id, database, "native-jobs").await;
    let key = state
        .get_or_create_metadata_pool_for_session(&scope.connection_id, database, session.client_session_id())
        .await
        .map_err(|_| "native_job_connection_failed")?;
    let pool = state.pool_handle(&key).await.ok_or("native_job_connection_failed")?;
    Ok((session, pool))
}

pub async fn runtime_identity(
    config: &ConnectionConfig,
    pool: &PoolKind,
    database: &str,
) -> Result<NativeJobRuntimeIdentity, &'static str> {
    runtime_identity_in_session(config, pool, database, None).await
}

pub(super) async fn runtime_identity_in_session(
    config: &ConnectionConfig,
    pool: &PoolKind,
    database: &str,
    physical: Option<&NativeJobPhysicalSession>,
) -> Result<NativeJobRuntimeIdentity, &'static str> {
    let timeout = super::super::agent_metadata_timeout(Some(config));
    let probed_info = match pool {
        PoolKind::Agent(client) => {
            if let Some(physical) = physical {
                let mut params = serde_json::json!({});
                physical.bind(&mut params);
                client
                    .lock()
                    .await
                    .call_typed_with_timeout("connection_info", params, timeout)
                    .await
                    .ok()
                    .and_then(|value| database_info_from_protocol_value(&value))
            } else {
                client.lock().await.connection_info(timeout).await.ok().and_then(|info| info.database_info)
            }
        }
        PoolKind::ExternalDriver { config: driver_config, session, .. } => {
            let mut params = serde_json::json!({ "connection": driver_config.as_ref() });
            if let Some(physical) = physical {
                physical.bind(&mut params);
            }
            session
                .invoke_with_timeout("connectionInfo", params, timeout)
                .await
                .ok()
                .and_then(|value| database_info_from_protocol_value(&value))
        }
        _ => return Err("native_job_driver_route_missing"),
    };
    let info = match (probed_info, config.database_info.clone()) {
        (Some(mut probed), Some(saved)) => {
            if probed.product_name.is_none() {
                probed.product_name = saved.product_name;
            }
            if probed.product_version.is_none() {
                probed.product_version = saved.product_version;
            }
            if probed.current_database.is_none() {
                probed.current_database = saved.current_database;
            }
            if probed.compatibility_mode.is_none() {
                probed.compatibility_mode = saved.compatibility_mode;
            }
            Some(probed)
        }
        (Some(probed), None) => Some(probed),
        (None, saved) => saved,
    };
    let engine = resolve_engine(config, info.as_ref())?;
    let query = NativeJobCatalogQuery {
        source: "session-user",
        coverage: NativeJobCatalogCoverage::CurrentUser,
        sql: "SELECT USER AS DBX_SESSION_USER FROM DUAL".into(),
        limit: 1,
    };
    let raw = execute_catalog_query_in_session(engine, pool, database, query, timeout, physical)
        .await
        .map_err(|_| "native_job_runtime_identity_failed")?;
    let rows = rows_from_result(
        decode_query_result(engine, raw).map_err(|_| "native_job_runtime_identity_failed")?,
        2,
        |_| Ok(()),
    )
    .map_err(|_| "native_job_runtime_identity_failed")?;
    let NativeJobMetadata::Available { value } = rows else {
        return Err("native_job_runtime_identity_invalid");
    };
    if value.len() != 1 {
        return Err("native_job_runtime_identity_invalid");
    }
    let session_user = value[0]
        .get("DBX_SESSION_USER")
        .and_then(Value::as_str)
        .ok_or("native_job_runtime_identity_invalid")?
        .to_string();
    Ok(NativeJobRuntimeIdentity { database_info: info, session_user })
}

pub async fn native_job_open_context_core(
    state: &AppState,
    connection_id: &str,
    database: &str,
) -> Result<NativeJobContext, String> {
    let scope =
        NativeJobScope { connection_id: connection_id.into(), database: database.into(), context_id: "opening".into() };
    native_job_open_context_with(state, connection_id, database, |config| async move {
        let (session, pool) = open_pool(state, &scope).await?;
        let result = runtime_identity(&config, &pool, database).await;
        session.finish(state, connection_id, (!database.is_empty()).then_some(database)).await;
        result
    })
    .await
    .map_err(str::to_string)
}

pub async fn native_job_list_with<Q, F>(
    state: &AppState,
    request: &NativeJobListRequest,
    mut query: Q,
) -> Result<NativeJobList, &'static str>
where
    Q: FnMut(NativeJobCatalogQuery) -> F,
    F: Future<Output = Result<Value, NativeJobCatalogFailure>>,
{
    let (scope, kind, offset, limit) = (&request.scope, request.kind, request.offset, request.limit);
    let bound = state.native_jobs.context(state, scope)?;
    let candidates =
        native_job_list_queries(bound.context.engine, kind, request.schema.as_deref(), &request.filter, offset, limit)?;
    let section = tokio::select! {
        biased;
        _ = bound.lifecycle.cancellation().cancelled() => return Err("native_job_context_changed"),
        read = read_catalog_candidates_with(candidates, |raw, limit| {
            rows_from_result(decode_query_result(bound.context.engine, raw)?, limit, |row| {
                if kind != NativeJobKind::Scheduler && row.get("DBX_JOB_ID").and_then(Value::as_str).is_none() {
                    return Err(NativeJobCatalogFailure::IdentityMismatch);
                }
                Ok(())
            })
        }, &mut query) => read?,
    };
    state.native_jobs.context(state, scope)?;
    let jobs = summaries(scope, bound.context.engine, kind, section.data);
    Ok(NativeJobList {
        jobs,
        source: NativeJobCatalogSource { source: section.source.map(str::to_string), coverage: section.coverage },
        offset,
        limit,
    })
}

fn summaries(
    scope: &NativeJobScope,
    engine: NativeJobEngine,
    kind: NativeJobKind,
    rows: NativeJobMetadata<Vec<NativeJobCatalogRow>>,
) -> NativeJobMetadata<Vec<NativeJobSummary>> {
    let parsed = match rows {
        NativeJobMetadata::Available { value } => (value, None),
        NativeJobMetadata::Truncated { value, limit } => (value, Some(limit)),
        other => return super::details::map_metadata(other, |_| unreachable!()),
    };
    let mut summaries = Vec::new();
    for row in parsed.0 {
        let text = |key: &str| row.get(key).and_then(Value::as_str).map(str::to_string);
        let mut aliases = Vec::new();
        let job_ref = match kind {
            NativeJobKind::Scheduler => NativeJobRef::Scheduler {
                scope: scope.clone(),
                owner: text("DBX_OWNER").unwrap_or_default(),
                name: text("JOB_NAME").unwrap_or_default(),
            },
            _ if engine == NativeJobEngine::Dameng => {
                let native = NativeJobRef::DamengNative {
                    scope: scope.clone(),
                    job_id: text("DBX_JOB_ID").unwrap_or_default(),
                    name: text("NAME").unwrap_or_default(),
                };
                if native.validate().is_err() {
                    return NativeJobCatalogFailure::IdentityMismatch.metadata();
                }
                if super::details::integer(row.get("SYS_FLAG")) == Some(2) {
                    aliases.push(native);
                    NativeJobRef::Legacy { scope: scope.clone(), job_id: text("DBX_JOB_ID").unwrap_or_default() }
                } else {
                    native
                }
            }
            _ => NativeJobRef::Legacy { scope: scope.clone(), job_id: text("DBX_JOB_ID").unwrap_or_default() },
        };
        if job_ref.validate().is_err() {
            return NativeJobCatalogFailure::IdentityMismatch.metadata();
        }
        let legacy = matches!(job_ref, NativeJobRef::Legacy { .. });
        let scheduler = matches!(job_ref, NativeJobRef::Scheduler { .. });
        let name = text(if scheduler {
            "JOB_NAME"
        } else if engine == NativeJobEngine::Dameng {
            "NAME"
        } else {
            "DBX_JOB_ID"
        })
        .unwrap_or_default();
        let enabled = if legacy && engine != NativeJobEngine::Dameng {
            match text("BROKEN").as_deref() {
                Some("N") => Some(true),
                Some("Y") => Some(false),
                _ => None,
            }
        } else {
            super::details::boolean(row.get(if scheduler { "ENABLED" } else { "ENABLE" }))
        };
        summaries.push(NativeJobSummary {
            job_ref,
            name,
            owner: if scheduler {
                text("DBX_OWNER")
            } else if engine == NativeJobEngine::Dameng {
                text("USERNAME")
            } else {
                None
            },
            enabled,
            job_type: text("JOB_TYPE"),
            state: text("STATE"),
            next_run: row.get(if scheduler { "NEXT_RUN_DATE" } else { "NEXT_DATE" }).cloned(),
            comments: text(if engine == NativeJobEngine::Dameng && !scheduler { "DESCRIBE" } else { "COMMENTS" }),
            aliases,
            log_user: text("LOG_USER"),
            priv_user: text("PRIV_USER"),
            schema_user: text("SCHEMA_USER"),
        });
    }
    match parsed.1 {
        Some(limit) => NativeJobMetadata::Truncated { value: summaries, limit },
        None => NativeJobMetadata::Available { value: summaries },
    }
}

pub async fn native_job_list_core(state: &AppState, request: &NativeJobListRequest) -> Result<NativeJobList, String> {
    let scope = &request.scope;
    let bound = state.native_jobs.context(state, scope).map_err(str::to_string)?;
    let timeout = super::super::agent_metadata_timeout(state.configs.read().await.get(&scope.connection_id));
    let (session, pool) = open_pool(state, scope).await.map_err(str::to_string)?;
    let result = async {
        validate_runtime_context(state, &bound, &pool).await?;
        native_job_list_with(state, request, |query| {
            execute_catalog_query(bound.context.engine, &pool, &scope.database, query, timeout)
        })
        .await
    }
    .await
    .map_err(str::to_string);
    session.finish(state, &scope.connection_id, (!scope.database.is_empty()).then_some(scope.database.as_str())).await;
    result
}

pub async fn native_job_read_core(
    state: &AppState,
    target: &NativeJobRef,
) -> Result<dbx_types::native_jobs::NativeJobDetails, String> {
    target.validate().map_err(str::to_string)?;
    let bound = state.native_jobs.context(state, target.scope()).map_err(str::to_string)?;
    let timeout = super::super::agent_metadata_timeout(state.configs.read().await.get(&target.scope().connection_id));
    let (session, pool) = open_pool(state, target.scope()).await.map_err(str::to_string)?;
    let result = async {
        validate_runtime_context(state, &bound, &pool).await?;
        native_job_read_with(state, target, |query| {
            execute_catalog_query(bound.context.engine, &pool, &target.scope().database, query, timeout)
        })
        .await
    }
    .await
    .map_err(str::to_string);
    session
        .finish(
            state,
            &target.scope().connection_id,
            (!target.scope().database.is_empty()).then_some(target.scope().database.as_str()),
        )
        .await;
    result
}

pub(super) async fn validate_runtime_context(
    state: &AppState,
    bound: &BoundContext,
    pool: &PoolKind,
) -> Result<(), &'static str> {
    validate_runtime_context_in_session(state, bound, pool, None).await
}

pub(super) async fn validate_runtime_context_in_session(
    state: &AppState,
    bound: &BoundContext,
    pool: &PoolKind,
    physical: Option<&NativeJobPhysicalSession>,
) -> Result<(), &'static str> {
    let scope = &bound.context.scope;
    state.native_jobs.context(state, scope)?;
    let config =
        state.configs.read().await.get(&scope.connection_id).cloned().ok_or("native_job_connection_missing")?;
    let identity = tokio::select! {
        biased;
        _ = bound.lifecycle.cancellation().cancelled() => return Err("native_job_context_changed"),
        identity = runtime_identity_in_session(&config, pool, &scope.database, physical) => identity?,
    };
    let actual_database = identity.database_info.as_ref().and_then(|info| info.current_database.as_ref());
    if identity.session_user != bound.context.session_user
        || actual_database != bound.context.actual_database.as_ref()
        || identity.database_info.as_ref().and_then(|info| info.product_version.as_ref())
            != bound.context.product_version.as_ref()
        || resolve_engine(&config, identity.database_info.as_ref())? != bound.context.engine
    {
        return Err("native_job_runtime_context_changed");
    }
    state.native_jobs.context(state, scope)?;
    Ok(())
}

pub async fn native_job_read_with<Q, F>(
    state: &AppState,
    target: &NativeJobRef,
    query: Q,
) -> Result<dbx_types::native_jobs::NativeJobDetails, &'static str>
where
    Q: FnMut(NativeJobCatalogQuery) -> F,
    F: Future<Output = Result<Value, NativeJobCatalogFailure>>,
{
    target.validate()?;
    let bound = state.native_jobs.context(state, target.scope())?;
    let mut result = tokio::select! {
        biased;
        _ = bound.lifecycle.cancellation().cancelled() => return Err("native_job_context_changed"),
        result = super::details::read_native_job_details_with(bound.context.engine, target, query) => result?,
    };
    state.native_jobs.context(state, target.scope())?;
    state.native_jobs.remember(bound.context.engine, &mut result);
    Ok(result)
}
