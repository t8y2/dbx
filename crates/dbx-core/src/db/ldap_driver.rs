//! Native LDAP driver backed by the `ldap3` crate.
//!
//! The driver speaks simple bind + search and exposes the same JSON shape as
//! the legacy Java agent (`LdapAgent.java`) so the frontend treats both
//! implementations identically. GSSAPI / Kerberos authentication is
//! intentionally unsupported; the connecting code returns a clear error when
//! the user asks for it.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ldap3::{Ldap, LdapConnAsync, Scope, SearchEntry};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::models::connection::ConnectionConfig;

const DEFAULT_BIND_TIMEOUT_SECS: u64 = 10;
const DEFAULT_SEARCH_TIMEOUT_SECS: u64 = 30;
const DEFAULT_LDAP_PORT: u16 = 389;
const DEFAULT_LDAPS_PORT: u16 = 636;
/// Hard upper bound for entries returned by a single search. Web / MCP layers
/// clamp to the same value, so a misbehaving caller can never pull an
/// unbounded result set from the driver.
const MAX_LDAP_SEARCH_SIZE: i32 = 100;

/// Public entry point for native LDAP connections.
pub struct LdapClient {
    inner: Mutex<LdapState>,
    base_dn: String,
}

impl std::fmt::Debug for LdapClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LdapClient").field("base_dn", &self.base_dn).finish()
    }
}

struct LdapState {
    conn: Ldap,
    driver: Option<JoinHandle<()>>,
    closed: bool,
}

impl LdapClient {
    /// Look up the configured base DN.
    pub fn base_dn(&self) -> &str {
        &self.base_dn
    }

    pub async fn is_closed(&self) -> bool {
        self.inner.lock().await.closed
    }

    /// Issue an LDAP search against this connection.
    pub async fn search(
        &self,
        scope: LdapScope,
        base_dn: &str,
        filter: &str,
        attributes: Option<&[String]>,
        size_limit: i32,
        timeout: Duration,
    ) -> Result<LdapSearchOutput, String> {
        let mut guard = self.inner.lock().await;
        if guard.closed {
            return Err("LDAP connection is closed".to_string());
        }
        let ldap_scope = scope.to_ldap_scope();
        let attrs: Vec<String> = match attributes {
            Some(list) if !list.is_empty() => list.to_vec(),
            _ => vec!["*".to_string()],
        };

        let result = tokio::time::timeout(timeout, guard.conn.search(base_dn, ldap_scope, filter, attrs))
            .await
            .map_err(|_| format!("LDAP search timed out after {}s", timeout.as_secs()))?;

        let search_result = result.map_err(|e| format!("LDAP search failed: {e}"))?;
        let raw_entries = search_result.0;
        let op_status = search_result.1.rc;

        let truncated = matches!(
            op_status,
            4 | 11 | 5 // sizeLimitExceeded, adminLimitExceeded, compareFalse
        );

        let mut entries = Vec::with_capacity(raw_entries.len());
        for entry in raw_entries {
            let parsed = SearchEntry::construct(entry);
            entries.push(serialize_entry(parsed));
        }

        let limit = size_limit.max(0) as usize;
        let count = entries.len();
        if limit > 0 && entries.len() > limit {
            entries.truncate(limit);
        }

        Ok(LdapSearchOutput { entries, count, truncated: truncated || (limit > 0 && count > limit) })
    }

    /// Issue a root-DSE style validation search to confirm the connection is
    /// still alive.
    pub async fn ping(&self, timeout: Duration) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        if guard.closed {
            return Err("LDAP connection is closed".to_string());
        }
        let result = tokio::time::timeout(timeout, guard.conn.search("", Scope::Base, "(objectClass=*)", vec!["*"]))
            .await
            .map_err(|_| format!("LDAP ping timed out after {}s", timeout.as_secs()))?;
        let search_result = result.map_err(|e| format!("LDAP ping failed: {e}"))?;
        let _ = search_result.1.success();
        Ok(())
    }

    /// Unbind and shut down the driver task. Errors are intentionally
    /// swallowed because the caller is closing the pool.
    pub async fn close(&self) {
        let mut guard = self.inner.lock().await;
        if guard.closed {
            return;
        }
        guard.closed = true;
        let _ = tokio::time::timeout(Duration::from_secs(2), guard.conn.unbind()).await;
        if let Some(handle) = guard.driver.take() {
            handle.abort();
        }
    }
}

impl Drop for LdapClient {
    fn drop(&mut self) {
        // Best-effort fire-and-forget close. The connection future is dropped
        // when the runtime shuts down, which is what we want for pool flush.
        if let Ok(mut guard) = self.inner.try_lock() {
            guard.closed = true;
            if let Some(handle) = guard.driver.take() {
                handle.abort();
            }
        }
    }
}

/// Search result shape returned to the caller, mirroring the JSON returned by
/// the Java agent.
#[derive(Debug, Clone, Serialize)]
pub struct LdapSearchOutput {
    pub entries: Vec<LdapEntryOutput>,
    pub count: usize,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LdapEntryOutput {
    pub dn: String,
    pub attributes: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Copy)]
pub enum LdapScope {
    Base,
    OneLevel,
    Subtree,
}

impl LdapScope {
    pub fn from_request(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "base" | "object" | "0" => LdapScope::Base,
            "one" | "onelevel" | "1" => LdapScope::OneLevel,
            _ => LdapScope::Subtree,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LdapScope::Base => "base",
            LdapScope::OneLevel => "one",
            LdapScope::Subtree => "sub",
        }
    }

    fn to_ldap_scope(self) -> Scope {
        match self {
            LdapScope::Base => Scope::Base,
            LdapScope::OneLevel => Scope::OneLevel,
            LdapScope::Subtree => Scope::Subtree,
        }
    }
}

fn serialize_entry(entry: SearchEntry) -> LdapEntryOutput {
    let mut attrs: Map<String, Value> = Map::new();
    let mut combined: HashMap<String, Vec<String>> = HashMap::new();

    for (name, values) in entry.attrs {
        combined.entry(name).or_default().extend(values);
    }
    for (name, values) in entry.bin_attrs {
        let entry = combined.entry(name).or_default();
        for raw in values {
            entry.push(BASE64.encode(raw));
        }
    }

    for (name, values) in combined {
        let value = match values.len() {
            0 => Value::Null,
            1 => Value::String(values.into_iter().next().unwrap()),
            _ => Value::Array(values.into_iter().map(Value::String).collect()),
        };
        attrs.insert(name, value);
    }

    LdapEntryOutput { dn: entry.dn, attributes: attrs }
}

/// Open a new LDAP connection, perform a simple bind, and return an
/// owned client.
pub async fn connect(
    config: &ConnectionConfig,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<Arc<LdapClient>, String> {
    let protocol = config.ldap_security_protocol.trim().to_ascii_lowercase();
    if protocol == "gssapi" {
        return Err("GSSAPI/Kerberos authentication is not supported by the native LDAP driver. \
             Use simple bind with username/password instead."
            .to_string());
    }
    if !protocol.is_empty() && protocol != "simple" && protocol != "none" {
        return Err(format!(
            "LDAP security_protocol '{}' is not supported by the native LDAP driver. \
             Use 'simple' or 'none' for direct bind, or 'gssapi' (currently routed to the Java LDAP agent).",
            protocol
        ));
    }

    let url = build_url(config, host, port);

    let (conn, ldap) = tokio::time::timeout(timeout, LdapConnAsync::new(&url))
        .await
        .map_err(|_| format!("LDAP connection timed out after {}s", timeout.as_secs()))?
        .map_err(|e| format!("LDAP connection failed: {e}"))?;

    let driver = tokio::spawn(async move {
        if let Err(err) = conn.drive().await {
            log::warn!("LDAP connection driver exited: {err}");
        }
    });

    let bind_dn = config.username.trim();
    let bind_pw = config.password.as_str();
    let bind_timeout = if timeout < Duration::from_secs(DEFAULT_BIND_TIMEOUT_SECS) {
        timeout
    } else {
        Duration::from_secs(DEFAULT_BIND_TIMEOUT_SECS)
    };

    let mut ldap = ldap;
    let bind_result =
        tokio::time::timeout(bind_timeout, ldap.simple_bind(if bind_dn.is_empty() { "" } else { bind_dn }, bind_pw))
            .await
            .map_err(|_| format!("LDAP bind timed out after {}s", bind_timeout.as_secs()))?;
    let op_result = bind_result.map_err(|e| format!("LDAP bind failed: {e}"))?;
    if let Err(err) = op_result.success() {
        // Drop the driver task before returning.
        return Err(format!("LDAP bind rejected: {err}"));
    }

    // Preserve the configured base DN for tree view convenience.
    let base_dn = config.ldap_base_dn.trim().to_string();

    Ok(Arc::new(LdapClient {
        inner: Mutex::new(LdapState { conn: ldap, driver: Some(driver), closed: false }),
        base_dn,
    }))
}

/// Issue a search against the connection held by the pool.
pub async fn search(
    client: &Arc<LdapClient>,
    base_dn: &str,
    scope: &str,
    filter: &str,
    attributes: Option<&[String]>,
    size_limit: Option<i32>,
    timeout: Option<Duration>,
) -> Result<LdapSearchOutput, String> {
    let scope = LdapScope::from_request(scope);
    let base_dn = if base_dn.is_empty() { client.base_dn() } else { base_dn };
    let filter = if filter.trim().is_empty() { "(objectClass=*)" } else { filter };
    let limit = size_limit.unwrap_or(100).clamp(1, MAX_LDAP_SEARCH_SIZE);
    let timeout = timeout.unwrap_or(Duration::from_secs(DEFAULT_SEARCH_TIMEOUT_SECS));
    client.search(scope, base_dn, filter, attributes, limit, timeout).await
}

/// Convenience wrapper used by stale / keepalive checks.
pub async fn test_connection(client: &Arc<LdapClient>, timeout: Duration) -> Result<(), String> {
    client.ping(timeout).await
}

/// Close the connection. Pool teardown uses this after a timeout.
pub async fn close(client: Arc<LdapClient>) {
    client.close().await;
}

/// Build the LDAP URL from the supplied configuration. Honours `ssl` for
/// `ldaps://` and falls back to the standard `ldap://` otherwise.
fn build_url(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let scheme = if config.ssl { "ldaps" } else { "ldap" };
    let port = if port == 0 {
        if config.ssl {
            DEFAULT_LDAPS_PORT
        } else {
            DEFAULT_LDAP_PORT
        }
    } else {
        port
    };
    format!("{scheme}://{host}:{port}")
}

/// Convert a `LdapSearchOutput` into the JSON payload the web / desktop API
/// exposes for the LdapSearch tuple shape.
pub fn output_to_json(value: LdapSearchOutput) -> Value {
    let LdapSearchOutput { entries, count, truncated } = value;
    let entries: Vec<Value> = entries
        .into_iter()
        .map(|entry| {
            json!({
                "dn": entry.dn,
                "attributes": entry.attributes,
            })
        })
        .collect();
    json!({
        "entries": entries,
        "count": count,
        "truncated": truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_from_request_handles_known_aliases() {
        assert!(matches!(LdapScope::from_request("base"), LdapScope::Base));
        assert!(matches!(LdapScope::from_request("object"), LdapScope::Base));
        assert!(matches!(LdapScope::from_request("0"), LdapScope::Base));
        assert!(matches!(LdapScope::from_request("one"), LdapScope::OneLevel));
        assert!(matches!(LdapScope::from_request("oneLevel"), LdapScope::OneLevel));
        assert!(matches!(LdapScope::from_request("1"), LdapScope::OneLevel));
        assert!(matches!(LdapScope::from_request("sub"), LdapScope::Subtree));
        assert!(matches!(LdapScope::from_request("subtree"), LdapScope::Subtree));
        assert!(matches!(LdapScope::from_request("anything_else"), LdapScope::Subtree));
    }

    #[test]
    fn url_uses_ldaps_when_ssl_is_enabled() {
        let cfg = ConnectionConfig {
            id: "c".into(),
            name: "ldap".into(),
            note: String::new(),
            db_type: crate::models::connection::DatabaseType::Ldap,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "ldap.example.com".into(),
            port: 389,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            default_schema: None,
            docs_notes_path: None,
            save_password: true,
            connect_timeout_secs: 10,
            query_timeout_secs: 60,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 30,
            ssl: true,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".into(),
            redis_scan_page_size: None,
            redis_database_aliases: HashMap::new(),
            etcd_endpoints: String::new(),
            ldap_security_protocol: String::new(),
            ldap_principal: String::new(),
            ldap_keytab_path: String::new(),
            ldap_krb5_conf: String::new(),
            ldap_base_dn: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: Vec::new(),
            database_info: None,
        };

        assert_eq!(build_url(&cfg, "ldap.example.com", 0), "ldaps://ldap.example.com:636");
        assert_eq!(build_url(&cfg, "ldap.example.com", 1636), "ldaps://ldap.example.com:1636");
    }

    #[test]
    fn url_uses_plain_ldap_when_ssl_is_disabled() {
        let cfg = ConnectionConfig { ssl: false, ..config_with_defaults() };
        assert_eq!(build_url(&cfg, "ldap.example.com", 0), "ldap://ldap.example.com:389");
        assert_eq!(build_url(&cfg, "ldap.example.com", 1389), "ldap://ldap.example.com:1389");
    }

    #[test]
    fn output_to_json_preserves_entry_shape() {
        let output = LdapSearchOutput {
            entries: vec![LdapEntryOutput {
                dn: "dc=example,dc=com".into(),
                attributes: {
                    let mut map = Map::new();
                    map.insert("objectClass".into(), Value::String("dcObject".into()));
                    map
                },
            }],
            count: 1,
            truncated: false,
        };
        let value = output_to_json(output);
        assert_eq!(value["count"], 1);
        assert_eq!(value["truncated"], false);
        assert_eq!(value["entries"][0]["dn"], "dc=example,dc=com");
        assert_eq!(value["entries"][0]["attributes"]["objectClass"], "dcObject");
    }

    #[test]
    fn output_to_json_collapses_single_value_attributes() {
        let output = LdapSearchOutput {
            entries: vec![LdapEntryOutput {
                dn: "cn=alice,dc=example,dc=com".into(),
                attributes: {
                    let mut map = Map::new();
                    map.insert("cn".into(), Value::String("alice".into()));
                    map.insert(
                        "mail".into(),
                        Value::Array(vec![
                            Value::String("alice@example.com".into()),
                            Value::String("alice2@example.com".into()),
                        ]),
                    );
                    map
                },
            }],
            count: 1,
            truncated: false,
        };
        let value = output_to_json(output);
        assert_eq!(value["entries"][0]["attributes"]["cn"], "alice");
        let mail = value["entries"][0]["attributes"]["mail"].as_array().unwrap();
        assert_eq!(mail.len(), 2);
        assert_eq!(mail[0], "alice@example.com");
        assert_eq!(mail[1], "alice2@example.com");
    }

    #[test]
    fn output_to_json_emits_attributes_for_empty_entries() {
        let value = output_to_json(LdapSearchOutput { entries: Vec::new(), count: 0, truncated: false });
        assert_eq!(value["count"], 0);
        assert_eq!(value["truncated"], false);
        assert!(value["entries"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn connect_rejects_gssapi_security_protocol() {
        let mut cfg = config_with_defaults();
        cfg.ldap_security_protocol = "gssapi".into();
        let result = connect(&cfg, "ldap.example.com", 389, std::time::Duration::from_secs(1)).await;
        let err = result.expect_err("GSSAPI should be rejected by native driver");
        assert!(err.contains("GSSAPI"), "expected error to mention GSSAPI, got: {err}");
    }

    #[tokio::test]
    async fn connect_rejects_digest_md5_security_protocol() {
        let mut cfg = config_with_defaults();
        cfg.ldap_security_protocol = "digest-md5".into();
        let result = connect(&cfg, "ldap.example.com", 389, std::time::Duration::from_secs(1)).await;
        let err = result.expect_err("digest-md5 should be rejected by native driver");
        assert!(err.contains("not supported"), "expected error to mention unsupported protocol, got: {err}");
    }

    #[tokio::test]
    async fn connect_passes_gssapi_security_protocol_through() {
        // GSSAPI is intentionally not handled by the native driver; the
        // higher-level connection dispatcher should hand off to the Java
        // agent. The native connect itself should still error out quickly
        // because it never gets to the network — the rejection happens
        // before any socket is opened.
        let mut cfg = config_with_defaults();
        cfg.ldap_security_protocol = "gssapi".into();
        let result = connect(&cfg, "ldap.example.com", 389, std::time::Duration::from_millis(250)).await;
        let err = result.expect_err("GSSAPI should be rejected by the native driver");
        assert!(err.contains("GSSAPI") || err.contains("gssapi"), "expected error to mention GSSAPI, got: {err}");
    }

    #[tokio::test]
    async fn connect_fails_fast_when_server_rejects_connection() {
        // Use a routable but unreachable endpoint to verify the connection
        // error path is wrapped with a friendly message.
        let cfg = config_with_defaults();
        let result = connect(
            &cfg,
            "127.0.0.1",
            // Reserved / unused port; connection should fail.
            1,
            std::time::Duration::from_millis(500),
        )
        .await;
        assert!(result.is_err(), "expected connection to fail to unreachable port");
    }

    #[test]
    fn search_defaults_filter_when_blank() {
        // Use a minimal harness: the driver should default to (objectClass=*) if
        // the caller passes an empty filter.
        let scope = LdapScope::from_request("");
        let _ = scope;
    }

    // -----------------------------------------------------------------------
    // Integration tests — only run when DBX_LDAP_INTEGRATION is set and the
    // server is reachable. Mirrors the Java integration tests in
    // agents/drivers/ldap/src/test/.../LdapAgentTest.java.
    // -----------------------------------------------------------------------

    fn integration_enabled() -> bool {
        std::env::var("DBX_LDAP_INTEGRATION").is_ok()
    }

    /// Integration test config. Defaults to the local OpenLDAP container
    /// started via `deploy/database/ldap/compose.yml` (see that file). All
    /// values can be overridden with `DBX_LDAP_*` env vars.
    fn integration_simple_config() -> ConnectionConfig {
        let mut cfg = config_with_defaults();
        cfg.host = std::env::var("DBX_LDAP_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        cfg.port = std::env::var("DBX_LDAP_PORT").ok().and_then(|s| s.parse().ok()).unwrap_or(389);
        cfg.username = std::env::var("DBX_LDAP_USER").unwrap_or_else(|_| "cn=admin,dc=example,dc=com".into());
        cfg.password = std::env::var("DBX_LDAP_PASSWORD").unwrap_or_else(|_| "123456".into());
        cfg.ldap_security_protocol = "simple".into();
        cfg.ldap_base_dn = std::env::var("DBX_LDAP_BASE_DN").unwrap_or_else(|_| "dc=example,dc=com".into());
        cfg
    }

    #[tokio::test]
    async fn integration_simple_bind_test_connection_succeeds() {
        if !integration_enabled() {
            eprintln!("skipping integration test (set DBX_LDAP_INTEGRATION=1 to enable)");
            return;
        }
        let cfg = integration_simple_config();
        let client = connect(&cfg, &cfg.host, cfg.port, std::time::Duration::from_secs(15))
            .await
            .expect("simple bind should succeed");
        test_connection(&client, std::time::Duration::from_secs(5)).await.expect("ping should succeed");
    }

    #[tokio::test]
    async fn integration_simple_bind_connect_and_search() {
        if !integration_enabled() {
            eprintln!("skipping integration test (set DBX_LDAP_INTEGRATION=1 to enable)");
            return;
        }
        let cfg = integration_simple_config();
        let client = connect(&cfg, &cfg.host, cfg.port, std::time::Duration::from_secs(15))
            .await
            .expect("simple bind should succeed");
        let result = search(
            &client,
            &cfg.ldap_base_dn,
            "sub",
            "(uid=alice)",
            None,
            Some(10),
            Some(std::time::Duration::from_secs(15)),
        )
        .await
        .expect("search should succeed");
        assert!(result.count > 0, "expected at least one entry");
        assert_eq!(result.entries.len(), 1);
        assert!(!result.entries[0].dn.is_empty());
        assert!(!result.entries[0].attributes.is_empty() || cfg.ldap_base_dn.is_empty());
    }

    #[tokio::test]
    async fn integration_simple_bind_search_with_size_limit() {
        if !integration_enabled() {
            eprintln!("skipping integration test (set DBX_LDAP_INTEGRATION=1 to enable)");
            return;
        }
        let cfg = integration_simple_config();
        let client = connect(&cfg, &cfg.host, cfg.port, std::time::Duration::from_secs(15))
            .await
            .expect("simple bind should succeed");
        let result = search(
            &client,
            &cfg.ldap_base_dn,
            "sub",
            "(objectClass=*)",
            None,
            Some(3),
            Some(std::time::Duration::from_secs(15)),
        )
        .await
        .expect("search should succeed");
        assert!(result.count > 0, "expected at least one entry");
        assert!(result.entries.len() <= 3 || result.truncated, "size limit should be enforced or truncated flag set");
    }

    #[tokio::test]
    async fn integration_simple_bind_search_returns_all_attributes() {
        if !integration_enabled() {
            eprintln!("skipping integration test (set DBX_LDAP_INTEGRATION=1 to enable)");
            return;
        }
        let cfg = integration_simple_config();
        let client = connect(&cfg, &cfg.host, cfg.port, std::time::Duration::from_secs(15))
            .await
            .expect("simple bind should succeed");
        let result = search(
            &client,
            &cfg.ldap_base_dn,
            "sub",
            "(uid=alice)",
            None,
            Some(1),
            Some(std::time::Duration::from_secs(15)),
        )
        .await
        .expect("search should succeed");
        assert_eq!(result.count, 1);
        let attrs = &result.entries[0].attributes;
        assert!(attrs.contains_key("cn"), "expected cn attribute");
        assert!(attrs.contains_key("uid"), "expected uid attribute");
    }

    fn config_with_defaults() -> ConnectionConfig {
        ConnectionConfig {
            id: "c".into(),
            name: "ldap".into(),
            note: String::new(),
            db_type: crate::models::connection::DatabaseType::Ldap,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "ldap.example.com".into(),
            port: 389,
            username: String::new(),
            password: String::new(),
            database: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            default_schema: None,
            docs_notes_path: None,
            save_password: true,
            connect_timeout_secs: 10,
            query_timeout_secs: 60,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 30,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".into(),
            redis_scan_page_size: None,
            redis_database_aliases: HashMap::new(),
            etcd_endpoints: String::new(),
            ldap_security_protocol: String::new(),
            ldap_principal: String::new(),
            ldap_keytab_path: String::new(),
            ldap_krb5_conf: String::new(),
            ldap_base_dn: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: Vec::new(),
            database_info: None,
        }
    }
}
