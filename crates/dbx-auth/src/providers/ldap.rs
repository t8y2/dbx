//! LDAP directory authentication (OpenLDAP / Active Directory and other generic directories).

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use ldap3::{LdapConnAsync, LdapConnSettings, Scope, SearchEntry};
use serde::{Deserialize, Serialize};

use crate::identity::{map_role, AuthIdentity, UserRole};
use crate::provider::{AuthError, AuthProvider, AuthProviderKind, FormCredentials, LoginMode};

/// Username placeholder: `{username}` inside `user_filter` is escaped and substituted.
pub const USERNAME_PLACEHOLDER: &str = "{username}";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LdapProviderConfig {
    /// Directory URL: `ldap://host:port` or `ldaps://host:port`.
    pub url: String,
    /// Whether to upgrade to StartTLS for `ldap://` (ignored for `ldaps://`).
    #[serde(default)]
    pub start_tls: bool,
    /// Service-account DN (search bind); default = anonymous search.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_dn: Option<String>,
    /// Service-account password. Sensitive: injected from the secret store for DB-sourced config, inline for env config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_password: Option<String>,
    pub base_dn: String,
    /// User-search filter template, e.g. `(&(objectClass=user)(sAMAccountName={username}))`.
    #[serde(default = "default_user_filter")]
    pub user_filter: String,
    /// Username attribute (default `uid`; AD uses `sAMAccountName`).
    #[serde(default = "default_username_attr")]
    pub username_attr: String,
    #[serde(default = "default_display_name_attr")]
    pub display_name_attr: String,
    #[serde(default = "default_email_attr")]
    pub email_attr: String,
    /// Group attribute (default `memberOf`; values may be group DNs or names depending on the directory).
    #[serde(default = "default_group_attr")]
    pub group_attr: String,
    /// Group → DBX role mapping (`{"ops-admin":"admin","*":"member"}`).
    #[serde(default)]
    pub role_map: HashMap<String, String>,
    #[serde(default)]
    pub default_role: Option<UserRole>,
    /// Connection and search timeout (seconds).
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,
}

fn default_user_filter() -> String {
    "(uid={username})".to_string()
}
fn default_username_attr() -> String {
    "uid".to_string()
}
fn default_display_name_attr() -> String {
    "displayName".to_string()
}
fn default_email_attr() -> String {
    "mail".to_string()
}
fn default_group_attr() -> String {
    "memberOf".to_string()
}
fn default_timeout_secs() -> u64 {
    10
}

impl Default for LdapProviderConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            start_tls: false,
            bind_dn: None,
            bind_password: None,
            base_dn: String::new(),
            user_filter: default_user_filter(),
            username_attr: default_username_attr(),
            display_name_attr: default_display_name_attr(),
            email_attr: default_email_attr(),
            group_attr: default_group_attr(),
            role_map: HashMap::new(),
            default_role: None,
            timeout_secs: default_timeout_secs(),
        }
    }
}

/// Escapes LDAP filter values (RFC 4515): `* ( ) \` and NUL.
/// Skipping this would splice user input into the filter, enabling injection.
pub fn escape_ldap_filter(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for byte in value.chars() {
        match byte {
            '*' => escaped.push_str("\\2a"),
            '(' => escaped.push_str("\\28"),
            ')' => escaped.push_str("\\29"),
            '\\' => escaped.push_str("\\5c"),
            '\0' => escaped.push_str("\\00"),
            _ => escaped.push(byte),
        }
    }
    escaped
}

/// LDAP directory auth provider. subject = the user DN (unique and stable within the directory).
pub struct LdapAuthProvider {
    id: String,
    config: LdapProviderConfig,
    label: String,
}

impl LdapAuthProvider {
    pub fn new(config: LdapProviderConfig) -> Self {
        Self { id: "ldap".to_string(), config, label: "LDAP".to_string() }
    }

    /// Distinguishes multiple instances (e.g. two directories plugged in parallel).
    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    fn render_filter(&self, username: &str) -> String {
        self.config.user_filter.replace(USERNAME_PLACEHOLDER, &escape_ldap_filter(username))
    }
}

#[async_trait]
impl AuthProvider for LdapAuthProvider {
    fn id(&self) -> &str {
        &self.id
    }

    fn kind(&self) -> AuthProviderKind {
        AuthProviderKind::Ldap
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn login_mode(&self) -> LoginMode {
        LoginMode::Form
    }

    async fn authenticate(&self, input: &FormCredentials) -> Result<AuthIdentity, AuthError> {
        let username = input.username.as_deref().unwrap_or("").trim();
        if username.is_empty() {
            return Err(AuthError::InvalidCredentials);
        }

        let timeout = Duration::from_secs(self.config.timeout_secs);
        let settings = LdapConnSettings::new().set_starttls(self.config.start_tls).set_conn_timeout(timeout);
        let (connection, mut ldap) = LdapConnAsync::with_settings(settings, &self.config.url)
            .await
            .map_err(|error| AuthError::ProviderUnavailable(format!("LDAP connect failed: {error}")))?;
        let _drive = tokio::spawn(async move { connection.drive().await });

        // Bind as the service account (or anonymously) to locate the user DN.
        let bind_result = match (self.config.bind_dn.as_deref(), self.config.bind_password.as_deref()) {
            (Some(bind_dn), Some(bind_password)) => {
                ldap.simple_bind(bind_dn, bind_password).await.map_err(ldap_unavailable)?
            }
            _ => ldap.simple_bind("", "").await.map_err(ldap_unavailable)?,
        };
        if let Err(error) = bind_result.success() {
            let _ = ldap.unbind().await;
            return Err(AuthError::Configuration(format!("LDAP service bind rejected: {error}")));
        }

        // Locate the user.
        let filter = self.render_filter(username);
        let search = ldap
            .search(
                &self.config.base_dn,
                Scope::Subtree,
                &filter,
                [
                    self.config.username_attr.as_str(),
                    self.config.display_name_attr.as_str(),
                    self.config.email_attr.as_str(),
                    self.config.group_attr.as_str(),
                ],
            )
            .await;
        let search = match search {
            Ok(search) => search,
            Err(error) => {
                let _ = ldap.unbind().await;
                return Err(ldap_unavailable(error));
            }
        };
        let entries = search.0;
        let Some(entry) = entries.into_iter().next() else {
            let _ = ldap.unbind().await;
            return Err(AuthError::InvalidCredentials);
        };
        let user_entry = SearchEntry::construct(entry);
        let dn = user_entry.dn;

        // Bind as the user to verify the password.
        let user_bind = ldap.simple_bind(&dn, &input.password).await.map_err(ldap_unavailable)?;
        let verified = user_bind.success().is_ok();
        let _ = ldap.unbind().await;
        if !verified {
            return Err(AuthError::InvalidCredentials);
        }

        let username = user_entry
            .attrs
            .get(&self.config.username_attr)
            .and_then(|values| values.first().cloned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| username.to_string());
        let display_name = user_entry
            .attrs
            .get(&self.config.display_name_attr)
            .and_then(|values| values.first().cloned())
            .filter(|value| !value.is_empty());
        let email = user_entry
            .attrs
            .get(&self.config.email_attr)
            .and_then(|values| values.first().cloned())
            .filter(|value| !value.is_empty());
        let groups = user_entry
            .attrs
            .get(&self.config.group_attr)
            .cloned()
            .unwrap_or_default();
        let role = map_role(&groups, &self.config.role_map, self.config.default_role.unwrap_or(UserRole::Member));

        Ok(AuthIdentity {
            provider_id: self.id().to_string(),
            subject: dn,
            username,
            display_name,
            email,
            groups,
            role,
        })
    }

    /// Connectivity test: connect + service bind + an empty search against base_dn.
    async fn test(&self) -> Result<(), AuthError> {
        let timeout = Duration::from_secs(self.config.timeout_secs);
        let settings = LdapConnSettings::new().set_starttls(self.config.start_tls).set_conn_timeout(timeout);
        let (connection, mut ldap) = LdapConnAsync::with_settings(settings, &self.config.url)
            .await
            .map_err(|error| AuthError::ProviderUnavailable(format!("LDAP connect failed: {error}")))?;
        let _drive = tokio::spawn(async move { connection.drive().await });
        let bind_result = match (self.config.bind_dn.as_deref(), self.config.bind_password.as_deref()) {
            (Some(bind_dn), Some(bind_password)) => ldap.simple_bind(bind_dn, bind_password).await.map_err(ldap_unavailable)?,
            _ => ldap.simple_bind("", "").await.map_err(ldap_unavailable)?,
        };
        let outcome = bind_result.success();
        let _ = ldap.unbind().await;
        outcome.map_err(|error| AuthError::Configuration(format!("LDAP bind failed: {error}")))?;
        Ok(())
    }
}

fn ldap_unavailable(error: impl std::fmt::Display) -> AuthError {
    AuthError::ProviderUnavailable(format!("LDAP request failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::escape_ldap_filter;

    #[test]
    fn escapes_filter_metacharacters() {
        assert_eq!(escape_ldap_filter("alice"), "alice");
        assert_eq!(escape_ldap_filter("a*b(c)"), "a\\2ab\\28c\\29");
        assert_eq!(escape_ldap_filter("a\\b"), "a\\5cb");
        assert_eq!(escape_ldap_filter("a\0b"), "a\\00b");
        assert_eq!(escape_ldap_filter("*(*)*"), "\\2a\\28\\2a\\29\\2a");
    }
}
