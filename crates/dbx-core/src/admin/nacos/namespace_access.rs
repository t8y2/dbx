use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures::{stream, StreamExt};
use sha2::{Digest, Sha256};

use crate::nacos::port::{NacosAdmin, NacosNamespaceAuthorizationSnapshot};
use crate::nacos::types::*;

const AUTH_PAGE_SIZE: u32 = 500;
const CACHE_TTL: Duration = Duration::from_secs(60);
const CACHE_MAX_CONNECTIONS: usize = 64;
const ADMIN_ROLE: &str = "ROLE_ADMIN";
// Namespace probing is deliberately reserved for the explicit connection-form
// action. Keep enough parallelism for useful feedback without overwhelming a
// Nacos server that contains many namespaces.
const DISCOVERY_CONCURRENCY: usize = 8;

#[derive(Clone)]
struct NamespaceAccessCacheEntry {
    connection_fingerprint: String,
    namespace_signature: [u8; 32],
    readable_ids: BTreeSet<String>,
    access_control: NacosAccessControlCapabilities,
    expires_at: Instant,
}

struct ReadableNamespaces {
    namespaces: Vec<NacosNamespaceInfo>,
    access_control: NacosAccessControlCapabilities,
}

fn cache() -> &'static Mutex<HashMap<String, NamespaceAccessCacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, NamespaceAccessCacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn invalidate(connection_id: &str) {
    cache().lock().unwrap_or_else(|error| error.into_inner()).remove(connection_id);
}

/// Access-control changes can affect a different DBX connection that targets
/// the same server with the edited account, so invalidate every cached account.
pub fn invalidate_all() {
    cache().lock().unwrap_or_else(|error| error.into_inner()).clear();
}

pub async fn list_readable_namespaces(
    connection_id: &str,
    connection_fingerprint: String,
    admin: Arc<dyn NacosAdmin>,
) -> Result<Vec<NacosNamespaceInfo>, String> {
    Ok(load_readable_namespaces(connection_id, connection_fingerprint, admin).await?.namespaces)
}

/// Lists namespaces for the explicit connection-form access-scope selector.
///
/// Authorization metadata provides the fast path. Some ordinary Nacos
/// accounts may enumerate namespaces but cannot read that metadata; for that
/// case only, this user-initiated operation verifies both configuration and
/// service access before offering a namespace. Sidebar loading never calls
/// this function, so it cannot trigger an N-per-namespace scan.
pub async fn list_displayable_namespaces(
    connection_id: &str,
    connection_fingerprint: String,
    admin: Arc<dyn NacosAdmin>,
) -> Result<Vec<NacosNamespaceInfo>, String> {
    let namespaces = admin.list_namespaces().await?;
    match resolve_readable_namespaces(connection_id, connection_fingerprint, admin.clone(), namespaces.clone()).await {
        Ok(result) => Ok(result.namespaces),
        Err(error) if is_managed_namespaces_required_error(&error) => {
            probe_displayable_namespaces(namespaces, admin).await
        }
        Err(error) => Err(error),
    }
}

fn is_rnacos_namespace_directory_unavailable(error: &str) -> bool {
    error.contains("NACOS_ERROR[rnacosNamespaceDirectoryUnavailable]")
}

fn scoped_namespace(namespace: &str) -> NacosNamespaceInfo {
    let namespace = namespace.trim().to_string();
    NacosNamespaceInfo {
        namespace_show_name: if namespace.is_empty() { "public".to_string() } else { namespace.clone() },
        namespace,
        namespace_desc: None,
        config_count: None,
        quota: None,
        namespace_type: None,
    }
}

async fn probe_displayable_namespaces(
    namespaces: Vec<NacosNamespaceInfo>,
    admin: Arc<dyn NacosAdmin>,
) -> Result<Vec<NacosNamespaceInfo>, String> {
    let mut checked = stream::iter(namespaces.into_iter().enumerate().map(|(index, namespace)| {
        let admin = admin.clone();
        async move { probe_namespace_access(admin, namespace).await.map(|accessible| (index, accessible)) }
    }))
    .buffer_unordered(DISCOVERY_CONCURRENCY)
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;

    checked.sort_by_key(|(index, _)| *index);
    Ok(checked.into_iter().filter_map(|(_, namespace)| namespace).collect())
}

async fn probe_namespace_access(
    admin: Arc<dyn NacosAdmin>,
    namespace: NacosNamespaceInfo,
) -> Result<Option<NacosNamespaceInfo>, String> {
    let namespace_id = namespace.namespace.clone();
    match admin
        .list_configs(NacosConfigQuery {
            namespace: Some(namespace_id.clone()),
            group: None,
            group_contains: false,
            data_id: None,
            app_name: None,
            search: None,
            page_no: Some(1),
            page_size: Some(1),
        })
        .await
    {
        Ok(_) => {}
        Err(error) if is_access_denied_error(&error) => return Ok(None),
        Err(error) => return Err(namespace_probe_error(&namespace_id, "configuration", &error)),
    }

    match admin
        .list_services(NacosServiceQuery {
            namespace: Some(namespace_id.clone()),
            group_name: None,
            service_name: None,
            page_no: Some(1),
            page_size: Some(1),
        })
        .await
    {
        Ok(_) => Ok(Some(namespace)),
        Err(error) if is_access_denied_error(&error) => Ok(None),
        Err(error) => Err(namespace_probe_error(&namespace_id, "service", &error)),
    }
}

fn is_access_denied_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("403")
        || error.contains("forbidden")
        || error.contains("access denied")
        || error.contains("authorization failed")
        || error.contains("authfailed")
}

fn namespace_probe_error(namespace: &str, capability: &str, detail: &str) -> String {
    format!(
        "NACOS_ERROR[namespaceAccessDetectionFailed]: unable to verify {capability} access for namespace `{namespace}`: {detail}"
    )
}

pub async fn sidebar_snapshot(
    connection_id: &str,
    connection_fingerprint: String,
    admin: Arc<dyn NacosAdmin>,
) -> Result<NacosNamespaceSidebarSnapshot, String> {
    match load_readable_namespaces(connection_id, connection_fingerprint, admin.clone()).await {
        Ok(result) => {
            Ok(NacosNamespaceSidebarSnapshot { namespaces: result.namespaces, access_control: result.access_control })
        }
        Err(error) if is_namespace_authorization_error(&error) => {
            let access_control = admin.access_control_capabilities();
            let has_access_control_reads = access_control.list_users.supported
                || access_control.list_role_bindings.supported
                || access_control.list_permissions.supported;
            if has_access_control_reads {
                // Namespace visibility remains fail-closed, while an account
                // that can inspect access control can still open that workspace.
                Ok(NacosNamespaceSidebarSnapshot { namespaces: Vec::new(), access_control })
            } else {
                Err(error)
            }
        }
        Err(error) => Err(error),
    }
}

/// Applies a user-saved display scope without relying on Nacos role metadata.
/// For r-nacos deployments without a namespace directory, the saved IDs also
/// provide the sidebar's explicit namespace list.
pub async fn sidebar_snapshot_with_visible_scope(
    connection_id: &str,
    connection_fingerprint: String,
    admin: Arc<dyn NacosAdmin>,
    visible_scope: Option<&[String]>,
) -> Result<NacosNamespaceSidebarSnapshot, String> {
    let Some(visible_scope) = visible_scope else {
        return sidebar_snapshot(connection_id, connection_fingerprint, admin).await;
    };

    let namespaces = match admin.list_namespaces().await {
        Ok(namespaces) => namespaces,
        // r-nacos's client OpenAPI does not guarantee a namespace directory.
        // A user-selected scope is enough to render the tree, while every
        // subsequent config request remains authorized by the server.
        Err(error) if is_rnacos_namespace_directory_unavailable(&error) => {
            visible_scope.iter().map(|namespace| scoped_namespace(namespace)).collect()
        }
        Err(error) => return Err(error),
    };
    let visible = visible_scope.iter().map(|namespace| namespace_identity(namespace)).collect();
    Ok(NacosNamespaceSidebarSnapshot {
        namespaces: filter_namespaces(namespaces, &visible),
        // A saved display scope only limits the namespace tree. It must not
        // suppress the independent probe that determines whether the account
        // can open the user and role workspace.
        access_control: admin.refresh_access_control_capabilities().await,
    })
}

fn is_namespace_authorization_error(error: &str) -> bool {
    error.contains("NACOS_ERROR[managedNamespacesRequired]")
        || error.contains("NACOS_ERROR[namespaceAuthorizationUnavailable]")
}

fn is_managed_namespaces_required_error(error: &str) -> bool {
    error.contains("NACOS_ERROR[managedNamespacesRequired]")
}

async fn load_readable_namespaces(
    connection_id: &str,
    connection_fingerprint: String,
    admin: Arc<dyn NacosAdmin>,
) -> Result<ReadableNamespaces, String> {
    let namespaces = admin.list_namespaces().await?;
    resolve_readable_namespaces(connection_id, connection_fingerprint, admin, namespaces).await
}

async fn resolve_readable_namespaces(
    connection_id: &str,
    connection_fingerprint: String,
    admin: Arc<dyn NacosAdmin>,
    namespaces: Vec<NacosNamespaceInfo>,
) -> Result<ReadableNamespaces, String> {
    let Some(username) =
        admin.current_username().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
    else {
        return Ok(ReadableNamespaces { namespaces, access_control: admin.access_control_capabilities() });
    };
    if let Some(explicit_scope) = admin.explicitly_scoped_namespace_ids() {
        let readable = explicit_scope.iter().map(|namespace| namespace_identity(namespace)).collect();
        return Ok(ReadableNamespaces {
            namespaces: filter_namespaces(namespaces, &readable),
            access_control: NacosAccessControlCapabilities::unavailable(NacosCapabilityReason::PermissionDenied),
        });
    }
    let signature = namespace_signature(&namespaces);
    if let Some((readable, cached_access_control)) =
        cached_readable_ids(connection_id, &connection_fingerprint, signature)
    {
        return Ok(ReadableNamespaces {
            namespaces: filter_namespaces(namespaces, &readable),
            access_control: cached_access_control,
        });
    }

    let (access_control, readable) = match admin.refresh_namespace_authorization(&username).await {
        Ok(Some(authorization)) => {
            let access_control = authorization.access_control.clone();
            let readable = readable_ids_from_authorization_snapshot(authorization, &namespaces)?;
            (access_control, readable)
        }
        Ok(None) => {
            let access_control = admin.access_control_capabilities();
            let readable = readable_ids_from_authorization(admin, &username, &namespaces).await?;
            (access_control, readable)
        }
        Err(error) => return Err(namespace_authorization_unavailable(&error)),
    };
    cache_readable_ids(connection_id, connection_fingerprint, signature, readable.clone(), access_control.clone());
    Ok(ReadableNamespaces { namespaces: filter_namespaces(namespaces, &readable), access_control })
}

fn readable_ids_from_authorization_snapshot(
    authorization: NacosNamespaceAuthorizationSnapshot,
    namespaces: &[NacosNamespaceInfo],
) -> Result<BTreeSet<String>, String> {
    if authorization.global_admin {
        return Ok(all_namespace_ids(namespaces));
    }
    let roles = authorization.roles.into_iter().collect::<BTreeSet<_>>();
    if roles.is_empty() {
        return Ok(BTreeSet::new());
    }
    readable_ids_from_permissions(&roles, &authorization.permissions, namespaces)
        .ok_or_else(|| namespace_authorization_unavailable("the server returned an unsupported permission resource"))
}

async fn readable_ids_from_authorization(
    admin: Arc<dyn NacosAdmin>,
    username: &str,
    namespaces: &[NacosNamespaceInfo],
) -> Result<BTreeSet<String>, String> {
    match admin.access_control_capabilities().mode {
        NacosAccessControlMode::EmbeddedRoles => readable_ids_from_embedded_user(admin, username, namespaces).await,
        NacosAccessControlMode::RoleBindings => readable_ids_from_role_bindings(admin, username, namespaces).await,
        NacosAccessControlMode::Unavailable => {
            Err(namespace_authorization_unavailable("this connection does not expose account authorization data"))
        }
    }
}

async fn readable_ids_from_embedded_user(
    admin: Arc<dyn NacosAdmin>,
    username: &str,
    namespaces: &[NacosNamespaceInfo],
) -> Result<BTreeSet<String>, String> {
    let users = admin
        .list_users(NacosUserQuery { username: Some(username.to_string()), page_no: Some(1), page_size: Some(2) })
        .await
        .map_err(|error| namespace_authorization_unavailable(&error))?;
    let user = users.items.into_iter().find(|user| user.username == username).ok_or_else(|| {
        namespace_authorization_unavailable("the current r-nacos account was absent from the authorization response")
    })?;
    Ok(readable_ids_from_namespace_privilege(user.enabled, user.namespace_privilege.as_ref(), namespaces))
}

async fn readable_ids_from_role_bindings(
    admin: Arc<dyn NacosAdmin>,
    username: &str,
    namespaces: &[NacosNamespaceInfo],
) -> Result<BTreeSet<String>, String> {
    let roles = list_current_roles(admin.clone(), username)
        .await
        .map_err(|error| namespace_authorization_unavailable(&error))?;
    if roles.contains(ADMIN_ROLE) {
        return Ok(all_namespace_ids(namespaces));
    }
    if roles.is_empty() {
        return Ok(BTreeSet::new());
    }

    let permissions = list_all_permissions(admin).await.map_err(|error| namespace_authorization_unavailable(&error))?;
    readable_ids_from_permissions(&roles, &permissions, namespaces)
        .ok_or_else(|| namespace_authorization_unavailable("the server returned an unsupported permission resource"))
}

fn namespace_authorization_unavailable(detail: &str) -> String {
    let detail_lowercase = detail.to_ascii_lowercase();
    let error_code = if detail_lowercase.contains("403")
        || detail_lowercase.contains("forbidden")
        || detail_lowercase.contains("access denied")
        || detail_lowercase.contains("authorization failed")
    {
        "managedNamespacesRequired"
    } else {
        "namespaceAuthorizationUnavailable"
    };
    format!(
        "NACOS_ERROR[{error_code}]: DBX cannot safely determine readable namespaces without per-namespace probes: {detail}"
    )
}

async fn list_current_roles(admin: Arc<dyn NacosAdmin>, username: &str) -> Result<BTreeSet<String>, String> {
    let mut roles = BTreeSet::new();
    let mut page_no = 1;
    loop {
        let page = admin
            .list_role_bindings(NacosRoleQuery {
                username: Some(username.to_string()),
                role: None,
                page_no: Some(page_no),
                page_size: Some(AUTH_PAGE_SIZE),
            })
            .await?;
        let count = page.items.len();
        roles.extend(page.items.into_iter().filter(|binding| binding.username == username).map(|binding| binding.role));
        if count < AUTH_PAGE_SIZE as usize || roles.len() as u64 >= page.total_count {
            break;
        }
        page_no += 1;
    }
    Ok(roles)
}

async fn list_all_permissions(admin: Arc<dyn NacosAdmin>) -> Result<Vec<NacosPermissionInfo>, String> {
    let mut permissions = Vec::new();
    let mut page_no = 1;
    loop {
        let page = admin
            .list_permissions(NacosPermissionQuery {
                role: None,
                resource: None,
                page_no: Some(page_no),
                page_size: Some(AUTH_PAGE_SIZE),
            })
            .await?;
        let count = page.items.len();
        permissions.extend(page.items);
        if count < AUTH_PAGE_SIZE as usize || permissions.len() as u64 >= page.total_count {
            break;
        }
        page_no += 1;
    }
    Ok(permissions)
}

fn readable_ids_from_namespace_privilege(
    enabled: Option<bool>,
    privilege: Option<&NacosNamespacePrivilege>,
    namespaces: &[NacosNamespaceInfo],
) -> BTreeSet<String> {
    let Some(privilege) = privilege.filter(|_| enabled != Some(false)) else {
        return if enabled == Some(false) { BTreeSet::new() } else { all_namespace_ids(namespaces) };
    };
    if !privilege.enabled {
        return all_namespace_ids(namespaces);
    }
    let mut readable = if privilege.whitelist_is_all {
        all_namespace_ids(namespaces)
    } else {
        privilege.whitelist.iter().map(|namespace| namespace_identity(namespace)).collect()
    };
    if privilege.blacklist_is_all {
        readable.clear();
    } else {
        for namespace in &privilege.blacklist {
            readable.remove(&namespace_identity(namespace));
        }
    }
    readable
}

fn readable_ids_from_permissions(
    roles: &BTreeSet<String>,
    permissions: &[NacosPermissionInfo],
    namespaces: &[NacosNamespaceInfo],
) -> Option<BTreeSet<String>> {
    let mut readable = BTreeSet::new();
    for permission in permissions.iter().filter(|permission| roles.contains(&permission.role)) {
        if !matches!(permission.action_raw.trim().to_ascii_lowercase().as_str(), "r" | "rw") {
            continue;
        }
        match permission.parsed_scope.as_ref().map(|scope| scope.kind) {
            Some(NacosPermissionScopeKind::Global) => return Some(all_namespace_ids(namespaces)),
            Some(NacosPermissionScopeKind::Namespace) => {
                if let Some(namespace) =
                    permission.parsed_scope.as_ref().and_then(|scope| scope.namespace_id.as_deref())
                {
                    readable.insert(namespace_identity(namespace));
                }
            }
            // A custom resource can grant access to an individual group or
            // data ID, but it cannot prove namespace-wide read access. Ignore
            // it rather than widening the sidebar's visible namespace scope.
            Some(NacosPermissionScopeKind::Custom | NacosPermissionScopeKind::Unknown) => {}
            None => return None,
        }
    }
    Some(readable)
}

fn namespace_identity(namespace: &str) -> String {
    if namespace.is_empty() || namespace == "public" {
        "public".to_string()
    } else {
        namespace.to_string()
    }
}

fn all_namespace_ids(namespaces: &[NacosNamespaceInfo]) -> BTreeSet<String> {
    namespaces.iter().map(|namespace| namespace_identity(&namespace.namespace)).collect()
}

fn filter_namespaces(namespaces: Vec<NacosNamespaceInfo>, readable: &BTreeSet<String>) -> Vec<NacosNamespaceInfo> {
    namespaces.into_iter().filter(|namespace| readable.contains(&namespace_identity(&namespace.namespace))).collect()
}

fn namespace_signature(namespaces: &[NacosNamespaceInfo]) -> [u8; 32] {
    let mut identities =
        namespaces.iter().map(|namespace| namespace_identity(&namespace.namespace)).collect::<Vec<_>>();
    identities.sort();
    identities.dedup();
    let mut hasher = Sha256::new();
    for identity in identities {
        hasher.update((identity.len() as u64).to_le_bytes());
        hasher.update(identity.as_bytes());
    }
    hasher.finalize().into()
}

fn cached_readable_ids(
    connection_id: &str,
    connection_fingerprint: &str,
    namespace_signature: [u8; 32],
) -> Option<(BTreeSet<String>, NacosAccessControlCapabilities)> {
    let mut entries = cache().lock().unwrap_or_else(|error| error.into_inner());
    let now = Instant::now();
    entries.retain(|_, entry| entry.expires_at > now);
    entries.get(connection_id).and_then(|entry| {
        (entry.connection_fingerprint == connection_fingerprint && entry.namespace_signature == namespace_signature)
            .then(|| (entry.readable_ids.clone(), entry.access_control.clone()))
    })
}

fn cache_readable_ids(
    connection_id: &str,
    connection_fingerprint: String,
    namespace_signature: [u8; 32],
    readable_ids: BTreeSet<String>,
    access_control: NacosAccessControlCapabilities,
) {
    let mut entries = cache().lock().unwrap_or_else(|error| error.into_inner());
    let now = Instant::now();
    entries.retain(|_, entry| entry.expires_at > now);
    if !entries.contains_key(connection_id) && entries.len() >= CACHE_MAX_CONNECTIONS {
        if let Some(oldest) = entries.iter().min_by_key(|(_, entry)| entry.expires_at).map(|(id, _)| id.clone()) {
            entries.remove(&oldest);
        }
    }
    entries.insert(
        connection_id.to_string(),
        NamespaceAccessCacheEntry {
            connection_fingerprint,
            namespace_signature,
            readable_ids,
            access_control,
            expires_at: now + CACHE_TTL,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn namespace(id: &str) -> NacosNamespaceInfo {
        NacosNamespaceInfo {
            namespace: id.to_string(),
            namespace_show_name: id.to_string(),
            namespace_desc: None,
            config_count: None,
            quota: None,
            namespace_type: None,
        }
    }

    fn role_binding_capabilities() -> NacosAccessControlCapabilities {
        NacosAccessControlCapabilities {
            mode: NacosAccessControlMode::RoleBindings,
            list_users: NacosOperationCapability::supported(),
            create_user: NacosOperationCapability::supported(),
            update_user: NacosOperationCapability::supported(),
            delete_user: NacosOperationCapability::supported(),
            list_role_bindings: NacosOperationCapability::supported(),
            assign_role: NacosOperationCapability::supported(),
            remove_role: NacosOperationCapability::supported(),
            list_permissions: NacosOperationCapability::supported(),
            grant_permission: NacosOperationCapability::supported(),
            revoke_permission: NacosOperationCapability::supported(),
            enhanced_workspace: true,
            supports_namespace_privileges: false,
        }
    }

    fn roles_only_capabilities() -> NacosAccessControlCapabilities {
        let mut capabilities = NacosAccessControlCapabilities::unavailable(NacosCapabilityReason::PermissionDenied);
        capabilities.mode = NacosAccessControlMode::RoleBindings;
        capabilities.list_users = NacosOperationCapability::supported();
        capabilities.list_role_bindings = NacosOperationCapability::supported();
        capabilities
    }

    struct CountingAdmin {
        namespaces: Vec<NacosNamespaceInfo>,
        readable_ids: BTreeSet<String>,
        role_error: bool,
        permission_error: bool,
        config_transport_error: bool,
        service_denied_ids: BTreeSet<String>,
        explicitly_scoped_ids: Option<Vec<String>>,
        namespace_calls: AtomicUsize,
        capability_calls: AtomicUsize,
        access_control_refresh_calls: AtomicUsize,
        role_calls: AtomicUsize,
        permission_calls: AtomicUsize,
        config_calls: AtomicUsize,
        service_calls: AtomicUsize,
    }

    impl CountingAdmin {
        fn restricted(namespace_count: usize) -> Self {
            let namespaces = (0..namespace_count).map(|index| namespace(&format!("team-{index}"))).collect::<Vec<_>>();
            let readable_ids = namespaces
                .iter()
                .enumerate()
                .filter(|(index, _)| index % 2 == 0)
                .map(|(_, namespace)| namespace.namespace.clone())
                .collect();
            Self {
                namespaces,
                readable_ids,
                role_error: false,
                permission_error: false,
                config_transport_error: false,
                service_denied_ids: BTreeSet::new(),
                explicitly_scoped_ids: None,
                namespace_calls: AtomicUsize::new(0),
                capability_calls: AtomicUsize::new(0),
                access_control_refresh_calls: AtomicUsize::new(0),
                role_calls: AtomicUsize::new(0),
                permission_calls: AtomicUsize::new(0),
                config_calls: AtomicUsize::new(0),
                service_calls: AtomicUsize::new(0),
            }
        }

        fn total_authorization_calls(&self) -> usize {
            self.namespace_calls.load(Ordering::SeqCst)
                + self.capability_calls.load(Ordering::SeqCst)
                + self.role_calls.load(Ordering::SeqCst)
                + self.permission_calls.load(Ordering::SeqCst)
                + self.config_calls.load(Ordering::SeqCst)
                + self.service_calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl NacosAdmin for CountingAdmin {
        fn access_control_capabilities(&self) -> NacosAccessControlCapabilities {
            if self.permission_error {
                roles_only_capabilities()
            } else {
                role_binding_capabilities()
            }
        }

        fn current_username(&self) -> Option<String> {
            Some("reader".to_string())
        }

        fn explicitly_scoped_namespace_ids(&self) -> Option<Vec<String>> {
            self.explicitly_scoped_ids.clone()
        }

        async fn refresh_access_control_capabilities(&self) -> NacosAccessControlCapabilities {
            self.access_control_refresh_calls.fetch_add(1, Ordering::SeqCst);
            self.access_control_capabilities()
        }

        async fn refresh_namespace_authorization(
            &self,
            username: &str,
        ) -> Result<Option<NacosNamespaceAuthorizationSnapshot>, String> {
            self.capability_calls.fetch_add(1, Ordering::SeqCst);
            let role_bindings = self
                .list_role_bindings(NacosRoleQuery {
                    username: Some(username.to_string()),
                    role: None,
                    page_no: Some(1),
                    page_size: Some(AUTH_PAGE_SIZE),
                })
                .await?;
            let permissions = self
                .list_permissions(NacosPermissionQuery {
                    role: None,
                    resource: None,
                    page_no: Some(1),
                    page_size: Some(AUTH_PAGE_SIZE),
                })
                .await?;
            Ok(Some(NacosNamespaceAuthorizationSnapshot {
                access_control: role_binding_capabilities(),
                roles: role_bindings.items.into_iter().map(|binding| binding.role).collect(),
                permissions: permissions.items,
                global_admin: false,
            }))
        }

        async fn test_connection(&self) -> Result<NacosConnectionInfo, String> {
            Err("unused".to_string())
        }

        async fn list_namespaces(&self) -> Result<Vec<NacosNamespaceInfo>, String> {
            self.namespace_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.namespaces.clone())
        }

        async fn create_namespace(&self, _: NacosNamespaceCreate) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn update_namespace(&self, _: NacosNamespaceUpdate) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn list_configs(&self, query: NacosConfigQuery) -> Result<NacosConfigList, String> {
            self.config_calls.fetch_add(1, Ordering::SeqCst);
            if self.config_transport_error {
                return Err("connection reset by peer".to_string());
            }
            let namespace = query.namespace.unwrap_or_default();
            if !self.readable_ids.contains(&namespace) {
                return Err("403 Forbidden".to_string());
            }
            Ok(NacosConfigList { page_no: 1, page_size: 1, total_count: 0, items: Vec::new() })
        }

        async fn search_config_content_page(
            &self,
            _: &str,
            _: &str,
            _: u32,
            _: u32,
        ) -> Result<Option<NacosConfigList>, String> {
            Err("unused".to_string())
        }

        async fn get_config(&self, _: NacosConfigKey) -> Result<NacosConfigItem, String> {
            Err("unused".to_string())
        }

        async fn publish_config(&self, _: NacosConfigUpsert) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn delete_config(&self, _: NacosConfigKey) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn list_config_history(&self, _: NacosConfigHistoryQuery) -> Result<NacosConfigHistoryList, String> {
            Err("unused".to_string())
        }

        async fn get_config_history(&self, _: NacosConfigHistoryKey) -> Result<NacosConfigItem, String> {
            Err("unused".to_string())
        }

        async fn rollback_config(&self, _: NacosConfigRollbackRequest) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn get_rnacos_console_captcha(&self) -> Result<NacosRNacosConsoleCaptcha, String> {
            Err("unused".to_string())
        }

        async fn login_rnacos_console(&self, _: Option<String>) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn list_role_bindings(&self, _: NacosRoleQuery) -> Result<NacosRoleList, String> {
            self.role_calls.fetch_add(1, Ordering::SeqCst);
            if self.role_error {
                return Err("403 Forbidden".to_string());
            }
            Ok(NacosRoleList {
                page_no: 1,
                page_size: AUTH_PAGE_SIZE,
                total_count: 1,
                items: vec![NacosRoleBinding { username: "reader".to_string(), role: "reader-role".to_string() }],
            })
        }

        async fn list_permissions(&self, _: NacosPermissionQuery) -> Result<NacosPermissionList, String> {
            self.permission_calls.fetch_add(1, Ordering::SeqCst);
            if self.permission_error {
                return Err("403 Forbidden".to_string());
            }
            let items = self
                .readable_ids
                .iter()
                .map(|namespace| NacosPermissionInfo {
                    role: "reader-role".to_string(),
                    resource_raw: format!("{namespace}:*:*"),
                    action_raw: "r".to_string(),
                    parsed_scope: Some(NacosPermissionScope {
                        kind: NacosPermissionScopeKind::Namespace,
                        namespace_id: Some(namespace.clone()),
                    }),
                })
                .collect::<Vec<_>>();
            Ok(NacosPermissionList { page_no: 1, page_size: AUTH_PAGE_SIZE, total_count: items.len() as u64, items })
        }

        async fn list_services(&self, query: NacosServiceQuery) -> Result<NacosServiceList, String> {
            self.service_calls.fetch_add(1, Ordering::SeqCst);
            let namespace = query.namespace.unwrap_or_default();
            if !self.readable_ids.contains(&namespace) || self.service_denied_ids.contains(&namespace) {
                return Err("403 Forbidden".to_string());
            }
            Ok(NacosServiceList { page_no: 1, page_size: 1, total_count: 0, items: Vec::new() })
        }

        async fn get_service(&self, _: NacosServiceQuery) -> Result<NacosServiceDetail, String> {
            Err("unused".to_string())
        }

        async fn create_service(&self, _: NacosServiceUpsert) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn update_service(&self, _: NacosServiceUpsert) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn delete_service(&self, _: NacosServiceQuery) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn list_instances(&self, _: NacosInstanceQuery) -> Result<Vec<NacosInstanceInfo>, String> {
            Err("unused".to_string())
        }

        async fn update_instance(&self, _: NacosInstanceUpdateRequest) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn register_instance(&self, _: NacosInstanceRegistration) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn deregister_instance(&self, _: NacosInstanceRef) -> Result<(), String> {
            Err("unused".to_string())
        }

        async fn get_dashboard(&self, _: NacosDashboardQuery) -> Result<NacosDashboardSnapshot, String> {
            Err("unused".to_string())
        }

        async fn raw_request(&self, _: NacosRawRequest) -> Result<NacosRawResponse, String> {
            Err("unused".to_string())
        }
    }

    #[test]
    fn role_permissions_keep_only_readable_namespaces() {
        let namespaces = vec![namespace("public"), namespace("team-a"), namespace("team-b")];
        let roles = BTreeSet::from(["reader".to_string()]);
        let permissions = vec![
            NacosPermissionInfo {
                role: "reader".to_string(),
                resource_raw: "team-a:*:*".to_string(),
                action_raw: "r".to_string(),
                parsed_scope: Some(NacosPermissionScope {
                    kind: NacosPermissionScopeKind::Namespace,
                    namespace_id: Some("team-a".to_string()),
                }),
            },
            NacosPermissionInfo {
                role: "reader".to_string(),
                resource_raw: "team-b:*:*".to_string(),
                action_raw: "w".to_string(),
                parsed_scope: Some(NacosPermissionScope {
                    kind: NacosPermissionScopeKind::Namespace,
                    namespace_id: Some("team-b".to_string()),
                }),
            },
        ];

        assert_eq!(
            readable_ids_from_permissions(&roles, &permissions, &namespaces),
            Some(BTreeSet::from(["team-a".to_string()]))
        );
    }

    #[test]
    fn custom_permissions_do_not_grant_namespace_wide_visibility() {
        let namespaces = vec![namespace("public"), namespace("team-a"), namespace("team-b")];
        let roles = BTreeSet::from(["reader".to_string()]);
        let permissions = vec![NacosPermissionInfo {
            role: "reader".to_string(),
            resource_raw: "team-a:GROUP_A:*".to_string(),
            action_raw: "r".to_string(),
            parsed_scope: Some(NacosPermissionScope {
                kind: NacosPermissionScopeKind::Custom,
                namespace_id: Some("team-a".to_string()),
            }),
        }];

        assert_eq!(readable_ids_from_permissions(&roles, &permissions, &namespaces), Some(BTreeSet::new()));
    }

    #[test]
    fn embedded_privileges_apply_whitelist_and_blacklist() {
        let namespaces = vec![namespace("public"), namespace("team-a"), namespace("team-b")];
        let privilege = NacosNamespacePrivilege {
            enabled: true,
            whitelist_is_all: false,
            whitelist: vec!["team-a".to_string(), "team-b".to_string()],
            blacklist_is_all: false,
            blacklist: vec!["team-b".to_string()],
        };

        assert_eq!(
            readable_ids_from_namespace_privilege(Some(true), Some(&privilege), &namespaces),
            BTreeSet::from(["team-a".to_string()])
        );
    }

    #[tokio::test]
    async fn restricted_sidebar_filtering_has_constant_request_count() {
        let mut request_counts = Vec::new();
        for namespace_count in [1, 100] {
            let connection_id = format!("constant-sidebar-requests-{namespace_count}");
            invalidate(&connection_id);
            let admin = Arc::new(CountingAdmin::restricted(namespace_count));

            let snapshot = sidebar_snapshot(&connection_id, "server-a".to_string(), admin.clone()).await.unwrap();

            assert_eq!(snapshot.namespaces.len(), namespace_count.div_ceil(2));
            assert!(snapshot.namespaces.iter().all(|namespace| namespace
                .namespace
                .trim_start_matches("team-")
                .parse::<usize>()
                .unwrap()
                % 2
                == 0));
            assert_eq!(admin.config_calls.load(Ordering::SeqCst), 0);
            assert_eq!(admin.capability_calls.load(Ordering::SeqCst), 1);
            assert_eq!(admin.role_calls.load(Ordering::SeqCst), 1);
            assert_eq!(admin.permission_calls.load(Ordering::SeqCst), 1);
            request_counts.push(admin.total_authorization_calls());
        }

        assert_eq!(request_counts, vec![4, 4]);
    }

    #[tokio::test]
    async fn unavailable_authorization_fails_closed_without_namespace_probes() {
        let connection_id = "unavailable-sidebar-authorization";
        invalidate(connection_id);
        let mut admin = CountingAdmin::restricted(100);
        admin.permission_error = true;
        let admin = Arc::new(admin);

        let error = list_readable_namespaces(connection_id, "server-a".to_string(), admin.clone()).await.unwrap_err();

        assert!(error.contains("NACOS_ERROR[managedNamespacesRequired]"));
        assert_eq!(admin.config_calls.load(Ordering::SeqCst), 0);
        assert_eq!(admin.total_authorization_calls(), 4);
    }

    #[tokio::test]
    async fn explicit_namespace_detection_probes_config_and_service_when_role_read_is_forbidden() {
        let connection_id = "displayable-namespaces-role-forbidden";
        invalidate(connection_id);
        let mut admin = CountingAdmin::restricted(4);
        admin.role_error = true;
        let admin = Arc::new(admin);

        let namespaces =
            list_displayable_namespaces(connection_id, "server-a".to_string(), admin.clone()).await.unwrap();

        assert_eq!(
            namespaces.iter().map(|namespace| namespace.namespace.as_str()).collect::<Vec<_>>(),
            vec!["team-0", "team-2"]
        );
        assert_eq!(admin.namespace_calls.load(Ordering::SeqCst), 1);
        assert_eq!(admin.capability_calls.load(Ordering::SeqCst), 1);
        assert_eq!(admin.role_calls.load(Ordering::SeqCst), 1);
        assert_eq!(admin.permission_calls.load(Ordering::SeqCst), 0);
        assert_eq!(admin.config_calls.load(Ordering::SeqCst), 4);
        assert_eq!(admin.service_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn explicit_namespace_detection_aborts_on_unexpected_probe_failure() {
        let connection_id = "displayable-namespaces-probe-failure";
        invalidate(connection_id);
        let mut admin = CountingAdmin::restricted(4);
        admin.role_error = true;
        admin.config_transport_error = true;
        let admin = Arc::new(admin);

        let error =
            list_displayable_namespaces(connection_id, "server-a".to_string(), admin.clone()).await.unwrap_err();

        assert!(error.contains("NACOS_ERROR[namespaceAccessDetectionFailed]"));
        assert_eq!(admin.namespace_calls.load(Ordering::SeqCst), 1);
        assert_eq!(admin.role_calls.load(Ordering::SeqCst), 1);
        assert_eq!(admin.permission_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn explicit_namespace_detection_requires_service_access_too() {
        let connection_id = "displayable-namespaces-service-denied";
        invalidate(connection_id);
        let mut admin = CountingAdmin::restricted(4);
        admin.role_error = true;
        admin.service_denied_ids.insert("team-0".to_string());
        let admin = Arc::new(admin);

        let namespaces =
            list_displayable_namespaces(connection_id, "server-a".to_string(), admin.clone()).await.unwrap();

        assert_eq!(namespaces.iter().map(|namespace| namespace.namespace.as_str()).collect::<Vec<_>>(), vec!["team-2"]);
        assert_eq!(admin.config_calls.load(Ordering::SeqCst), 4);
        assert_eq!(admin.service_calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn roles_only_sidebar_keeps_access_control_entry_without_widening_namespaces() {
        let connection_id = "roles-only-sidebar-authorization";
        invalidate(connection_id);
        let mut admin = CountingAdmin::restricted(100);
        admin.permission_error = true;
        let admin = Arc::new(admin);

        let snapshot = sidebar_snapshot(connection_id, "server-a".to_string(), admin.clone()).await.unwrap();

        assert!(snapshot.namespaces.is_empty());
        assert!(snapshot.access_control.list_role_bindings.supported);
        assert!(!snapshot.access_control.list_permissions.supported);
        assert_eq!(admin.config_calls.load(Ordering::SeqCst), 0);
        assert_eq!(admin.total_authorization_calls(), 4);
    }

    #[tokio::test]
    async fn explicitly_scoped_namespace_list_skips_authorization_queries() {
        let connection_id = "explicit-sidebar-scope";
        invalidate(connection_id);
        let mut admin = CountingAdmin::restricted(100);
        admin.permission_error = true;
        admin.explicitly_scoped_ids = Some(vec!["team-2".to_string(), "team-78".to_string()]);
        let admin = Arc::new(admin);

        let snapshot = sidebar_snapshot(connection_id, "server-a".to_string(), admin.clone()).await.unwrap();

        assert_eq!(
            snapshot.namespaces.iter().map(|namespace| namespace.namespace.as_str()).collect::<Vec<_>>(),
            vec!["team-2", "team-78"]
        );
        assert_eq!(admin.total_authorization_calls(), 1);
        assert!(!snapshot.access_control.list_users.supported);
    }

    #[tokio::test]
    async fn visible_sidebar_scope_refreshes_access_control_without_authorization_inference() {
        let connection_id = "visible-sidebar-scope";
        invalidate(connection_id);
        let admin = CountingAdmin::restricted(100);
        let admin = Arc::new(admin);
        let visible_scope = vec!["team-2".to_string(), "team-78".to_string()];

        let snapshot = sidebar_snapshot_with_visible_scope(
            connection_id,
            "server-a".to_string(),
            admin.clone(),
            Some(&visible_scope),
        )
        .await
        .unwrap();

        assert_eq!(
            snapshot.namespaces.iter().map(|namespace| namespace.namespace.as_str()).collect::<Vec<_>>(),
            vec!["team-2", "team-78"]
        );
        assert_eq!(admin.namespace_calls.load(Ordering::SeqCst), 1);
        assert!(snapshot.access_control.list_users.supported);
        assert_eq!(admin.access_control_refresh_calls.load(Ordering::SeqCst), 1);
        assert_eq!(admin.capability_calls.load(Ordering::SeqCst), 0);
        assert_eq!(admin.role_calls.load(Ordering::SeqCst), 0);
        assert_eq!(admin.permission_calls.load(Ordering::SeqCst), 0);
        assert_eq!(admin.config_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn cache_is_bound_to_connection_fingerprint_and_namespace_set() {
        let connection_id = "namespace-cache-test";
        invalidate(connection_id);
        let first_namespaces = vec![namespace("public"), namespace("team-a")];
        let first_signature = namespace_signature(&first_namespaces);
        cache_readable_ids(
            connection_id,
            "server-a".to_string(),
            first_signature,
            BTreeSet::from(["team-a".to_string()]),
            role_binding_capabilities(),
        );

        assert_eq!(
            cached_readable_ids(connection_id, "server-a", first_signature).map(|(ids, _)| ids),
            Some(BTreeSet::from(["team-a".to_string()]))
        );
        assert_eq!(cached_readable_ids(connection_id, "server-b", first_signature), None);
        assert_eq!(cached_readable_ids(connection_id, "server-a", namespace_signature(&[namespace("team-b")])), None);
        invalidate(connection_id);
        assert_eq!(cached_readable_ids(connection_id, "server-a", first_signature), None);

        cache_readable_ids(
            connection_id,
            "server-a".to_string(),
            first_signature,
            BTreeSet::new(),
            role_binding_capabilities(),
        );
        cache_readable_ids(
            "other-connection",
            "server-a".to_string(),
            first_signature,
            BTreeSet::new(),
            role_binding_capabilities(),
        );
        invalidate_all();
        assert_eq!(cached_readable_ids(connection_id, "server-a", first_signature), None);
        assert_eq!(cached_readable_ids("other-connection", "server-a", first_signature), None);
    }
}
