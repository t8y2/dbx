use serde_json::{json, Value};

use crate::models::connection::{ConnectionConfig, DatabaseType};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NatsConnectionConfig {
    /// The configured NATS URL. It remains the TLS server-name source even
    /// when DBX reaches it through a local SSH/proxy tunnel.
    pub server_url: String,
    /// Optional local endpoint supplied by DBX transport layers. These fields
    /// are intentionally separate from `server_url` so TLS SNI is not changed
    /// to `127.0.0.1` or the proxy host.
    pub connect_host: Option<String>,
    pub connect_port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub token: Option<String>,
    pub tls_skip_verify: bool,
    pub connect_timeout_secs: u64,
    pub request_timeout_secs: u64,
}

impl NatsConnectionConfig {
    pub fn from_connection(connection: &ConnectionConfig) -> Result<Self, String> {
        if connection.db_type != DatabaseType::MessageQueue {
            return Err("NATS requires a message queue connection profile".to_string());
        }
        let raw = connection.external_config.as_ref().ok_or("NATS connection is missing external_config")?;
        let object = raw.as_object().ok_or("NATS external_config must be an object")?;
        let kind = object.get("systemKind").and_then(Value::as_str).unwrap_or_default();
        if !kind.eq_ignore_ascii_case("nats") {
            return Err("Message queue connection is not configured as NATS (systemKind=nats)".to_string());
        }

        let server_url = object
            .get("serverUrl")
            .or_else(|| object.get("server_url"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                let scheme = if connection.ssl { "tls" } else { "nats" };
                format!(
                    "{scheme}://{}:{}",
                    connection.host.trim(),
                    if connection.port == 0 { 4222 } else { connection.port }
                )
            });
        let parsed = reqwest::Url::parse(&server_url).map_err(|error| format!("Invalid NATS server URL: {error}"))?;
        if !matches!(parsed.scheme(), "nats" | "tls")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || (parsed.path() != "/" && !parsed.path().is_empty())
        {
            return Err("NATS server URL must use nats:// or tls:// and include a host".to_string());
        }
        let url_uses_tls = parsed.scheme() == "tls";
        if connection.ssl != url_uses_tls {
            return Err("NATS server URL scheme and the TLS setting must agree".to_string());
        }
        let auth = object.get("auth").and_then(Value::as_object);
        let username = object
            .get("username")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| auth.and_then(|auth| auth.get("username")).and_then(Value::as_str).map(ToOwned::to_owned))
            .or_else(|| (!connection.username.trim().is_empty()).then(|| connection.username.clone()));
        let password = object
            .get("password")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| auth.and_then(|auth| auth.get("password")).and_then(Value::as_str).map(ToOwned::to_owned))
            .or_else(|| (!connection.password.is_empty()).then(|| connection.password.clone()));
        let token = object
            .get("token")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| auth.and_then(|auth| auth.get("token")).and_then(Value::as_str).map(ToOwned::to_owned));
        if token.as_deref().is_some_and(|token| !token.is_empty())
            && (username.as_deref().is_some_and(|username| !username.is_empty())
                || password.as_deref().is_some_and(|password| !password.is_empty()))
        {
            return Err(
                "NATS connection must use either token or username/password authentication, not both".to_string()
            );
        }
        let tls_skip_verify = object.get("tlsSkipVerify").and_then(Value::as_bool).unwrap_or(false);
        let connect_timeout_secs = connection.effective_connect_timeout_secs().max(1);
        let request_timeout_secs = connection.effective_query_timeout_secs().max(1);
        Ok(Self {
            server_url,
            connect_host: None,
            connect_port: None,
            username,
            password,
            token,
            tls_skip_verify,
            connect_timeout_secs,
            request_timeout_secs,
        })
    }

    /// Use a local DBX tunnel/proxy endpoint without changing the configured
    /// URL or TLS server name.
    pub fn with_connect_override(mut self, host: &str, port: u16) -> Result<Self, String> {
        let host = host.trim();
        if host.is_empty() || port == 0 {
            return Err("NATS transport override requires a host and port".to_string());
        }
        self.connect_host = Some(host.to_string());
        self.connect_port = Some(port);
        Ok(self)
    }

    pub fn configured_endpoint(&self) -> Result<(String, u16), String> {
        let parsed =
            reqwest::Url::parse(&self.server_url).map_err(|error| format!("Invalid NATS server URL: {error}"))?;
        Ok((parsed.host_str().ok_or("NATS server URL is missing a host")?.to_string(), parsed.port().unwrap_or(4222)))
    }

    pub fn agent_value(&self) -> Value {
        json!({
            "serverUrl": self.server_url,
            "connectHost": self.connect_host,
            "connectPort": self.connect_port,
            "username": self.username,
            "password": self.password,
            "token": self.token,
            "tlsSkipVerify": self.tls_skip_verify,
            "connectTimeoutMs": self.connect_timeout_secs.saturating_mul(1000),
            "requestTimeoutMs": self.request_timeout_secs.saturating_mul(1000),
        })
    }

    pub fn is_nats_connection(connection: &ConnectionConfig) -> bool {
        Self::from_connection(connection).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_nats_mq_profiles() {
        let connection: ConnectionConfig = serde_json::from_value(json!({
            "id":"c1","name":"mq","db_type":"mq","host":"localhost","port":4222,
            "username":"","password":"","ssl":false,
            "external_config":{"systemKind":"rabbitmq"}
        }))
        .unwrap();
        assert!(NatsConnectionConfig::from_connection(&connection).is_err());
    }

    #[test]
    fn builds_nats_url_from_connection_fields() {
        let connection: ConnectionConfig = serde_json::from_value(json!({
            "id":"c1","name":"nats","db_type":"mq","host":"localhost","port":4222,
            "username":"alice","password":"secret","ssl":false,
            "external_config":{"systemKind":"nats"}
        }))
        .unwrap();
        let config = NatsConnectionConfig::from_connection(&connection).unwrap();
        assert_eq!(config.server_url, "nats://localhost:4222");
        assert_eq!(config.username.as_deref(), Some("alice"));
    }

    #[test]
    fn accepts_legacy_nested_auth_and_prefers_canonical_top_level_credentials() {
        let legacy: ConnectionConfig = serde_json::from_value(json!({
            "id":"c1","name":"nats","db_type":"mq","host":"localhost","port":4222,
            "username":"","password":"","ssl":false,
            "external_config":{
                "systemKind":"nats","serverUrl":"nats://localhost:4222",
                "auth":{"kind":"basic","username":"legacy","password":"legacy-password"}
            }
        }))
        .unwrap();
        let config = NatsConnectionConfig::from_connection(&legacy).unwrap();
        assert_eq!(config.username.as_deref(), Some("legacy"));
        assert_eq!(config.password.as_deref(), Some("legacy-password"));

        let canonical: ConnectionConfig = serde_json::from_value(json!({
            "id":"c2","name":"nats","db_type":"mq","host":"localhost","port":4222,
            "username":"","password":"","ssl":false,
            "external_config":{
                "systemKind":"nats","serverUrl":"nats://localhost:4222",
                "username":"canonical","password":"canonical-password",
                "auth":{"kind":"basic","username":"legacy","password":"legacy-password"}
            }
        }))
        .unwrap();
        let config = NatsConnectionConfig::from_connection(&canonical).unwrap();
        assert_eq!(config.username.as_deref(), Some("canonical"));
        assert_eq!(config.password.as_deref(), Some("canonical-password"));
    }

    #[test]
    fn rejects_credential_bearing_urls_and_mixed_authentication() {
        let credential_url: ConnectionConfig = serde_json::from_value(json!({
            "id":"c1","name":"nats","db_type":"mq","host":"localhost","port":4222,
            "username":"","password":"","ssl":false,
            "external_config":{"systemKind":"nats","serverUrl":"nats://token@localhost:4222"}
        }))
        .unwrap();
        assert!(NatsConnectionConfig::from_connection(&credential_url).is_err());

        let mixed_auth: ConnectionConfig = serde_json::from_value(json!({
            "id":"c2","name":"nats","db_type":"mq","host":"localhost","port":4222,
            "username":"","password":"","ssl":false,
            "external_config":{"systemKind":"nats","serverUrl":"nats://localhost:4222","username":"alice","password":"secret","token":"token"}
        }))
        .unwrap();
        assert!(NatsConnectionConfig::from_connection(&mixed_auth).is_err());
    }

    #[test]
    fn keeps_tls_server_name_when_a_transport_override_is_used() {
        let connection: ConnectionConfig = serde_json::from_value(json!({
            "id":"c1","name":"nats","db_type":"mq","host":"nats.example.test","port":4222,
            "username":"","password":"","ssl":true,
            "external_config":{"systemKind":"nats","serverUrl":"tls://nats.example.test:4222"}
        }))
        .unwrap();
        let config = NatsConnectionConfig::from_connection(&connection)
            .unwrap()
            .with_connect_override("127.0.0.1", 43123)
            .unwrap();
        assert_eq!(config.configured_endpoint().unwrap(), ("nats.example.test".to_string(), 4222));
        assert_eq!(config.agent_value()["connectHost"], "127.0.0.1");
        assert_eq!(config.agent_value()["connectPort"], 43123);
    }

    #[test]
    fn rejects_conflicting_url_scheme_and_tls_setting() {
        let connection: ConnectionConfig = serde_json::from_value(json!({
            "id":"c1","name":"nats","db_type":"mq","host":"localhost","port":4222,
            "username":"","password":"","ssl":false,
            "external_config":{"systemKind":"nats","serverUrl":"tls://localhost:4222"}
        }))
        .unwrap();
        assert!(NatsConnectionConfig::from_connection(&connection).is_err());
    }
}
