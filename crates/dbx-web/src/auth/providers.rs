//! Provider assembly: merges DB (`auth_providers` table + secret store) and env
//! (`DBX_AUTH_CONFIG` / `DBX_AUTH_CONFIG_FILE`) sources into provider instances.
//!
//! Merge rule: env entries override DB entries by id (env wins) and are read-only in the UI.
//! Sensitive fields (LDAP bind passwords, callback shared secrets, OIDC client secrets) never land in
//! `config_json`: DB-sourced ones are encrypted via `set_secret` and read back at assembly.

use std::collections::HashSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::auth::user_store::StorageAuthUserStore;
use crate::state::WebState;

/// Provider config entry shared by the env and DB sources.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProviderConfigEntry {
    pub id: String,
    /// `ldap` | `http_callback` (`oidc`, `proxy_header` added in later phases).
    pub kind: String,
    #[serde(default)]
    pub label: Option<String>,
    /// Provider config structure (no sensitive values; DB-sourced secrets are stored separately).
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i64,
}

fn default_true() -> bool {
    true
}

/// Sensitive field names per kind (config keys stored separately in the secret store).
pub const SECRET_FIELDS_BY_KIND: &[(&str, &str)] =
    &[("ldap", "bind_password"), ("http_callback", "shared_secret"), ("oidc", "client_secret")];

pub fn secret_field_for_kind(kind: &str) -> Option<&'static str> {
    SECRET_FIELDS_BY_KIND.iter().find(|(known, _)| *known == kind).map(|(_, field)| *field)
}

/// Secret key: `<provider_id>.<field>` under the `auth.providers` namespace.
fn secret_key(id: &str, field: &str) -> String {
    format!("{id}.{field}")
}

/// Parses the env inline JSON or config file (`DBX_AUTH_CONFIG` / `DBX_AUTH_CONFIG_FILE`).
pub fn env_provider_entries() -> Result<Vec<ProviderConfigEntry>, String> {
    let inline = std::env::var("DBX_AUTH_CONFIG").ok();
    let file = std::env::var("DBX_AUTH_CONFIG_FILE").ok();
    let raw = match (inline, file) {
        (Some(json), _) if !json.trim().is_empty() => json,
        (_, Some(path)) if !path.trim().is_empty() => std::fs::read_to_string(&path)
            .map_err(|error| format!("DBX_AUTH_CONFIG_FILE unreadable: {error}"))?,
        _ => return Ok(Vec::new()),
    };
    let entries: Vec<ProviderConfigEntry> =
        serde_json::from_str(&raw).map_err(|error| format!("DBX auth config parse failed: {error}"))?;
    for entry in &entries {
        if entry.id.trim().is_empty() {
            return Err("DBX auth config entry has empty id".to_string());
        }
    }
    Ok(entries)
}

/// Assembled provider description (admin API view, sensitive fields redacted).
#[derive(Debug, Serialize)]
pub struct AssembledProvider {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub enabled: bool,
    pub sort_order: i64,
    /// `env` | `db`; env entries are read-only in the UI.
    pub source: &'static str,
    /// Redacted config (sensitive fields replaced with null).
    pub config: serde_json::Value,
    /// Secret field names already configured (UI shows a "configured — leave empty to keep" placeholder).
    pub has_secrets: Vec<String>,
}

/// Builds a provider instance from one DB/env entry. `None` means the kind is not implemented.
pub(crate) async fn build_provider(
    entry: &ProviderConfigEntry,
    app: &Arc<dbx_core::connection::AppState>,
    resolve_db_secret: bool,
) -> Result<Option<Arc<dyn dbx_auth::AuthProvider>>, String> {
    let config = entry.config.clone();
    match entry.kind.as_str() {
        "ldap" => {
            let mut parsed: dbx_auth::providers::ldap::LdapProviderConfig =
                serde_json::from_value(config.clone()).map_err(|error| format!("provider {}: {error}", entry.id))?;
            if resolve_db_secret {
                if let Ok(Some(secret)) =
                    app.storage.get_secret(dbx_core::persistence::auth_providers::AUTH_PROVIDERS_SECRET_NS, &secret_key(&entry.id, "bind_password")).await
                {
                    parsed.bind_password = Some(secret);
                }
            }
            let mut provider = dbx_auth::providers::LdapAuthProvider::new(parsed).with_id(&entry.id);
            if let Some(label) = entry.label.as_deref().filter(|label| !label.is_empty()) {
                provider = provider.with_label(label);
            }
            Ok(Some(Arc::new(provider)))
        }
        "proxy_header" => {
            let parsed: dbx_auth::providers::proxy_header::ProxyHeaderConfig =
                serde_json::from_value(config.clone()).map_err(|error| format!("provider {}: {error}", entry.id))?;
            let mut provider = dbx_auth::providers::ProxyHeaderProvider::new(parsed).with_id(&entry.id);
            if let Some(label) = entry.label.as_deref().filter(|label| !label.is_empty()) {
                provider = provider.with_label(label);
            }
            Ok(Some(Arc::new(provider)))
        }
        "oidc" => {
            let mut parsed: dbx_auth::providers::oidc::OidcProviderConfig =
                serde_json::from_value(config.clone()).map_err(|error| format!("provider {}: {error}", entry.id))?;
            if resolve_db_secret {
                if let Ok(Some(secret)) =
                    app.storage.get_secret(dbx_core::persistence::auth_providers::AUTH_PROVIDERS_SECRET_NS, &secret_key(&entry.id, "client_secret")).await
                {
                    parsed.client_secret = Some(secret);
                }
            }
            let mut provider = dbx_auth::providers::OidcAuthProvider::with_id(parsed, &entry.id).map_err(|error| error.to_string())?;
            if let Some(label) = entry.label.as_deref().filter(|label| !label.is_empty()) {
                provider = provider.with_label(label);
            }
            Ok(Some(Arc::new(provider)))
        }
        "http_callback" => {
            let mut parsed: dbx_auth::providers::http_callback::HttpCallbackConfig =
                serde_json::from_value(config.clone()).map_err(|error| format!("provider {}: {error}", entry.id))?;
            if resolve_db_secret {
                if let Ok(Some(secret)) =
                    app.storage.get_secret(dbx_core::persistence::auth_providers::AUTH_PROVIDERS_SECRET_NS, &secret_key(&entry.id, "shared_secret")).await
                {
                    parsed.shared_secret = Some(secret);
                }
            }
            if parsed.shared_secret.as_deref().is_none_or(|secret| secret.is_empty()) {
                // Callback deployments without a shared secret belong only on trusted internal networks;
                log::warn!("auth provider {} has no shared secret; use only on trusted networks", entry.id);
            }
            let mut provider = dbx_auth::providers::HttpCallbackProvider::with_id(parsed, &entry.id).map_err(|error| error.to_string())?;
            if let Some(label) = entry.label.as_deref().filter(|label| !label.is_empty()) {
                provider = provider.with_label(label);
            }
            Ok(Some(Arc::new(provider)))
        }
        _ => Ok(None),
    }
}

/// Reassembles the provider registry (at startup and after every admin change).
/// Always includes the built-in local provider; then env entries (overriding DB by id), then DB entries.
pub async fn assemble_registry(state: &WebState) -> Result<(), String> {
    let user_store: Arc<StorageAuthUserStore> = Arc::new(StorageAuthUserStore::new(state.app.clone()));
    let mut providers: Vec<Arc<dyn dbx_auth::AuthProvider>> =
        vec![Arc::new(dbx_auth::providers::LocalAuthProvider::new(user_store.clone()))];
    let mut taken_ids: HashSet<String> = HashSet::new();

    let env_entries = env_provider_entries()?;
    for entry in &env_entries {
        match build_provider(entry, &state.app, false).await {
            Ok(Some(provider)) => {
                providers.push(provider);
                taken_ids.insert(entry.id.clone());
            }
            Ok(None) => log::warn!("auth provider {} has unknown kind {}", entry.id, entry.kind),
            Err(error) => log::error!("auth provider {} skipped: {error}", entry.id),
        }
    }

    for row in state.app.storage.list_auth_providers().await? {
        if !row.enabled || taken_ids.contains(&row.id) {
            continue;
        }
        let entry = ProviderConfigEntry {
            id: row.id.clone(),
            kind: row.kind.clone(),
            label: Some(row.label.clone()),
            config: serde_json::from_str(&row.config_json).unwrap_or(serde_json::Value::Null),
            enabled: true,
            sort_order: row.sort_order,
        };
        match build_provider(&entry, &state.app, true).await {
            Ok(Some(provider)) => providers.push(provider),
            Ok(None) => log::warn!("auth provider {} has unknown kind {}", row.id, row.kind),
            Err(error) => log::error!("auth provider {} skipped: {error}", row.id),
        }
    }

    state.auth_registry.set_providers(providers);
    Ok(())
}

/// Admin list view: DB entries (redacted) plus env entries (redacted, source=env).
pub async fn list_providers_for_admin(state: &WebState) -> Result<Vec<AssembledProvider>, String> {
    let env_ids: HashSet<String> = env_provider_entries()?.into_iter().map(|entry| entry.id).collect();
    let mut assembled = Vec::new();

    for entry in env_provider_entries()? {
        let mut config = entry.config.clone();
        redact_secret(&entry.kind, &mut config);
        let label = entry.label.clone().unwrap_or_else(|| entry_kind_label(&entry.kind));
        assembled.push(AssembledProvider {
            id: entry.id,
            kind: entry.kind,
            label,
            enabled: entry.enabled,
            sort_order: entry.sort_order,
            source: "env",
            config,
            has_secrets: Vec::new(),
        });
    }

    for row in state.app.storage.list_auth_providers().await? {
        if env_ids.contains(&row.id) {
            continue;
        }
        let mut config: serde_json::Value = serde_json::from_str(&row.config_json).unwrap_or(serde_json::Value::Null);
        redact_secret(&row.kind, &mut config);
        let mut has_secrets = Vec::new();
        if let Some(field) = secret_field_for_kind(&row.kind) {
            let present = state
                .app
                .storage
                .get_secret(dbx_core::persistence::auth_providers::AUTH_PROVIDERS_SECRET_NS, &secret_key(&row.id, field))
                .await
                .ok()
                .flatten()
                .is_some();
            if present {
                has_secrets.push(field.to_string());
            }
        }
        let label = if row.label.is_empty() { entry_kind_label(&row.kind) } else { row.label.clone() };
        assembled.push(AssembledProvider {
            id: row.id,
            kind: row.kind,
            label,
            enabled: row.enabled,
            sort_order: row.sort_order,
            source: "db",
            config,
            has_secrets,
        });
    }
    Ok(assembled)
}

fn entry_kind_label(kind: &str) -> String {
    match kind {
        "ldap" => "LDAP".to_string(),
        "http_callback" => "HTTP Auth".to_string(),
        "oidc" => "SSO".to_string(),
        "proxy_header" => "Proxy".to_string(),
        _ => kind.to_string(),
    }
}

/// Replaces sensitive field values with null (admin response redaction).
fn redact_secret(kind: &str, config: &mut serde_json::Value) {
    let Some(field) = secret_field_for_kind(kind) else { return };
    if let Some(object) = config.as_object_mut() {
        object.insert(field.to_string(), serde_json::Value::Null);
    }
}

/// Saves a DB entry: splits sensitive fields into the secret store; the rest goes to config_json.
pub async fn save_db_provider(state: &WebState, entry: &ProviderConfigEntry) -> Result<(), String> {
    let mut config = entry.config.clone();
    if let Some(field) = secret_field_for_kind(&entry.kind) {
        let value = config.get(field).cloned();
        if let Some(object) = config.as_object_mut() {
            object.insert(field.to_string(), serde_json::Value::Null);
        }
        match value {
            // Field absent or null → keep the stored secret; empty string → clear; non-empty → overwrite.
            Some(serde_json::Value::String(secret)) if !secret.is_empty() => {
                state
                    .app
                    .storage
                    .set_secret(dbx_core::persistence::auth_providers::AUTH_PROVIDERS_SECRET_NS, &secret_key(&entry.id, field), &secret)
                    .await?;
            }
            Some(serde_json::Value::String(_)) => {
                state
                    .app
                    .storage
                    .set_secret(dbx_core::persistence::auth_providers::AUTH_PROVIDERS_SECRET_NS, &secret_key(&entry.id, field), "")
                    .await?;
            }
            _ => {}
        }
    }
    let now = dbx_auth::unix_now();
    state
        .app
        .storage
        .upsert_auth_provider(dbx_core::persistence::auth_providers::AuthProviderRow {
            id: entry.id.clone(),
            kind: entry.kind.clone(),
            label: entry.label.clone().unwrap_or_default(),
            config_json: config.to_string(),
            enabled: entry.enabled,
            sort_order: entry.sort_order,
            updated_at: now,
        })
        .await
}

/// Deletes a DB entry and its secrets.
pub async fn delete_db_provider(state: &WebState, id: &str) -> Result<(), String> {
    state.app.storage.delete_auth_provider(id).await?;
    for (_, field) in SECRET_FIELDS_BY_KIND {
        state
            .app
            .storage
            .set_secret(dbx_core::persistence::auth_providers::AUTH_PROVIDERS_SECRET_NS, &secret_key(id, field), "")
            .await?;
    }
    Ok(())
}
