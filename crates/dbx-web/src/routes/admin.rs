//! Web 用户权限体系管理 API。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use dbx_core::persistence::access_control::{
    normalize_username, BlacklistEntry, DepartmentRecord, RoleRecord, UserSummary, BLACKLIST_KIND_IP,
    BLACKLIST_KIND_USER,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

use crate::auth::verify_password;
use crate::request_context::{current_request_user, RequestUser};
use crate::state::WebState;

const MIN_PASSWORD_LEN: usize = 6;

#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
    pub department_id: Option<i64>,
    #[serde(default)]
    pub role_ids: Vec<i64>,
    #[serde(default)]
    pub is_admin: bool,
}

#[derive(Debug, Default)]
struct Nullable<T>(Option<Option<T>>);

impl<'de, T> Deserialize<'de> for Nullable<T>
where
    T: Deserialize<'de>,
{
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Option::<T>::deserialize(deserializer).map(|value| Self(Some(value)))
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct UpdateUserRequest {
    #[serde(default)]
    display_name: Nullable<String>,
    #[serde(default)]
    department_id: Nullable<i64>,
    pub role_ids: Option<Vec<i64>>,
    pub status: Option<i64>,
    pub is_admin: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct ResetPasswordRequest {
    pub new_password: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateDepartmentRequest {
    pub name: String,
    #[serde(default)]
    pub sort: i64,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDepartmentRequest {
    pub name: Option<String>,
    pub sort: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct RoleScope {
    #[serde(default)]
    pub allowed_group_ids: Vec<String>,
    #[serde(default)]
    pub allowed_connection_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
    pub description: Option<String>,
    pub permissions: Vec<String>,
    pub scope: RoleScope,
}

#[derive(Debug, Default, Deserialize)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    #[serde(default)]
    description: Nullable<String>,
    pub permissions: Option<Vec<String>>,
    pub scope: Option<RoleScope>,
}

#[derive(Debug, Deserialize)]
pub struct CreateBlacklistRequest {
    pub kind: String,
    pub value: String,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
struct UserRoleResponse {
    id: i64,
    name: String,
}

#[derive(Debug, Serialize)]
struct UserResponse {
    id: i64,
    username: String,
    display_name: Option<String>,
    department_id: Option<i64>,
    department_name: Option<String>,
    is_admin: bool,
    status: i64,
    must_change_password: bool,
    password_updated_at: i64,
    created_at: i64,
    updated_at: i64,
    roles: Vec<UserRoleResponse>,
}

#[derive(Debug, Serialize)]
struct DepartmentListResponse {
    id: i64,
    name: String,
    sort: i64,
    created_at: i64,
    user_count: i64,
}

#[derive(Debug, Serialize)]
struct DepartmentResponse {
    id: i64,
    name: String,
    sort: i64,
    created_at: i64,
}

#[derive(Debug, Serialize)]
struct RoleResponse {
    id: i64,
    name: String,
    description: Option<String>,
    permissions: Vec<String>,
    scope: RoleScope,
    created_at: i64,
    updated_at: i64,
    user_count: i64,
}

#[derive(Debug, Serialize)]
struct BlacklistResponse {
    id: i64,
    kind: String,
    value: String,
    reason: Option<String>,
    created_by: Option<String>,
    created_at: i64,
}

#[derive(Debug, Serialize)]
struct ScopeTreeResponse {
    nodes: Vec<ScopeNode>,
    ungrouped: Vec<ScopeNode>,
}

#[derive(Debug, Serialize)]
struct ScopeNode {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<ScopeNode>>,
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn error_response(status: StatusCode, code: &str) -> Response {
    json_response(status, json!({"error": code}))
}

fn internal_error(operation: &str, error: String) -> Response {
    log::error!("admin API {operation} failed: {error}");
    error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
}

fn storage_write_error(operation: &str, error: String) -> Response {
    if error.contains("UNIQUE constraint failed") {
        error_response(StatusCode::CONFLICT, "already_exists")
    } else if error.contains("not found") {
        error_response(StatusCode::NOT_FOUND, "not_found")
    } else {
        internal_error(operation, error)
    }
}

fn require_admin(state: &WebState) -> Result<RequestUser, Response> {
    if let Some(response) = state.admin_gating_response() {
        return Err(response);
    }
    match current_request_user() {
        Some(user) if user.is_admin => Ok(user),
        _ => Err(error_response(StatusCode::FORBIDDEN, "admin_required")),
    }
}

fn role_response(role: RoleRecord) -> RoleResponse {
    RoleResponse {
        id: role.id,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        scope: RoleScope {
            allowed_group_ids: role.allowed_group_ids,
            allowed_connection_ids: role.allowed_connection_ids,
        },
        created_at: role.created_at,
        updated_at: role.updated_at,
        user_count: role.user_count,
    }
}

fn department_response(department: DepartmentRecord) -> DepartmentResponse {
    DepartmentResponse {
        id: department.id,
        name: department.name,
        sort: department.sort,
        created_at: department.created_at,
    }
}

async fn load_user_responses(state: &WebState) -> Result<Vec<UserResponse>, Response> {
    let users = state.app.storage.list_users().await.map_err(|error| internal_error("list users", error))?;
    let roles = state.app.storage.list_roles().await.map_err(|error| internal_error("list roles", error))?;
    let role_ids = roles.into_iter().map(|role| (role.name, role.id)).collect::<HashMap<_, _>>();
    Ok(users.into_iter().map(|user| user_response(user, &role_ids)).collect())
}

fn user_response(user: UserSummary, role_ids: &HashMap<String, i64>) -> UserResponse {
    UserResponse {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        department_id: user.department_id,
        department_name: user.department_name,
        is_admin: user.is_admin,
        status: i64::from(user.status),
        must_change_password: user.must_change_password,
        password_updated_at: user.password_updated_at,
        created_at: user.created_at,
        updated_at: user.updated_at,
        roles: user
            .roles
            .into_iter()
            .filter_map(|name| role_ids.get(&name).copied().map(|id| UserRoleResponse { id, name }))
            .collect(),
    }
}

async fn load_user_response(state: &WebState, user_id: i64) -> Result<UserResponse, Response> {
    load_user_responses(state)
        .await?
        .into_iter()
        .find(|user| user.id == user_id)
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "not_found"))
}

async fn validate_role_ids(state: &WebState, role_ids: &[i64]) -> Result<(), Response> {
    let roles = state.app.storage.list_roles().await.map_err(|error| internal_error("validate roles", error))?;
    let known = roles.into_iter().map(|role| role.id).collect::<HashSet<_>>();
    if role_ids.iter().all(|role_id| known.contains(role_id)) {
        Ok(())
    } else {
        Err(error_response(StatusCode::BAD_REQUEST, "invalid_role"))
    }
}

async fn remove_user_sessions(state: &WebState, predicate: impl Fn(&crate::state::UserSession) -> bool) {
    let mut removed = Vec::new();
    {
        let mut sessions = state.sessions.write().await;
        sessions.retain(|token, session| {
            if predicate(session) {
                removed.push(token.clone());
                false
            } else {
                true
            }
        });
    }
    for token in removed {
        state.app.session_credentials.clear_owner(&token);
    }
}

pub async fn list_users(State(state): State<Arc<WebState>>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    match load_user_responses(&state).await {
        Ok(users) => (StatusCode::OK, Json(users)).into_response(),
        Err(response) => response,
    }
}

pub async fn create_user(State(state): State<Arc<WebState>>, Json(body): Json<CreateUserRequest>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    let username = match normalize_username(&body.username) {
        Ok(username) => username,
        Err(_) => return error_response(StatusCode::BAD_REQUEST, "invalid_username"),
    };
    if body.password.chars().count() < MIN_PASSWORD_LEN {
        return error_response(StatusCode::BAD_REQUEST, "weak_password");
    }
    if let Err(response) = validate_role_ids(&state, &body.role_ids).await {
        return response;
    }
    let password_hash = match crate::auth::hash_password(&body.password) {
        Ok(hash) => hash,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };
    let user_id = match state
        .app
        .storage
        .create_user(&username, &password_hash, body.display_name.as_deref(), body.department_id, body.is_admin)
        .await
    {
        Ok(user_id) => user_id,
        Err(error) => return storage_write_error("create user", error),
    };
    if let Err(error) = state.app.storage.set_user_roles(user_id, &body.role_ids).await {
        let _ = state.app.storage.delete_user(user_id).await;
        return storage_write_error("set user roles", error);
    }
    state.set_user_system_ready(true);
    state.invalidate_permission_cache_user(user_id).await;
    match load_user_response(&state, user_id).await {
        Ok(user) => (StatusCode::CREATED, Json(user)).into_response(),
        Err(response) => response,
    }
}

pub async fn update_user(
    State(state): State<Arc<WebState>>,
    Path(user_id): Path<i64>,
    Json(body): Json<UpdateUserRequest>,
) -> Response {
    let admin = match require_admin(&state) {
        Ok(admin) => admin,
        Err(response) => return response,
    };
    if admin.user_id == user_id && (body.status.is_some() || body.is_admin.is_some()) {
        return error_response(StatusCode::FORBIDDEN, "self_forbidden");
    }
    let current = match state.app.storage.get_user_by_id(user_id).await {
        Ok(Some(user)) => user,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "not_found"),
        Err(error) => return internal_error("load user", error),
    };
    let status = match body.status {
        Some(0) => false,
        Some(1) => true,
        Some(_) => return error_response(StatusCode::BAD_REQUEST, "invalid_status"),
        None => current.status,
    };
    if let Some(role_ids) = body.role_ids.as_deref() {
        if let Err(response) = validate_role_ids(&state, role_ids).await {
            return response;
        }
    }
    let display_name = body.display_name.0.unwrap_or(current.display_name);
    let department_id = body.department_id.0.unwrap_or(current.department_id);
    let is_admin = body.is_admin.unwrap_or(current.is_admin);
    if let Err(error) =
        state.app.storage.update_user_profile(user_id, display_name.as_deref(), department_id, is_admin).await
    {
        return storage_write_error("update user", error);
    }
    if status != current.status {
        if let Err(error) = state.app.storage.update_user_status(user_id, status).await {
            return storage_write_error("update user status", error);
        }
    }
    if let Some(role_ids) = body.role_ids.as_deref() {
        if let Err(error) = state.app.storage.set_user_roles(user_id, role_ids).await {
            return storage_write_error("set user roles", error);
        }
    }
    state.invalidate_permission_cache_user(user_id).await;
    if !status {
        remove_user_sessions(&state, |session| session.user_id == user_id).await;
    }
    match load_user_response(&state, user_id).await {
        Ok(user) => (StatusCode::OK, Json(user)).into_response(),
        Err(response) => response,
    }
}

pub async fn reset_user_password(
    State(state): State<Arc<WebState>>,
    Path(user_id): Path<i64>,
    Json(body): Json<ResetPasswordRequest>,
) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    if body.new_password.chars().count() < MIN_PASSWORD_LEN {
        return error_response(StatusCode::BAD_REQUEST, "weak_password");
    }
    let password_hash = match crate::auth::hash_password(&body.new_password) {
        Ok(hash) => hash,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
    };
    match state.app.storage.set_user_password(user_id, &password_hash, true).await {
        Ok(()) => json_response(StatusCode::OK, json!({"ok": true})),
        Err(error) => storage_write_error("reset user password", error),
    }
}

pub async fn delete_user(State(state): State<Arc<WebState>>, Path(user_id): Path<i64>) -> Response {
    let admin = match require_admin(&state) {
        Ok(admin) => admin,
        Err(response) => return response,
    };
    if admin.user_id == user_id {
        return error_response(StatusCode::FORBIDDEN, "self_forbidden");
    }
    match state.app.storage.delete_user(user_id).await {
        Ok(()) => {
            state.invalidate_permission_cache_user(user_id).await;
            remove_user_sessions(&state, |session| session.user_id == user_id).await;
            json_response(StatusCode::OK, json!({"ok": true}))
        }
        Err(error) => storage_write_error("delete user", error),
    }
}

pub async fn list_departments(State(state): State<Arc<WebState>>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    match state.app.storage.list_departments().await {
        Ok(departments) => {
            let body = departments
                .into_iter()
                .map(|department| DepartmentListResponse {
                    id: department.id,
                    name: department.name,
                    sort: department.sort,
                    created_at: department.created_at,
                    user_count: department.user_count,
                })
                .collect::<Vec<_>>();
            (StatusCode::OK, Json(body)).into_response()
        }
        Err(error) => internal_error("list departments", error),
    }
}

pub async fn create_department(
    State(state): State<Arc<WebState>>,
    Json(body): Json<CreateDepartmentRequest>,
) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    let department_id = match state.app.storage.create_department(body.name.trim(), body.sort).await {
        Ok(id) => id,
        Err(error) => return storage_write_error("create department", error),
    };
    match state.app.storage.list_departments().await {
        Ok(departments) => match departments.into_iter().find(|department| department.id == department_id) {
            Some(department) => (StatusCode::CREATED, Json(department_response(department))).into_response(),
            None => error_response(StatusCode::NOT_FOUND, "not_found"),
        },
        Err(error) => internal_error("load department", error),
    }
}

pub async fn update_department(
    State(state): State<Arc<WebState>>,
    Path(department_id): Path<i64>,
    Json(body): Json<UpdateDepartmentRequest>,
) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    let current = match state.app.storage.list_departments().await {
        Ok(departments) => match departments.into_iter().find(|department| department.id == department_id) {
            Some(department) => department,
            None => return error_response(StatusCode::NOT_FOUND, "not_found"),
        },
        Err(error) => return internal_error("load department", error),
    };
    let name = body.name.as_deref().unwrap_or(&current.name).trim();
    let sort = body.sort.unwrap_or(current.sort);
    if let Err(error) = state.app.storage.update_department(department_id, name, sort).await {
        return storage_write_error("update department", error);
    }
    match state.app.storage.list_departments().await {
        Ok(departments) => match departments.into_iter().find(|department| department.id == department_id) {
            Some(department) => (StatusCode::OK, Json(department_response(department))).into_response(),
            None => error_response(StatusCode::NOT_FOUND, "not_found"),
        },
        Err(error) => internal_error("reload department", error),
    }
}

pub async fn delete_department(State(state): State<Arc<WebState>>, Path(department_id): Path<i64>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    let current = match state.app.storage.list_departments().await {
        Ok(departments) => match departments.into_iter().find(|department| department.id == department_id) {
            Some(department) => department,
            None => return error_response(StatusCode::NOT_FOUND, "not_found"),
        },
        Err(error) => return internal_error("load department", error),
    };
    if current.user_count > 0 {
        return error_response(StatusCode::CONFLICT, "in_use");
    }
    match state.app.storage.delete_department(department_id).await {
        Ok(()) => json_response(StatusCode::OK, json!({"ok": true})),
        Err(error) => storage_write_error("delete department", error),
    }
}

pub async fn list_roles(State(state): State<Arc<WebState>>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    match state.app.storage.list_roles().await {
        Ok(roles) => (StatusCode::OK, Json(roles.into_iter().map(role_response).collect::<Vec<_>>())).into_response(),
        Err(error) => internal_error("list roles", error),
    }
}

pub async fn create_role(State(state): State<Arc<WebState>>, Json(body): Json<CreateRoleRequest>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    let permissions_json = match serde_json::to_string(&body.permissions) {
        Ok(value) => value,
        Err(error) => return internal_error("serialize role permissions", error.to_string()),
    };
    let scope_json = match serde_json::to_string(&body.scope) {
        Ok(value) => value,
        Err(error) => return internal_error("serialize role scope", error.to_string()),
    };
    let role_id = match state
        .app
        .storage
        .create_role(body.name.trim(), body.description.as_deref(), &permissions_json, &scope_json)
        .await
    {
        Ok(id) => id,
        Err(error) => return storage_write_error("create role", error),
    };
    match state.app.storage.list_roles().await {
        Ok(roles) => match roles.into_iter().find(|role| role.id == role_id) {
            Some(role) => (StatusCode::CREATED, Json(role_response(role))).into_response(),
            None => error_response(StatusCode::NOT_FOUND, "not_found"),
        },
        Err(error) => internal_error("load role", error),
    }
}

pub async fn update_role(
    State(state): State<Arc<WebState>>,
    Path(role_id): Path<i64>,
    Json(body): Json<UpdateRoleRequest>,
) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    let current = match state.app.storage.list_roles().await {
        Ok(roles) => match roles.into_iter().find(|role| role.id == role_id) {
            Some(role) => role,
            None => return error_response(StatusCode::NOT_FOUND, "not_found"),
        },
        Err(error) => return internal_error("load role", error),
    };
    let name = body.name.unwrap_or(current.name);
    let description = body.description.0.unwrap_or(current.description);
    let permissions = body.permissions.unwrap_or(current.permissions);
    let scope = body.scope.unwrap_or(RoleScope {
        allowed_group_ids: current.allowed_group_ids,
        allowed_connection_ids: current.allowed_connection_ids,
    });
    let permissions_json = match serde_json::to_string(&permissions) {
        Ok(value) => value,
        Err(error) => return internal_error("serialize role permissions", error.to_string()),
    };
    let scope_json = match serde_json::to_string(&scope) {
        Ok(value) => value,
        Err(error) => return internal_error("serialize role scope", error.to_string()),
    };
    if let Err(error) = state
        .app
        .storage
        .update_role(role_id, name.trim(), description.as_deref(), &permissions_json, &scope_json)
        .await
    {
        return storage_write_error("update role", error);
    }
    state.invalidate_permission_cache_all().await;
    match state.app.storage.list_roles().await {
        Ok(roles) => match roles.into_iter().find(|role| role.id == role_id) {
            Some(role) => (StatusCode::OK, Json(role_response(role))).into_response(),
            None => error_response(StatusCode::NOT_FOUND, "not_found"),
        },
        Err(error) => internal_error("reload role", error),
    }
}

pub async fn delete_role(State(state): State<Arc<WebState>>, Path(role_id): Path<i64>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    let current = match state.app.storage.list_roles().await {
        Ok(roles) => match roles.into_iter().find(|role| role.id == role_id) {
            Some(role) => role,
            None => return error_response(StatusCode::NOT_FOUND, "not_found"),
        },
        Err(error) => return internal_error("load role", error),
    };
    if current.user_count > 0 {
        return error_response(StatusCode::CONFLICT, "in_use");
    }
    match state.app.storage.delete_role(role_id).await {
        Ok(()) => {
            state.invalidate_permission_cache_all().await;
            json_response(StatusCode::OK, json!({"ok": true}))
        }
        Err(error) => storage_write_error("delete role", error),
    }
}

pub async fn list_blacklist(State(state): State<Arc<WebState>>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    match state.app.storage.list_blacklist().await {
        Ok(entries) => {
            (StatusCode::OK, Json(entries.into_iter().map(blacklist_response).collect::<Vec<_>>())).into_response()
        }
        Err(error) => internal_error("list blacklist", error),
    }
}

fn blacklist_response(entry: BlacklistEntry) -> BlacklistResponse {
    BlacklistResponse {
        id: entry.id,
        kind: entry.kind,
        value: entry.value,
        reason: entry.reason,
        created_by: entry.created_by,
        created_at: entry.created_at,
    }
}

pub async fn create_blacklist(
    State(state): State<Arc<WebState>>,
    Json(body): Json<CreateBlacklistRequest>,
) -> Response {
    let admin = match require_admin(&state) {
        Ok(admin) => admin,
        Err(response) => return response,
    };
    let value = match body.kind.as_str() {
        BLACKLIST_KIND_IP => body.value.trim().to_string(),
        BLACKLIST_KIND_USER => match normalize_username(&body.value) {
            Ok(username) => username,
            Err(_) => return error_response(StatusCode::BAD_REQUEST, "invalid_username"),
        },
        _ => return error_response(StatusCode::BAD_REQUEST, "invalid_kind"),
    };
    let entry_id = match state
        .app
        .storage
        .add_blacklist(&body.kind, &value, body.reason.as_deref(), Some(&admin.username))
        .await
    {
        Ok(id) => id,
        Err(error) => return storage_write_error("create blacklist entry", error),
    };
    if let Err(error) = state.blacklist.reload(&state.app.storage).await {
        return internal_error("reload blacklist", error);
    }
    if body.kind == BLACKLIST_KIND_USER {
        remove_user_sessions(&state, |session| session.username == value).await;
    }
    match state.app.storage.list_blacklist().await {
        Ok(entries) => match entries.into_iter().find(|entry| entry.id == entry_id) {
            Some(entry) => (StatusCode::CREATED, Json(blacklist_response(entry))).into_response(),
            None => error_response(StatusCode::NOT_FOUND, "not_found"),
        },
        Err(error) => internal_error("load blacklist entry", error),
    }
}

pub async fn delete_blacklist(State(state): State<Arc<WebState>>, Path(entry_id): Path<i64>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    if let Err(error) = state.app.storage.remove_blacklist(entry_id).await {
        return storage_write_error("delete blacklist entry", error);
    }
    if let Err(error) = state.blacklist.reload(&state.app.storage).await {
        return internal_error("reload blacklist", error);
    }
    json_response(StatusCode::OK, json!({"ok": true}))
}

pub async fn scope_tree(State(state): State<Arc<WebState>>) -> Response {
    if let Err(response) = require_admin(&state) {
        return response;
    }
    let layout = match state.app.storage.load_sidebar_layout().await {
        Ok(layout) => layout.unwrap_or_else(|| json!({"groups": [], "order": []})),
        Err(error) => return internal_error("load sidebar layout", error),
    };
    let connections = match state.app.storage.load_connections().await {
        Ok(connections) => connections,
        Err(error) => return internal_error("load connections", error),
    };
    let connection_names = connections
        .iter()
        .map(|connection| (connection.id.clone(), connection.name.clone()))
        .collect::<HashMap<_, _>>();
    let group_names = layout
        .get("groups")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|group| Some((group.get("id")?.as_str()?.to_string(), group.get("name")?.as_str()?.to_string())))
        .collect::<HashMap<_, _>>();
    let mut grouped = HashSet::new();
    let nodes = layout
        .get("order")
        .and_then(Value::as_array)
        .map(|entries| build_group_nodes(entries, &group_names, &connection_names, &mut grouped))
        .unwrap_or_default();
    let ungrouped = connections
        .into_iter()
        .filter(|connection| !grouped.contains(&connection.id))
        .map(|connection| ScopeNode { kind: "connection", id: connection.id, name: connection.name, children: None })
        .collect();
    (StatusCode::OK, Json(ScopeTreeResponse { nodes, ungrouped })).into_response()
}

fn build_group_nodes(
    entries: &[Value],
    group_names: &HashMap<String, String>,
    connection_names: &HashMap<String, String>,
    grouped: &mut HashSet<String>,
) -> Vec<ScopeNode> {
    entries
        .iter()
        .filter_map(|entry| {
            if entry.get("type").and_then(Value::as_str) != Some("group") {
                return None;
            }
            let id = entry.get("id")?.as_str()?.to_string();
            let mut children = entry
                .get("children")
                .and_then(Value::as_array)
                .map(|children| build_scope_children(children, group_names, connection_names, grouped))
                .unwrap_or_default();
            if let Some(connection_ids) = entry.get("connectionIds").and_then(Value::as_array) {
                children.extend(connection_ids.iter().filter_map(|id| {
                    let id = id.as_str()?;
                    connection_node(id, connection_names, grouped)
                }));
            }
            Some(ScopeNode {
                kind: "group",
                name: group_names.get(&id).cloned().unwrap_or_else(|| id.clone()),
                id,
                children: Some(children),
            })
        })
        .collect()
}

fn build_scope_children(
    entries: &[Value],
    group_names: &HashMap<String, String>,
    connection_names: &HashMap<String, String>,
    grouped: &mut HashSet<String>,
) -> Vec<ScopeNode> {
    let mut nodes = Vec::new();
    for entry in entries {
        match entry.get("type").and_then(Value::as_str) {
            Some("group") => {
                nodes.extend(build_group_nodes(std::slice::from_ref(entry), group_names, connection_names, grouped))
            }
            Some("connection") => {
                if let Some(id) = entry.get("id").and_then(Value::as_str) {
                    if let Some(node) = connection_node(id, connection_names, grouped) {
                        nodes.push(node);
                    }
                }
            }
            _ => {}
        }
    }
    nodes
}

fn connection_node(
    id: &str,
    connection_names: &HashMap<String, String>,
    grouped: &mut HashSet<String>,
) -> Option<ScopeNode> {
    let name = connection_names.get(id)?.clone();
    grouped.insert(id.to_string());
    Some(ScopeNode { kind: "connection", id: id.to_string(), name, children: None })
}

#[derive(Debug, Deserialize)]
pub struct ClearProtectionPasswordRequest {
    /// "connection-group" or "saved-sql-folder"
    pub target_type: String,
    pub target_id: String,
    pub login_password: String,
}

/// Clear the protection password for a connection group or saved SQL folder.
/// Requires the user's login password for security verification.
pub async fn clear_protection_password(
    State(state): State<Arc<WebState>>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ClearProtectionPasswordRequest>,
) -> Result<Response, StatusCode> {
    // Extract session and verify login password
    let token = crate::auth::session_token_from_headers(&headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let session = {
        let guard = state.sessions.read().await;
        guard.get(&token).cloned()
    };
    let Some(session) = session else {
        return Err(StatusCode::UNAUTHORIZED);
    };
    let user = state
        .app
        .storage
        .get_user_by_id(session.user_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    if !verify_password(&body.login_password, &user.password_hash) {
        return Ok(error_response(StatusCode::UNAUTHORIZED, "invalid_credentials"));
    }

    match body.target_type.as_str() {
        "connection-group" => {
            // Load sidebar layout, find the group, clear its passwordHash
            let mut layout = state
                .app
                .storage
                .load_sidebar_layout()
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
                .unwrap_or(json!({"groups": []}));

            if let Some(groups) = layout.get_mut("groups").and_then(Value::as_array_mut) {
                for group in groups.iter_mut() {
                    if group.get("id").and_then(Value::as_str) == Some(&body.target_id) {
                        if let Some(obj) = group.as_object_mut() {
                            obj.insert("passwordHash".to_string(), json!(null));
                        }
                        break;
                    }
                }
            }

            state.app.storage.save_sidebar_layout(&layout).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        "saved-sql-folder" => {
            // Clear password_hash in the saved_sql_folders table
            state
                .app
                .storage
                .clear_saved_sql_folder_password(&body.target_id)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        _ => {
            return Ok(error_response(StatusCode::BAD_REQUEST, "invalid_target_type"));
        }
    }

    Ok((StatusCode::OK, Json(json!({"ok": true}))).into_response())
}
