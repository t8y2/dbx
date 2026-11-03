use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlDebugCompile {
    pub server_epoch: Uuid,
    pub operation_id: String,
    pub connection_id: String,
    pub database: String,
    pub client_session_id: String,
    pub target: Option<PlDebugInspectTarget>,
    pub preview: Value,
    pub expected_connection_revision: String,
    pub confirmed: bool,
    #[serde(default)]
    pub production_confirmed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlDebugCompileRef {
    pub server_epoch: Uuid,
    pub operation_id: String,
    pub connection_id: String,
    pub client_session_id: String,
}

pub struct PlDebugCompileAdmission {
    compilation: Arc<Compilation>,
    inspection: Option<inspection::PlDebugInspectionAdmission>,
    validation: Result<(), String>,
}

pub(super) struct Compilation {
    pub(super) request: PlDebugCompile,
    owner: AccessOwner,
    credential_owner: Option<String>,
    driver_key: String,
    profile_ids: Vec<String>,
    state: Mutex<CompilationState>,
}

struct CompilationState {
    dispatched: bool,
    ddl_state: &'static str,
    result: Option<Value>,
    error: Option<String>,
    cleanup_error: Option<String>,
    finished: bool,
    released: bool,
    revoked: bool,
}

impl Compilation {
    fn lock(&self) -> MutexGuard<'_, CompilationState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    pub(super) fn protects_connection(&self, connection_id: &str) -> bool {
        let data = self.lock();
        self.request.connection_id == connection_id && (!data.finished || !data.released || data.ddl_state == "unknown")
    }

    pub(super) fn matches_scope(&self, scope: &PlDebugMutationScope) -> bool {
        match scope {
            PlDebugMutationScope::Connections(ids) => ids.contains(&self.request.connection_id),
            PlDebugMutationScope::WriteProtection { connection_id, credential_owner } => {
                connection_id == &self.request.connection_id && credential_owner == &self.credential_owner
            }
            PlDebugMutationScope::TunnelProfiles(ids) => self.profile_ids.iter().any(|id| ids.contains(id)),
            PlDebugMutationScope::Driver(key) => key == &self.driver_key,
            PlDebugMutationScope::AllRuntimes => true,
        }
    }

    fn view(&self) -> Value {
        let data = self.lock();
        json!({"serverEpoch":self.request.server_epoch,"operationId":self.request.operation_id,
            "connectionId":self.request.connection_id,"clientSessionId":self.request.client_session_id,
            "target":{"schema":self.request.preview["schema"],"objectName":self.request.preview["objectName"],"objectType":self.request.preview["objectType"]},
            "dispatched":data.dispatched,"ddlState":data.ddl_state,"result":data.result,
            "error":data.error,"cleanupError":data.cleanup_error,"finished":data.finished,
            "releaseState":if data.released {"released"} else {"unconfirmed"}})
    }

    pub(super) async fn check_write(&self, app: &AppState) -> Result<(), String> {
        if self.lock().revoked {
            return Err(INACCESSIBLE.into());
        }
        let request = &self.request;
        if let Some(name) = super::super::connection_readonly_name(app, &request.connection_id).await {
            return Err(format!("Connection '{name}' is read-only; unlock writes before compiling debug information"));
        }
        let configs = app.configs.read().await;
        let config = configs.get(&request.connection_id).ok_or("The original connection no longer exists")?;
        if (crate::production_safety::is_production_database(config, &request.database)
            || crate::production_safety::is_production_database(
                config,
                request.preview["schema"].as_str().unwrap_or_default(),
            ))
            && !request.production_confirmed
        {
            return Err("Production compilation requires confirmation bound to this request".into());
        }
        Ok(())
    }

    pub(super) fn dispatching(&self) -> Result<(), String> {
        let mut data = self.lock();
        if data.revoked {
            return Err(INACCESSIBLE.into());
        }
        data.dispatched = true;
        data.ddl_state = "unknown";
        Ok(())
    }

    pub(super) fn agent_result(&self, value: Value) -> Result<(), String> {
        let state = match value["ddlState"].as_str() {
            Some("not_started") if value["dispatched"] == false => "not_started",
            Some("executed") if value["dispatched"] == true => "executed",
            Some("failed") if value["dispatched"] == true => "failed",
            Some("unknown") if value["dispatched"] == true => "unknown",
            _ => return Err("The original Agent returned an invalid compilation receipt".into()),
        };
        if value["operationId"] != self.request.operation_id || value["finished"] != true {
            return Err("The original Agent did not confirm this compilation operation's completion".into());
        }
        let mut data = self.lock();
        data.dispatched = value["dispatched"] == true;
        data.ddl_state = state;
        if state != "unknown" {
            data.error = None;
        }
        data.result = Some(value);
        Ok(())
    }

    pub(super) fn call_error(&self, error: &AgentCallError) {
        let mut data = self.lock();
        if error.operation_outcome() == AgentOperationOutcome::NotStarted {
            data.dispatched = false;
            data.ddl_state = "not_started";
        }
        data.error = Some(error.to_string());
    }

    pub(super) fn finish(&self, error: Option<String>) {
        let mut data = self.lock();
        data.finished = true;
        if error.is_some() {
            data.error = error;
        }
    }

    pub(super) fn abandoned(&self) {
        let mut data = self.lock();
        if !data.finished {
            data.finished = true;
            data.error = Some("The original compilation task stopped before completing its receipt".into());
        }
    }

    pub(super) fn cleanup_error(&self, error: String) {
        self.lock().cleanup_error = Some(error);
    }
    pub(super) fn released(&self) {
        self.lock().released = true;
    }
}

fn original(
    app: &AppState,
    access: &PlDebugAccess,
    request: &PlDebugCompile,
) -> Result<Option<Arc<Compilation>>, String> {
    let registry = app.pl_debug.lock();
    let Some(existing) = registry.compilations.get(&(access.owner.clone(), request.operation_id.clone())) else {
        return Ok(None);
    };
    if existing.lock().revoked {
        return Err(INACCESSIBLE.into());
    }
    if serde_json::to_value(&existing.request).unwrap() != serde_json::to_value(request).unwrap() {
        return Err("The compilation operation identity belongs to a different request".into());
    }
    Ok(Some(existing.clone()))
}

pub async fn pl_debug_compile_core(
    app: &Arc<AppState>,
    access: &PlDebugAccess,
    request: PlDebugCompile,
) -> Result<Value, String> {
    let admission = pl_debug_prepare_compile_core(app, access, request)
        .await
        .map_err(PlDebugSubmissionError::into_legacy_message)?;
    pl_debug_submit_compile_core(app, access, admission).map_err(PlDebugSubmissionError::into_legacy_message)
}

pub async fn pl_debug_prepare_compile_core(
    app: &Arc<AppState>,
    access: &PlDebugAccess,
    request: PlDebugCompile,
) -> Result<PlDebugCompileAdmission, PlDebugSubmissionError> {
    let epoch = request.server_epoch;
    let key = (access.owner.clone(), request.operation_id.clone());
    prepare_compilation(app, access, request).await.map_err(|message| {
        if epoch != app.pl_debug.epoch || app.pl_debug.lock().compilations.contains_key(&key) {
            PlDebugSubmissionError::Unresolved(message)
        } else {
            PlDebugSubmissionError::RejectedBeforeRegistration(message)
        }
    })
}

async fn prepare_compilation(
    app: &Arc<AppState>,
    access: &PlDebugAccess,
    request: PlDebugCompile,
) -> Result<PlDebugCompileAdmission, String> {
    app.pl_debug.check_epoch(request.server_epoch)?;
    validate_identity(&request.operation_id)?;
    validate_identity(&request.client_session_id)?;
    if let Some(existing) = original(app, access, &request)? {
        return Ok(PlDebugCompileAdmission { compilation: existing, inspection: None, validation: Ok(()) });
    }
    if !request.confirmed || request.preview["canCompile"] != true || !request.preview.is_object() {
        return Err("Confirm the exact debug compilation preview before executing it".into());
    }
    let target = request.target.as_ref().ok_or("A named compilation target is required")?;
    if !matches!(target.object_type.as_str(), "PROCEDURE" | "FUNCTION") || target.object_name.is_empty() {
        return Err("Debug compilation requires an exact named procedure or function".into());
    }
    let mut inspection = PlDebugInspect {
        connection_id: request.connection_id.clone(),
        database: request.database.clone(),
        client_session_id: request.client_session_id.clone(),
        target: request.target.clone(),
    };
    inspection.target.as_mut().unwrap().metadata_preparation = Some("debug_compile".into());
    let admission = inspection::pl_debug_prepare_inspection_core(app, &inspection)
        .await?
        .ok_or("Debug compilation requires a registered Oracle or OceanBase Oracle channel")?;
    if request.expected_connection_revision != connection_revision(app.pl_debug.epoch, &admission.lifecycle) {
        return Err("The connection changed after compilation confirmation; inspect the target again".into());
    }
    let driver_key = dbx_drivers::agent_runtime::db_type_to_agent_key(
        &admission.config.db_type,
        admission.config.driver_profile.as_deref(),
    )
    .ok_or("The original compilation driver is not available")?
    .to_owned();
    let profile_ids =
        admission.config.effective_transport_layers().iter().map(|layer| layer.profile_id().to_owned()).collect();
    let compilation = Arc::new(Compilation {
        request,
        owner: access.owner.clone(),
        credential_owner: access.credential_owner.clone(),
        driver_key,
        profile_ids,
        state: Mutex::new(CompilationState {
            dispatched: false,
            ddl_state: "not_started",
            result: None,
            error: None,
            cleanup_error: None,
            finished: false,
            released: false,
            revoked: false,
        }),
    });
    let validation = with_credential_owner(access.credential_owner.clone(), compilation.check_write(app)).await;
    Ok(PlDebugCompileAdmission { compilation, inspection: Some(admission), validation })
}

pub fn pl_debug_submit_compile_core(
    app: &Arc<AppState>,
    access: &PlDebugAccess,
    prepared: PlDebugCompileAdmission,
) -> Result<Value, PlDebugSubmissionError> {
    let PlDebugCompileAdmission { compilation, inspection, validation } = prepared;
    app.pl_debug.check_epoch(compilation.request.server_epoch)?;
    if compilation.owner != access.owner || compilation.credential_owner != access.credential_owner {
        return Err(INACCESSIBLE.into());
    }
    let admission;
    {
        let mut registry = app.pl_debug.lock();
        if let Some(existing) =
            registry.compilations.get(&(access.owner.clone(), compilation.request.operation_id.clone()))
        {
            if serde_json::to_value(&existing.request).unwrap() != serde_json::to_value(&compilation.request).unwrap() {
                return Err("The compilation operation identity belongs to a different request".into());
            }
            if existing.lock().revoked {
                return Err(INACCESSIBLE.into());
            }
            return Ok(existing.view());
        }
        validation.map_err(PlDebugSubmissionError::RejectedBeforeRegistration)?;
        admission = inspection.ok_or("The original compilation receipt is no longer available")?;
        let connection = &compilation.request.connection_id;
        if !registry.accepting
            || registry.compilations.len() >= MAX_START_IDENTITIES
            || registry.connection_fences.contains_key(connection)
            || registry.connection_drains.contains_key(connection)
            || registry.mutation_permits.values().any(|intent| intent.blocks_start(connection))
            || registry.compilations.values().any(|entry| entry.protects_connection(connection))
            || registry
                .sessions
                .values()
                .any(|entry| entry.start.connection_id == *connection && entry.lock().protects_execution())
            || registry
                .inspections
                .values()
                .any(|owner| owner.request.connection_id == *connection && !owner.resources_quiescent())
            || !app.connection_lifecycle_is_current(connection, &admission.lifecycle)
        {
            return Err(PlDebugSubmissionError::RejectedBeforeRegistration(
                "The original connection is busy or changed; compilation was not registered".into(),
            ));
        }
        registry
            .compilations
            .insert((access.owner.clone(), compilation.request.operation_id.clone()), compilation.clone());
    }
    match inspection::submit_compilation(app, access, admission, compilation.clone()) {
        Ok(submission) => submission.detach(),
        Err(error) => {
            compilation.finish(Some(error));
            compilation.released();
        }
    }
    Ok(compilation.view())
}

pub fn pl_debug_compile_status_core(
    app: &AppState,
    access: &PlDebugAccess,
    reference: PlDebugCompileRef,
) -> Result<Value, String> {
    app.pl_debug.check_epoch(reference.server_epoch)?;
    let registry = app.pl_debug.lock();
    let entry = registry.compilations.get(&(access.owner.clone(), reference.operation_id)).ok_or(INACCESSIBLE)?;
    if entry.lock().revoked
        || entry.request.connection_id != reference.connection_id
        || entry.request.client_session_id != reference.client_session_id
    {
        return Err(INACCESSIBLE.into());
    }
    Ok(entry.view())
}

pub(super) fn revoke(registry: &RegistryState, owner: &AccessOwner) {
    for compilation in registry.compilations.values().filter(|entry| &entry.owner == owner) {
        compilation.lock().revoked = true;
    }
}
