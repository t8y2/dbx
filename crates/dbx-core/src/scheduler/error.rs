//! Scheduler error contract (ADR §5.4): every error carries a retryability
//! kind, a machine-readable code from the frozen vocabulary, and a message.
//! The kind decides engine retry behaviour; the code maps to API statuses.

use std::fmt;

/// Retryability classification carried by every scheduler error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskErrorKind {
    /// Invalid config, missing provider/connection, permission denied.
    NonRetryable,
    /// Network failures, temporary timeouts, transient provider unavailability.
    Retryable,
    /// Explicit cancel: never retried.
    Cancelled,
}

#[derive(Debug, Clone)]
pub struct TaskError {
    pub kind: TaskErrorKind,
    pub code: String,
    pub message: String,
}

impl TaskError {
    pub fn new(kind: TaskErrorKind, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { kind, code: code.into(), message: message.into() }
    }

    pub fn invalid_config(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "invalid_config", message)
    }

    pub fn invalid_trigger(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "invalid_trigger", message)
    }

    pub fn provider_not_found(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "provider_not_found", message)
    }

    /// A registered provider whose plugin is not installed / not running.
    /// Transient: the plugin may come back, so retries are allowed.
    pub fn provider_unavailable(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::Retryable, "provider_unavailable", message)
    }

    pub fn connection_missing(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "connection_missing", message)
    }

    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "permission_denied", message)
    }

    pub fn version_conflict(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "version_conflict", message)
    }

    pub fn run_already_active(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "run_already_active", message)
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::Cancelled, "cancelled", message)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::Retryable, "timeout", message)
    }

    pub fn execution_failed(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::Retryable, "execution_failed", message)
    }

    pub fn worker_interrupted(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "worker_interrupted", message)
    }

    pub fn restart_limit_reached(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "restart_limit_reached", message)
    }

    /// Store/engine level failures. Treated as transient so a temporarily
    /// busy SQLite does not fail runs permanently.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::Retryable, "scheduler_unavailable", message)
    }

    /// Internal invariant violations (serialization bugs, corrupted stored
    /// state). Never retried automatically.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(TaskErrorKind::NonRetryable, "internal", message)
    }

    /// Whether the engine may automatically retry a failed run.
    pub fn retryable(&self) -> bool {
        self.kind == TaskErrorKind::Retryable
    }
}

impl fmt::Display for TaskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for TaskError {}

impl From<rusqlite::Error> for TaskError {
    fn from(error: rusqlite::Error) -> Self {
        Self::unavailable(error.to_string())
    }
}

/// Secret red line (ADR §10): `password` / `token` / `secret` / `private_key`
/// / `authorization` / session-key values must never enter task config,
/// payloads, logs, events or the database. `secretRef` (an opaque reference
/// into the secret store) is explicitly allowed. The marker list mirrors
/// `dbx-plugin-runtime`'s `SECRET_KEY_FRAGMENTS` (keys are normalized to
/// lowercase alphanumerics before matching, so `private_key` and
/// `session_key` fold into their marker).
const SECRET_KEY_MARKERS: [&str; 6] = ["password", "token", "secret", "privatekey", "authorization", "sessionkey"];
const SECRET_REF_KEY: &str = "secretref";

fn normalizes_to_secret(key: &str) -> bool {
    let normalized: String =
        key.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect();
    if normalized == SECRET_REF_KEY {
        return false;
    }
    SECRET_KEY_MARKERS.iter().any(|marker| normalized.contains(marker))
}

/// Recursively strips secret-shaped keys from a JSON value in place.
pub fn redact_secrets(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            let secrets: Vec<String> = map.keys().filter(|key| normalizes_to_secret(key)).cloned().collect();
            for key in secrets {
                map.insert(key, serde_json::Value::Null);
            }
            for child in map.values_mut() {
                redact_secrets(child);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                redact_secrets(item);
            }
        }
        _ => {}
    }
}

/// Recursively removes secret-shaped keys entirely. Used before persisting
/// task config: a nulled key would still pass through exports and events,
/// so the key itself must not survive (ADR §10).
pub fn remove_secret_keys(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            let secrets: Vec<String> = map.keys().filter(|key| normalizes_to_secret(key)).cloned().collect();
            for key in secrets {
                map.remove(&key);
            }
            for child in map.values_mut() {
                remove_secret_keys(child);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                remove_secret_keys(item);
            }
        }
        _ => {}
    }
}

/// Strict variant for callers that must fail closed instead of redacting.
pub fn validate_config_secrets(value: &serde_json::Value) -> Result<(), TaskError> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                if normalizes_to_secret(key) {
                    return Err(TaskError::invalid_config(format!(
                        "Task config must not contain secret values: {key}"
                    )));
                }
                validate_config_secrets(child)?;
            }
            Ok(())
        }
        serde_json::Value::Array(items) => items.iter().try_for_each(validate_config_secrets),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn secrets_are_redacted_from_nested_config() {
        let mut config = json!({
            "command": "echo hi",
            "auth": { "password": "p", "privateKey": "k", "authorization": "Bearer x", "sessionKey": "s", "secretRef": "keep-me" },
            "items": [{ "api_token": "t", "note": "n" }]
        });
        redact_secrets(&mut config);
        assert_eq!(config["auth"]["password"], serde_json::Value::Null);
        assert_eq!(config["auth"]["privateKey"], serde_json::Value::Null);
        assert_eq!(config["auth"]["authorization"], serde_json::Value::Null);
        assert_eq!(config["auth"]["sessionKey"], serde_json::Value::Null);
        assert_eq!(config["auth"]["secretRef"], "keep-me");
        assert_eq!(config["items"][0]["api_token"], serde_json::Value::Null);
        assert_eq!(config["items"][0]["note"], "n");
    }

    #[test]
    fn config_with_secret_is_rejected() {
        assert!(validate_config_secrets(&json!({"password": "x"})).is_err());
        assert!(validate_config_secrets(&json!({"auth": {"private_key": "x"}})).is_err());
        assert!(validate_config_secrets(&json!({"command": "ls"})).is_ok());
        assert!(validate_config_secrets(&json!({"secretRef": "vault://x"})).is_ok());
    }

    #[test]
    fn retry_classification_matches_contract() {
        assert!(TaskError::timeout("slow").retryable());
        assert!(TaskError::execution_failed("boom").retryable());
        assert!(TaskError::provider_unavailable("plugin restarting").retryable());
        assert!(!TaskError::invalid_config("bad").retryable());
        assert!(!TaskError::connection_missing("gone").retryable());
        assert!(!TaskError::provider_not_found("gone").retryable());
        assert!(!TaskError::permission_denied("no").retryable());
        assert!(!TaskError::cancelled("user").retryable());
    }
}
