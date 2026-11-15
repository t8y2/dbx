//! Authentication provider registry.

use std::sync::{Arc, RwLock};

use crate::provider::{AuthProvider, ProviderInfo};

/// Registry of auth providers: assembled at startup and swapped as a whole when
/// the admin UI changes providers (same pattern as `DialectRegistry` in `dbx-sql-dialect`).
///
/// Uses a std `RwLock`: reads and swaps are short synchronous critical sections,
#[derive(Default)]
pub struct AuthRegistry {
    providers: RwLock<Vec<Arc<dyn AuthProvider>>>,
}

impl AuthRegistry {
    pub fn new() -> Self {
        Self { providers: RwLock::new(Vec::new()) }
    }

    /// Replaces the whole provider set (the given order is the login-page order).
    pub fn set_providers(&self, providers: Vec<Arc<dyn AuthProvider>>) {
        *self.locked() = providers;
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn AuthProvider>> {
        self.locked().iter().find(|provider| provider.id() == id).cloned()
    }

    pub fn list(&self) -> Vec<Arc<dyn AuthProvider>> {
        self.locked().clone()
    }

    pub fn infos(&self) -> Vec<ProviderInfo> {
        self.list().iter().map(|provider| ProviderInfo {
            id: provider.id().to_string(),
            kind: provider.kind(),
            label: provider.label().to_string(),
            mode: provider.login_mode().as_str(),
            // `requires_username` is overridden upstream using the account count (see provider.rs).
            requires_username: false,
        }).collect()
    }

    fn locked(&self) -> std::sync::RwLockWriteGuard<'_, Vec<Arc<dyn AuthProvider>>> {
        self.providers.write().expect("auth registry lock poisoned")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::AuthIdentity;
    use crate::provider::{AuthError, FormCredentials, LoginMode};
    use async_trait::async_trait;

    struct StubProvider {
        id: &'static str,
        mode: LoginMode,
    }

    #[async_trait]
    impl AuthProvider for StubProvider {
        fn id(&self) -> &str {
            self.id
        }
        fn kind(&self) -> crate::provider::AuthProviderKind {
            crate::provider::AuthProviderKind::Ldap
        }
        fn label(&self) -> &str {
            "stub"
        }
        fn login_mode(&self) -> LoginMode {
            self.mode.clone()
        }
        async fn authenticate(&self, input: &FormCredentials) -> Result<AuthIdentity, AuthError> {
            Ok(AuthIdentity {
                provider_id: self.id.to_string(),
                subject: input.username.clone().unwrap_or_default(),
                username: input.username.clone().unwrap_or_default(),
                display_name: None,
                email: None,
                groups: Vec::new(),
                role: crate::identity::UserRole::Member,
            })
        }
    }

    fn stub(id: &'static str) -> Arc<dyn AuthProvider> {
        Arc::new(StubProvider { id, mode: LoginMode::Form })
    }

    #[test]
    fn registry_replaces_and_resolves_by_id() {
        let registry = AuthRegistry::new();
        assert!(registry.get("a").is_none());

        registry.set_providers(vec![stub("a"), stub("b")]);
        assert_eq!(registry.list().len(), 2);
        assert_eq!(registry.get("b").unwrap().id(), "b");
        assert_eq!(registry.infos().len(), 2);

        registry.set_providers(vec![stub("c")]);
        assert!(registry.get("a").is_none());
        assert_eq!(registry.get("c").unwrap().id(), "c");
    }
}
