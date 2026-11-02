use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use crate::nacos::port::NacosAdmin;
use crate::nacos::types::*;

const PAGE_SIZE: u32 = 500;
const OPERATION_TTL: Duration = Duration::from_secs(30 * 60);
const ADMIN_ROLE: &str = "ROLE_ADMIN";

#[derive(Clone, Debug)]
enum StepCommand {
    CreateUser { username: String },
    DeleteUser { username: String },
    DeleteCreatedUser { username: String },
    AssignRole { username: String, role: String, undo_removal: RoleRemovalMode },
    RemoveRole { username: String, role: String, mode: RoleRemovalMode },
    GrantPermission(NacosPermissionInfo),
    RevokePermission(NacosPermissionInfo),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RoleRemovalMode {
    PreserveRole,
    DeleteRole,
}

#[derive(Clone, Copy)]
enum ExecutionStrategy {
    ContinueAfterFailure,
    StopAfterFailure,
}

fn operation_for_command(command: &StepCommand) -> NacosAccessControlOperation {
    match command {
        StepCommand::CreateUser { .. } => NacosAccessControlOperation::CreateUser,
        StepCommand::DeleteUser { .. } | StepCommand::DeleteCreatedUser { .. } => {
            NacosAccessControlOperation::DeleteUser
        }
        StepCommand::AssignRole { .. } => NacosAccessControlOperation::AssignRole,
        StepCommand::RemoveRole { .. } => NacosAccessControlOperation::RemoveRole,
        StepCommand::GrantPermission(_) => NacosAccessControlOperation::GrantPermission,
        StepCommand::RevokePermission(_) => NacosAccessControlOperation::RevokePermission,
    }
}

fn ensure_commands_supported(
    capabilities: &NacosAccessControlCapabilities,
    commands: &[StepCommand],
) -> Result<(), String> {
    for command in commands {
        let operation = operation_for_command(command);
        let capability = capabilities.operation(operation);
        if !capability.supported {
            return Err(format!(
                "NACOS_ERROR[unsupportedOperation]: Nacos access-control operation {operation:?} is unavailable ({:?})",
                capability.reason.unwrap_or(NacosCapabilityReason::NotVerified)
            ));
        }
    }
    Ok(())
}

type OperationPlan = (Vec<StepCommand>, HashMap<String, String>, bool);
type ValidatedMembers = (Vec<String>, HashMap<String, String>, Vec<StepCommand>);

#[derive(Clone)]
struct StoredOperation {
    connection_id: String,
    connection_fingerprint: String,
    result: NacosAccessOperationResult,
    failed: Vec<(usize, StepCommand)>,
    undo: Vec<StepCommand>,
    undoable: bool,
    execution_strategy: ExecutionStrategy,
    expires_at: Instant,
}

fn operations() -> &'static Mutex<HashMap<String, StoredOperation>> {
    static OPERATIONS: OnceLock<Mutex<HashMap<String, StoredOperation>>> = OnceLock::new();
    OPERATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn connection_operation_lock(connection_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    let mut locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap_or_else(|error| error.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(connection_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(connection_id.to_string(), Arc::downgrade(&lock));
    lock
}

fn cleanup_operations(registry: &mut HashMap<String, StoredOperation>) {
    let now = Instant::now();
    registry.retain(|_, operation| operation.expires_at > now);
}

pub async fn load_snapshot(admin: Arc<dyn NacosAdmin>) -> Result<NacosAccessControlSnapshot, String> {
    let (mut users, role_bindings, permissions, namespaces) = tokio::try_join!(
        list_all_users(admin.clone()),
        list_all_role_bindings(admin.clone()),
        list_all_permissions(admin.clone()),
        admin.list_namespaces(),
    )?;

    let mut roles_by_user: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for binding in &role_bindings {
        roles_by_user.entry(binding.username.clone()).or_default().push(binding.role.clone());
    }
    for user in &mut users {
        if let Some(roles) = roles_by_user.get_mut(&user.username) {
            roles.sort();
            roles.dedup();
            user.roles = roles.clone();
        }
    }

    let mut summaries: BTreeMap<String, NacosRoleSummary> = BTreeMap::new();
    for binding in &role_bindings {
        let summary = summaries.entry(binding.role.clone()).or_insert_with(|| role_summary(&binding.role));
        summary.member_count += 1;
    }
    for permission in &permissions {
        let summary = summaries.entry(permission.role.clone()).or_insert_with(|| role_summary(&permission.role));
        summary.permission_count += 1;
    }
    for summary in summaries.values_mut() {
        summary.complete = summary.administrator || (summary.member_count > 0 && summary.permission_count > 0);
    }

    Ok(NacosAccessControlSnapshot {
        users,
        role_bindings,
        permissions,
        roles: summaries.into_values().collect(),
        namespaces,
        current_username: admin.current_username(),
    })
}

fn role_summary(role: &str) -> NacosRoleSummary {
    NacosRoleSummary {
        role: role.to_string(),
        member_count: 0,
        permission_count: 0,
        complete: false,
        administrator: role == ADMIN_ROLE,
    }
}

async fn list_all_users(admin: Arc<dyn NacosAdmin>) -> Result<Vec<NacosUserInfo>, String> {
    let mut items = Vec::new();
    let mut page_no = 1;
    loop {
        let page = admin
            .list_users(NacosUserQuery { username: None, page_no: Some(page_no), page_size: Some(PAGE_SIZE) })
            .await?;
        let count = page.items.len();
        items.extend(page.items);
        if count < PAGE_SIZE as usize || items.len() as u64 >= page.total_count {
            break;
        }
        page_no += 1;
    }
    items.sort_by(|left, right| left.username.cmp(&right.username));
    items.dedup_by(|left, right| left.username == right.username);
    Ok(items)
}

async fn list_all_role_bindings(admin: Arc<dyn NacosAdmin>) -> Result<Vec<NacosRoleBinding>, String> {
    let mut items = Vec::new();
    let mut page_no = 1;
    loop {
        let page = admin
            .list_role_bindings(NacosRoleQuery {
                username: None,
                role: None,
                page_no: Some(page_no),
                page_size: Some(PAGE_SIZE),
            })
            .await?;
        let count = page.items.len();
        items.extend(page.items);
        if count < PAGE_SIZE as usize || items.len() as u64 >= page.total_count {
            break;
        }
        page_no += 1;
    }
    items.sort_by(|left, right| (&left.role, &left.username).cmp(&(&right.role, &right.username)));
    items.dedup_by(|left, right| left.role == right.role && left.username == right.username);
    Ok(items)
}

async fn list_all_permissions(admin: Arc<dyn NacosAdmin>) -> Result<Vec<NacosPermissionInfo>, String> {
    let mut items = Vec::new();
    let mut page_no = 1;
    loop {
        let page = admin
            .list_permissions(NacosPermissionQuery {
                role: None,
                resource: None,
                page_no: Some(page_no),
                page_size: Some(PAGE_SIZE),
            })
            .await?;
        let count = page.items.len();
        items.extend(page.items);
        if count < PAGE_SIZE as usize || items.len() as u64 >= page.total_count {
            break;
        }
        page_no += 1;
    }
    items.sort_by(|left, right| {
        (&left.role, &left.resource_raw, &left.action_raw).cmp(&(&right.role, &right.resource_raw, &right.action_raw))
    });
    items.dedup();
    Ok(items)
}

pub fn effective_permissions(snapshot: &NacosAccessControlSnapshot, username: &str) -> Vec<NacosEffectivePermission> {
    let roles: BTreeSet<&str> = snapshot
        .role_bindings
        .iter()
        .filter(|binding| binding.username == username)
        .map(|binding| binding.role.as_str())
        .collect();
    if roles.contains(ADMIN_ROLE) {
        return vec![NacosEffectivePermission {
            resource_raw: "*:*:*".to_string(),
            action: "rw".to_string(),
            parsed_scope: Some(NacosPermissionScope { kind: NacosPermissionScopeKind::Global, namespace_id: None }),
            source_roles: vec![ADMIN_ROLE.to_string()],
        }];
    }

    let mut grouped: BTreeMap<String, NacosEffectivePermission> = BTreeMap::new();
    for permission in snapshot.permissions.iter().filter(|permission| roles.contains(permission.role.as_str())) {
        let entry = grouped.entry(effective_permission_key(permission)).or_insert_with(|| NacosEffectivePermission {
            resource_raw: permission.resource_raw.clone(),
            action: permission.action_raw.clone(),
            parsed_scope: permission.parsed_scope.clone(),
            source_roles: Vec::new(),
        });
        if entry.resource_raw == ":*:*" && permission.resource_raw == "public:*:*" {
            entry.resource_raw = permission.resource_raw.clone();
        }
        entry.action = merge_actions(&entry.action, &permission.action_raw);
        entry.source_roles.push(permission.role.clone());
    }
    for permission in grouped.values_mut() {
        permission.source_roles.sort();
        permission.source_roles.dedup();
    }
    grouped.into_values().collect()
}

fn effective_permission_key(permission: &NacosPermissionInfo) -> String {
    match permission.parsed_scope.as_ref() {
        Some(scope) if scope.kind == NacosPermissionScopeKind::Namespace => {
            format!("namespace:{}", scope.namespace_id.as_deref().unwrap_or_default())
        }
        _ if matches!(permission.resource_raw.as_str(), ":*:*" | "public:*:*") => "namespace:public".to_string(),
        _ => format!("raw:{}", permission.resource_raw),
    }
}

fn merge_actions(left: &str, right: &str) -> String {
    if left == right {
        return left.to_string();
    }
    let reads = matches!(left, "r" | "rw") || matches!(right, "r" | "rw");
    let writes = matches!(left, "w" | "rw") || matches!(right, "w" | "rw");
    match (reads, writes) {
        (true, true) => "rw".to_string(),
        (true, false) => "r".to_string(),
        (false, true) => "w".to_string(),
        _ => right.to_string(),
    }
}

pub async fn start_operation(
    connection_id: &str,
    connection_fingerprint: String,
    admin: Arc<dyn NacosAdmin>,
    request: NacosAccessOperationRequest,
) -> Result<(NacosAccessOperationResult, bool), String> {
    let operation_lock = connection_operation_lock(connection_id);
    let _operation_guard = operation_lock.lock().await;
    let snapshot = load_snapshot(admin.clone()).await?;
    let execution_strategy = execution_strategy_for_request(&request);
    let (commands, credentials, undoable) = plan_operation(&snapshot, request)?;
    let capabilities = admin.refresh_access_control_capabilities().await;
    ensure_commands_supported(&capabilities, &commands)?;
    let operation_id = uuid::Uuid::new_v4().to_string();
    let stored = execute_commands(
        connection_id,
        connection_fingerprint,
        &operation_id,
        admin,
        commands,
        &credentials,
        undoable,
        execution_strategy,
    )
    .await;
    let state_changed = stored.result.steps.iter().any(|step| step.status == NacosAccessOperationStepStatus::Succeeded);
    let result = stored.result.clone();
    let mut registry = operations().lock().unwrap_or_else(|error| error.into_inner());
    cleanup_operations(&mut registry);
    registry.insert(operation_id, stored);
    Ok((result, state_changed))
}

fn execution_strategy_for_request(request: &NacosAccessOperationRequest) -> ExecutionStrategy {
    match request {
        // Compound workflows are deliberately ordered. Once a prerequisite
        // fails, later commands must remain retryable instead of executing
        // against a partially updated role or user.
        NacosAccessOperationRequest::CreateUser { .. }
        | NacosAccessOperationRequest::CreateRole { .. }
        | NacosAccessOperationRequest::UpdateUserRoles { .. }
        | NacosAccessOperationRequest::UpdateRole { .. }
        | NacosAccessOperationRequest::DeleteUser { .. }
        | NacosAccessOperationRequest::DeleteRole { .. } => ExecutionStrategy::StopAfterFailure,
        _ => ExecutionStrategy::ContinueAfterFailure,
    }
}

pub fn get_operation(
    connection_id: &str,
    connection_fingerprint: &str,
    operation_id: &str,
) -> Result<NacosAccessOperationResult, String> {
    let mut registry = operations().lock().unwrap_or_else(|error| error.into_inner());
    cleanup_operations(&mut registry);
    let operation =
        registry.get(operation_id).ok_or_else(|| "Nacos access operation was not found or expired".to_string())?;
    if operation.connection_id != connection_id || operation.connection_fingerprint != connection_fingerprint {
        return Err("Nacos access operation was not found or expired".to_string());
    }
    Ok(operation.result.clone())
}

pub async fn retry_operation(
    connection_id: &str,
    connection_fingerprint: String,
    admin: Arc<dyn NacosAdmin>,
    retry: NacosAccessOperationRetry,
) -> Result<(NacosAccessOperationResult, bool), String> {
    let operation_lock = connection_operation_lock(connection_id);
    let _operation_guard = operation_lock.lock().await;
    let stored = {
        let mut registry = operations().lock().unwrap_or_else(|error| error.into_inner());
        cleanup_operations(&mut registry);
        registry
            .get(&retry.operation_id)
            .filter(|operation| {
                operation.connection_id == connection_id && operation.connection_fingerprint == connection_fingerprint
            })
            .cloned()
            .ok_or_else(|| "Nacos access operation was not found or expired".to_string())?
    };
    if stored.failed.is_empty() {
        return Ok((stored.result, false));
    }
    let snapshot = load_snapshot(admin.clone()).await?;
    let credentials: HashMap<String, String> = retry
        .credentials
        .into_iter()
        .map(|credential| (credential.username.trim().to_string(), credential.password))
        .collect();
    let commands: Vec<StepCommand> = stored.failed.iter().map(|(_, command)| command.clone()).collect();
    let capabilities = admin.refresh_access_control_capabilities().await;
    ensure_commands_supported(&capabilities, &commands)?;
    validate_replayed_commands(&snapshot, &commands)?;
    let retried = execute_commands(
        connection_id,
        connection_fingerprint,
        &retry.operation_id,
        admin,
        commands,
        &credentials,
        stored.undoable,
        stored.execution_strategy,
    )
    .await;
    let state_changed =
        retried.result.steps.iter().any(|step| step.status == NacosAccessOperationStepStatus::Succeeded);
    let mut next = stored.clone();
    let original_failures = stored.failed;
    for ((original_index, _), retry_step) in original_failures.iter().zip(&retried.result.steps) {
        let mut step = retry_step.clone();
        step.id = next.result.steps[*original_index].id.clone();
        next.result.steps[*original_index] = step;
    }
    next.failed =
        retried.failed.into_iter().map(|(retry_index, command)| (original_failures[retry_index].0, command)).collect();
    next.undo.extend(retried.undo);
    let succeeded =
        next.result.steps.iter().filter(|step| step.status == NacosAccessOperationStepStatus::Succeeded).count();
    next.result.status = if next.failed.is_empty() {
        NacosAccessOperationStatus::Succeeded
    } else if succeeded == 0 {
        NacosAccessOperationStatus::Failed
    } else {
        NacosAccessOperationStatus::Partial
    };
    next.result.can_retry = !next.failed.is_empty();
    next.result.can_undo = !next.undo.is_empty();
    next.expires_at = Instant::now() + OPERATION_TTL;
    let result = next.result.clone();
    operations().lock().unwrap_or_else(|error| error.into_inner()).insert(retry.operation_id, next);
    Ok((result, state_changed))
}

pub async fn undo_operation(
    connection_id: &str,
    connection_fingerprint: String,
    admin: Arc<dyn NacosAdmin>,
    operation_id: &str,
) -> Result<(NacosAccessOperationResult, bool), String> {
    let operation_lock = connection_operation_lock(connection_id);
    let _operation_guard = operation_lock.lock().await;
    let stored = {
        let mut registry = operations().lock().unwrap_or_else(|error| error.into_inner());
        cleanup_operations(&mut registry);
        registry
            .get(operation_id)
            .filter(|operation| {
                operation.connection_id == connection_id && operation.connection_fingerprint == connection_fingerprint
            })
            .cloned()
            .ok_or_else(|| "Nacos access operation was not found or expired".to_string())?
    };
    if !stored.result.can_undo {
        return Err("This Nacos access operation cannot be undone".to_string());
    }
    let commands: Vec<_> = stored.undo.into_iter().rev().collect();
    let snapshot = load_snapshot(admin.clone()).await?;
    let capabilities = admin.refresh_access_control_capabilities().await;
    ensure_commands_supported(&capabilities, &commands)?;
    validate_replayed_commands(&snapshot, &commands)?;
    let mut undone = execute_commands(
        connection_id,
        connection_fingerprint,
        operation_id,
        admin,
        commands,
        &HashMap::new(),
        false,
        ExecutionStrategy::StopAfterFailure,
    )
    .await;
    let state_changed = undone.result.steps.iter().any(|step| step.status == NacosAccessOperationStepStatus::Succeeded);
    for step in &mut undone.result.steps {
        if step.status == NacosAccessOperationStepStatus::Succeeded {
            step.status = NacosAccessOperationStepStatus::Compensated;
        }
    }
    undone.result.status =
        if undone.failed.is_empty() { NacosAccessOperationStatus::Undone } else { NacosAccessOperationStatus::Partial };
    let result = undone.result.clone();
    operations().lock().unwrap_or_else(|error| error.into_inner()).insert(operation_id.to_string(), undone);
    Ok((result, state_changed))
}

fn validate_replayed_commands(snapshot: &NacosAccessControlSnapshot, commands: &[StepCommand]) -> Result<(), String> {
    let mut bindings: BTreeSet<(String, String)> =
        snapshot.role_bindings.iter().map(|binding| (binding.username.clone(), binding.role.clone())).collect();
    let mut permissions: BTreeSet<NacosPermissionInfo> = snapshot.permissions.iter().cloned().collect();
    for command in commands {
        match command {
            StepCommand::RevokePermission(permission) => {
                // A role has no independent Nacos entity. Once its permissions are gone,
                // removing its final binding completes a role deletion rather than leaving
                // a memberless role behind.
                permissions.remove(permission);
            }
            StepCommand::RemoveRole { username, role, mode } => {
                if !bindings.contains(&(username.clone(), role.clone())) {
                    continue;
                }
                if *mode == RoleRemovalMode::PreserveRole
                    && snapshot.current_username.as_deref() == Some(username.as_str())
                {
                    return Err(
                        "Retrying or undoing a current-account role removal requires a new confirmation".to_string()
                    );
                }
                let member_count = bindings.iter().filter(|(_, bound_role)| bound_role == role).count();
                validate_role_removal_count(role, member_count, *mode)?;
                bindings.remove(&(username.clone(), role.clone()));
            }
            StepCommand::DeleteUser { username } | StepCommand::DeleteCreatedUser { username } => {
                let user_exists = snapshot.users.iter().any(|user| user.username == *username);
                if matches!(command, StepCommand::DeleteCreatedUser { .. }) && !user_exists {
                    continue;
                }
                if !user_exists {
                    return Err(format!("Nacos user {username} no longer exists"));
                }
                if snapshot.current_username.as_deref() == Some(username.as_str()) {
                    return Err("Retrying deletion of the current account requires a new confirmation".to_string());
                }
                let roles: Vec<_> = bindings
                    .iter()
                    .filter(|(bound_username, _)| bound_username == username)
                    .map(|(_, role)| role.clone())
                    .collect();
                if matches!(command, StepCommand::DeleteCreatedUser { .. }) && !roles.is_empty() {
                    return Err(format!(
                        "Cannot undo creation of Nacos user {username} because it now has external role bindings: {}",
                        roles.join(", ")
                    ));
                }
                for role in roles {
                    let member_count = bindings.iter().filter(|(_, bound_role)| bound_role == &role).count();
                    if role == ADMIN_ROLE && member_count <= 1 {
                        return Err("At least one ROLE_ADMIN member must remain".to_string());
                    }
                }
                bindings.retain(|(bound_username, _)| bound_username != username);
            }
            _ => {}
        }
    }
    Ok(())
}

fn plan_operation(
    snapshot: &NacosAccessControlSnapshot,
    request: NacosAccessOperationRequest,
) -> Result<OperationPlan, String> {
    match request {
        NacosAccessOperationRequest::CreateUser { username, password, roles, confirmation } => {
            let username = required(&username, "Nacos username")?;
            if password.is_empty() {
                return Err("Nacos password is required".to_string());
            }
            if snapshot.users.iter().any(|user| user.username == username) {
                return Err(format!("Nacos user {username} already exists"));
            }
            let roles = unique_strings(roles);
            validate_assignable_roles(snapshot, &roles)?;
            if roles.iter().any(|role| role == ADMIN_ROLE) && confirmation.as_deref() != Some(username.as_str()) {
                return Err("Assigning ROLE_ADMIN requires typing the target username".to_string());
            }
            let mut commands = vec![StepCommand::CreateUser { username: username.clone() }];
            commands.extend(roles.into_iter().map(|role| StepCommand::AssignRole {
                username: username.clone(),
                role,
                undo_removal: RoleRemovalMode::PreserveRole,
            }));
            Ok((commands, HashMap::from([(username, password)]), true))
        }
        NacosAccessOperationRequest::CreateRole { role, members, new_users, permissions, confirmation } => {
            let role = required(&role, "Nacos role")?;
            if role == ADMIN_ROLE {
                return Err("ROLE_ADMIN is reserved and cannot be created".to_string());
            }
            if snapshot.roles.iter().any(|item| item.role == role) {
                return Err(format!("Nacos role {role} already exists"));
            }
            let (members, credentials, mut commands) = validate_members(snapshot, members, new_users)?;
            let permissions = expand_permissions(&role, permissions)?;
            if members.is_empty() || permissions.is_empty() {
                return Err("A role requires at least one member and one namespace permission".to_string());
            }
            let anchor = members[0].clone();
            commands.push(StepCommand::AssignRole {
                username: anchor.clone(),
                role: role.clone(),
                undo_removal: RoleRemovalMode::DeleteRole,
            });
            commands.extend(permissions.into_iter().map(StepCommand::GrantPermission));
            commands.extend(members.into_iter().skip(1).map(|username| StepCommand::AssignRole {
                username,
                role: role.clone(),
                undo_removal: RoleRemovalMode::DeleteRole,
            }));
            let _ = confirmation;
            Ok((commands, credentials, true))
        }
        NacosAccessOperationRequest::UpdateUserRoles { username, roles, confirmation } => {
            let username = required(&username, "Nacos username")?;
            let user = snapshot
                .users
                .iter()
                .find(|user| user.username == username)
                .ok_or_else(|| format!("Nacos user {username} does not exist"))?;
            validate_assignable_roles(snapshot, &roles)?;
            let desired: BTreeSet<_> = unique_strings(roles).into_iter().collect();
            let current: BTreeSet<_> = user.roles.iter().cloned().collect();
            validate_role_removals(snapshot, &username, &current, &desired, confirmation.as_deref())?;
            if desired.contains(ADMIN_ROLE)
                && !current.contains(ADMIN_ROLE)
                && confirmation.as_deref() != Some(username.as_str())
            {
                return Err("Assigning ROLE_ADMIN requires typing the target username".to_string());
            }
            let mut commands: Vec<_> = desired
                .difference(&current)
                .map(|role| StepCommand::AssignRole {
                    username: username.clone(),
                    role: role.clone(),
                    undo_removal: RoleRemovalMode::PreserveRole,
                })
                .collect();
            commands.extend(current.difference(&desired).map(|role| StepCommand::RemoveRole {
                username: username.clone(),
                role: role.clone(),
                mode: RoleRemovalMode::PreserveRole,
            }));
            Ok((commands, HashMap::new(), false))
        }
        NacosAccessOperationRequest::UpdateRole { role, members, new_users, permissions, confirmation } => {
            let role = required(&role, "Nacos role")?;
            if !snapshot.roles.iter().any(|item| item.role == role) {
                return Err(format!("Nacos role {role} does not exist"));
            }
            let (members, credentials, mut commands) = validate_members(snapshot, members, new_users)?;
            let current_members: BTreeSet<_> = snapshot
                .role_bindings
                .iter()
                .filter(|binding| binding.role == role)
                .map(|binding| binding.username.clone())
                .collect();
            let desired_members: BTreeSet<_> = members.into_iter().collect();
            if role == ADMIN_ROLE {
                if desired_members.is_empty() {
                    return Err("At least one ROLE_ADMIN member must remain".to_string());
                }
                validate_admin_member_change(snapshot, &current_members, &desired_members, confirmation.as_deref())?;
            }
            let desired_permissions: BTreeSet<_> = if role == ADMIN_ROLE {
                BTreeSet::new()
            } else {
                let expanded = expand_permissions(&role, permissions)?;
                if expanded.is_empty() {
                    return Err("A role requires at least one namespace permission".to_string());
                }
                expanded.into_iter().collect()
            };
            let current_managed: BTreeSet<_> = snapshot
                .permissions
                .iter()
                .filter(|permission| permission.role == role)
                .filter(|permission| {
                    permission
                        .parsed_scope
                        .as_ref()
                        .is_some_and(|scope| scope.kind == NacosPermissionScopeKind::Namespace)
                })
                .cloned()
                .collect();
            commands.extend(desired_members.difference(&current_members).map(|username| StepCommand::AssignRole {
                username: username.clone(),
                role: role.clone(),
                undo_removal: RoleRemovalMode::PreserveRole,
            }));
            commands
                .extend(desired_permissions.difference(&current_managed).cloned().map(StepCommand::GrantPermission));
            commands
                .extend(current_managed.difference(&desired_permissions).cloned().map(StepCommand::RevokePermission));
            commands.extend(current_members.difference(&desired_members).map(|username| StepCommand::RemoveRole {
                username: username.clone(),
                role: role.clone(),
                mode: RoleRemovalMode::PreserveRole,
            }));
            Ok((commands, credentials, false))
        }
        NacosAccessOperationRequest::DeleteUser { username, confirmation } => {
            let username = required(&username, "Nacos username")?;
            if !snapshot.users.iter().any(|user| user.username == username) {
                return Err(format!("Nacos user {username} does not exist"));
            }
            if confirmation.as_deref() != Some(username.as_str()) {
                return Err("Deleting a user requires typing its username".to_string());
            }
            let current: BTreeSet<_> = snapshot
                .role_bindings
                .iter()
                .filter(|binding| binding.username == username)
                .map(|binding| binding.role.clone())
                .collect();
            validate_role_removals(snapshot, &username, &current, &BTreeSet::new(), confirmation.as_deref())?;
            let mut commands: Vec<_> = current
                .into_iter()
                .map(|role| StepCommand::RemoveRole {
                    username: username.clone(),
                    role,
                    mode: RoleRemovalMode::PreserveRole,
                })
                .collect();
            commands.push(StepCommand::DeleteUser { username });
            Ok((commands, HashMap::new(), false))
        }
        NacosAccessOperationRequest::DeleteRole { role, confirmation } => {
            let role = required(&role, "Nacos role")?;
            if role == ADMIN_ROLE {
                return Err("ROLE_ADMIN cannot be deleted".to_string());
            }
            if confirmation.as_deref() != Some(role.as_str()) {
                return Err("Deleting a role requires typing its role name".to_string());
            }
            if !snapshot.roles.iter().any(|item| item.role == role) {
                return Err(format!("Nacos role {role} does not exist"));
            }
            let mut commands: Vec<_> = snapshot
                .permissions
                .iter()
                .filter(|permission| permission.role == role)
                .cloned()
                .map(StepCommand::RevokePermission)
                .collect();
            commands.extend(snapshot.role_bindings.iter().filter(|binding| binding.role == role).map(|binding| {
                StepCommand::RemoveRole {
                    username: binding.username.clone(),
                    role: role.clone(),
                    mode: RoleRemovalMode::DeleteRole,
                }
            }));
            Ok((commands, HashMap::new(), false))
        }
        NacosAccessOperationRequest::RevokePermission { permission, confirmation } => {
            if !snapshot.permissions.contains(&permission) {
                return Err("The Nacos permission no longer exists".to_string());
            }
            if permission.role == ADMIN_ROLE {
                return Err("ROLE_ADMIN permissions are built into Nacos and cannot be revoked".to_string());
            }
            if confirmation.as_deref() != Some(permission.role.as_str()) {
                return Err("Revoking a raw permission requires typing its role name".to_string());
            }
            Ok((vec![StepCommand::RevokePermission(permission)], HashMap::new(), false))
        }
    }
}

fn validate_members(
    snapshot: &NacosAccessControlSnapshot,
    members: Vec<String>,
    new_users: Vec<NacosNewUserDraft>,
) -> Result<ValidatedMembers, String> {
    let existing_users: BTreeSet<_> = snapshot.users.iter().map(|user| user.username.as_str()).collect();
    let mut normalized = unique_strings(members);
    for member in &normalized {
        if !existing_users.contains(member.as_str()) {
            return Err(format!("Nacos user {member} does not exist"));
        }
    }
    let mut credentials = HashMap::new();
    let mut commands = Vec::new();
    for user in new_users {
        let username = required(&user.username, "Nacos username")?;
        if user.password.is_empty() {
            return Err(format!("Password is required for new user {username}"));
        }
        if existing_users.contains(username.as_str())
            || normalized.contains(&username)
            || credentials.contains_key(&username)
        {
            return Err(format!("Nacos user {username} is duplicated or already exists"));
        }
        credentials.insert(username.clone(), user.password);
        commands.push(StepCommand::CreateUser { username: username.clone() });
        normalized.push(username);
    }
    Ok((normalized, credentials, commands))
}

fn validate_assignable_roles(snapshot: &NacosAccessControlSnapshot, roles: &[String]) -> Result<(), String> {
    for role in unique_strings(roles.to_vec()) {
        let summary = snapshot
            .roles
            .iter()
            .find(|item| item.role == role)
            .ok_or_else(|| format!("Nacos role {role} does not exist"))?;
        if !summary.complete && summary.permission_count == 0 {
            return Err(format!("Nacos role {role} has no permissions and must be repaired before assignment"));
        }
    }
    Ok(())
}

fn validate_role_removals(
    snapshot: &NacosAccessControlSnapshot,
    username: &str,
    current: &BTreeSet<String>,
    desired: &BTreeSet<String>,
    confirmation: Option<&str>,
) -> Result<(), String> {
    for role in current.difference(desired) {
        let count = snapshot.role_bindings.iter().filter(|binding| binding.role == *role).count();
        if role == ADMIN_ROLE && count <= 1 {
            return Err(format!("Add another member to {role} before removing its last member"));
        }
        if role == ADMIN_ROLE
            && snapshot.current_username.as_deref() == Some(username)
            && confirmation != Some(username)
        {
            return Err("Changing the current administrator requires typing the current username".to_string());
        }
    }
    if snapshot.current_username.as_deref() == Some(username) && current != desired && confirmation != Some(username) {
        return Err("Changing the current account requires typing the current username".to_string());
    }
    Ok(())
}

fn validate_role_removal_count(role: &str, member_count: usize, mode: RoleRemovalMode) -> Result<(), String> {
    if role == ADMIN_ROLE && (mode == RoleRemovalMode::DeleteRole || member_count <= 1) {
        return Err("At least one ROLE_ADMIN member must remain".to_string());
    }
    Ok(())
}

fn validate_admin_member_change(
    snapshot: &NacosAccessControlSnapshot,
    current: &BTreeSet<String>,
    desired: &BTreeSet<String>,
    confirmation: Option<&str>,
) -> Result<(), String> {
    let adds_administrator = desired.difference(current).next().is_some();
    if let Some(current_username) = snapshot.current_username.as_deref() {
        if current.contains(current_username)
            && !desired.contains(current_username)
            && confirmation != Some(current_username)
        {
            return Err("Removing the current administrator requires typing the current username".to_string());
        }
        if adds_administrator && confirmation != Some(ADMIN_ROLE) && confirmation != Some(current_username) {
            return Err("Assigning ROLE_ADMIN requires typing ROLE_ADMIN".to_string());
        }
    } else if adds_administrator && confirmation != Some(ADMIN_ROLE) {
        return Err("Assigning ROLE_ADMIN requires typing ROLE_ADMIN".to_string());
    }
    Ok(())
}

fn expand_permissions(role: &str, drafts: Vec<NacosPermissionDraft>) -> Result<Vec<NacosPermissionInfo>, String> {
    let mut namespaces = BTreeSet::new();
    let mut permissions = Vec::new();
    for draft in drafts {
        let action = draft.action.trim().to_ascii_lowercase();
        if !matches!(action.as_str(), "r" | "w" | "rw") {
            return Err("Permission action must be r, w, or rw".to_string());
        }
        for namespace_id in draft.namespace_ids {
            let namespace_id = namespace_id.trim();
            let normalized = if namespace_id.is_empty() || namespace_id == "public" { "public" } else { namespace_id };
            if !namespaces.insert(normalized.to_string()) {
                return Err(format!("Namespace {normalized} is selected more than once"));
            }
            // Nacos Console persists the default namespace explicitly as
            // `public:*:*`. Keep DBX-generated rules in that canonical form
            // so they remain identical when viewed in the official console.
            let resource_raw = format!("{normalized}:*:*");
            permissions.push(NacosPermissionInfo {
                role: role.to_string(),
                resource_raw,
                action_raw: action.clone(),
                parsed_scope: Some(NacosPermissionScope {
                    kind: NacosPermissionScopeKind::Namespace,
                    namespace_id: Some(normalized.to_string()),
                }),
            });
        }
    }
    Ok(permissions)
}

async fn execute_commands(
    connection_id: &str,
    connection_fingerprint: String,
    operation_id: &str,
    admin: Arc<dyn NacosAdmin>,
    commands: Vec<StepCommand>,
    credentials: &HashMap<String, String>,
    undoable: bool,
    execution_strategy: ExecutionStrategy,
) -> StoredOperation {
    let mut result = NacosAccessOperationResult {
        operation_id: operation_id.to_string(),
        status: NacosAccessOperationStatus::Running,
        steps: commands.iter().enumerate().map(|(index, command)| step_for_command(index, command)).collect(),
        can_retry: false,
        can_undo: false,
    };
    let mut failed = Vec::new();
    let mut undo = Vec::new();
    let mut blocked = false;
    for (index, command) in commands.into_iter().enumerate() {
        if blocked {
            result.steps[index].status = NacosAccessOperationStepStatus::Skipped;
            result.steps[index].message = Some("Skipped because an earlier required step failed".to_string());
            result.steps[index].needs_password = matches!(command, StepCommand::CreateUser { .. });
            failed.push((index, command));
            continue;
        }
        result.steps[index].status = NacosAccessOperationStepStatus::Running;
        let execution = match validate_command_before_execution(admin.clone(), &command).await {
            Ok(()) => execute_command_reconciled(admin.clone(), &command, credentials).await,
            Err(error) => Err(error),
        };
        match execution {
            Ok(()) => {
                result.steps[index].status = NacosAccessOperationStepStatus::Succeeded;
                if undoable {
                    if let Some(inverse) = inverse_command(&command) {
                        undo.push(inverse);
                    }
                }
            }
            Err(message) => {
                result.steps[index].status = NacosAccessOperationStepStatus::Failed;
                result.steps[index].message = Some(message);
                result.steps[index].needs_password = matches!(command, StepCommand::CreateUser { .. });
                failed.push((index, command));
                blocked = matches!(execution_strategy, ExecutionStrategy::StopAfterFailure);
            }
        }
    }
    let succeeded = result.steps.iter().filter(|step| step.status == NacosAccessOperationStepStatus::Succeeded).count();
    result.status = if failed.is_empty() {
        NacosAccessOperationStatus::Succeeded
    } else if succeeded == 0 {
        NacosAccessOperationStatus::Failed
    } else {
        NacosAccessOperationStatus::Partial
    };
    result.can_retry = !failed.is_empty();
    result.can_undo = undoable && !undo.is_empty();
    StoredOperation {
        connection_id: connection_id.to_string(),
        connection_fingerprint,
        result,
        failed,
        undo,
        undoable,
        execution_strategy,
        expires_at: Instant::now() + OPERATION_TTL,
    }
}

/// Connection teardown and configuration replacement must make old retry and
/// undo records unusable before a new adapter can target another server.
pub fn invalidate_operations(connection_id: &str) {
    let mut registry = operations().lock().unwrap_or_else(|error| error.into_inner());
    registry.retain(|_, operation| operation.connection_id != connection_id);
}

async fn validate_command_before_execution(admin: Arc<dyn NacosAdmin>, command: &StepCommand) -> Result<(), String> {
    match command {
        StepCommand::RemoveRole { username, role, mode } => {
            let bindings = list_all_role_bindings(admin).await?;
            if !bindings.iter().any(|binding| binding.username == *username && binding.role == *role) {
                return Ok(());
            }
            let member_count = bindings.iter().filter(|binding| binding.role == *role).count();
            validate_role_removal_count(role, member_count, *mode)
        }
        StepCommand::DeleteUser { username } | StepCommand::DeleteCreatedUser { username } => {
            let bindings = list_all_role_bindings(admin).await?;
            if bindings.iter().any(|binding| binding.username == *username) {
                return Err(format!("Remove every role binding from {username} before deleting the user"));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn execute_command(
    admin: &dyn NacosAdmin,
    command: &StepCommand,
    credentials: &HashMap<String, String>,
) -> Result<(), String> {
    match command {
        StepCommand::CreateUser { username } => {
            let password = credentials
                .get(username)
                .filter(|password| !password.is_empty())
                .ok_or_else(|| format!("Password must be entered again for {username}"))?;
            admin
                .create_user(NacosUserCreate {
                    username: username.clone(),
                    password: password.clone(),
                    nickname: None,
                    enabled: None,
                    roles: Vec::new(),
                    namespace_privilege: None,
                })
                .await
        }
        StepCommand::DeleteUser { username } => admin.delete_user(username.clone()).await,
        StepCommand::DeleteCreatedUser { username } => {
            let bindings = admin
                .list_role_bindings(NacosRoleQuery {
                    username: Some(username.clone()),
                    role: None,
                    page_no: Some(1),
                    page_size: Some(PAGE_SIZE),
                })
                .await?;
            if bindings.items.iter().any(|binding| binding.username == *username) {
                return Err(format!("User {username} has role bindings that were not created by this operation"));
            }
            admin.delete_user(username.clone()).await
        }
        StepCommand::AssignRole { username, role, .. } => {
            admin.assign_role(NacosRoleBinding { username: username.clone(), role: role.clone() }).await
        }
        StepCommand::RemoveRole { username, role, .. } => {
            admin.remove_role(NacosRoleBinding { username: username.clone(), role: role.clone() }).await
        }
        StepCommand::GrantPermission(permission) => admin.grant_permission(permission.clone()).await,
        StepCommand::RevokePermission(permission) => admin.revoke_permission(permission.clone()).await,
    }
}

async fn execute_command_reconciled(
    admin: Arc<dyn NacosAdmin>,
    command: &StepCommand,
    credentials: &HashMap<String, String>,
) -> Result<(), String> {
    match execute_command(admin.as_ref(), command, credentials).await {
        Ok(()) => Ok(()),
        Err(error) if is_timeout_error(&error) => {
            if command_is_satisfied(admin, command).await.unwrap_or(false) {
                Ok(())
            } else {
                Err(error)
            }
        }
        Err(error) => Err(error),
    }
}

fn is_timeout_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("timeout") || error.contains("timed out")
}

async fn command_is_satisfied(admin: Arc<dyn NacosAdmin>, command: &StepCommand) -> Result<bool, String> {
    match command {
        StepCommand::CreateUser { username } => {
            let users = list_all_users(admin).await?;
            Ok(users.iter().any(|user| user.username == *username))
        }
        StepCommand::DeleteUser { username } | StepCommand::DeleteCreatedUser { username } => {
            let users = list_all_users(admin).await?;
            Ok(users.iter().all(|user| user.username != *username))
        }
        StepCommand::AssignRole { username, role, .. } | StepCommand::RemoveRole { username, role, .. } => {
            let present = list_all_role_bindings(admin)
                .await?
                .iter()
                .any(|binding| binding.username == *username && binding.role == *role);
            Ok(if matches!(command, StepCommand::AssignRole { .. }) { present } else { !present })
        }
        StepCommand::GrantPermission(permission) | StepCommand::RevokePermission(permission) => {
            let present = list_all_permissions(admin).await?.contains(permission);
            Ok(if matches!(command, StepCommand::GrantPermission(_)) { present } else { !present })
        }
    }
}

fn inverse_command(command: &StepCommand) -> Option<StepCommand> {
    match command {
        StepCommand::CreateUser { username } => Some(StepCommand::DeleteCreatedUser { username: username.clone() }),
        StepCommand::AssignRole { username, role, undo_removal } => {
            Some(StepCommand::RemoveRole { username: username.clone(), role: role.clone(), mode: *undo_removal })
        }
        StepCommand::GrantPermission(permission) => Some(StepCommand::RevokePermission(permission.clone())),
        _ => None,
    }
}

fn step_for_command(index: usize, command: &StepCommand) -> NacosAccessOperationStep {
    let (action, target) = match command {
        StepCommand::CreateUser { username } => ("createUser", username.clone()),
        StepCommand::DeleteUser { username } | StepCommand::DeleteCreatedUser { username } => {
            ("deleteUser", username.clone())
        }
        StepCommand::AssignRole { username, role, .. } => ("assignRole", format!("{username} · {role}")),
        StepCommand::RemoveRole { username, role, .. } => ("removeRole", format!("{username} · {role}")),
        StepCommand::GrantPermission(permission) => (
            "grantPermission",
            format!("{} · {} · {}", permission.role, permission.resource_raw, permission.action_raw),
        ),
        StepCommand::RevokePermission(permission) => (
            "revokePermission",
            format!("{} · {} · {}", permission.role, permission.resource_raw, permission.action_raw),
        ),
    };
    NacosAccessOperationStep {
        id: format!("step-{}", index + 1),
        action: action.to_string(),
        target,
        status: NacosAccessOperationStepStatus::Pending,
        retryable: true,
        needs_password: false,
        message: None,
    }
}

fn required(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(value.to_string())
    }
}

fn unique_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_capabilities_are_checked_per_mutation() {
        let mut capabilities = NacosAccessControlCapabilities::unavailable(NacosCapabilityReason::PermissionDenied);
        capabilities.grant_permission = NacosOperationCapability::supported();
        let permission = NacosPermissionInfo {
            role: "ops".to_string(),
            resource_raw: "team-a:*:*".to_string(),
            action_raw: "r".to_string(),
            parsed_scope: None,
        };

        assert!(ensure_commands_supported(&capabilities, &[StepCommand::GrantPermission(permission)]).is_ok());
        let error =
            ensure_commands_supported(&capabilities, &[StepCommand::CreateUser { username: "alice".to_string() }])
                .unwrap_err();
        assert!(error.contains("CreateUser"));
        assert!(error.contains("PermissionDenied"));
    }

    #[test]
    fn combines_read_and_write_from_multiple_roles() {
        let snapshot = NacosAccessControlSnapshot {
            users: Vec::new(),
            role_bindings: vec![
                NacosRoleBinding { username: "alice".to_string(), role: "reader".to_string() },
                NacosRoleBinding { username: "alice".to_string(), role: "writer".to_string() },
            ],
            permissions: vec![permission("reader", "team:*:*", "r"), permission("writer", "team:*:*", "w")],
            roles: Vec::new(),
            namespaces: Vec::new(),
            current_username: None,
        };
        let effective = effective_permissions(&snapshot, "alice");
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].action, "rw");
        assert_eq!(effective[0].source_roles, vec!["reader", "writer"]);
    }

    #[test]
    fn combines_legacy_and_canonical_public_namespace_permissions() {
        let snapshot = NacosAccessControlSnapshot {
            users: Vec::new(),
            role_bindings: vec![
                NacosRoleBinding { username: "alice".to_string(), role: "reader".to_string() },
                NacosRoleBinding { username: "alice".to_string(), role: "writer".to_string() },
            ],
            permissions: vec![
                NacosPermissionInfo {
                    role: "reader".to_string(),
                    resource_raw: ":*:*".to_string(),
                    action_raw: "r".to_string(),
                    parsed_scope: Some(NacosPermissionScope {
                        kind: NacosPermissionScopeKind::Namespace,
                        namespace_id: Some("public".to_string()),
                    }),
                },
                permission("writer", "public:*:*", "w"),
            ],
            roles: Vec::new(),
            namespaces: Vec::new(),
            current_username: None,
        };
        let effective = effective_permissions(&snapshot, "alice");
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].resource_raw, "public:*:*");
        assert_eq!(effective[0].action, "rw");
    }

    #[test]
    fn permission_drafts_reject_duplicate_namespaces() {
        let error = expand_permissions(
            "ops",
            vec![
                NacosPermissionDraft { namespace_ids: vec!["public".to_string()], action: "r".to_string() },
                NacosPermissionDraft { namespace_ids: vec!["public".to_string()], action: "w".to_string() },
            ],
        )
        .unwrap_err();
        assert!(error.contains("selected more than once"));
    }

    #[test]
    fn deleting_any_user_requires_exact_typed_username_confirmation() {
        let mut snapshot = snapshot_with_user("alice");
        snapshot.current_username = None;
        let error = plan_operation(
            &snapshot,
            NacosAccessOperationRequest::DeleteUser {
                username: "alice".to_string(),
                confirmation: Some("Alice".to_string()),
            },
        )
        .unwrap_err();
        assert!(error.contains("typing its username"));

        let (commands, _, _) = plan_operation(
            &snapshot,
            NacosAccessOperationRequest::DeleteUser {
                username: "alice".to_string(),
                confirmation: Some("alice".to_string()),
            },
        )
        .unwrap();
        assert!(matches!(commands.as_slice(), [StepCommand::DeleteUser { username }] if username == "alice"));
    }

    #[test]
    fn removing_the_last_regular_role_member_preserves_its_permissions() {
        let mut snapshot = snapshot_with_user("alice");
        snapshot.current_username = None;
        snapshot.role_bindings.push(NacosRoleBinding { username: "alice".to_string(), role: "ops".to_string() });
        snapshot.users[0].roles.push("ops".to_string());
        snapshot.roles.push(NacosRoleSummary {
            role: "ops".to_string(),
            member_count: 1,
            permission_count: 1,
            complete: true,
            administrator: false,
        });
        let (commands, _, _) = plan_operation(
            &snapshot,
            NacosAccessOperationRequest::UpdateUserRoles {
                username: "alice".to_string(),
                roles: Vec::new(),
                confirmation: None,
            },
        )
        .unwrap();
        assert!(matches!(
            commands.as_slice(),
            [StepCommand::RemoveRole { username, role, mode: RoleRemovalMode::PreserveRole }]
                if username == "alice" && role == "ops"
        ));
    }

    #[test]
    fn role_creation_binds_an_anchor_before_granting_permissions() {
        let snapshot = snapshot_with_user("alice");
        let (commands, _, undoable) = plan_operation(
            &snapshot,
            NacosAccessOperationRequest::CreateRole {
                role: "ops".to_string(),
                members: vec!["alice".to_string()],
                new_users: Vec::new(),
                permissions: vec![NacosPermissionDraft {
                    namespace_ids: vec!["public".to_string()],
                    action: "rw".to_string(),
                }],
                confirmation: None,
            },
        )
        .unwrap();
        assert!(undoable);
        assert!(
            matches!(&commands[0], StepCommand::AssignRole { username, role, .. } if username == "alice" && role == "ops")
        );
        assert!(
            matches!(&commands[1], StepCommand::GrantPermission(permission) if permission.resource_raw == "public:*:*")
        );
    }

    #[test]
    fn creating_an_administrator_with_whitespace_still_requires_confirmation() {
        let mut snapshot = snapshot_with_user("alice");
        snapshot.roles.push(NacosRoleSummary {
            role: ADMIN_ROLE.to_string(),
            member_count: 1,
            permission_count: 0,
            complete: true,
            administrator: true,
        });
        let error = plan_operation(
            &snapshot,
            NacosAccessOperationRequest::CreateUser {
                username: "bob".to_string(),
                password: "secret".to_string(),
                roles: vec![" ROLE_ADMIN ".to_string()],
                confirmation: None,
            },
        )
        .unwrap_err();
        assert!(error.contains("Assigning ROLE_ADMIN"));
    }

    #[test]
    fn compound_operations_stop_after_a_prerequisite_failure() {
        let requests = [
            NacosAccessOperationRequest::CreateUser {
                username: "alice".to_string(),
                password: "secret".to_string(),
                roles: vec!["ops".to_string()],
                confirmation: None,
            },
            NacosAccessOperationRequest::CreateRole {
                role: "ops".to_string(),
                members: vec!["alice".to_string()],
                new_users: Vec::new(),
                permissions: Vec::new(),
                confirmation: None,
            },
            NacosAccessOperationRequest::UpdateUserRoles {
                username: "alice".to_string(),
                roles: Vec::new(),
                confirmation: None,
            },
            NacosAccessOperationRequest::UpdateRole {
                role: "ops".to_string(),
                members: Vec::new(),
                new_users: Vec::new(),
                permissions: Vec::new(),
                confirmation: None,
            },
            NacosAccessOperationRequest::DeleteUser { username: "alice".to_string(), confirmation: None },
            NacosAccessOperationRequest::DeleteRole { role: "ops".to_string(), confirmation: None },
        ];
        for request in requests {
            assert!(matches!(execution_strategy_for_request(&request), ExecutionStrategy::StopAfterFailure));
        }
    }

    #[test]
    fn role_removal_modes_distinguish_edits_from_role_deletion() {
        assert!(validate_role_removal_count("ops", 1, RoleRemovalMode::PreserveRole).is_ok());
        assert!(validate_role_removal_count("ops", 1, RoleRemovalMode::DeleteRole).is_ok());

        let admin_error = validate_role_removal_count(ADMIN_ROLE, 2, RoleRemovalMode::DeleteRole).unwrap_err();
        assert!(admin_error.contains("ROLE_ADMIN"));
        assert!(validate_role_removal_count(ADMIN_ROLE, 2, RoleRemovalMode::PreserveRole).is_ok());
        assert!(validate_role_removal_count(ADMIN_ROLE, 1, RoleRemovalMode::PreserveRole).is_err());
    }

    #[test]
    fn operation_locks_are_shared_only_within_a_connection() {
        let first = connection_operation_lock("connection-a");
        let same = connection_operation_lock("connection-a");
        let other = connection_operation_lock("connection-b");

        assert!(Arc::ptr_eq(&first, &same));
        assert!(!Arc::ptr_eq(&first, &other));
    }

    #[test]
    fn operations_cannot_be_reused_after_the_connection_identity_changes() {
        let operation_id = "fingerprint-check".to_string();
        let mut registry = operations().lock().unwrap_or_else(|error| error.into_inner());
        registry.insert(
            operation_id.clone(),
            StoredOperation {
                connection_id: "nacos".to_string(),
                connection_fingerprint: "server-a".to_string(),
                result: NacosAccessOperationResult {
                    operation_id: operation_id.clone(),
                    status: NacosAccessOperationStatus::Succeeded,
                    steps: Vec::new(),
                    can_retry: false,
                    can_undo: false,
                },
                failed: Vec::new(),
                undo: Vec::new(),
                undoable: false,
                execution_strategy: ExecutionStrategy::StopAfterFailure,
                expires_at: Instant::now() + OPERATION_TTL,
            },
        );
        drop(registry);

        assert!(get_operation("nacos", "server-a", &operation_id).is_ok());
        assert!(get_operation("nacos", "server-b", &operation_id).is_err());

        invalidate_operations("nacos");
        assert!(get_operation("nacos", "server-a", &operation_id).is_err());
    }

    #[test]
    fn retrying_user_deletion_rechecks_new_role_bindings() {
        let mut snapshot = snapshot_with_user("alice");
        snapshot.current_username = None;
        snapshot.role_bindings.push(NacosRoleBinding { username: "alice".to_string(), role: ADMIN_ROLE.to_string() });
        let error = validate_replayed_commands(&snapshot, &[StepCommand::DeleteUser { username: "alice".to_string() }])
            .unwrap_err();
        assert!(error.contains("ROLE_ADMIN"));
    }

    #[test]
    fn retrying_current_user_deletion_requires_a_new_confirmation() {
        let snapshot = snapshot_with_user("alice");
        let error = validate_replayed_commands(&snapshot, &[StepCommand::DeleteUser { username: "alice".to_string() }])
            .unwrap_err();
        assert!(error.contains("current account"));
    }

    #[test]
    fn undoing_user_creation_rejects_external_role_bindings() {
        let mut snapshot = snapshot_with_user("alice");
        snapshot.current_username = None;
        snapshot
            .role_bindings
            .push(NacosRoleBinding { username: "alice".to_string(), role: "external-role".to_string() });

        let error =
            validate_replayed_commands(&snapshot, &[StepCommand::DeleteCreatedUser { username: "alice".to_string() }])
                .unwrap_err();
        assert!(error.contains("external-role"));
    }

    #[test]
    fn undoing_user_creation_is_idempotent_when_the_user_is_already_absent() {
        let mut snapshot = snapshot_with_user("alice");
        snapshot.users.clear();
        snapshot.current_username = None;

        assert!(validate_replayed_commands(
            &snapshot,
            &[StepCommand::DeleteCreatedUser { username: "alice".to_string() }],
        )
        .is_ok());
    }

    fn snapshot_with_user(username: &str) -> NacosAccessControlSnapshot {
        NacosAccessControlSnapshot {
            users: vec![NacosUserInfo {
                username: username.to_string(),
                nickname: None,
                enabled: None,
                roles: Vec::new(),
                namespace_privilege: None,
                source: None,
            }],
            role_bindings: Vec::new(),
            permissions: Vec::new(),
            roles: Vec::new(),
            namespaces: Vec::new(),
            current_username: Some(username.to_string()),
        }
    }

    fn permission(role: &str, resource: &str, action: &str) -> NacosPermissionInfo {
        NacosPermissionInfo {
            role: role.to_string(),
            resource_raw: resource.to_string(),
            action_raw: action.to_string(),
            parsed_scope: None,
        }
    }
}
