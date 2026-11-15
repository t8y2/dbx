//! User identity and role model.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Minimal role model for web login users.
///
/// `admin` manages auth providers, users and security settings; every other
/// capability is identical for both roles (workspace data is shared; credential
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UserRole {
    Admin,
    Member,
}

impl UserRole {
    pub fn as_str(self) -> &'static str {
        match self {
            UserRole::Admin => "admin",
            UserRole::Member => "member",
        }
    }

    pub fn parse(value: &str) -> Option<UserRole> {
        match value {
            "admin" => Some(UserRole::Admin),
            "member" => Some(UserRole::Member),
            _ => None,
        }
    }
}

/// Generic group/role-name → DBX role mapping (shared by LDAP groups, OIDC groups claims, etc.).
///
/// Resolution order: exact match over `groups` in order → the `"*"` fallback → `default`.
/// Values accept only `admin` / `member`; anything else counts as unconfigured.
pub fn map_role(groups: &[String], role_map: &HashMap<String, String>, default: UserRole) -> UserRole {
    for group in groups {
        if let Some(role) = role_map.get(group).and_then(|value| UserRole::parse(value)) {
            return role;
        }
    }
    role_map.get("*").and_then(|value| UserRole::parse(value)).unwrap_or(default)
}

/// Identity produced by a provider after successful authentication. `subject` is unique
/// within the provider (OIDC `sub` / LDAP bind DN / local user id).
#[derive(Clone, Debug)]
pub struct AuthIdentity {
    pub provider_id: String,
    pub subject: String,
    pub username: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    pub groups: Vec<String>,
    pub role: UserRole,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn role_map(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn map_role_prefers_explicit_groups_in_order() {
        let map = role_map(&[("ops-admin", "admin"), ("*","member")]);
        let groups = vec!["ops-viewer".to_string(), "ops-admin".to_string()];
        assert_eq!(map_role(&groups, &map, UserRole::Member), UserRole::Admin);
    }

    #[test]
    fn map_role_falls_back_to_wildcard_then_default() {
        let map = role_map(&[("*", "member")]);
        assert_eq!(map_role(&[], &map, UserRole::Admin), UserRole::Member);
        assert_eq!(map_role(&["unknown".to_string()], &map, UserRole::Admin), UserRole::Member);

        let empty = HashMap::new();
        assert_eq!(map_role(&[], &empty, UserRole::Member), UserRole::Member);
    }

    #[test]
    fn map_role_ignores_unrecognized_values() {
        let map = role_map(&[("ops-x", "superuser"), ("*", "not-a-role")]);
        assert_eq!(map_role(&["ops-x".to_string()], &map, UserRole::Member), UserRole::Member);
    }

    #[test]
    fn user_role_round_trips() {
        assert_eq!(UserRole::parse("admin"), Some(UserRole::Admin));
        assert_eq!(UserRole::Admin.as_str(), "admin");
        assert_eq!(UserRole::parse("guest"), None);
    }
}
