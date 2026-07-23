use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IdentifierCase {
    Lower,
    Upper,
    Mixed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseConnectionInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_charset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_collation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unquoted_identifier_case: Option<IdentifierCase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quoted_identifier_case: Option<IdentifierCase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jdbc_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestResult {
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_info: Option<DatabaseConnectionInfo>,
}

impl ConnectionTestResult {
    pub fn success(message: impl Into<String>) -> Self {
        Self { message: message.into(), database_info: None }
    }

    pub fn with_database_info(mut self, database_info: Option<DatabaseConnectionInfo>) -> Self {
        self.database_info = database_info;
        self
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseInfoEnvelope {
    #[serde(default)]
    database_info: Option<DatabaseConnectionInfo>,
}

pub fn database_info_from_protocol_value(value: &Value) -> Option<DatabaseConnectionInfo> {
    serde_json::from_value::<DatabaseInfoEnvelope>(value.clone()).ok()?.database_info
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    #[serde(default)]
    pub driver_profile: Option<String>,
    #[serde(default)]
    pub driver_label: Option<String>,
    #[serde(default)]
    pub url_params: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_java_options: Vec<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_databases: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_schemas: Option<HashMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attached_databases: Vec<AttachedDatabaseConfig>,
    /// SQL statements executed right after the connection is established
    /// (DuckDB only for now): INSTALL/LOAD, SET, CREATE SECRET, ATTACH, ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_script: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transport_layers: Vec<TransportLayerConfig>,
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default = "default_query_timeout_secs")]
    pub query_timeout_secs: u64,
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    #[serde(default = "default_keepalive_interval_secs")]
    pub keepalive_interval_secs: u64,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ca_cert_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_cert_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_key_path: String,
    #[serde(default)]
    pub sysdba: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oracle_connection_type: Option<String>,
    #[serde(default)]
    pub connection_string: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redis_connection_mode: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub redis_sentinel_master: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub redis_sentinel_nodes: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub redis_sentinel_username: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub redis_sentinel_password: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub redis_sentinel_tls: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub redis_cluster_nodes: String,
    #[serde(default = "default_redis_key_separator", skip_serializing_if = "is_default_redis_separator")]
    pub redis_key_separator: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redis_scan_page_size: Option<u64>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub etcd_endpoints: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub gbase_server: String,
    /// Informix server name (INFORMIXSERVER). When empty, the agent
    /// derives it from the hostname.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub informix_server: String,
    /// Typed configuration for external tabular sources.
    #[serde(default)]
    pub external_config: Option<serde_json::Value>,
    #[serde(default)]
    pub jdbc_driver_class: Option<String>,
    #[serde(default)]
    pub jdbc_driver_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub one_time: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub read_only: bool,
    /// Explicitly marks every database reachable through this connection as production.
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_production: bool,
    /// Database-level production markers for multi-database connections.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub production_databases: Vec<String>,
    /// Metadata captured from the latest successful connection test for this saved config.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_info: Option<DatabaseConnectionInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TransportLayerConfig {
    Ssh(SshTunnelConfig),
    Proxy(ProxyTunnelConfig),
    #[serde(rename = "http_tunnel")]
    HttpTunnel(HttpTunnelConfig),
}

impl TransportLayerConfig {
    pub fn same_type_as(&self, other: &TransportLayerConfig) -> bool {
        matches!(
            (self, other),
            (TransportLayerConfig::Ssh(_), TransportLayerConfig::Ssh(_))
                | (TransportLayerConfig::Proxy(_), TransportLayerConfig::Proxy(_))
                | (TransportLayerConfig::HttpTunnel(_), TransportLayerConfig::HttpTunnel(_))
        )
    }

    pub fn id(&self) -> &str {
        match self {
            TransportLayerConfig::Ssh(layer) => &layer.id,
            TransportLayerConfig::Proxy(layer) => &layer.id,
            TransportLayerConfig::HttpTunnel(layer) => &layer.id,
        }
    }

    pub fn profile_id(&self) -> &str {
        match self {
            TransportLayerConfig::Ssh(layer) => &layer.profile_id,
            TransportLayerConfig::Proxy(layer) => &layer.profile_id,
            TransportLayerConfig::HttpTunnel(layer) => &layer.profile_id,
        }
    }

    /// Builds the concrete layer used at connect time for a layer that
    /// references a shared tunnel profile: the profile supplies the whole
    /// configuration while the referencing layer keeps its own identity,
    /// enabled flag, and profile reference.
    pub fn resolved_from_profile(&self, profile: &TransportLayerConfig) -> TransportLayerConfig {
        let mut resolved = profile.clone();
        let (id, enabled, profile_id) = (self.id().to_string(), self.enabled(), self.profile_id().to_string());
        match &mut resolved {
            TransportLayerConfig::Ssh(layer) => {
                layer.id = id;
                layer.enabled = enabled;
                layer.profile_id = profile_id;
            }
            TransportLayerConfig::Proxy(layer) => {
                layer.id = id;
                layer.enabled = enabled;
                layer.profile_id = profile_id;
            }
            TransportLayerConfig::HttpTunnel(layer) => {
                layer.id = id;
                layer.enabled = enabled;
                layer.profile_id = profile_id;
            }
        }
        resolved
    }

    pub fn scrub_secrets(&mut self) {
        match self {
            TransportLayerConfig::Ssh(layer) => {
                layer.password = String::new();
                layer.key_passphrase = String::new();
            }
            TransportLayerConfig::Proxy(layer) => {
                layer.password = String::new();
            }
            TransportLayerConfig::HttpTunnel(layer) => {
                layer.token = String::new();
            }
        }
    }

    pub fn name(&self) -> &str {
        match self {
            TransportLayerConfig::Ssh(layer) => &layer.name,
            TransportLayerConfig::Proxy(layer) => &layer.name,
            TransportLayerConfig::HttpTunnel(layer) => &layer.name,
        }
    }

    pub fn enabled(&self) -> bool {
        match self {
            TransportLayerConfig::Ssh(layer) => layer.enabled,
            TransportLayerConfig::Proxy(layer) => layer.enabled,
            TransportLayerConfig::HttpTunnel(layer) => layer.enabled,
        }
    }

    pub fn endpoint(&self) -> (&str, u16) {
        match self {
            TransportLayerConfig::Ssh(layer) => (&layer.host, layer.port),
            TransportLayerConfig::Proxy(layer) => (&layer.host, layer.port),
            // HTTP script tunnel layers dial a PHP script URL instead of a host:port
            // endpoint, and are validated as the outermost transport layer.
            TransportLayerConfig::HttpTunnel(_) => ("", 0),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SshTunnelConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub key_passphrase: String,
    #[serde(default = "default_ssh_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default)]
    pub expose_lan: bool,
    #[serde(default)]
    pub use_ssh_agent: bool,
    /// Custom SSH agent socket path (e.g. `~/.ssh/agent.sock`).
    /// When set and `use_ssh_agent` is true, this path is used instead of
    /// the `SSH_AUTH_SOCK` environment variable.
    #[serde(default)]
    pub ssh_agent_sock_path: String,
    /// Login method: `"password"`, `"key"`, `"agent"`, or `"none"`.
    /// Empty string means an older saved connection predating this field —
    /// the backend falls back to probing key > password > agent based on
    /// which fields are non-empty. When set to a specific method the backend
    /// only tries that method (after the standard `none` probe).
    #[serde(default)]
    pub auth_method: String,
    /// When non-empty, this layer references a shared tunnel profile
    /// (Settings > Tunnels). The profile's configuration replaces this
    /// layer's own fields at connect time; only `id` and `enabled` are
    /// kept from the referencing layer.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProxyTunnelConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub proxy_type: ProxyType,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_proxy_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    /// Optional target for tunnel profile testing. When set, the test connects
    /// to this `host:port`; when empty, the test performs an endpoint-only
    /// liveness probe that requires no external destination.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub test_target: Option<String>,
    /// See [`SshTunnelConfig::profile_id`].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HttpTunnelConfig {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub token: String,
    #[serde(default = "default_http_tunnel_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    /// See [`SshTunnelConfig::profile_id`].
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachedDatabaseConfig {
    pub name: String,
    pub path: String,
}

fn default_true() -> bool {
    true
}

fn default_ssh_port() -> u16 {
    22
}

pub fn default_ssh_connect_timeout_secs() -> u64 {
    5
}

pub fn default_http_tunnel_connect_timeout_secs() -> u64 {
    10
}

pub fn default_connect_timeout_secs() -> u64 {
    10
}

pub fn default_query_timeout_secs() -> u64 {
    60
}

pub fn default_idle_timeout_secs() -> u64 {
    60
}

pub fn default_keepalive_interval_secs() -> u64 {
    30
}

fn default_proxy_port() -> u16 {
    1080
}

fn is_false(value: &bool) -> bool {
    !*value
}

pub fn default_redis_key_separator() -> String {
    ":".to_string()
}

fn is_default_redis_separator(value: &str) -> bool {
    value == ":"
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum ProxyType {
    #[default]
    Socks5,
    Http,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    Mysql,
    Postgres,
    Sqlite,
    Rqlite,
    Redis,
    #[serde(rename = "duckdb")]
    DuckDb,
    #[serde(rename = "clickhouse")]
    ClickHouse,
    #[serde(rename = "sqlserver")]
    SqlServer,
    #[serde(rename = "mongodb")]
    MongoDb,
    #[serde(rename = "oracle")]
    Oracle,
    #[serde(rename = "elasticsearch")]
    Elasticsearch,
    #[serde(rename = "qdrant")]
    Qdrant,
    #[serde(rename = "milvus")]
    Milvus,
    #[serde(rename = "weaviate")]
    Weaviate,
    #[serde(rename = "chromadb")]
    ChromaDb,
    Doris,
    #[serde(rename = "starrocks")]
    StarRocks,
    #[serde(rename = "manticoresearch")]
    ManticoreSearch,
    Databend,
    Redshift,
    Dameng,
    Kingbase,
    Highgo,
    Vastbase,
    Goldendb,
    Gaussdb,
    Kwdb,
    Yashandb,
    Databricks,
    #[serde(rename = "saphana")]
    SapHana,
    Teradata,
    Vertica,
    Firebird,
    Exasol,
    #[serde(rename = "opengauss")]
    OpenGauss,
    #[serde(rename = "oceanbase-oracle")]
    OceanbaseOracle,
    Gbase,
    Access,
    #[serde(rename = "h2")]
    H2,
    Snowflake,
    Trino,
    #[serde(rename = "prestosql")]
    PrestoSql,
    Hive,
    Spark,
    #[serde(rename = "db2")]
    Db2,
    Informix,
    #[serde(rename = "neo4j")]
    Neo4j,
    Cassandra,
    #[serde(rename = "bigquery")]
    Bigquery,
    Kylin,
    Sundb,
    Oscar,
    Tdengine,
    Xugu,
    Iotdb,
    Etcd,
    #[serde(rename = "zookeeper")]
    ZooKeeper,
    Nacos,
    #[serde(rename = "iris")]
    Iris,
    #[serde(rename = "turso")]
    Turso,
    #[serde(rename = "cloudflare-d1")]
    CloudflareD1,
    #[serde(rename = "influxdb")]
    InfluxDb,
    #[serde(rename = "questdb")]
    Questdb,
    Jdbc,
    /// Message queue admin connection (Pulsar / Kafka / RocketMQ). The specific
    /// system is determined by `external_config.systemKind`.
    #[serde(rename = "mq")]
    MessageQueue,
}

#[derive(Deserialize)]
struct ConnectionConfigData {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    #[serde(default)]
    pub driver_profile: Option<String>,
    #[serde(default)]
    pub driver_label: Option<String>,
    #[serde(default)]
    pub url_params: Option<String>,
    #[serde(default)]
    pub agent_java_options: Vec<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: Option<String>,
    #[serde(default)]
    pub visible_databases: Option<Vec<String>>,
    #[serde(default)]
    pub visible_schemas: Option<HashMap<String, Vec<String>>>,
    #[serde(default)]
    pub attached_databases: Vec<AttachedDatabaseConfig>,
    #[serde(default)]
    pub init_script: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub transport_layers: Vec<TransportLayerConfig>,
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default = "default_query_timeout_secs")]
    pub query_timeout_secs: u64,
    #[serde(default = "default_idle_timeout_secs")]
    pub idle_timeout_secs: u64,
    #[serde(default = "default_keepalive_interval_secs")]
    pub keepalive_interval_secs: u64,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub ca_cert_path: String,
    #[serde(default)]
    pub client_cert_path: String,
    #[serde(default)]
    pub client_key_path: String,
    #[serde(default)]
    pub sysdba: bool,
    #[serde(default)]
    pub oracle_connection_type: Option<String>,
    #[serde(default)]
    pub connection_string: Option<String>,
    #[serde(default)]
    pub redis_connection_mode: Option<String>,
    #[serde(default)]
    pub redis_sentinel_master: String,
    #[serde(default)]
    pub redis_sentinel_nodes: String,
    #[serde(default)]
    pub redis_sentinel_username: String,
    #[serde(default)]
    pub redis_sentinel_password: String,
    #[serde(default)]
    pub redis_sentinel_tls: bool,
    #[serde(default)]
    pub redis_cluster_nodes: String,
    #[serde(default = "default_redis_key_separator")]
    pub redis_key_separator: String,
    #[serde(default)]
    pub redis_scan_page_size: Option<u64>,
    #[serde(default)]
    pub etcd_endpoints: String,
    #[serde(default)]
    pub gbase_server: String,
    #[serde(default)]
    pub informix_server: String,
    #[serde(default)]
    pub external_config: Option<serde_json::Value>,
    #[serde(default)]
    pub jdbc_driver_class: Option<String>,
    #[serde(default)]
    pub jdbc_driver_paths: Vec<String>,
    #[serde(default)]
    pub one_time: bool,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub is_production: bool,
    #[serde(default)]
    pub production_databases: Vec<String>,
    #[serde(default)]
    pub database_info: Option<DatabaseConnectionInfo>,
}

impl From<ConnectionConfigData> for ConnectionConfig {
    fn from(data: ConnectionConfigData) -> Self {
        Self {
            id: data.id,
            name: data.name,
            db_type: data.db_type,
            driver_profile: data.driver_profile,
            driver_label: data.driver_label,
            url_params: data.url_params,
            agent_java_options: data.agent_java_options,
            host: data.host,
            port: data.port,
            username: data.username,
            password: data.password,
            database: data.database,
            visible_databases: data.visible_databases,
            visible_schemas: data.visible_schemas,
            attached_databases: data.attached_databases,
            init_script: data.init_script,
            color: data.color,
            transport_layers: data.transport_layers,
            connect_timeout_secs: data.connect_timeout_secs,
            query_timeout_secs: data.query_timeout_secs,
            idle_timeout_secs: data.idle_timeout_secs,
            keepalive_interval_secs: data.keepalive_interval_secs,
            ssl: data.ssl,
            ca_cert_path: data.ca_cert_path,
            client_cert_path: data.client_cert_path,
            client_key_path: data.client_key_path,
            sysdba: data.sysdba,
            oracle_connection_type: data.oracle_connection_type,
            connection_string: data.connection_string,
            redis_connection_mode: data.redis_connection_mode,
            redis_sentinel_master: data.redis_sentinel_master,
            redis_sentinel_nodes: data.redis_sentinel_nodes,
            redis_sentinel_username: data.redis_sentinel_username,
            redis_sentinel_password: data.redis_sentinel_password,
            redis_sentinel_tls: data.redis_sentinel_tls,
            redis_cluster_nodes: data.redis_cluster_nodes,
            redis_key_separator: data.redis_key_separator,
            redis_scan_page_size: data.redis_scan_page_size,
            etcd_endpoints: data.etcd_endpoints,
            gbase_server: data.gbase_server,
            informix_server: data.informix_server,
            external_config: data.external_config,
            jdbc_driver_class: data.jdbc_driver_class,
            jdbc_driver_paths: data.jdbc_driver_paths,
            one_time: data.one_time,
            read_only: data.read_only,
            is_production: data.is_production,
            production_databases: data.production_databases,
            database_info: data.database_info,
        }
    }
}

impl<'de> Deserialize<'de> for ConnectionConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let mut value = Value::deserialize(deserializer)?;
        migrate_legacy_transport_layers(&mut value);
        let data = ConnectionConfigData::deserialize(value).map_err(serde::de::Error::custom)?;
        Ok(data.into())
    }
}

fn migrate_legacy_transport_layers(value: &mut Value) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if object.get("transport_layers").and_then(Value::as_array).is_some_and(|layers| !layers.is_empty()) {
        return;
    }

    let mut layers = Vec::new();
    let ssh_enabled = object.get("ssh_enabled").and_then(Value::as_bool).unwrap_or(false);
    if ssh_enabled {
        if let Some(ssh_tunnels) = object.get("ssh_tunnels").and_then(Value::as_array) {
            for hop in ssh_tunnels {
                let mut layer = hop.clone();
                if let Some(layer_object) = layer.as_object_mut() {
                    layer_object.insert("type".to_string(), Value::String("ssh".to_string()));
                }
                layers.push(layer);
            }
        }

        if layers.is_empty() && string_field(object, "ssh_host").is_some() {
            let mut layer = serde_json::Map::new();
            layer.insert("type".to_string(), Value::String("ssh".to_string()));
            layer.insert("id".to_string(), Value::String("legacy".to_string()));
            layer.insert("enabled".to_string(), Value::Bool(true));
            copy_string(object, &mut layer, "ssh_host", "host");
            copy_u64(object, &mut layer, "ssh_port", "port", default_ssh_port() as u64);
            copy_string(object, &mut layer, "ssh_user", "user");
            copy_string(object, &mut layer, "ssh_password", "password");
            copy_string(object, &mut layer, "ssh_key_path", "key_path");
            copy_string(object, &mut layer, "ssh_key_passphrase", "key_passphrase");
            copy_u64(
                object,
                &mut layer,
                "ssh_connect_timeout_secs",
                "connect_timeout_secs",
                default_ssh_connect_timeout_secs(),
            );
            copy_bool(object, &mut layer, "ssh_expose_lan", "expose_lan");
            layers.push(Value::Object(layer));
        }
    }

    let proxy_enabled = object.get("proxy_enabled").and_then(Value::as_bool).unwrap_or(false);
    if proxy_enabled && string_field(object, "proxy_host").is_some() {
        let mut layer = serde_json::Map::new();
        layer.insert("type".to_string(), Value::String("proxy".to_string()));
        layer.insert("id".to_string(), Value::String("legacy-proxy".to_string()));
        layer.insert("enabled".to_string(), Value::Bool(true));
        copy_string(object, &mut layer, "proxy_type", "proxy_type");
        copy_string(object, &mut layer, "proxy_host", "host");
        copy_u64(object, &mut layer, "proxy_port", "port", default_proxy_port() as u64);
        copy_string(object, &mut layer, "proxy_username", "username");
        copy_string(object, &mut layer, "proxy_password", "password");
        layers.push(Value::Object(layer));
    }

    if !layers.is_empty() {
        object.insert("transport_layers".to_string(), Value::Array(layers));
    }
}

fn string_field(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
}

fn copy_string(
    object: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    from: &str,
    to: &str,
) {
    if let Some(value) = object.get(from).and_then(Value::as_str) {
        target.insert(to.to_string(), Value::String(value.to_string()));
    }
}

fn copy_bool(
    object: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    from: &str,
    to: &str,
) {
    if let Some(value) = object.get(from).and_then(Value::as_bool) {
        target.insert(to.to_string(), Value::Bool(value));
    }
}

fn copy_u64(
    object: &serde_json::Map<String, Value>,
    target: &mut serde_json::Map<String, Value>,
    from: &str,
    to: &str,
    default: u64,
) {
    let value = object.get(from).and_then(Value::as_u64).filter(|value| *value > 0).unwrap_or(default);
    target.insert(to.to_string(), Value::Number(value.into()));
}

impl ConnectionConfig {
    pub fn effective_transport_layers(&self) -> Vec<TransportLayerConfig> {
        self.transport_layers.iter().filter(|layer| layer.enabled()).cloned().collect()
    }

    pub fn effective_ssh_tunnels(&self) -> Vec<SshTunnelConfig> {
        self.effective_transport_layers()
            .into_iter()
            .filter_map(|layer| match layer {
                TransportLayerConfig::Ssh(ssh) => Some(ssh),
                TransportLayerConfig::Proxy(_) | TransportLayerConfig::HttpTunnel(_) => None,
            })
            .collect()
    }

    pub fn has_effective_transport_layers(&self) -> bool {
        !self.effective_transport_layers().is_empty()
    }

    pub fn has_effective_ssh_tunnels(&self) -> bool {
        self.effective_transport_layers().iter().any(|layer| matches!(layer, TransportLayerConfig::Ssh(_)))
    }

    pub fn effective_connect_timeout_secs(&self) -> u64 {
        if self.connect_timeout_secs == 0 {
            default_connect_timeout_secs()
        } else {
            self.connect_timeout_secs.clamp(1, 300)
        }
    }

    pub fn effective_query_timeout_secs(&self) -> u64 {
        if self.query_timeout_secs == 0 {
            0
        } else {
            self.query_timeout_secs.max(1)
        }
    }

    pub fn effective_database(&self) -> Option<&str> {
        self.database.as_deref().filter(|database| !database.trim().is_empty()).or_else(|| self.default_database())
    }

    fn default_database(&self) -> Option<&'static str> {
        match self.db_type {
            DatabaseType::Postgres => match self.driver_profile.as_deref() {
                Some("cockroachdb") => Some("defaultdb"),
                _ => Some("postgres"),
            },
            DatabaseType::Redshift => Some("dev"),
            DatabaseType::ClickHouse => Some("default"),
            DatabaseType::Rqlite | DatabaseType::Turso | DatabaseType::CloudflareD1 => Some("main"),
            DatabaseType::Gaussdb | DatabaseType::OpenGauss => Some("postgres"),
            DatabaseType::Kwdb => Some("defaultdb"),
            DatabaseType::Vastbase => Some("postgres"),
            DatabaseType::Highgo => Some("highgo"),
            DatabaseType::Yashandb => Some("yasdb"),
            DatabaseType::Oscar => Some("osrdb"),
            DatabaseType::Firebird => Some("employee"),
            DatabaseType::H2 => Some("test"),
            DatabaseType::Informix => Some("sysmaster"),
            DatabaseType::Neo4j => Some("neo4j"),
            _ => None,
        }
    }

    pub fn needs_bare_mysql(&self) -> bool {
        matches!(self.db_type, DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch)
            || self.driver_profile.as_deref().map(|p| p.to_lowercase()).is_some_and(|p| {
                matches!(p.as_str(), "doris" | "starrocks" | "manticoresearch" | "selectdb" | "oceanbase")
            })
    }

    pub fn is_starrocks(&self) -> bool {
        self.db_type == DatabaseType::StarRocks
            || self.driver_profile.as_deref().is_some_and(|profile| profile.eq_ignore_ascii_case("starrocks"))
    }

    pub fn bare_mysql_supports_tls(&self) -> bool {
        self.is_starrocks()
    }

    pub fn bare_mysql_uses_tls(&self) -> bool {
        if !self.bare_mysql_supports_tls() {
            return false;
        }
        if mysql_url_params_tls_disabled(self.url_params.as_deref()) {
            return false;
        }
        self.mysql_uses_tls()
    }

    pub fn canonicalized(&self) -> Self {
        let mut config = self.clone();
        if config.db_type == DatabaseType::Mysql
            && config.driver_profile.as_deref().is_some_and(|profile| profile.eq_ignore_ascii_case("tdengine"))
        {
            config.db_type = DatabaseType::Tdengine;
            if config.port == 0 || config.port == 6030 {
                config.port = 6041;
            }
            config.driver_profile = Some("tdengine".to_string());
            if config.driver_label.as_deref().unwrap_or("").trim().is_empty() {
                config.driver_label = Some("TDengine".to_string());
            }
        }
        config
    }

    pub fn uses_redis_sentinel(&self) -> bool {
        self.db_type == DatabaseType::Redis
            && self.redis_connection_mode.as_deref().is_some_and(|mode| mode.eq_ignore_ascii_case("sentinel"))
    }

    pub fn uses_redis_cluster(&self) -> bool {
        self.db_type == DatabaseType::Redis
            && self.redis_connection_mode.as_deref().is_some_and(|mode| mode.eq_ignore_ascii_case("cluster"))
    }

    pub fn redis_tls_insecure(&self) -> bool {
        self.db_type == DatabaseType::Redis && redis_url_params_enable_insecure(self.url_params.as_deref())
    }

    pub fn connection_url(&self) -> String {
        self.connection_url_with_host(&self.host, self.port)
    }

    pub fn redacted_connection_url(&self) -> String {
        self.redacted_connection_url_with_host(&self.host, self.port)
    }

    pub fn redacted_connection_url_with_host(&self, host: &str, port: u16) -> String {
        let raw_host = host;
        let host = bracket_ipv6(host);
        let db_part = self.effective_database().map(|d| format!("/{}", encode_url_part(d))).unwrap_or_default();
        let params = self.normalized_url_params();

        match self.db_type {
            DatabaseType::Sqlite | DatabaseType::DuckDb => {
                format!("{}?mode=rwc", self.host)
            }
            DatabaseType::Access => self.host.clone(),
            DatabaseType::Redis => {
                let scheme = if self.ssl { "rediss" } else { "redis" };
                let fragment = self.redis_tls_insecure_fragment();
                format!("{scheme}://{host}:{port}/{fragment}")
            }
            DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::ManticoreSearch
            | DatabaseType::Databend => {
                let suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                format!("mysql://{host}:{port}{db_part}{suffix}")
            }
            DatabaseType::Postgres | DatabaseType::Redshift => {
                let suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                format!("postgres://{host}:{port}{db_part}{suffix}")
            }
            DatabaseType::ClickHouse => clickhouse_http_url(self, raw_host, port),
            DatabaseType::Rqlite => rqlite_http_url(self, raw_host, port),
            DatabaseType::Turso => turso_http_url(self, raw_host, port),
            DatabaseType::CloudflareD1 => cloudflare_d1_api_url(self),
            DatabaseType::SqlServer => {
                format!("server=tcp:{host},{port};database={}", self.database.as_deref().unwrap_or("master"))
            }
            DatabaseType::MongoDb => {
                let is_tunneled = host != self.host.as_str() || port != self.port;
                if let Some(cs) = self.connection_string.as_deref().filter(|s| !s.is_empty()) {
                    let cs = normalize_mongo_uri_direct_connection(cs);
                    if is_tunneled {
                        return rewrite_mongo_uri_host(&cs, &host, port);
                    }
                    return cs;
                }
                let mut suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                if is_tunneled && !suffix.contains("directConnection=") {
                    if suffix.is_empty() {
                        suffix = "?directConnection=true".to_string();
                    } else {
                        suffix.push_str("&directConnection=true");
                    }
                }
                let db_part = mongo_uri_db_part_for_suffix(&db_part, &suffix);
                format!("mongodb://{host}:{port}{db_part}{suffix}")
            }
            DatabaseType::Oracle => format!("oracle://{host}:{port}{db_part}"),
            DatabaseType::Elasticsearch
            | DatabaseType::Qdrant
            | DatabaseType::Milvus
            | DatabaseType::Weaviate
            | DatabaseType::ChromaDb => {
                let scheme = if self.ssl { "https" } else { "http" };
                format!("{scheme}://{host}:{port}")
            }
            DatabaseType::Dameng => format!("dm://{host}:{port}{db_part}"),
            DatabaseType::Kingbase => format!("kingbase://{host}:{port}{db_part}"),
            DatabaseType::Highgo => format!("highgo://{host}:{port}{db_part}"),
            DatabaseType::Vastbase => format!("vastbase://{host}:{port}{db_part}"),
            DatabaseType::Goldendb => format!("goldendb://{host}:{port}{db_part}"),
            DatabaseType::Gaussdb => format!("gaussdb://{host}:{port}{db_part}"),
            DatabaseType::Kwdb => format!("kwdb://{host}:{port}{db_part}"),
            DatabaseType::Yashandb => format!("yashandb://{host}:{port}{db_part}"),
            DatabaseType::Databricks => format!("databricks://{host}:{port}{db_part}"),
            DatabaseType::SapHana => format!("saphana://{host}:{port}{db_part}"),
            DatabaseType::Teradata => format!("teradata://{host}:{port}{db_part}"),
            DatabaseType::Vertica => format!("vertica://{host}:{port}{db_part}"),
            DatabaseType::Firebird => format!("firebird://{host}:{port}{db_part}"),
            DatabaseType::Exasol => format!("exasol://{host}:{port}{db_part}"),
            DatabaseType::OpenGauss => format!("opengauss://{host}:{port}{db_part}"),
            DatabaseType::OceanbaseOracle => {
                let base = format!("oceanbase-oracle://{host}:{port}{db_part}");
                if params.is_empty() {
                    base
                } else {
                    format!("{base}?{params}")
                }
            }
            DatabaseType::Questdb => format!("questdb://{host}:{port}{db_part}"),
            DatabaseType::Gbase => format!("gbase://{host}:{port}{db_part}"),
            DatabaseType::H2 => format!("h2://{host}:{port}{db_part}"),
            DatabaseType::Snowflake => format!("snowflake://{host}/{db_part}"),
            DatabaseType::Trino => format!("trino://{host}:{port}{db_part}"),
            DatabaseType::PrestoSql => format!("prestosql://{host}:{port}{db_part}"),
            DatabaseType::Hive => format!("hive://{host}:{port}{db_part}"),
            DatabaseType::Spark => format!("spark://{host}:{port}{db_part}"),
            DatabaseType::Db2 => format!("db2://{host}:{port}{db_part}"),
            DatabaseType::Informix => format!("informix://{host}:{port}{db_part}"),
            DatabaseType::Neo4j => format!("neo4j://{host}:{port}{db_part}"),
            DatabaseType::Cassandra => format!("cassandra://{host}:{port}{db_part}"),
            DatabaseType::Bigquery => format!("bigquery://{host}/{db_part}"),
            DatabaseType::Kylin => format!("kylin://{host}:{port}{db_part}"),
            DatabaseType::Sundb => format!("sundb://{host}:{port}{db_part}"),
            DatabaseType::Oscar => format!("oscar://{host}:{port}{db_part}"),
            DatabaseType::Tdengine => format!("tdengine://{host}:{port}{db_part}"),
            DatabaseType::Xugu => format!("xugu://{host}:{port}{db_part}"),
            DatabaseType::Iotdb => {
                let base = format!("iotdb://{host}:{port}{db_part}");
                if params.is_empty() {
                    base
                } else {
                    format!("{base}?{params}")
                }
            }
            DatabaseType::Etcd => {
                format!("etcd://{host}:{port}")
            }
            DatabaseType::ZooKeeper => {
                format!("zookeeper://{host}:{port}")
            }
            DatabaseType::Iris => format!("iris://{host}:{port}{db_part}"),
            DatabaseType::InfluxDb => {
                let scheme = if self.ssl { "https" } else { "http" };
                format!("{scheme}://{host}:{port}")
            }
            DatabaseType::Jdbc => "jdbc:<redacted>".to_string(),
            DatabaseType::MessageQueue => self.message_queue_admin_url(),
            DatabaseType::Nacos => self.nacos_admin_url(),
        }
    }

    pub fn connection_url_with_host(&self, host: &str, port: u16) -> String {
        let raw_host = host;
        let host = bracket_ipv6(host);
        let db_part = self.effective_database().map(|d| format!("/{}", encode_url_part(d))).unwrap_or_default();
        let username = encode_url_part(&self.username);
        let password = encode_url_part(&self.password);
        let params = self.normalized_url_params();

        match self.db_type {
            DatabaseType::Sqlite | DatabaseType::DuckDb => {
                format!("{}?mode=rwc", self.host)
            }
            DatabaseType::Access => self.host.clone(),
            DatabaseType::Redis => {
                let scheme = if self.ssl { "rediss" } else { "redis" };
                let fragment = self.redis_tls_insecure_fragment();
                if self.username.is_empty() && self.password.is_empty() {
                    format!("{scheme}://{host}:{port}/{fragment}")
                } else if self.username.is_empty() {
                    format!("{scheme}://:{password}@{host}:{port}/{fragment}")
                } else {
                    format!("{scheme}://{username}:{password}@{host}:{port}/{fragment}")
                }
            }
            DatabaseType::Mysql
            | DatabaseType::Doris
            | DatabaseType::StarRocks
            | DatabaseType::ManticoreSearch
            | DatabaseType::Databend => {
                let suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                format!("mysql://{}:{}@{host}:{port}{db_part}{suffix}", username, password)
            }
            DatabaseType::Postgres | DatabaseType::Redshift => {
                let suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                format!("postgres://{}:{}@{host}:{port}{db_part}{suffix}", username, password)
            }
            DatabaseType::ClickHouse => clickhouse_http_url(self, raw_host, port),
            DatabaseType::Rqlite => rqlite_http_url(self, raw_host, port),
            DatabaseType::Turso => turso_http_url(self, raw_host, port),
            DatabaseType::CloudflareD1 => cloudflare_d1_api_url(self),
            DatabaseType::SqlServer => format!(
                "server=tcp:{host},{port};user={};password={};database={}",
                self.username,
                self.password,
                self.database.as_deref().unwrap_or("master")
            ),
            DatabaseType::MongoDb => {
                let is_tunneled = host != self.host.as_str() || port != self.port;
                if let Some(cs) = self.connection_string.as_deref().filter(|s| !s.is_empty()) {
                    let cs = normalize_mongo_uri_direct_connection(cs);
                    if is_tunneled {
                        return rewrite_mongo_uri_host(&cs, &host, port);
                    }
                    return cs;
                }
                let mut suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                if is_tunneled && !suffix.contains("directConnection=") {
                    if suffix.is_empty() {
                        suffix = "?directConnection=true".to_string();
                    } else {
                        suffix.push_str("&directConnection=true");
                    }
                }
                let db_part = mongo_uri_db_part_for_suffix(&db_part, &suffix);
                if self.username.is_empty() {
                    format!("mongodb://{host}:{port}{db_part}{suffix}")
                } else {
                    format!("mongodb://{username}:{password}@{host}:{port}{db_part}{suffix}")
                }
            }
            DatabaseType::Oracle => {
                format!("oracle://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Elasticsearch
            | DatabaseType::Qdrant
            | DatabaseType::Milvus
            | DatabaseType::Weaviate
            | DatabaseType::ChromaDb => {
                let scheme = if self.ssl { "https" } else { "http" };
                format!("{scheme}://{host}:{port}")
            }
            DatabaseType::Dameng => {
                format!("dm://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Kingbase => {
                format!("kingbase://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Highgo => {
                format!("highgo://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Vastbase => {
                format!("vastbase://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Goldendb => {
                format!("goldendb://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Gaussdb => {
                format!("gaussdb://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Kwdb => {
                format!("kwdb://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Yashandb => {
                format!("yashandb://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Databricks => {
                format!("databricks://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::SapHana => {
                format!("saphana://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Teradata => {
                format!("teradata://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Vertica => {
                format!("vertica://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Firebird => {
                format!("firebird://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Exasol => {
                format!("exasol://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::OpenGauss => {
                format!("opengauss://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::OceanbaseOracle => {
                let base = format!("oceanbase-oracle://{}:{}@{host}:{port}{db_part}", username, password);
                if params.is_empty() {
                    base
                } else {
                    format!("{base}?{params}")
                }
            }
            DatabaseType::Questdb => {
                format!("questdb://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Gbase => {
                format!("gbase://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::H2 => {
                format!("h2://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Snowflake => {
                format!("snowflake://{}:{}@{host}/{db_part}", username, password)
            }
            DatabaseType::Trino => {
                format!("trino://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::PrestoSql => {
                format!("prestosql://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Hive => {
                format!("hive://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Spark => {
                format!("spark://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Db2 => {
                format!("db2://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Informix => {
                format!("informix://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Neo4j => {
                format!("neo4j://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Cassandra => {
                format!("cassandra://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Bigquery => {
                format!("bigquery://{}:{}@{host}/{db_part}", username, password)
            }
            DatabaseType::Kylin => {
                format!("kylin://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Sundb => {
                format!("sundb://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Oscar => {
                format!("oscar://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Tdengine => {
                format!("tdengine://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Xugu => {
                format!("xugu://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Iotdb => {
                let base = format!("iotdb://{}:{}@{host}:{port}{db_part}", username, password);
                if params.is_empty() {
                    base
                } else {
                    format!("{base}?{params}")
                }
            }
            DatabaseType::Etcd => {
                if self.username.is_empty() {
                    format!("etcd://{host}:{port}")
                } else {
                    format!("etcd://{}:{}@{host}:{port}", username, password)
                }
            }
            DatabaseType::ZooKeeper => {
                if self.username.is_empty() {
                    format!("zookeeper://{host}:{port}")
                } else {
                    format!("zookeeper://{}:{}@{host}:{port}", username, password)
                }
            }
            DatabaseType::Iris => {
                format!("iris://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::InfluxDb => {
                let scheme = if self.ssl { "https" } else { "http" };
                format!("{scheme}://{host}:{port}")
            }
            DatabaseType::Jdbc => {
                self.connection_string.as_deref().filter(|value| !value.is_empty()).unwrap_or("jdbc:").to_string()
            }
            DatabaseType::MessageQueue => self.message_queue_admin_url(),
            DatabaseType::Nacos => self.nacos_admin_url(),
        }
    }

    pub fn sqlserver_port_explicit(&self) -> bool {
        if self.db_type != DatabaseType::SqlServer {
            return false;
        }
        self.external_config
            .as_ref()
            .and_then(|value| value.get("portExplicit").or_else(|| value.get("port_explicit")))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    }

    fn message_queue_admin_url(&self) -> String {
        self.external_config
            .as_ref()
            .and_then(|value| value.get("adminUrl").or_else(|| value.get("admin_url")))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("mq://")
            .to_string()
    }

    fn nacos_admin_url(&self) -> String {
        self.external_config
            .as_ref()
            .and_then(|value| value.get("serverAddr").or_else(|| value.get("server_addr")))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("nacos://")
            .to_string()
    }

    fn normalized_url_params(&self) -> String {
        let value = self.url_params.as_deref().unwrap_or("").trim();
        if self.needs_bare_mysql() {
            if self.bare_mysql_uses_tls() {
                return normalize_mysql_url_params(value, true, self.ca_cert_path.trim().is_empty());
            }
            return normalize_bare_mysql_url_params(value);
        }
        match self.db_type {
            DatabaseType::Mysql => {
                normalize_mysql_url_params(value, self.mysql_uses_tls(), self.ca_cert_path.trim().is_empty())
            }
            DatabaseType::Doris | DatabaseType::StarRocks | DatabaseType::ManticoreSearch => {
                let params = normalize_bare_mysql_url_params(value);
                if params.is_empty() {
                    "enable_cleartext_plugin=true".to_string()
                } else {
                    format!("{params}&enable_cleartext_plugin=true")
                }
            }
            DatabaseType::Databend => normalize_bare_mysql_url_params(value),
            DatabaseType::Postgres | DatabaseType::Redshift => normalize_postgres_url_params(value, self.ssl),
            DatabaseType::MongoDb => {
                normalize_mongo_url_params(value, self.ssl, !self.username.trim().is_empty(), self.ca_cert_path.trim())
            }
            _ => value.trim_start_matches('?').to_string(),
        }
    }

    pub fn clickhouse_uses_tls(&self) -> bool {
        self.ssl || url_params_contains_flag(self.url_params.as_deref(), "secure", "true")
    }

    pub fn mysql_uses_tls(&self) -> bool {
        self.ssl
            || self.host.to_ascii_lowercase().ends_with(".tidbcloud.com")
            || mysql_url_params_require_tls(self.url_params.as_deref())
    }

    fn redis_tls_insecure_fragment(&self) -> &'static str {
        if self.ssl && self.redis_tls_insecure() {
            "#insecure"
        } else {
            ""
        }
    }
}

fn redis_url_params_enable_insecure(params: Option<&str>) -> bool {
    params.unwrap_or("").trim().trim_start_matches('?').split(['&', ';']).any(|part| {
        let part = part.trim();
        if part.is_empty() {
            return false;
        }
        let Some((key, value)) = part.split_once('=') else {
            return part.eq_ignore_ascii_case("insecure");
        };
        let key = key.trim();
        matches!(key.to_ascii_lowercase().as_str(), "insecure" | "tls_insecure" | "accept_invalid_certs")
            && matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "insecure")
    })
}

fn url_params_contains_flag(params: Option<&str>, key: &str, expected: &str) -> bool {
    params.unwrap_or("").trim().trim_start_matches('?').split(['&', ';']).filter_map(|part| part.split_once('=')).any(
        |(part_key, value)| part_key.trim().eq_ignore_ascii_case(key) && value.trim().eq_ignore_ascii_case(expected),
    )
}

fn mysql_tls_file_param_is(key: &str, target: &str) -> bool {
    let normalized = key.to_ascii_lowercase().replace(['-', '_'], "");
    normalized == format!("ssl{target}")
}

fn mysql_url_params_tls_disabled(params: Option<&str>) -> bool {
    params.unwrap_or("").trim().trim_start_matches('?').split('&').any(|part| {
        let part = part.trim();
        if part.is_empty() {
            return false;
        }
        let Some((key, value)) = part.split_once('=') else {
            return false;
        };
        let key = key.trim();
        let value = value.trim();
        (key.eq_ignore_ascii_case("require_ssl") && value.eq_ignore_ascii_case("false"))
            || ((key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode"))
                && matches!(value.to_ascii_lowercase().replace('-', "_").as_str(), "disabled" | "disable"))
    })
}

fn mysql_url_params_require_tls(params: Option<&str>) -> bool {
    params.unwrap_or("").trim().trim_start_matches('?').split('&').any(|part| {
        let part = part.trim();
        if part.is_empty() {
            return false;
        }
        let Some((key, value)) = part.split_once('=') else {
            return mysql_tls_file_param_is(part, "cert") || mysql_tls_file_param_is(part, "key");
        };
        let key = key.trim();
        let value = value.trim();
        (key.eq_ignore_ascii_case("require_ssl") && value.eq_ignore_ascii_case("true"))
            || mysql_tls_file_param_is(key, "cert")
            || mysql_tls_file_param_is(key, "key")
            || ((key.eq_ignore_ascii_case("ssl-mode") || key.eq_ignore_ascii_case("sslmode"))
                && matches!(
                    value.to_ascii_lowercase().replace('-', "_").as_str(),
                    "required" | "require" | "verify_ca" | "verify_identity"
                ))
    })
}

fn normalize_bare_mysql_url_params(value: &str) -> String {
    value
        .trim_start_matches('?')
        .split('&')
        .filter(|part| {
            !part.is_empty()
                && !url_param_key_is(part, "charset")
                && !url_param_key_is(part, "ssl-mode")
                && !url_param_key_is(part, "sslmode")
                && !url_param_key_is(part, "require_ssl")
                && !url_param_key_is(part, "verify_ca")
                && !url_param_key_is(part, "verify_identity")
        })
        .collect::<Vec<_>>()
        .join("&")
}

fn is_mysql_cleartext_password_param(key: &str) -> bool {
    matches!(key.to_ascii_lowercase().as_str(), "allowcleartextpasswords" | "enable_cleartext_plugin")
}

fn mysql_url_param_value_is_true(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")
}

fn normalize_mysql_url_params(value: &str, force_tls: bool, accept_invalid_certs: bool) -> String {
    let value = value.trim_start_matches('?');
    let mut parts: Vec<String> = value.split('&').filter(|part| !part.is_empty()).map(str::to_string).collect();
    let enable_cleartext_plugin = parts.iter().any(|part| {
        let Some((key, value)) = part.split_once('=') else {
            return false;
        };
        is_mysql_cleartext_password_param(key.trim()) && mysql_url_param_value_is_true(value)
    });

    parts.retain(|part| {
        let Some((key, _)) = part.split_once('=') else {
            return true;
        };
        !is_mysql_cleartext_password_param(key.trim())
    });

    if force_tls {
        parts.retain(|part| {
            !url_param_key_is(part, "ssl-mode")
                && !url_param_key_is(part, "sslmode")
                && !url_param_key_is(part, "require_ssl")
        });
        parts.insert(0, "require_ssl=true".to_string());
        if accept_invalid_certs && !parts.iter().any(|part| url_param_key_is(part, "verify_ca")) {
            parts.push("verify_ca=false".to_string());
        }
        if !parts.iter().any(|part| url_param_key_is(part, "verify_identity")) {
            parts.push("verify_identity=false".to_string());
        }
    } else if !parts.iter().any(|part| {
        url_param_key_is(part, "ssl-mode") || url_param_key_is(part, "sslmode") || url_param_key_is(part, "require_ssl")
    }) {
        // Default MySQL connections keep TLS off unless the user explicitly
        // enables a TLS mode.
        parts.insert(0, "ssl-mode=disabled".to_string());
    }

    if !parts.iter().any(|part| url_param_key_is(part, "charset")) {
        parts.push("charset=utf8mb4".to_string());
    }
    if enable_cleartext_plugin {
        parts.push("enable_cleartext_plugin=true".to_string());
    }

    parts.join("&")
}

fn normalize_mongo_url_params(value: &str, force_tls: bool, default_auth_source: bool, ca_cert_path: &str) -> String {
    let value = value.trim_start_matches('?');
    let mut parts: Vec<String> = value.split('&').filter(|part| !part.is_empty()).map(str::to_string).collect();

    if force_tls {
        parts.retain(|part| !url_param_key_is(part, "tls") && !url_param_key_is(part, "ssl"));
        parts.insert(0, "tls=true".to_string());
    }

    normalize_mongo_tls_compat_params(&mut parts);

    if !force_tls {
        parts.retain(|part| {
            !url_param_key_is(part, "tlsAllowInvalidCertificates") && !url_param_key_is(part, "tlsCAFile")
        });
    }

    let existing_tls_ca_file = if ca_cert_path.is_empty() {
        parts.iter().find(|part| url_param_key_is(part, "tlsCAFile")).cloned()
    } else {
        None
    };
    parts.retain(|part| !url_param_key_is(part, "tlsCAFile"));

    if force_tls {
        if !ca_cert_path.is_empty() {
            parts.push(format!("tlsCAFile={}", encode_mongo_tls_file_path(ca_cert_path)));
        } else if let Some(part) = existing_tls_ca_file {
            parts.push(part);
        }
    }

    if default_auth_source && !parts.iter().any(|part| url_param_key_is(part, "authSource")) {
        parts.push("authSource=admin".to_string());
    }

    parts.join("&")
}

/// The Rust MongoDB driver uses rustls by default, which does not accept
/// `tlsAllowInvalidHostnames` in the connection string. Map it to the
/// supported `tlsAllowInvalidCertificates` option instead.
fn normalize_mongo_tls_compat_params(parts: &mut Vec<String>) {
    let allow_invalid_hostnames =
        parts.iter().any(|part| url_param_key_is(part, "tlsAllowInvalidHostnames") && mongo_url_param_is_truthy(part));
    parts.retain(|part| !url_param_key_is(part, "tlsAllowInvalidHostnames"));
    if allow_invalid_hostnames && !parts.iter().any(|part| url_param_key_is(part, "tlsAllowInvalidCertificates")) {
        parts.push("tlsAllowInvalidCertificates=true".to_string());
    }
}

fn mongo_url_param_is_truthy(part: &str) -> bool {
    let Some((_, value)) = part.split_once('=') else {
        return true;
    };
    matches!(percent_decode_str(value).decode_utf8_lossy().trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes")
}

fn encode_mongo_tls_file_path(path: &str) -> String {
    utf8_percent_encode(path, NON_ALPHANUMERIC).to_string()
}

fn mongo_uri_db_part_for_suffix<'a>(db_part: &'a str, suffix: &str) -> &'a str {
    if db_part.is_empty() && !suffix.is_empty() {
        "/"
    } else {
        db_part
    }
}

fn normalize_mongo_uri_direct_connection(uri: &str) -> String {
    let uri = normalize_mongo_uri_query_path(uri);
    if !mongo_uri_has_multiple_seeds(&uri) || !mongo_uri_has_direct_connection_true(&uri) {
        return uri;
    }

    let (before_fragment, fragment) =
        uri.split_once('#').map(|(base, fragment)| (base, Some(fragment))).unwrap_or((uri.as_str(), None));
    let Some((base, query)) = before_fragment.split_once('?') else {
        return uri;
    };
    let params =
        query.split('&').filter(|part| !mongo_url_param_is_direct_connection_true(part)).collect::<Vec<_>>().join("&");

    let mut normalized = if params.is_empty() { base.to_string() } else { format!("{base}?{params}") };
    if let Some(fragment) = fragment {
        normalized.push('#');
        normalized.push_str(fragment);
    }
    normalized
}

fn normalize_mongo_uri_query_path(uri: &str) -> String {
    let Some(rest_start) = uri.find("://").map(|idx| idx + "://".len()) else {
        return uri.to_string();
    };
    if !uri[..rest_start].eq_ignore_ascii_case("mongodb://")
        && !uri[..rest_start].eq_ignore_ascii_case("mongodb+srv://")
    {
        return uri.to_string();
    }
    let rest = &uri[rest_start..];
    let Some(first_path_or_query) = rest.find(['/', '?', '#']) else {
        return uri.to_string();
    };
    if rest.as_bytes()[first_path_or_query] != b'?' {
        return uri.to_string();
    }
    let insert_at = rest_start + first_path_or_query;
    format!("{}/{}", &uri[..insert_at], &uri[insert_at..])
}

fn mongo_uri_has_multiple_seeds(uri: &str) -> bool {
    if mongo_uri_is_srv(uri) {
        // The Rust MongoDB driver resolves SRV records into a seed list, so an
        // SRV URL must not keep directConnection=true even with one hostname.
        return true;
    }
    mongo_uri_host_section(uri)
        .map(|hosts| hosts.split(',').filter(|host| !host.trim().is_empty()).count() > 1)
        .unwrap_or(false)
}

fn mongo_uri_is_srv(uri: &str) -> bool {
    uri.get(..14).is_some_and(|scheme| scheme.eq_ignore_ascii_case("mongodb+srv://"))
}

fn mongo_uri_host_section(uri: &str) -> Option<&str> {
    let rest = uri.strip_prefix("mongodb://").or_else(|| uri.strip_prefix("mongodb+srv://"))?;
    let authority = rest.split('/').next()?.split('?').next().unwrap_or(rest);
    Some(match authority.rfind('@') {
        Some(idx) => &authority[idx + 1..],
        None => authority,
    })
}

fn mongo_uri_has_direct_connection_true(uri: &str) -> bool {
    uri.split_once('?')
        .map(|(_, query)| {
            query.split('#').next().unwrap_or("").split('&').any(mongo_url_param_is_direct_connection_true)
        })
        .unwrap_or(false)
}

fn mongo_url_param_is_direct_connection_true(part: &str) -> bool {
    let Some((key, value)) = part.split_once('=') else {
        return false;
    };
    percent_decode_str(key).decode_utf8_lossy().eq_ignore_ascii_case("directConnection")
        && percent_decode_str(value).decode_utf8_lossy().eq_ignore_ascii_case("true")
}

fn normalize_postgres_url_params(value: &str, force_tls: bool) -> String {
    let value = value.trim_start_matches('?');

    let mut timezone: Option<String> = None;
    let mut search_path: Option<String> = None;
    let mut parts: Vec<String> = Vec::new();

    for part in value.split('&').filter(|part| !part.is_empty()) {
        let (raw_key, raw_value) = part.split_once('=').unwrap_or((part, ""));
        let key = percent_decode_str(raw_key).decode_utf8_lossy();
        if key.eq_ignore_ascii_case("timezone") || key.eq_ignore_ascii_case("time_zone") {
            let decoded_value = percent_decode_str(raw_value).decode_utf8_lossy().trim().to_string();
            if !decoded_value.is_empty() {
                timezone = Some(decoded_value);
            }
        } else if key.eq_ignore_ascii_case("schema") || key.eq_ignore_ascii_case("currentSchema") {
            let decoded_value = percent_decode_str(raw_value).decode_utf8_lossy().trim().to_string();
            if !decoded_value.is_empty() {
                search_path = Some(decoded_value);
            }
        } else if key.eq_ignore_ascii_case("ssl-mode") {
            let decoded_value = percent_decode_str(raw_value).decode_utf8_lossy();
            match decoded_value.to_ascii_lowercase().replace('_', "-").as_str() {
                "require" | "required" => parts.push("sslmode=require".to_string()),
                "prefer" | "preferred" => parts.push("sslmode=prefer".to_string()),
                "disable" | "disabled" => parts.push("sslmode=disable".to_string()),
                "verify-ca" => parts.push("sslmode=verify-ca".to_string()),
                "verify-full" | "verify-identity" => parts.push("sslmode=verify-full".to_string()),
                _ => {}
            }
        } else if key.eq_ignore_ascii_case("charset")
            || key.eq_ignore_ascii_case("require_ssl")
            || key.eq_ignore_ascii_case("verify_ca")
            || key.eq_ignore_ascii_case("verify_identity")
        {
            // These MySQL-style parameters may be present in older/imported
            // saved connections. tokio-postgres rejects unknown URL keys.
        } else {
            parts.push(part.to_string());
        }
    }

    let mut connection_options: Vec<(&str, String)> = Vec::new();
    if let Some(search_path) = search_path {
        connection_options.push(("search_path=", format!("-c search_path={search_path}")));
    }
    if let Some(timezone) = timezone {
        connection_options.push(("timezone=", format!("-c TimeZone={timezone}")));
    }

    if connection_options.is_empty() {
        if !parts.iter().any(|part| url_param_key_is(part, "sslmode")) {
            // Match libpq/JDBC: absent mode prefers TLS and falls back to plaintext.
            // Explicit ssl toggle still forces require; users can opt into disable.
            parts.insert(0, if force_tls { "sslmode=require" } else { "sslmode=prefer" }.to_string());
        }
        return parts.join("&");
    }

    if let Some(options_index) = parts.iter().position(|part| {
        part.split_once('=')
            .map(|(raw_key, _)| percent_decode_str(raw_key).decode_utf8_lossy().eq_ignore_ascii_case("options"))
            .unwrap_or(false)
    }) {
        let (raw_key, raw_value) = parts[options_index].split_once('=').unwrap_or(("options", ""));
        let options_value = percent_decode_str(raw_value).decode_utf8_lossy();
        let lower_options = options_value.to_ascii_lowercase();
        let appended_options = connection_options
            .into_iter()
            .filter_map(|(needle, option)| (!lower_options.contains(needle)).then_some(option))
            .collect::<Vec<_>>()
            .join(" ");
        if !appended_options.is_empty() {
            let combined = format!("{} {}", options_value.trim(), appended_options).trim().to_string();
            parts[options_index] = format!("{raw_key}={}", encode_url_part(&combined));
        }
    } else {
        let combined = connection_options.into_iter().map(|(_, option)| option).collect::<Vec<_>>().join(" ");
        parts.push(format!("options={}", encode_url_part(&combined)));
    }

    if !parts.iter().any(|part| url_param_key_is(part, "sslmode")) {
        parts.insert(0, if force_tls { "sslmode=require" } else { "sslmode=prefer" }.to_string());
    }

    parts.join("&")
}

fn url_param_key_is(part: &str, expected: &str) -> bool {
    let key = part.split_once('=').map(|(key, _)| key).unwrap_or(part);
    percent_decode_str(key).decode_utf8_lossy().eq_ignore_ascii_case(expected)
}

fn clickhouse_http_url(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let trimmed = host.trim();
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return format!("https://{}", trim_clickhouse_host_port(rest, port));
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        let scheme = if config.clickhouse_uses_tls() { "https" } else { "http" };
        return format!("{scheme}://{}", trim_clickhouse_host_port(rest, port));
    }
    let scheme = if config.clickhouse_uses_tls() { "https" } else { "http" };
    format!("{scheme}://{}:{port}", bracket_ipv6(trimmed))
}

fn rqlite_http_url(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let trimmed = host.trim();
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return format!("https://{}", trim_http_host_port(rest, port));
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        let scheme = if config.ssl { "https" } else { "http" };
        return format!("{scheme}://{}", trim_http_host_port(rest, port));
    }
    let scheme = if config.ssl { "https" } else { "http" };
    format!("{scheme}://{}:{port}", bracket_ipv6(trimmed))
}

fn turso_http_url(config: &ConnectionConfig, host: &str, port: u16) -> String {
    let trimmed = host.trim();

    // Handle libsql:// protocol (Turso native)
    if let Some(rest) = trimmed.strip_prefix("libsql://") {
        return format!("https://{}", trim_http_host_port(rest, port));
    }

    // Handle explicit https://
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return format!("https://{}", trim_http_host_port(rest, port));
    }

    // Handle explicit http:// (respect ssl config)
    if let Some(rest) = trimmed.strip_prefix("http://") {
        let scheme = if config.ssl { "https" } else { "http" };
        return format!("{scheme}://{}", trim_http_host_port(rest, port));
    }

    // Default: bare hostname -> prefer HTTPS for Turso (default port 443)
    let scheme = if port == 443 || config.ssl { "https" } else { "http" };
    format!("{scheme}://{}:{port}", bracket_ipv6(trimmed))
}

fn cloudflare_d1_api_url(config: &ConnectionConfig) -> String {
    let account_id = config.host.trim();
    let database_id = config.database.as_deref().unwrap_or_default().trim();
    format!("https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}")
}

fn trim_http_host_port(value: &str, default_port: u16) -> String {
    let authority = value.trim_end_matches('/').split('/').next().unwrap_or(value).split('?').next().unwrap_or(value);
    if authority.starts_with('[') && !authority.contains("]:") {
        return format!("{authority}:{default_port}");
    }
    if authority.rsplit_once(':').is_some() {
        authority.to_string()
    } else {
        format!("{authority}:{default_port}")
    }
}

fn trim_clickhouse_host_port(value: &str, default_port: u16) -> String {
    let authority = value.trim_end_matches('/').split('/').next().unwrap_or(value).split('?').next().unwrap_or(value);
    if authority.starts_with('[') && !authority.contains("]:") {
        return format!("{authority}:{default_port}");
    }
    if authority.rsplit_once(':').is_some() {
        authority.to_string()
    } else {
        format!("{authority}:{default_port}")
    }
}

pub fn parse_mongo_first_host(uri: &str) -> Option<(String, u16)> {
    let rest = uri.strip_prefix("mongodb://").or_else(|| uri.strip_prefix("mongodb+srv://"))?;
    let authority = rest.split('/').next()?;
    let host_section = match authority.rfind('@') {
        Some(idx) => &authority[idx + 1..],
        None => authority,
    };
    let first = host_section.split(',').next()?;
    match first.rsplit_once(':') {
        Some((h, p)) => Some((h.to_string(), p.parse().unwrap_or(27017))),
        None => Some((first.to_string(), 27017)),
    }
}

fn rewrite_mongo_uri_host(uri: &str, new_host: &str, new_port: u16) -> String {
    let (_scheme, rest) = if let Some(r) = uri.strip_prefix("mongodb+srv://") {
        ("mongodb://", r)
    } else if let Some(r) = uri.strip_prefix("mongodb://") {
        ("mongodb://", r)
    } else {
        return uri.to_string();
    };

    let (creds_prefix, after_creds) = match rest.find('@') {
        Some(idx) => (&rest[..=idx], &rest[idx + 1..]),
        None => ("", rest),
    };

    let after_hosts = match after_creds.find('/') {
        Some(idx) => &after_creds[idx..],
        None => "",
    };

    let mut result = format!("mongodb://{creds_prefix}{new_host}:{new_port}{after_hosts}");

    if !result.contains("directConnection=") {
        if result.contains('?') {
            result.push_str("&directConnection=true");
        } else {
            result.push_str("?directConnection=true");
        }
    }

    result
}

pub fn parse_jdbc_host_port(url: &str) -> Option<(String, u16)> {
    let rest = jdbc_transport_rest(url)?;

    // jdbc:oracle:thin:@host:port:SID  or  jdbc:oracle:thin:@//host:port/service
    if let Some(after) = rest.strip_prefix("oracle:") {
        let at_pos = after.find('@')?;
        let after_at = &after[at_pos + 1..];
        if after_at.trim_start().starts_with('(') {
            let host = oracle_descriptor_value(after_at, "HOST")?;
            let port = oracle_descriptor_value(after_at, "PORT")?;
            return Some((host, port.parse().ok()?));
        }
        let after_at = after_at.strip_prefix("//").unwrap_or(after_at);
        let host_port = after_at.split(&['/', ':', '?'][..]).next()?;
        let port_str = after_at.strip_prefix(host_port)?.strip_prefix(':')?.split(&[':', '/', ';', '?'][..]).next()?;
        return Some((host_port.to_string(), port_str.parse().ok()?));
    }

    // jdbc:sqlserver://host:port;prop=val  or  jdbc:sqlserver://host\instance:port;...
    if let Some(after) = rest.strip_prefix("sqlserver://") {
        let authority = after.split(';').next().unwrap_or(after);
        let authority = authority.split('\\').next().unwrap_or(authority);
        return match authority.rsplit_once(':') {
            Some((h, p)) => Some((h.to_string(), p.parse().ok()?)),
            None => Some((authority.to_string(), 1433)),
        };
    }

    // Generic: jdbc:subprotocol://[user:pass@]host:port[/path][?query]
    let scheme_end = rest.find("://")?;
    let after_scheme = &rest[scheme_end + 3..];
    let authority = after_scheme.split('/').next().unwrap_or(after_scheme);
    let authority = authority.split('?').next().unwrap_or(authority);
    let host_port = match authority.rfind('@') {
        Some(idx) => &authority[idx + 1..],
        None => authority,
    };
    match host_port.rsplit_once(':') {
        Some((h, p)) => Some((h.to_string(), p.parse().ok()?)),
        None => None,
    }
}

fn jdbc_transport_rest(url: &str) -> Option<&str> {
    if let Some(rest) = url.strip_prefix("jdbc:").or_else(|| url.strip_prefix("JDBC:")) {
        return Some(rest);
    }

    let rest = url.strip_prefix("jdbcx:").or_else(|| url.strip_prefix("JDBCX:"))?;
    if let Some(scheme_end) = rest.find("://") {
        let scheme = &rest[..scheme_end];
        return Some(match scheme.rfind(':') {
            Some(extension_end) => &rest[extension_end + 1..],
            None => rest,
        });
    }

    // Oracle's descriptor and thin URL forms do not contain `://`. In an
    // extended JDBCX URL the vendor transport follows the first colon.
    let tail = rest.split_once(':').map(|(_, tail)| tail);
    match tail {
        Some(tail) if tail.get(.."oracle:".len()).is_some_and(|prefix| prefix.eq_ignore_ascii_case("oracle:")) => {
            Some(tail)
        }
        _ => Some(rest),
    }
}

pub fn rewrite_jdbc_url_host(url: &str, new_host: &str, new_port: u16) -> String {
    let normalized_url = url.to_ascii_uppercase();
    let normalized_rest = jdbc_transport_rest(url).map(str::to_ascii_uppercase).unwrap_or_default();
    if normalized_rest.starts_with("ORACLE:") && normalized_url.contains("(HOST=") && normalized_url.contains("(PORT=")
    {
        return rewrite_oracle_descriptor_host(url, new_host, new_port);
    }

    let Some((old_host, old_port)) = parse_jdbc_host_port(url) else {
        return url.to_string();
    };
    let old_authority = format!("{old_host}:{old_port}");
    let new_authority = format!("{new_host}:{new_port}");
    url.replacen(&old_authority, &new_authority, 1)
}

fn oracle_descriptor_value(descriptor: &str, key: &str) -> Option<String> {
    let key = format!("({key}=");
    let start = descriptor.to_ascii_uppercase().find(&key)?;
    let value_start = start + key.len();
    let value_end = descriptor[value_start..].find(')')? + value_start;
    Some(descriptor[value_start..value_end].trim().to_string())
}

fn rewrite_oracle_descriptor_host(url: &str, new_host: &str, new_port: u16) -> String {
    let rewritten_host = replace_oracle_descriptor_value(url, "HOST", new_host);
    replace_oracle_descriptor_value(&rewritten_host, "PORT", &new_port.to_string())
}

fn replace_oracle_descriptor_value(input: &str, key: &str, value: &str) -> String {
    let token = format!("({key}=");
    let Some(start) = input.to_ascii_uppercase().find(&token) else {
        return input.to_string();
    };
    let value_start = start + token.len();
    let Some(value_end) = input[value_start..].find(')').map(|offset| value_start + offset) else {
        return input.to_string();
    };
    format!("{}{}{}", &input[..value_start], value, &input[value_end..])
}

fn encode_url_part(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn bracket_ipv6(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        database_info_from_protocol_value, default_query_timeout_secs, default_redis_key_separator,
        default_ssh_connect_timeout_secs, ConnectionConfig, ConnectionTestResult, DatabaseConnectionInfo, DatabaseType,
        IdentifierCase, ProxyTunnelConfig, ProxyType, TransportLayerConfig,
    };
    use std::str::FromStr;

    #[test]
    fn default_query_timeout_is_sixty_seconds() {
        assert_eq!(default_query_timeout_secs(), 60);
    }

    #[test]
    fn connection_test_result_uses_camel_case_and_omits_missing_details() {
        let result =
            ConnectionTestResult::success("Connection successful").with_database_info(Some(DatabaseConnectionInfo {
                product_name: Some("H2".to_string()),
                unquoted_identifier_case: Some(IdentifierCase::Upper),
                ..DatabaseConnectionInfo::default()
            }));

        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["message"], "Connection successful");
        assert_eq!(value["databaseInfo"]["productName"], "H2");
        assert_eq!(value["databaseInfo"]["unquotedIdentifierCase"], "upper");
        assert!(value["databaseInfo"].get("driverName").is_none());
    }

    #[test]
    fn protocol_database_info_parser_accepts_details_and_legacy_responses() {
        let parsed = database_info_from_protocol_value(&serde_json::json!({
            "ok": true,
            "databaseInfo": {
                "productName": "H2",
                "currentDatabase": "app",
                "serverCharset": "utf8mb4",
                "jdbcVersion": "4.2"
            }
        }))
        .unwrap();
        assert_eq!(parsed.product_name.as_deref(), Some("H2"));
        assert_eq!(parsed.current_database.as_deref(), Some("app"));
        assert_eq!(parsed.server_charset.as_deref(), Some("utf8mb4"));
        assert_eq!(parsed.jdbc_version.as_deref(), Some("4.2"));
        assert_eq!(database_info_from_protocol_value(&serde_json::json!({ "ok": true })), None);
    }

    fn mysql_config(username: &str, password: &str, database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "id".to_string(),
            name: "name".to_string(),
            db_type: DatabaseType::Mysql,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "10.1.2.3".to_string(),
            port: 2883,
            username: username.to_string(),
            password: password.to_string(),
            database: database.map(str::to_string),
            visible_databases: None,
            visible_schemas: None,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: super::default_connect_timeout_secs(),
            query_timeout_secs: default_query_timeout_secs(),
            idle_timeout_secs: super::default_idle_timeout_secs(),
            keepalive_interval_secs: super::default_keepalive_interval_secs(),
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
            redis_key_separator: default_redis_key_separator(),
            redis_scan_page_size: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    #[test]
    fn legacy_mcp_access_is_ignored_and_not_serialized() {
        let legacy: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "legacy",
            "name": "Legacy",
            "db_type": "mysql",
            "host": "127.0.0.1",
            "port": 3306,
            "username": "root",
            "password": "",
            "database": null,
            "mcp_access": "read_only"
        }))
        .unwrap();
        assert!(serde_json::to_value(&legacy).unwrap().get("mcp_access").is_none());
        assert!(!legacy.read_only);
    }

    #[test]
    fn database_identifier_whitespace_is_preserved_and_percent_encoded() {
        let mut config = mysql_config("root", "secret", Some(" analytics "));

        assert_eq!(config.effective_database(), Some(" analytics "));
        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/%20analytics%20?ssl-mode=disabled&charset=utf8mb4"
        );

        config.db_type = DatabaseType::Postgres;
        assert_eq!(config.effective_database(), Some(" analytics "));
        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:2883/%20analytics%20?sslmode=prefer");
    }

    #[test]
    fn whitespace_only_database_uses_database_type_default() {
        let mut config = mysql_config("root", "secret", Some("   "));
        assert_eq!(config.effective_database(), None);

        config.db_type = DatabaseType::Postgres;
        assert_eq!(config.effective_database(), Some("postgres"));
    }

    fn mongodb_config(username: &str, password: &str, database: Option<&str>) -> ConnectionConfig {
        let mut config = mysql_config(username, password, database);
        config.db_type = DatabaseType::MongoDb;
        config.port = 17000;
        config
    }

    #[test]
    fn zookeeper_database_type_uses_stable_wire_name() {
        assert_eq!(serde_json::to_string(&DatabaseType::ZooKeeper).unwrap(), "\"zookeeper\"");
        assert_eq!(serde_json::from_str::<DatabaseType>("\"zookeeper\"").unwrap(), DatabaseType::ZooKeeper);
    }

    #[test]
    fn cloudflare_d1_database_type_and_api_url_are_stable() {
        assert_eq!(serde_json::to_string(&DatabaseType::CloudflareD1).unwrap(), "\"cloudflare-d1\"");
        assert_eq!(serde_json::from_str::<DatabaseType>("\"cloudflare-d1\"").unwrap(), DatabaseType::CloudflareD1);

        let mut config = mysql_config("", "secret-token", Some("database-id"));
        config.db_type = DatabaseType::CloudflareD1;
        config.host = "account-id".to_string();
        config.port = 443;
        assert_eq!(
            config.connection_url(),
            "https://api.cloudflare.com/client/v4/accounts/account-id/d1/database/database-id"
        );
        assert!(!config.connection_url().contains("secret-token"));
    }

    #[test]
    fn connection_config_defaults_missing_agent_java_options_to_empty() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "Hive",
            "db_type": "hive",
            "host": "hive.local",
            "port": 10000,
            "username": "",
            "password": "",
            "database": "default"
        }))
        .unwrap();

        assert!(config.agent_java_options.is_empty());
        assert_eq!(config.database_info, None);
    }

    #[test]
    fn connection_config_database_info_survives_json_round_trip() {
        let mut config = mysql_config("root", "secret", Some("app"));
        config.database_info = Some(DatabaseConnectionInfo {
            product_name: Some("MySQL".to_string()),
            product_version: Some("8.4.0".to_string()),
            current_database: Some("app".to_string()),
            server_charset: Some("utf8mb4".to_string()),
            ..DatabaseConnectionInfo::default()
        });

        let value = serde_json::to_value(&config).unwrap();
        assert_eq!(value["database_info"]["productVersion"], "8.4.0");

        let restored: ConnectionConfig = serde_json::from_value(value).unwrap();
        assert_eq!(restored.database_info, config.database_info);
    }

    #[test]
    fn zookeeper_connection_url_uses_zookeeper_scheme() {
        let mut config = mysql_config("", "", None);
        config.db_type = DatabaseType::ZooKeeper;
        config.host = "zk.local".to_string();
        config.port = 2181;

        assert_eq!(config.connection_url_with_host("zk.local", 2181), "zookeeper://zk.local:2181");

        config.username = "digest".to_string();
        config.password = "secret".to_string();

        assert_eq!(config.connection_url_with_host("zk.local", 2181), "zookeeper://digest:secret@zk.local:2181");
    }

    #[test]
    fn legacy_single_ssh_config_migrates_to_transport_layer() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "mysql",
            "host": "10.1.2.3",
            "port": 3306,
            "username": "root",
            "password": "",
            "database": null,
            "ssh_enabled": true,
            "ssh_host": "bastion.example.com",
            "ssh_port": 2200,
            "ssh_user": "deploy",
            "ssh_password": "secret",
            "ssh_connect_timeout_secs": 0,
            "ssh_expose_lan": true
        }))
        .unwrap();

        let hops = config.effective_ssh_tunnels();
        assert_eq!(hops.len(), 1);
        assert_eq!(hops[0].id, "legacy");
        assert_eq!(hops[0].host, "bastion.example.com");
        assert_eq!(hops[0].port, 2200);
        assert_eq!(hops[0].user, "deploy");
        assert_eq!(hops[0].password, "secret");
        assert_eq!(hops[0].connect_timeout_secs, default_ssh_connect_timeout_secs());
        assert!(hops[0].expose_lan);
    }

    #[test]
    fn missing_connection_timeout_defaults_to_ten_seconds() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "mysql",
            "host": "10.1.2.3",
            "port": 3306,
            "username": "root",
            "password": "",
            "database": null
        }))
        .unwrap();

        assert_eq!(config.connect_timeout_secs, 10);
        assert_eq!(config.effective_connect_timeout_secs(), 10);
    }

    #[test]
    fn legacy_ssh_tunnels_migrate_to_ordered_transport_layers() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "mysql",
            "host": "10.1.2.3",
            "port": 3306,
            "username": "root",
            "password": "",
            "database": null,
            "ssh_enabled": true,
            "ssh_tunnels": [
                { "id": "first", "host": "a", "port": 22, "user": "u" },
                { "id": "second", "host": "b", "port": 2200, "user": "u" }
            ]
        }))
        .unwrap();

        let hops = config.effective_ssh_tunnels();
        assert_eq!(hops.iter().map(|hop| hop.id.as_str()).collect::<Vec<_>>(), vec!["first", "second"]);
    }

    #[test]
    fn legacy_proxy_config_migrates_to_transport_layer() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "mysql",
            "host": "10.1.2.3",
            "port": 3306,
            "username": "root",
            "password": "",
            "database": null,
            "proxy_enabled": true,
            "proxy_type": "http",
            "proxy_host": "proxy.example.com",
            "proxy_port": 8080,
            "proxy_username": "alice",
            "proxy_password": "secret"
        }))
        .unwrap();

        assert_eq!(config.transport_layers.len(), 1);
        match &config.transport_layers[0] {
            TransportLayerConfig::Proxy(proxy) => {
                assert_eq!(proxy.id, "legacy-proxy");
                assert_eq!(proxy.proxy_type, ProxyType::Http);
                assert_eq!(proxy.host, "proxy.example.com");
                assert_eq!(proxy.port, 8080);
                assert_eq!(proxy.username, "alice");
                assert_eq!(proxy.password, "secret");
            }
            _ => panic!("expected proxy layer"),
        }
    }

    #[test]
    fn existing_transport_layers_take_precedence_over_legacy_fields() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "mysql",
            "host": "10.1.2.3",
            "port": 3306,
            "username": "root",
            "password": "",
            "database": null,
            "ssh_enabled": true,
            "ssh_host": "legacy.example.com",
            "transport_layers": [{ "type": "proxy", "id": "proxy", "host": "proxy", "port": 1080 }]
        }))
        .unwrap();

        assert_eq!(config.transport_layers.len(), 1);
        assert!(matches!(&config.transport_layers[0], TransportLayerConfig::Proxy(proxy) if proxy.id == "proxy"));
    }

    #[test]
    fn serialized_connection_config_omits_legacy_transport_fields() {
        let mut config = mysql_config("root", "", None);
        config.transport_layers = vec![TransportLayerConfig::Proxy(ProxyTunnelConfig {
            profile_id: String::new(),
            id: "proxy".to_string(),
            name: String::new(),
            enabled: true,
            proxy_type: ProxyType::Socks5,
            host: "proxy".to_string(),
            port: 1080,
            username: String::new(),
            password: String::new(),
            test_target: None,
        })];

        let saved = serde_json::to_value(config).unwrap();

        assert!(saved.get("transport_layers").is_some());
        for key in ["ssh_tunnels", "ssh_host", "ssh_password", "proxy_host", "proxy_password", "proxy_enabled"] {
            assert!(saved.get(key).is_none(), "legacy key {key} should not serialize");
        }
    }

    #[test]
    fn query_timeout_zero_disables_timeout() {
        let mut config = mysql_config("root", "", None);
        config.query_timeout_secs = 0;

        assert_eq!(config.effective_query_timeout_secs(), 0);
    }

    #[test]
    fn query_timeout_preserves_long_running_exports() {
        let mut config = mysql_config("root", "", None);
        config.query_timeout_secs = 3600;

        assert_eq!(config.effective_query_timeout_secs(), 3600);
    }

    #[test]
    fn mysql_url_encodes_proxy_style_username_with_colons_and_at() {
        let config = mysql_config("1234:xxx@xx.xx:abc123", "p@ss:word", None);

        assert_eq!(
            config.connection_url(),
            "mysql://1234%3Axxx%40xx%2Exx%3Aabc123:p%40ss%3Aword@10.1.2.3:2883?ssl-mode=disabled&charset=utf8mb4"
        );
    }

    #[test]
    fn mysql_url_encodes_oceanbase_username() {
        let config = mysql_config("user@tenant#cluster", "secret", None);

        assert_eq!(
            config.connection_url(),
            "mysql://user%40tenant%23cluster:secret@10.1.2.3:2883?ssl-mode=disabled&charset=utf8mb4"
        );
    }

    #[test]
    fn oceanbase_profile_uses_bare_mysql_connection_options() {
        let mut config = mysql_config("user@tenant#cluster", "secret", None);
        config.driver_profile = Some("oceanbase".to_string());

        assert!(config.needs_bare_mysql());
        assert_eq!(config.connection_url(), "mysql://user%40tenant%23cluster:secret@10.1.2.3:2883");
    }

    #[test]
    fn starrocks_profile_omits_mysql_ssl_mode_param_when_tls_disabled() {
        let mut config = mysql_config("root", "secret", Some("analytics"));
        config.driver_profile = Some("starrocks".to_string());
        config.url_params = Some(
            "ssl-mode=disabled&sslmode=required&require_ssl=true&verify_ca=false&verify_identity=false&charset=utf8mb4"
                .to_string(),
        );

        assert!(config.needs_bare_mysql());
        assert!(!config.bare_mysql_uses_tls());
        assert_eq!(config.connection_url(), "mysql://root:secret@10.1.2.3:2883/analytics");
    }

    #[test]
    fn starrocks_profile_preserves_mysql_tls_params_when_enabled() {
        let mut config = mysql_config("root", "secret", Some("analytics"));
        config.driver_profile = Some("starrocks".to_string());
        config.ssl = true;
        config.url_params = Some("verify_ca=true&verify_identity=false".to_string());

        assert!(config.bare_mysql_uses_tls());
        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/analytics?require_ssl=true&verify_ca=true&verify_identity=false&charset=utf8mb4"
        );
    }

    #[test]
    fn starrocks_database_type_preserves_mysql_tls_params_when_enabled() {
        let mut config = mysql_config("root", "secret", Some("analytics"));
        config.db_type = DatabaseType::StarRocks;
        config.ssl = true;
        config.ca_cert_path = "/tmp/starrocks-ca.pem".to_string();

        assert!(config.bare_mysql_uses_tls());
        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/analytics?require_ssl=true&verify_identity=false&charset=utf8mb4"
        );
    }

    #[test]
    fn starrocks_profile_keeps_non_mysql_tls_params() {
        let mut config = mysql_config("root", "secret", Some("analytics"));
        config.driver_profile = Some("starrocks".to_string());
        config.url_params = Some("connect_timeout=10&sessionVariables=query_timeout=60".to_string());

        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/analytics?connect_timeout=10&sessionVariables=query_timeout=60"
        );
    }

    #[test]
    fn tdengine_profile_is_canonicalized_to_agent_database_type() {
        let mut config = mysql_config("root", "taosdata", Some("power"));
        config.driver_profile = Some("tdengine".to_string());
        config.driver_label = None;
        config.port = 6030;

        let canonical = config.canonicalized();

        assert_eq!(canonical.db_type, DatabaseType::Tdengine);
        assert_eq!(canonical.port, 6041);
        assert_eq!(canonical.driver_profile.as_deref(), Some("tdengine"));
        assert_eq!(canonical.driver_label.as_deref(), Some("TDengine"));
        assert!(!canonical.needs_bare_mysql());
    }

    #[test]
    fn informix_empty_database_uses_sysmaster_for_connection() {
        let mut config = mysql_config("informix", "in4mix", None);
        config.db_type = DatabaseType::Informix;
        config.port = 9088;

        assert_eq!(config.effective_database(), Some("sysmaster"));
        assert_eq!(config.connection_url(), "informix://informix:in4mix@10.1.2.3:9088/sysmaster");
    }

    #[test]
    fn h2_empty_database_uses_test_for_connection() {
        let mut config = mysql_config("sa", "", None);
        config.db_type = DatabaseType::H2;
        config.port = 9092;

        assert_eq!(config.effective_database(), Some("test"));
        assert_eq!(config.connection_url(), "h2://sa:@10.1.2.3:9092/test");
    }

    #[test]
    fn neo4j_empty_database_uses_neo4j_for_connection() {
        let mut config = mysql_config("neo4j", "secret", None);
        config.db_type = DatabaseType::Neo4j;
        config.port = 7687;

        assert_eq!(config.effective_database(), Some("neo4j"));
        assert_eq!(config.connection_url(), "neo4j://neo4j:secret@10.1.2.3:7687/neo4j");
    }

    #[test]
    fn clickhouse_empty_database_uses_default() {
        let mut config = mysql_config("default", "", None);
        config.db_type = DatabaseType::ClickHouse;
        config.port = 8123;

        assert_eq!(config.effective_database(), Some("default"));
    }

    #[test]
    fn kingbase_empty_database_has_no_default() {
        let mut config = mysql_config("SYSTEM", "secret", None);
        config.db_type = DatabaseType::Kingbase;
        config.port = 54321;

        assert_eq!(config.effective_database(), None);
        assert_eq!(config.connection_url(), "kingbase://SYSTEM:secret@10.1.2.3:54321");
    }

    #[test]
    fn vastbase_empty_database_uses_postgres_for_connection() {
        let mut config = mysql_config("vastbase", "secret", None);
        config.db_type = DatabaseType::Vastbase;
        config.port = 5432;

        assert_eq!(config.effective_database(), Some("postgres"));
        assert_eq!(config.connection_url(), "vastbase://vastbase:secret@10.1.2.3:5432/postgres");
    }

    #[test]
    fn clickhouse_tls_uses_https_from_ssl_or_secure_param() {
        let mut config = mysql_config("default", "", None);
        config.db_type = DatabaseType::ClickHouse;
        config.port = 8443;

        assert_eq!(config.connection_url(), "http://10.1.2.3:8443");

        config.ssl = true;
        assert_eq!(config.connection_url(), "https://10.1.2.3:8443");

        config.ssl = false;
        config.url_params = Some("secure=true".to_string());
        assert_eq!(config.connection_url(), "https://10.1.2.3:8443");
    }

    #[test]
    fn clickhouse_host_may_include_http_scheme() {
        let mut config = mysql_config("default", "", None);
        config.db_type = DatabaseType::ClickHouse;
        config.host = "https://clickhouse.example.com".to_string();
        config.port = 8443;

        assert_eq!(config.connection_url(), "https://clickhouse.example.com:8443");
    }

    #[test]
    fn mysql_url_encodes_password_and_database() {
        let config = mysql_config("root", "p@ss:word#1", Some("db/name"));

        assert_eq!(
            config.connection_url(),
            "mysql://root:p%40ss%3Aword%231@10.1.2.3:2883/db%2Fname?ssl-mode=disabled&charset=utf8mb4"
        );
    }

    #[test]
    fn mysql_url_appends_custom_params() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.url_params = Some("charset=utf8mb4".to_string());

        assert_eq!(config.connection_url(), "mysql://root:secret@10.1.2.3:2883/test?ssl-mode=disabled&charset=utf8mb4");
    }

    #[test]
    fn mysql_cleartext_password_auth_alias_normalizes_to_driver_param() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.url_params = Some("allowCleartextPasswords=true".to_string());

        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/test?ssl-mode=disabled&charset=utf8mb4&enable_cleartext_plugin=true"
        );
    }

    #[test]
    fn mysql_cleartext_password_auth_keeps_canonical_driver_param() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.url_params = Some("enable_cleartext_plugin=true".to_string());

        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/test?ssl-mode=disabled&charset=utf8mb4&enable_cleartext_plugin=true"
        );
    }

    #[test]
    fn mysql_cleartext_password_auth_deduplicates_aliases() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.url_params =
            Some("allowCleartextPasswords=true&enable_cleartext_plugin=true&charset=utf8mb4".to_string());

        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/test?ssl-mode=disabled&charset=utf8mb4&enable_cleartext_plugin=true"
        );
    }

    #[test]
    fn mysql_cleartext_password_auth_omits_disabled_values() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.url_params = Some("allowCleartextPasswords=false&enable_cleartext_plugin=&charset=utf8mb4".to_string());

        assert_eq!(config.connection_url(), "mysql://root:secret@10.1.2.3:2883/test?ssl-mode=disabled&charset=utf8mb4");
    }

    #[test]
    fn mysql_tls_switch_requires_ssl_without_strict_certificate_checks_by_default() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.ssl = true;

        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/test?require_ssl=true&verify_ca=false&verify_identity=false&charset=utf8mb4"
        );
    }

    #[test]
    fn mysql_explicit_preferred_tls_mode_is_preserved() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.url_params = Some("ssl-mode=preferred".to_string());

        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/test?ssl-mode=preferred&charset=utf8mb4"
        );
    }

    #[test]
    fn mysql_tls_switch_uses_ca_cert_for_ca_validation() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.ssl = true;
        config.ca_cert_path = "/tmp/tidb-ca.pem".to_string();

        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/test?require_ssl=true&verify_identity=false&charset=utf8mb4"
        );
    }

    #[test]
    fn tidb_cloud_mysql_url_requires_tls() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.host = "gateway01.us-west-2.prod.aws.tidbcloud.com".to_string();
        config.port = 4000;
        config.url_params = Some("require_ssl=false&charset=utf8mb4".to_string());

        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@gateway01.us-west-2.prod.aws.tidbcloud.com:4000/test?require_ssl=true&charset=utf8mb4&verify_ca=false&verify_identity=false"
        );
    }

    #[test]
    fn postgres_url_appends_custom_params() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("sslmode=disable".to_string());

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=disable");
    }

    #[test]
    fn postgres_url_prefers_tls_by_default() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer");
    }

    #[test]
    fn postgres_tls_switch_adds_require_sslmode() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.ssl = true;

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=require");
    }

    #[test]
    fn postgres_url_normalizes_timezone_param_into_options() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("sslmode=require&timezone=Asia/Shanghai".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=require&options=%2Dc%20TimeZone%3DAsia%2FShanghai"
        );
        let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
        assert_eq!(pg_config.get_options(), Some("-c TimeZone=Asia/Shanghai"));
    }

    #[test]
    fn postgres_url_maps_schema_param_into_search_path_options() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("schema=public".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dpublic"
        );
        let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
        assert_eq!(pg_config.get_options(), Some("-c search_path=public"));
    }

    #[test]
    fn postgres_url_maps_current_schema_param_into_search_path_options() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("currentSchema=app".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer&options=%2Dc%20search%5Fpath%3Dapp"
        );
        let pg_config = tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
        assert_eq!(pg_config.get_options(), Some("-c search_path=app"));
    }

    #[test]
    fn postgres_url_ignores_mysql_only_params_from_saved_connections() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("ssl-mode=preferred&charset=utf8mb4".to_string());

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer");
        tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
    }

    #[test]
    fn postgres_url_maps_mysql_ssl_mode_require_to_sslmode() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("ssl-mode=required&verify_ca=false&verify_identity=false".to_string());

        assert_eq!(config.connection_url(), "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=require");
        tokio_postgres::Config::from_str(&config.connection_url()).unwrap();
    }

    #[test]
    fn postgres_url_appends_timezone_to_existing_options() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("options=-c%20statement_timeout%3D5000&TimeZone=UTC".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer&options=%2Dc%20statement%5Ftimeout%3D5000%20%2Dc%20TimeZone%3DUTC"
        );
    }

    #[test]
    fn postgres_url_keeps_existing_options_timezone() {
        let mut config = mysql_config("postgres", "secret", Some("test"));
        config.db_type = DatabaseType::Postgres;
        config.url_params = Some("options=-c%20TimeZone%3DUTC&timezone=Asia/Shanghai".to_string());

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=prefer&options=-c%20TimeZone%3DUTC"
        );
    }

    #[test]
    fn postgres_url_defaults_to_postgres_database_when_omitted() {
        let mut config = mysql_config("root", "secret", None);
        config.db_type = DatabaseType::Postgres;

        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:2883/postgres?sslmode=prefer");
    }

    #[test]
    fn postgres_url_defaults_to_postgres_database_when_empty() {
        let mut config = mysql_config("root", "secret", Some(""));
        config.db_type = DatabaseType::Postgres;

        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:2883/postgres?sslmode=prefer");
    }

    #[test]
    fn redshift_url_defaults_to_dev_database_when_empty() {
        let mut config = mysql_config("awsuser", "secret", Some(""));
        config.db_type = DatabaseType::Redshift;

        assert_eq!(config.connection_url(), "postgres://awsuser:secret@10.1.2.3:2883/dev?sslmode=prefer");
    }

    #[test]
    fn cockroachdb_url_defaults_to_defaultdb_database() {
        let mut config = mysql_config("root", "secret", None);
        config.db_type = DatabaseType::Postgres;
        config.driver_profile = Some("cockroachdb".to_string());

        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:2883/defaultdb?sslmode=prefer");
    }

    #[test]
    fn gaussdb_url_defaults_to_postgres_database() {
        let mut config = mysql_config("gaussdb", "secret", None);
        config.db_type = DatabaseType::Gaussdb;

        assert_eq!(config.connection_url(), "gaussdb://gaussdb:secret@10.1.2.3:2883/postgres");
    }

    #[test]
    fn kwdb_url_defaults_to_defaultdb_database() {
        let mut config = mysql_config("root", "secret", None);
        config.db_type = DatabaseType::Kwdb;

        assert_eq!(config.connection_url(), "kwdb://root:secret@10.1.2.3:2883/defaultdb");
    }

    #[test]
    fn yashandb_url_defaults_to_yasdb_database() {
        let mut config = mysql_config("sys", "secret", None);
        config.db_type = DatabaseType::Yashandb;

        assert_eq!(config.connection_url(), "yashandb://sys:secret@10.1.2.3:2883/yasdb");
    }

    #[test]
    fn oscar_url_defaults_to_osrdb_database() {
        let mut config = mysql_config("SYSDBA", "secret", None);
        config.db_type = DatabaseType::Oscar;

        assert_eq!(config.connection_url(), "oscar://SYSDBA:secret@10.1.2.3:2883/osrdb");
    }

    #[test]
    fn mongodb_form_url_without_params_defaults_auth_source_to_admin() {
        let config = mongodb_config("root", "secret", Some("admin"));

        assert_eq!(config.connection_url(), "mongodb://root:secret@10.1.2.3:17000/admin?authSource=admin");
    }

    #[test]
    fn mongodb_form_url_default_database_does_not_change_auth_source() {
        let config = mongodb_config("root", "secret", Some("app"));

        assert_eq!(config.connection_url(), "mongodb://root:secret@10.1.2.3:17000/app?authSource=admin");
    }

    #[test]
    fn mongodb_form_url_without_database_keeps_slash_before_params() {
        let config = mongodb_config("root", "secret", None);

        assert_eq!(config.connection_url(), "mongodb://root:secret@10.1.2.3:17000/?authSource=admin");
        assert_eq!(config.redacted_connection_url(), "mongodb://10.1.2.3:17000/?authSource=admin");
    }

    #[test]
    fn mongodb_form_url_without_username_does_not_default_auth_source() {
        let config = mongodb_config("", "", Some("app"));

        assert_eq!(config.connection_url(), "mongodb://10.1.2.3:17000/app");
    }

    #[test]
    fn mongodb_form_url_preserves_explicit_auth_source() {
        let mut config = mongodb_config("root", "secret", Some("app"));
        config.url_params = Some("authSource=app".to_string());

        assert_eq!(config.connection_url(), "mongodb://root:secret@10.1.2.3:17000/app?authSource=app");
    }

    #[test]
    fn mongodb_form_url_appends_custom_params() {
        let mut config = mongodb_config("root", "secret", Some("app"));
        config.url_params = Some("?authSource=admin&authMechanism=SCRAM-SHA-1&directConnection=true".to_string());

        assert_eq!(
            config.connection_url(),
            "mongodb://root:secret@10.1.2.3:17000/app?authSource=admin&authMechanism=SCRAM-SHA-1&directConnection=true"
        );
    }

    #[test]
    fn redacted_mysql_url_omits_credentials() {
        let config = mysql_config("user@tenant#cluster", "p@ss:word#1", Some("db/name"));

        let url = config.redacted_connection_url();

        assert_eq!(url, "mysql://10.1.2.3:2883/db%2Fname?ssl-mode=disabled&charset=utf8mb4");
        assert!(!url.contains("user"));
        assert!(!url.contains("p%40ss"));
        assert!(!url.contains("p@ss"));
    }

    #[test]
    fn redacted_sqlserver_url_omits_credentials() {
        let mut config = mysql_config("sa", "super-secret", Some("master"));
        config.db_type = DatabaseType::SqlServer;

        let url = config.redacted_connection_url();

        assert_eq!(url, "server=tcp:10.1.2.3,2883;database=master");
        assert!(!url.contains("sa"));
        assert!(!url.contains("super-secret"));
    }

    #[test]
    fn redacted_redis_url_omits_credentials_and_keeps_tls_scheme() {
        let mut config = mysql_config("default", "redis-secret", None);
        config.db_type = DatabaseType::Redis;
        config.ssl = true;

        let url = config.redacted_connection_url();

        assert_eq!(url, "rediss://10.1.2.3:2883/");
        assert!(!url.contains("default"));
        assert!(!url.contains("redis-secret"));
    }

    #[test]
    fn redis_tls_insecure_url_params_append_insecure_fragment() {
        let mut config = mysql_config("default", "secret", Some("0"));
        config.db_type = DatabaseType::Redis;
        config.ssl = true;
        config.url_params = Some("insecure=true".to_string());

        assert_eq!(config.connection_url(), "rediss://default:secret@10.1.2.3:2883/#insecure");
        assert_eq!(config.redacted_connection_url(), "rediss://10.1.2.3:2883/#insecure");
    }

    #[test]
    fn redis_insecure_url_params_do_not_affect_plain_tcp() {
        let mut config = mysql_config("default", "secret", Some("0"));
        config.db_type = DatabaseType::Redis;
        config.url_params = Some("insecure=true".to_string());

        assert_eq!(config.connection_url(), "redis://default:secret@10.1.2.3:2883/");
    }

    #[test]
    fn redacted_mongodb_url_keeps_custom_params_without_credentials() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.url_params = Some("authSource=admin&authMechanism=SCRAM-SHA-1".to_string());

        let url = config.redacted_connection_url();

        assert_eq!(url, "mongodb://10.1.2.3:17000/admin?authSource=admin&authMechanism=SCRAM-SHA-1");
        assert!(!url.contains("root"));
        assert!(!url.contains("secret"));
    }

    #[test]
    fn mongodb_form_tls_uses_standard_scheme_and_tls_param() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.ssl = true;

        assert_eq!(config.connection_url(), "mongodb://root:secret@10.1.2.3:17000/admin?tls=true&authSource=admin");
        assert_eq!(config.redacted_connection_url(), "mongodb://10.1.2.3:17000/admin?tls=true&authSource=admin");
    }

    #[test]
    fn mongodb_form_tls_replaces_existing_tls_params() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.ssl = true;
        config.url_params = Some("authSource=admin&ssl=false&tls=false".to_string());

        assert_eq!(config.connection_url(), "mongodb://root:secret@10.1.2.3:17000/admin?tls=true&authSource=admin");
    }

    #[test]
    fn mongodb_form_tls_ca_cert_adds_tls_ca_file_param() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.ssl = true;
        config.ca_cert_path = "/tmp/mongo-ca.pem".to_string();

        assert_eq!(
            config.connection_url(),
            "mongodb://root:secret@10.1.2.3:17000/admin?tls=true&tlsCAFile=%2Ftmp%2Fmongo%2Dca%2Epem&authSource=admin"
        );
    }

    #[test]
    fn mongodb_form_tls_cert_params_replace_existing_url_values() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.ssl = true;
        config.ca_cert_path = "/tmp/new-ca.pem".to_string();
        config.url_params = Some("tlsCAFile=%2Fold-ca.pem&authSource=admin".to_string());

        assert_eq!(
            config.connection_url(),
            "mongodb://root:secret@10.1.2.3:17000/admin?tls=true&authSource=admin&tlsCAFile=%2Ftmp%2Fnew%2Dca%2Epem"
        );
    }

    #[test]
    fn mongodb_form_tls_preserves_legacy_tls_ca_file_in_url_params() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.ssl = true;
        config.url_params = Some("tlsCAFile=%2Ftmp%2Flegacy-ca.pem&authSource=admin".to_string());

        assert_eq!(
            config.connection_url(),
            "mongodb://root:secret@10.1.2.3:17000/admin?tls=true&authSource=admin&tlsCAFile=%2Ftmp%2Flegacy-ca.pem"
        );
    }

    #[test]
    fn mongodb_form_tls_allow_invalid_hostnames_maps_to_allow_invalid_certificates() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.ssl = true;
        config.url_params = Some("replicaSet=rs0&tlsAllowInvalidHostnames=true".to_string());

        assert_eq!(
            config.connection_url(),
            "mongodb://root:secret@10.1.2.3:17000/admin?tls=true&replicaSet=rs0&tlsAllowInvalidCertificates=true&authSource=admin"
        );
        assert!(!config.connection_url().contains("tlsAllowInvalidHostnames"));
    }

    #[test]
    fn parse_mongo_first_host_replica_set() {
        let uri = "mongodb://user:pass@host1:27017,host2:27017,host3:27017/admin?replicaSet=rs0";
        let (host, port) = super::parse_mongo_first_host(uri).unwrap();
        assert_eq!(host, "host1");
        assert_eq!(port, 27017);
    }

    #[test]
    fn parse_mongo_first_host_single() {
        let uri = "mongodb://user:pass@myhost:30000/db";
        let (host, port) = super::parse_mongo_first_host(uri).unwrap();
        assert_eq!(host, "myhost");
        assert_eq!(port, 30000);
    }

    #[test]
    fn parse_mongo_first_host_no_creds() {
        let uri = "mongodb://host1:27017,host2:27017/admin";
        let (host, port) = super::parse_mongo_first_host(uri).unwrap();
        assert_eq!(host, "host1");
        assert_eq!(port, 27017);
    }

    #[test]
    fn parse_mongo_first_host_srv() {
        let uri = "mongodb+srv://user:pass@cluster0.example.net/db";
        let (host, port) = super::parse_mongo_first_host(uri).unwrap();
        assert_eq!(host, "cluster0.example.net");
        assert_eq!(port, 27017);
    }

    #[test]
    fn mongodb_connection_string_rewritten_when_tunneled() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.connection_string =
            Some("mongodb://read:pass@host1:27017,host2:27017/admin?replicaSet=rs0&authSource=admin".to_string());

        let url = config.connection_url_with_host("127.0.0.1", 54321);

        assert_eq!(
            url,
            "mongodb://read:pass@127.0.0.1:54321/admin?replicaSet=rs0&authSource=admin&directConnection=true"
        );
    }

    #[test]
    fn mongodb_connection_string_unchanged_when_not_tunneled() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.connection_string = Some("mongodb://read:pass@host1:27017,host2:27017/admin?replicaSet=rs0".to_string());

        let url = config.connection_url();

        assert_eq!(url, "mongodb://read:pass@host1:27017,host2:27017/admin?replicaSet=rs0");
    }

    #[test]
    fn mongodb_connection_string_without_database_keeps_slash_before_params() {
        let mut config = mongodb_config("root", "secret", None);
        config.connection_string = Some("mongodb://read:pass@host1:27017?authSource=admin".to_string());

        let url = config.connection_url();

        assert_eq!(url, "mongodb://read:pass@host1:27017/?authSource=admin");
    }

    #[test]
    fn mongodb_connection_string_without_database_keeps_slash_when_tunneled() {
        let mut config = mongodb_config("root", "secret", None);
        config.connection_string = Some("mongodb://read:pass@host1:27017?authSource=admin".to_string());

        let url = config.connection_url_with_host("127.0.0.1", 54321);

        assert_eq!(url, "mongodb://read:pass@127.0.0.1:54321/?authSource=admin&directConnection=true");
    }

    #[test]
    fn mongodb_multi_seed_connection_string_removes_direct_connection_true() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.connection_string = Some(
            "mongodb://read:pass@host1:27017,host2:27017/admin?directConnection=true&replicaSet=rs0&authSource=admin"
                .to_string(),
        );

        let url = config.connection_url();

        assert_eq!(url, "mongodb://read:pass@host1:27017,host2:27017/admin?replicaSet=rs0&authSource=admin");
    }

    #[test]
    fn mongodb_srv_connection_string_removes_direct_connection_true() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.connection_string = Some(
            "mongodb+srv://read:pass@cluster.example.net/admin?tls=true&authSource=admin&directConnection=true&replicaSet=rs0"
                .to_string(),
        );

        let url = config.connection_url();

        assert_eq!(url, "mongodb+srv://read:pass@cluster.example.net/admin?tls=true&authSource=admin&replicaSet=rs0");
    }

    #[test]
    fn mongodb_single_seed_connection_string_keeps_direct_connection_true() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.connection_string =
            Some("mongodb://read:pass@host1:27017/admin?directConnection=true&authSource=admin".to_string());

        let url = config.connection_url();

        assert_eq!(url, "mongodb://read:pass@host1:27017/admin?directConnection=true&authSource=admin");
    }

    #[test]
    fn mongodb_form_url_adds_direct_connection_when_tunneled() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.url_params = Some("replicaSet=rs0&authSource=admin".to_string());

        let url = config.connection_url_with_host("127.0.0.1", 54321);

        assert_eq!(
            url,
            "mongodb://root:secret@127.0.0.1:54321/admin?replicaSet=rs0&authSource=admin&directConnection=true"
        );
    }

    #[test]
    fn mongodb_form_url_without_database_keeps_slash_before_tunneled_params() {
        let config = mongodb_config("root", "secret", None);

        let url = config.connection_url_with_host("127.0.0.1", 54321);

        assert_eq!(url, "mongodb://root:secret@127.0.0.1:54321/?authSource=admin&directConnection=true");
    }

    #[test]
    fn mongodb_form_url_no_duplicate_direct_connection() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.url_params = Some("directConnection=true&authSource=admin".to_string());

        let url = config.connection_url_with_host("127.0.0.1", 54321);

        assert!(url.matches("directConnection").count() == 1);
    }

    #[test]
    fn parse_jdbc_host_port_postgresql() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:postgresql://myhost:5432/mydb").unwrap();
        assert_eq!(h, "myhost");
        assert_eq!(p, 5432);
    }

    #[test]
    fn parse_jdbc_host_port_mysql() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:mysql://db.example.com:3306/app?useSSL=false").unwrap();
        assert_eq!(h, "db.example.com");
        assert_eq!(p, 3306);
    }

    #[test]
    fn parse_jdbcx_host_port_with_and_without_extension() {
        assert_eq!(
            super::parse_jdbc_host_port("jdbcx:mysql://db.example.com:3306/app"),
            Some(("db.example.com".to_string(), 3306))
        );
        assert_eq!(
            super::parse_jdbc_host_port("jdbcx:prql:postgresql://pg.example.com:5432/app"),
            Some(("pg.example.com".to_string(), 5432))
        );
        assert_eq!(
            super::parse_jdbc_host_port("jdbcx:query:sqlserver://sql.example.com:1433;databaseName=app"),
            Some(("sql.example.com".to_string(), 1433))
        );
    }

    #[test]
    fn parse_jdbc_host_port_with_userinfo() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:postgresql://user:pass@pghost:5433/db").unwrap();
        assert_eq!(h, "pghost");
        assert_eq!(p, 5433);
    }

    #[test]
    fn parse_jdbc_host_port_oracle_thin() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:oracle:thin:@orahost:1521:ORCL").unwrap();
        assert_eq!(h, "orahost");
        assert_eq!(p, 1521);
    }

    #[test]
    fn parse_jdbc_host_port_oracle_service() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:oracle:thin:@//orahost:1521/service").unwrap();
        assert_eq!(h, "orahost");
        assert_eq!(p, 1521);
    }

    #[test]
    fn parse_jdbc_host_port_oracle_descriptor() {
        let (h, p) = super::parse_jdbc_host_port(
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=orahost)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=orcl)))",
        )
        .unwrap();
        assert_eq!(h, "orahost");
        assert_eq!(p, 1521);
    }

    #[test]
    fn rewrite_jdbc_url_host_oracle_descriptor() {
        let url =
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=orahost)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=orcl)))";

        assert_eq!(
            super::rewrite_jdbc_url_host(url, "127.0.0.1", 11521),
            "jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=11521))(CONNECT_DATA=(SERVICE_NAME=orcl)))"
        );
    }

    #[test]
    fn parse_jdbc_host_port_sqlserver() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:sqlserver://mshost:1433;databaseName=master").unwrap();
        assert_eq!(h, "mshost");
        assert_eq!(p, 1433);
    }

    #[test]
    fn parse_jdbc_host_port_sqlserver_no_port() {
        let (h, p) = super::parse_jdbc_host_port("jdbc:sqlserver://mshost;databaseName=master").unwrap();
        assert_eq!(h, "mshost");
        assert_eq!(p, 1433);
    }

    #[test]
    fn parse_jdbc_host_port_no_port_returns_none() {
        assert!(super::parse_jdbc_host_port("jdbc:postgresql://myhost/mydb").is_none());
    }

    #[test]
    fn parse_jdbc_host_port_invalid_returns_none() {
        assert!(super::parse_jdbc_host_port("not-a-jdbc-url").is_none());
    }

    #[test]
    fn rewrite_jdbc_url_postgresql() {
        let url = "jdbc:postgresql://myhost:5432/mydb";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 54321);
        assert_eq!(rewritten, "jdbc:postgresql://127.0.0.1:54321/mydb");
    }

    #[test]
    fn rewrite_jdbcx_url_preserves_extension() {
        let url = "jdbcx:script:mysql://db.example.com:3306/app";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 13306);
        assert_eq!(rewritten, "jdbcx:script:mysql://127.0.0.1:13306/app");

        let sqlserver = "jdbcx:query:sqlserver://sql.example.com:1433;databaseName=app";
        let rewritten = super::rewrite_jdbc_url_host(sqlserver, "127.0.0.1", 11433);
        assert_eq!(rewritten, "jdbcx:query:sqlserver://127.0.0.1:11433;databaseName=app");
    }

    #[test]
    fn rewrite_jdbcx_oracle_descriptor() {
        let url = "jdbcx:web:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=orahost)(PORT=1521))(CONNECT_DATA=(SERVICE_NAME=orcl)))";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 11521);
        assert_eq!(
            rewritten,
            "jdbcx:web:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=11521))(CONNECT_DATA=(SERVICE_NAME=orcl)))"
        );
    }

    #[test]
    fn rewrite_jdbc_url_oracle() {
        let url = "jdbc:oracle:thin:@orahost:1521:ORCL";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 54321);
        assert_eq!(rewritten, "jdbc:oracle:thin:@127.0.0.1:54321:ORCL");
    }

    #[test]
    fn rewrite_jdbc_url_sqlserver() {
        let url = "jdbc:sqlserver://mshost:1433;databaseName=master";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 54321);
        assert_eq!(rewritten, "jdbc:sqlserver://127.0.0.1:54321;databaseName=master");
    }

    #[test]
    fn rewrite_jdbc_url_unparseable_returns_original() {
        let url = "jdbc:custom:some-opaque-string";
        let rewritten = super::rewrite_jdbc_url_host(url, "127.0.0.1", 54321);
        assert_eq!(rewritten, url);
    }
}
