//! Database-link public metadata and one-shot, Agent-local credential execution.
use super::oracle_packages::TransferSchemaObjectItem;
use super::*;
use std::io::Write;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferDatabaseLinkConfig {
    pub object_type: TransferObjectKind,
    pub name: String,
    pub source_owner: String,
    pub target_name: String,
    pub target_scope: String,
    pub authentication: String,
    pub username: String,
    pub host: String,
    pub protocol: Option<String>,
    pub tenant: Option<String>,
    pub cluster: Option<String>,
    #[serde(default)]
    pub credential_available: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferDatabaseLinkCredential {
    pub object_type: TransferObjectKind,
    pub name: String,
    pub password: String,
}

impl std::fmt::Debug for TransferDatabaseLinkCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferDatabaseLinkCredential")
            .field("object_type", &self.object_type).field("name", &self.name)
            .field("password", &"[REDACTED]").finish()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct Definition { owner: String, name: String, username: String, host: String }
struct Planned { item: TransferSchemaObjectItem, config: Option<TransferDatabaseLinkConfig>, existing: Option<Definition> }

pub(super) fn is_link(kind: TransferObjectKind) -> bool {
    matches!(kind, TransferObjectKind::DbLink | TransferObjectKind::PublicDbLink)
}
fn selected(request: &TransferRequest) -> Vec<(TransferObjectKind, String)> {
    let mut links = Vec::new();
    for selection in request.object_selection_mode().selections() {
        if is_link(selection.object_type) {
            for name in &selection.names {
                let key = (selection.object_type, name.clone());
                if !links.contains(&key) { links.push(key); }
            }
        }
    }
    links
}
pub(super) async fn dependency_available(state: &AppState, request: &TransferRequest, pool: &str, owner: &str, name: &str, allow_planned: bool) -> Result<bool, String> {
    let result = metadata(state, pool, &format!("SELECT OWNER, DB_LINK FROM ALL_DB_LINKS WHERE DB_LINK = {} AND (OWNER = {} OR OWNER IN ('PUBLIC', '__public'))", quote_string_literal(name), quote_string_literal(owner))).await?;
    if !result.rows.is_empty() { return Ok(true); }
    Ok(allow_planned && request.database_links.iter().any(|config| {
        config.target_name == name && config.target_name == config.name
            && selected(request).contains(&(config.object_type, config.name.clone()))
            && (config.target_scope == "public" || matches!(config.target_scope.as_str(), "private" | "tenant"))
            && (config.credential_available || credential(request, config.object_type, &config.name).is_ok())
    }))
}
fn valid_name(value: &str) -> bool {
    value.len() <= 128 && Regex::new(r"\A[A-Za-z][A-Za-z0-9_$#]*(?:\.[A-Za-z0-9_$#]+)*\z").unwrap().is_match(value)
}
fn text(row: &[serde_json::Value], index: usize) -> String {
    row.get(index).and_then(|v| v.as_str()).unwrap_or_default().into()
}
async fn metadata(state: &AppState, pool: &str, sql: &str) -> Result<db::QueryResult, String> {
    let result = execute_read_on_pool(state, pool, sql).await.map_err(|_| "DBLINK_METADATA_UNAVAILABLE")?;
    if result.truncated || result.has_more { return Err("DBLINK_METADATA_TRUNCATED".into()); }
    Ok(result)
}
async fn login(state: &AppState, pool: &str) -> Result<String, String> {
    let result = metadata(state, pool, "SELECT USER FROM DUAL").await?;
    let value = result.rows.first().map(|r| text(r, 0)).unwrap_or_default();
    if value.is_empty() { Err("DBLINK_LOGIN_UNKNOWN".into()) } else { Ok(value) }
}
async fn read(state: &AppState, pool: &str, owner: &str, name: &str) -> Result<Option<Definition>, String> {
    let rows = metadata(state, pool, &format!("SELECT OWNER, DB_LINK, USERNAME, HOST FROM ALL_DB_LINKS WHERE OWNER = {} AND DB_LINK = {}", quote_string_literal(owner), quote_string_literal(name))).await?.rows;
    if rows.len() > 1 { return Err("DBLINK_AMBIGUOUS_IDENTITY".into()); }
    Ok(rows.first().map(|row| Definition { owner: text(row, 0), name: text(row, 1), username: text(row, 2), host: text(row, 3) }))
}
fn credential<'a>(request: &'a TransferRequest, kind: TransferObjectKind, name: &str) -> Result<&'a str, String> {
    let entries: Vec<_> = request.database_link_credentials.iter().filter(|c| c.object_type == kind && c.name == name).collect();
    if entries.len() != 1 || entries[0].password.is_empty() { return Err("DBLINK_TARGET_CREDENTIAL_REQUIRED".into()); }
    let value = entries[0].password.as_str();
    if value.contains(['\0', '\r', '\n', '"']) { return Err("DBLINK_CREDENTIAL_FORMAT_UNSUPPORTED".into()); }
    Ok(value)
}
fn validate_config(config: &TransferDatabaseLinkConfig, target: &DatabaseType) -> Result<(), String> {
    if !valid_name(&config.target_name) || config.authentication != "fixedUser" || config.username.is_empty() || config.host.trim().is_empty()
        || [&config.username, &config.host].iter().any(|s| s.contains(['\0', '\r', '\n'])) {
        return Err("DBLINK_TARGET_CONFIGURATION_REQUIRED".into());
    }
    match target {
        DatabaseType::Oracle if matches!(config.target_scope.as_str(), "private" | "public") => {
            if [&config.protocol, &config.tenant, &config.cluster].iter().any(|value| value.as_deref().is_some_and(|v| !v.is_empty())) { return Err("DBLINK_ORACLE_CONFIGURATION_UNSUPPORTED".into()); }
        }
        DatabaseType::OceanbaseOracle if config.target_scope == "tenant" => {
            let protocol = config.protocol.as_deref().unwrap_or_default();
            let tenant = config.tenant.as_deref().unwrap_or_default();
            if !matches!(protocol, "OB" | "OCI") || tenant.is_empty()
                || (protocol == "OCI" && (tenant != "oracle" || config.cluster.as_deref().is_some_and(|v| !v.is_empty()))) {
                return Err("DBLINK_OB_CONFIGURATION_UNSUPPORTED".into());
            }
            if [tenant, config.cluster.as_deref().unwrap_or_default()].iter().any(|s| s.contains(['\0', '\r', '\n'])) { return Err("DBLINK_OB_CONFIGURATION_UNSUPPORTED".into()); }
        }
        _ => return Err("DBLINK_TARGET_SCOPE_UNSUPPORTED".into()),
    }
    Ok(())
}

async fn secure_rpc(state: &AppState, pool: &str, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    if method == "create_database_link_secure_v1" {
        crate::query::check_read_only_for_connection(state, pool, "CREATE DATABASE LINK").await.map_err(|_| "DBLINK_TARGET_READ_ONLY")?;
    }
    let pool = ensure_transfer_statement_pool(state, pool).await.map_err(|_| "DBLINK_AGENT_UNAVAILABLE")?;
    let PoolKind::Agent(client) = pool else { return Err("DBLINK_SECURE_AGENT_REQUIRED".into()); };
    // Deliberately no reconnect/replay wrapper and no raw driver/transport error formatting.
    let result = client.lock().await.call_with_timeout(method, params, Some(std::time::Duration::from_secs(35)))
        .await.map_err(|_| "DBLINK_OUTCOME_UNKNOWN_OR_AGENT_UNSUPPORTED".into());
    result
}
async fn endpoint(state: &AppState, pool: &str, kind: &DatabaseType) -> Result<String, String> {
    if !matches!(kind, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) { return Err("DBLINK_ENDPOINT_UNSUPPORTED".into()); }
    let sql = endpoint_version_sql(kind);
    let rows = metadata(state, pool, sql).await?.rows;
    let version = rows.first().map(|r| text(r, 0)).unwrap_or_default();
    // Only documented/test-target versions are eligible; unknown versions do not inherit support.
    let supported = endpoint_version_supported(kind, &version);
    if !supported { return Err("DBLINK_VERSION_UNSUPPORTED_OR_UNKNOWN".into()); }
    login(state, pool).await
}
fn endpoint_version_sql(kind: &DatabaseType) -> &'static str {
    if *kind == DatabaseType::OceanbaseOracle { "SELECT OB_VERSION() FROM DUAL" }
    else { "SELECT BANNER FROM V$VERSION WHERE BANNER LIKE 'Oracle Database%'" }
}
fn endpoint_version_supported(kind: &DatabaseType, version: &str) -> bool {
    match kind {
        DatabaseType::OceanbaseOracle => Regex::new(r"\A\s*4\.2\.5(?:\.[0-9]+)*(?:\s.*)?\z").unwrap().is_match(version),
        DatabaseType::Oracle => Regex::new(r"Oracle Database (?:19c|21c|23ai|23c)\b").unwrap().is_match(version),
        _ => false,
    }
}
async fn privileges(state: &AppState, pool: &str, database_type: DatabaseType, scope: &str, replace: bool) -> Result<(), String> {
    let privileges: Vec<_> = metadata(state, pool, oracle_packages::creation_privileges_sql(database_type)).await?.rows.iter().map(|r| text(r, 0)).collect();
    let create = if scope == "public" { "CREATE PUBLIC DATABASE LINK" } else { "CREATE DATABASE LINK" };
    if !privileges.iter().any(|p| p == create) || (scope == "public" && replace && !privileges.iter().any(|p| p == "DROP PUBLIC DATABASE LINK")) { return Err("DBLINK_TARGET_PRIVILEGE_REQUIRED".into()); }
    Ok(())
}
async fn build_plan(state: &AppState, request: &TransferRequest, source: &str, target: &str, executing: bool) -> Result<Vec<Planned>, String> {
    let source_type = get_db_type(state, &request.source_connection_id).await?;
    let target_type = get_db_type(state, &request.target_connection_id).await?;
    let mut plan = Vec::new();
    for (kind, name) in selected(request) {
        let mut entry = Planned { item: TransferSchemaObjectItem { execution_phase: None, credential_required: Some(true), object_type: kind, name: name.clone(), source_schema: String::new(), target_schema: String::new(), action: "create".into(), ddl: String::new(), dependencies: Vec::new(), warnings: vec!["Target fixed-user authentication must be configured again; remote connectivity is not tested.".into()], errors: Vec::new() }, config: None, existing: None };
        let preparation: Result<(), String> = async {
            if !valid_name(&name) { return Err("DBLINK_SOURCE_NAME_UNSUPPORTED".into()); }
            let configs: Vec<_> = request.database_links.iter().filter(|c| c.object_type == kind && c.name == name).collect();
            if configs.len() != 1 { return Err("DBLINK_TARGET_CONFIGURATION_REQUIRED".into()); }
            let config = configs[0];
            validate_config(config, &target_type)?;
            if request.database_links.iter().filter(|other| other.target_name == config.target_name && other.target_scope == config.target_scope && selected(request).contains(&(other.object_type, other.name.clone()))).count() != 1 { return Err("DBLINK_DUPLICATE_TARGET_IDENTITY".into()); }
            let source_login = endpoint(state, source, &source_type).await?;
            let target_login = endpoint(state, target, &target_type).await?;
            let source_owner = if kind == TransferObjectKind::PublicDbLink { "PUBLIC" } else { source_login.as_str() };
            if source_type == DatabaseType::OceanbaseOracle && kind == TransferObjectKind::PublicDbLink { return Err("DBLINK_OB_PUBLIC_SOURCE_UNSUPPORTED".into()); }
            if config.source_owner != source_owner { return Err("DBLINK_SOURCE_OWNER_MUST_MATCH_LOGIN_OR_PUBLIC".into()); }
            if read(state, source, source_owner, &name).await?.is_none() { return Err("DBLINK_SOURCE_NOT_VISIBLE".into()); }
            let target_owner = if config.target_scope == "public" { "PUBLIC" } else { target_login.as_str() };
            if config.target_scope == "private" && resolve_oracle_schema(&request.target_schema, &request.target_database) != target_login { return Err("DBLINK_PRIVATE_TARGET_MUST_MATCH_LOGIN".into()); }
            if request.source_connection_id == request.target_connection_id && source_owner == target_owner && name == config.target_name { return Err("DBLINK_SOURCE_AND_TARGET_IDENTICAL".into()); }
            entry.item.source_schema = source_owner.into();
            entry.item.target_schema = target_owner.into();
            entry.existing = read(state, target, target_owner, &config.target_name).await?;
            if entry.existing.is_some() { entry.item.action = if request.object_conflict_policy == TransferObjectConflictPolicy::Skip { "skip" } else { "replace" }.into(); }
            if entry.item.action != "skip" {
                if executing { credential(request, kind, &name)?; } else if !config.credential_available { return Err("DBLINK_TARGET_CREDENTIAL_REQUIRED".into()); }
                privileges(state, target, target_type, &config.target_scope, entry.item.action == "replace").await?;
                let capability = secure_rpc(state, target, "database_link_secure_v1_info", serde_json::json!({})).await.map_err(|_| "DBLINK_SECURE_AGENT_CAPABILITY_UNAVAILABLE")?;
                if capability.get("supported").and_then(|v| v.as_bool()) != Some(true) { return Err("DBLINK_SECURE_AGENT_UNSUPPORTED".into()); }
            } else { entry.item.credential_required = Some(false); }
            // No password placeholders or executable credential SQL in public preview.
            entry.config = Some(config.clone());
            Ok(())
        }.await;
        if let Err(error) = preparation { entry.item.action = "blocked".into(); entry.item.errors.push(error); }
        plan.push(entry);
    }
    Ok(plan)
}
pub(super) async fn preview(state: &AppState, request: &TransferRequest, source: &str, target: &str) -> Result<Option<TransferSchemaObjectPlan>, String> {
    if request.content == TransferContent::DataOnly || selected(request).is_empty() { return Ok(None); }
    let items: Vec<_> = build_plan(state, request, source, target, false).await?.into_iter().map(|p| p.item).collect();
    Ok(Some(TransferSchemaObjectPlan { can_execute: items.iter().all(|p| p.action != "blocked"), items }))
}
pub(super) async fn ensure_ready(state: &AppState, request: &TransferRequest, source: &str, target: &str) -> Result<(), String> {
    if request.content == TransferContent::DataOnly || selected(request).is_empty() { return Ok(()); }
    let plan = build_plan(state, request, source, target, true).await?;
    if plan.iter().any(|p| p.item.action == "blocked") { return Err(plan.iter().flat_map(|p| p.item.errors.clone()).collect::<Vec<_>>().join("; ")); }
    Ok(())
}
fn backup(state: &AppState, definition: &Definition) -> Result<String, String> {
    let directory = state.storage.data_dir().join("transfer-object-backups");
    std::fs::create_dir_all(&directory).map_err(|_| "DBLINK_BACKUP_FAILED")?;
    let path = directory.join(format!("database-link-{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new(); options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&path).map_err(|_| "DBLINK_BACKUP_FAILED")?;
    file.write_all(&serde_json::to_vec(definition).map_err(|_| "DBLINK_BACKUP_FAILED")?).and_then(|_| file.sync_all()).map_err(|_| "DBLINK_BACKUP_FAILED")?;
    Ok(path.to_string_lossy().into_owned())
}
pub(super) async fn execute<F: FnMut(TransferProgress)>(state: &AppState, request: &TransferRequest, source: &str, target: &str, progress: &mut F) -> Result<TransferObjectOutcome, String> {
    if request.content == TransferContent::DataOnly || selected(request).is_empty() { return Ok(TransferObjectOutcome::default()); }
    let plan = build_plan(state, request, source, target, true).await?;
    let blocked = plan.iter().any(|p| p.item.action == "blocked");
    let mut outcome = TransferObjectOutcome::default();
    for entry in plan {
        let item = &entry.item;
        let mut result = TransferSchemaObjectResult { object_type: item.object_type, name: item.name.clone(), schema: item.target_schema.clone(), status: "failed".into(), compile_status: None, source_verified: None, error: None, recovery: None };
        let operation: Result<(), String> = async {
            if blocked { return Err(if item.errors.is_empty() { "DBLINK_PLAN_BLOCKED".into() } else { item.errors.join("; ") }); }
            if is_cancelled(&request.transfer_id).await { return Err("Cancelled before database-link execution".into()); }
            if item.action == "skip" { result.status = "skipped".into(); return Ok(()); }
            let config = entry.config.as_ref().ok_or("DBLINK_PLAN_INCOMPLETE")?;
            let current = read(state, target, &item.target_schema, &config.target_name).await?;
            if current != entry.existing { return Err("DBLINK_TARGET_CHANGED_REPREVIEW_REQUIRED".into()); }
            if let Some(existing) = &current {
                let path = backup(state, existing)?;
                result.recovery = Some(format!("Dictionary owner/name/username/host snapshot retained at {path}. Original password is unavailable. Restore requires explicitly supplied authentication and, for OB, protocol/tenant/cluster configuration. No automatic rollback."));
                let public = if config.target_scope == "public" { "PUBLIC " } else { "" };
                execute_on_pool(state, target, &format!("DROP {public}DATABASE LINK {}", config.target_name)).await.map_err(|_| "DBLINK_DROP_OUTCOME_UNKNOWN")?;
                result.recovery = Some(format!("Original target link was deleted. Dictionary owner/name/username/host snapshot retained at {path}; restore explicitly with original authentication, a newly supplied password and, for OB, protocol/tenant/cluster. No automatic rollback."));
            }
            let password = credential(request, item.object_type, &item.name)?;
            let reply = secure_rpc(state, target, "create_database_link_secure_v1", serde_json::json!({ "name": config.target_name, "scope": config.target_scope, "authentication": config.authentication, "username": config.username, "password": password, "host": config.host, "protocol": config.protocol, "tenant": config.tenant, "cluster": config.cluster })).await?;
            if reply.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                let code = reply.get("errorCode").and_then(|v| v.as_str()).unwrap_or_default();
                let safe = match code { "DBLINK_CREATE_FAILED" | "DBLINK_INVALID_CONFIGURATION" | "DBLINK_MANUAL_TRANSACTION_UNSUPPORTED" | "DBLINK_AGENT_UNSUPPORTED" => code, _ => "DBLINK_OUTCOME_UNKNOWN" };
                return Err(match reply.get("vendorCode").and_then(|v| v.as_i64()) { Some(v) => format!("{safe} (vendor code {v})"), None => safe.into() });
            }
            let actual = read(state, target, &item.target_schema, &config.target_name).await?;
            if !actual.as_ref().is_some_and(|d| d.owner == item.target_schema && d.name == config.target_name && d.username == config.username && d.host == config.host) { return Err("DBLINK_DICTIONARY_READBACK_MISMATCH".into()); }
            result.status = "created".into(); result.source_verified = Some(true);
            Ok(())
        }.await;
        if let Err(error) = operation { result.error = Some(error); }
        let key = format!("{:?}:{}", item.object_type, item.name);
        match result.status.as_str() { "created" => outcome.transferred.push(key), "skipped" => outcome.skipped.push(key), _ => outcome.failed.push(key) }
        progress(TransferProgress { transfer_id: request.transfer_id.clone(), table: format!("schema object: {}", item.name), table_index: request.tables.len(), total_tables: request.tables.len(), rows_transferred: outcome.transferred.len() as u64, total_rows: None, status: if result.error.is_some() { TransferStatus::Error } else { TransferStatus::Running }, error: result.error.clone(), terminal: false, object_result: Some(result.clone()) });
        outcome.object_results.push(result);
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> TransferRequest {
        serde_json::from_value(serde_json::json!({"transferId":"link","sourceConnectionId":"s","sourceDatabase":"S","sourceSchema":"S","targetConnectionId":"t","targetDatabase":"T","targetSchema":"T","tables":[],"createTable":false,"batchSize":10,"objects":[{"objectType":"DB_LINK","names":["REMOTE.EXAMPLE"]}]})).unwrap()
    }
    #[test]
    fn execution_credentials_cannot_roundtrip_into_saved_request() {
        let mut request = request();
        request.database_link_credentials.push(TransferDatabaseLinkCredential { object_type: TransferObjectKind::DbLink, name: "REMOTE.EXAMPLE".into(), password: "marker-secret".into() });
        let serialized = serde_json::to_string(&request).unwrap();
        assert!(!serialized.contains("marker-secret"));
        assert!(!serialized.contains("databaseLinkCredentials"));
        assert!(!format!("{request:?}").contains("marker-secret"));
        let decoded: TransferRequest = serde_json::from_str(&serialized).unwrap();
        assert!(decoded.database_link_credentials.is_empty());
        assert!(credential(&decoded, TransferObjectKind::DbLink, "REMOTE.EXAMPLE").is_err());
    }
    #[test]
    fn credential_debug_never_displays_password() {
        let credential = TransferDatabaseLinkCredential { object_type: TransferObjectKind::DbLink, name: "REMOTE.EXAMPLE".into(), password: "credential-marker".into() };
        assert!(!format!("{credential:?}").contains("credential-marker"));
        assert!(format!("{credential:?}").contains("REDACTED"));
    }
    #[test]
    fn dotted_link_names_remain_single_identifiers() {
        assert!(valid_name("REMOTE.EXAMPLE"));
        assert!(!valid_name("REMOTE; DROP TABLE X"));
        assert!(!valid_name("REMOTE\nEXAMPLE"));
    }
    #[test]
    fn oracle_mode_version_query_and_gate_use_ob_version_results() {
        assert_eq!(endpoint_version_sql(&DatabaseType::OceanbaseOracle), "SELECT OB_VERSION() FROM DUAL");
        assert_eq!(endpoint_version_sql(&DatabaseType::Oracle), "SELECT BANNER FROM V$VERSION WHERE BANNER LIKE 'Oracle Database%'");
        for version in ["4.2.5", "4.2.5.0", "4.2.5.6", " 4.2.5.6 "] { assert!(endpoint_version_supported(&DatabaseType::OceanbaseOracle, version), "{version}"); }
        for version in ["", "4.2.50.0", "4.3.0.0", "3.4.2.5.0", "5.7.25-OceanBase-v4.2.5.0", "4.2.5x"] { assert!(!endpoint_version_supported(&DatabaseType::OceanbaseOracle, version), "{version}"); }
        assert!(endpoint_version_supported(&DatabaseType::Oracle, "Oracle Database 19c Enterprise Edition"));
        assert!(!endpoint_version_supported(&DatabaseType::Oracle, "4.2.5.0"));
        assert!(!endpoint_version_supported(&DatabaseType::Mysql, "4.2.5.0"));
    }
    #[test]
    fn public_config_rejects_credential_fields() {
        assert!(serde_json::from_value::<TransferDatabaseLinkConfig>(serde_json::json!({ "objectType":"DB_LINK", "name":"REMOTE", "sourceOwner":"USER", "targetName":"REMOTE", "targetScope":"private", "authentication":"fixedUser", "username":"REMOTEUSER", "host":"remote", "password":"secret" })).is_err());
    }
    #[test]
    fn scopes_require_explicit_supported_target_configuration() {
        let mut config: TransferDatabaseLinkConfig = serde_json::from_value(serde_json::json!({ "objectType":"DB_LINK", "name":"REMOTE", "sourceOwner":"USER", "targetName":"REMOTE", "targetScope":"tenant", "authentication":"fixedUser", "username":"REMOTEUSER", "host":"remote", "protocol":"OB", "tenant":"remoteTenant" })).unwrap();
        assert!(validate_config(&config, &DatabaseType::OceanbaseOracle).is_ok());
        assert!(validate_config(&config, &DatabaseType::Oracle).is_err());
        config.target_scope = "public".into();
        assert!(validate_config(&config, &DatabaseType::OceanbaseOracle).is_err());
        config.protocol = None; config.tenant = None;
        assert!(validate_config(&config, &DatabaseType::Oracle).is_ok());
        config.authentication = "currentUser".into();
        assert!(validate_config(&config, &DatabaseType::Oracle).is_err());
    }
    #[test]
    fn execution_rejects_missing_empty_and_duplicate_credentials() {
        let mut request = request();
        assert!(credential(&request, TransferObjectKind::DbLink, "REMOTE.EXAMPLE").is_err());
        let mut secret = TransferDatabaseLinkCredential { object_type: TransferObjectKind::DbLink, name: "REMOTE.EXAMPLE".into(), password: String::new() };
        request.database_link_credentials.push(secret.clone());
        assert!(credential(&request, TransferObjectKind::DbLink, "REMOTE.EXAMPLE").is_err());
        secret.password = "marker-secret".into(); request.database_link_credentials = vec![secret.clone()];
        assert!(credential(&request, TransferObjectKind::DbLink, "REMOTE.EXAMPLE").is_ok());
        request.database_link_credentials.push(secret);
        assert!(credential(&request, TransferObjectKind::DbLink, "REMOTE.EXAMPLE").is_err());
    }
}
