use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible_databases: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attached_databases: Vec<AttachedDatabaseConfig>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_user: String,
    #[serde(default)]
    pub ssh_password: String,
    #[serde(default)]
    pub ssh_key_path: String,
    #[serde(default)]
    pub ssh_key_passphrase: String,
    #[serde(default)]
    pub ssh_expose_lan: bool,
    #[serde(default = "default_ssh_connect_timeout_secs")]
    pub ssh_connect_timeout_secs: u64,
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxy_type: ProxyType,
    #[serde(default)]
    pub proxy_host: String,
    #[serde(default = "default_proxy_port")]
    pub proxy_port: u16,
    #[serde(default)]
    pub proxy_username: String,
    #[serde(default)]
    pub proxy_password: String,
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub sysdba: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oracle_connection_type: Option<String>,
    #[serde(default)]
    pub connection_string: Option<String>,
    /// Typed configuration for external tabular sources.
    #[serde(default)]
    pub external_config: Option<serde_json::Value>,
    #[serde(default)]
    pub jdbc_driver_class: Option<String>,
    #[serde(default)]
    pub jdbc_driver_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttachedDatabaseConfig {
    pub name: String,
    pub path: String,
}

fn default_ssh_port() -> u16 {
    22
}

pub fn default_ssh_connect_timeout_secs() -> u64 {
    5
}

fn default_proxy_port() -> u16 {
    1080
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyType {
    Socks5,
    Http,
}

impl Default for ProxyType {
    fn default() -> Self {
        Self::Socks5
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseType {
    Mysql,
    Postgres,
    Sqlite,
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
    Doris,
    #[serde(rename = "starrocks")]
    StarRocks,
    Redshift,
    Dameng,
    Kingbase,
    Highgo,
    Vastbase,
    Goldendb,
    Gaussdb,
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
    Hive,
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
    Tdengine,
    Jdbc,
}

impl ConnectionConfig {
    pub fn effective_ssh_connect_timeout_secs(&self) -> u64 {
        if self.ssh_connect_timeout_secs == 0 {
            default_ssh_connect_timeout_secs()
        } else {
            self.ssh_connect_timeout_secs
        }
    }

    pub fn effective_database(&self) -> Option<&str> {
        self.database
            .as_deref()
            .map(str::trim)
            .filter(|database| !database.is_empty())
            .or_else(|| self.default_database())
    }

    fn default_database(&self) -> Option<&'static str> {
        match self.db_type {
            DatabaseType::Postgres => match self.driver_profile.as_deref() {
                Some("cockroachdb") => Some("defaultdb"),
                _ => Some("postgres"),
            },
            DatabaseType::Redshift => Some("dev"),
            DatabaseType::ClickHouse => Some("default"),
            DatabaseType::Gaussdb | DatabaseType::OpenGauss => Some("postgres"),
            DatabaseType::Kingbase | DatabaseType::Vastbase => Some("postgres"),
            DatabaseType::Highgo => Some("highgo"),
            DatabaseType::Yashandb => Some("yasdb"),
            DatabaseType::Firebird => Some("employee"),
            DatabaseType::H2 => Some("test"),
            DatabaseType::Informix => Some("sysmaster"),
            DatabaseType::Neo4j => Some("neo4j"),
            _ => None,
        }
    }

    pub fn needs_bare_mysql(&self) -> bool {
        matches!(self.db_type, DatabaseType::Doris | DatabaseType::StarRocks)
            || self
                .driver_profile
                .as_deref()
                .map(|p| p.to_lowercase())
                .is_some_and(|p| matches!(p.as_str(), "doris" | "starrocks" | "selectdb" | "oceanbase"))
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

    pub fn connection_url(&self) -> String {
        self.connection_url_with_host(&self.host, self.port)
    }

    pub fn redacted_connection_url(&self) -> String {
        self.redacted_connection_url_with_host(&self.host, self.port)
    }

    pub fn redacted_connection_url_with_host(&self, host: &str, port: u16) -> String {
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
                format!("{scheme}://{host}:{port}/")
            }
            DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks => {
                format!("mysql://{host}:{port}{db_part}?{params}")
            }
            DatabaseType::Postgres | DatabaseType::Redshift => {
                let suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                format!("postgres://{host}:{port}{db_part}{suffix}")
            }
            DatabaseType::ClickHouse => format!("http://{host}:{port}"),
            DatabaseType::SqlServer => {
                format!("server=tcp:{host},{port};database={}", self.database.as_deref().unwrap_or("master"))
            }
            DatabaseType::MongoDb => {
                let is_tunneled = host != self.host.as_str() || port != self.port;
                if let Some(cs) = self.connection_string.as_deref().filter(|s| !s.is_empty()) {
                    if is_tunneled {
                        return rewrite_mongo_uri_host(cs, &host, port);
                    }
                    return cs.to_string();
                }
                let mut suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                if is_tunneled && !suffix.contains("directConnection=") {
                    if suffix.is_empty() {
                        suffix = "?directConnection=true".to_string();
                    } else {
                        suffix.push_str("&directConnection=true");
                    }
                }
                format!("mongodb://{host}:{port}{db_part}{suffix}")
            }
            DatabaseType::Oracle => format!("oracle://{host}:{port}{db_part}"),
            DatabaseType::Elasticsearch => {
                let scheme = if self.ssl { "https" } else { "http" };
                format!("{scheme}://{host}:{port}")
            }
            DatabaseType::Dameng => format!("dm://{host}:{port}{db_part}"),
            DatabaseType::Kingbase => format!("kingbase://{host}:{port}{db_part}"),
            DatabaseType::Highgo => format!("highgo://{host}:{port}{db_part}"),
            DatabaseType::Vastbase => format!("vastbase://{host}:{port}{db_part}"),
            DatabaseType::Goldendb => format!("goldendb://{host}:{port}{db_part}"),
            DatabaseType::Gaussdb => format!("gaussdb://{host}:{port}{db_part}"),
            DatabaseType::Yashandb => format!("yashandb://{host}:{port}{db_part}"),
            DatabaseType::Databricks => format!("databricks://{host}:{port}{db_part}"),
            DatabaseType::SapHana => format!("saphana://{host}:{port}{db_part}"),
            DatabaseType::Teradata => format!("teradata://{host}:{port}{db_part}"),
            DatabaseType::Vertica => format!("vertica://{host}:{port}{db_part}"),
            DatabaseType::Firebird => format!("firebird://{host}:{port}{db_part}"),
            DatabaseType::Exasol => format!("exasol://{host}:{port}{db_part}"),
            DatabaseType::OpenGauss => format!("opengauss://{host}:{port}{db_part}"),
            DatabaseType::OceanbaseOracle => format!("oceanbase-oracle://{host}:{port}{db_part}"),
            DatabaseType::Gbase => format!("gbase://{host}:{port}{db_part}"),
            DatabaseType::H2 => format!("h2://{host}:{port}{db_part}"),
            DatabaseType::Snowflake => format!("snowflake://{host}/{db_part}"),
            DatabaseType::Trino => format!("trino://{host}:{port}{db_part}"),
            DatabaseType::Hive => format!("hive://{host}:{port}{db_part}"),
            DatabaseType::Db2 => format!("db2://{host}:{port}{db_part}"),
            DatabaseType::Informix => format!("informix://{host}:{port}{db_part}"),
            DatabaseType::Neo4j => format!("neo4j://{host}:{port}{db_part}"),
            DatabaseType::Cassandra => format!("cassandra://{host}:{port}{db_part}"),
            DatabaseType::Bigquery => format!("bigquery://{host}/{db_part}"),
            DatabaseType::Kylin => format!("kylin://{host}:{port}{db_part}"),
            DatabaseType::Sundb => format!("sundb://{host}:{port}{db_part}"),
            DatabaseType::Tdengine => format!("tdengine://{host}:{port}{db_part}"),
            DatabaseType::Jdbc => "jdbc:<redacted>".to_string(),
        }
    }

    pub fn connection_url_with_host(&self, host: &str, port: u16) -> String {
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
                if self.username.is_empty() && self.password.is_empty() {
                    format!("{scheme}://{host}:{port}/")
                } else if self.username.is_empty() {
                    format!("{scheme}://:{password}@{host}:{port}/")
                } else {
                    format!("{scheme}://{username}:{password}@{host}:{port}/")
                }
            }
            DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks => {
                format!("mysql://{}:{}@{host}:{port}{db_part}?{params}", username, password)
            }
            DatabaseType::Postgres | DatabaseType::Redshift => {
                let suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                format!("postgres://{}:{}@{host}:{port}{db_part}{suffix}", username, password)
            }
            DatabaseType::ClickHouse => format!("http://{host}:{port}"),
            DatabaseType::SqlServer => format!(
                "server=tcp:{host},{port};user={};password={};database={}",
                self.username,
                self.password,
                self.database.as_deref().unwrap_or("master")
            ),
            DatabaseType::MongoDb => {
                let is_tunneled = host != self.host.as_str() || port != self.port;
                if let Some(cs) = self.connection_string.as_deref().filter(|s| !s.is_empty()) {
                    if is_tunneled {
                        return rewrite_mongo_uri_host(cs, &host, port);
                    }
                    return cs.to_string();
                }
                let mut suffix = if params.is_empty() { String::new() } else { format!("?{params}") };
                if is_tunneled && !suffix.contains("directConnection=") {
                    if suffix.is_empty() {
                        suffix = "?directConnection=true".to_string();
                    } else {
                        suffix.push_str("&directConnection=true");
                    }
                }
                if self.username.is_empty() {
                    format!("mongodb://{host}:{port}{db_part}{suffix}")
                } else {
                    format!("mongodb://{username}:{password}@{host}:{port}{db_part}{suffix}")
                }
            }
            DatabaseType::Oracle => {
                format!("oracle://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Elasticsearch => {
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
                format!("oceanbase-oracle://{}:{}@{host}:{port}{db_part}", username, password)
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
            DatabaseType::Hive => {
                format!("hive://{}:{}@{host}:{port}{db_part}", username, password)
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
            DatabaseType::Tdengine => {
                format!("tdengine://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Jdbc => {
                self.connection_string.as_deref().filter(|value| !value.is_empty()).unwrap_or("jdbc:").to_string()
            }
        }
    }

    fn normalized_url_params(&self) -> String {
        let value = self.url_params.as_deref().unwrap_or("").trim();
        if self.needs_bare_mysql() {
            let v = value.trim_start_matches('?');
            let filtered: Vec<&str> = v
                .split('&')
                .filter(|p| !p.is_empty() && !p.starts_with("charset=") && !p.starts_with("ssl-mode=preferred"))
                .collect();
            return if filtered.is_empty() {
                "ssl-mode=disabled".to_string()
            } else {
                format!("ssl-mode=disabled&{}", filtered.join("&"))
            };
        }
        match self.db_type {
            DatabaseType::Mysql => {
                let base = "ssl-mode=preferred&charset=utf8mb4";
                if value.is_empty() {
                    base.to_string()
                } else if value.contains("ssl-mode=") {
                    let v = value.trim_start_matches('?');
                    if v.contains("charset=") {
                        v.to_string()
                    } else {
                        format!("{v}&charset=utf8mb4")
                    }
                } else {
                    let v = value.trim_start_matches('?');
                    if v.contains("charset=") {
                        format!("ssl-mode=preferred&{v}")
                    } else {
                        format!("{base}&{v}")
                    }
                }
            }
            DatabaseType::Doris | DatabaseType::StarRocks => {
                let v = value.trim_start_matches('?');
                let filtered: Vec<&str> = v
                    .split('&')
                    .filter(|p| !p.is_empty() && !p.starts_with("charset=") && !p.starts_with("ssl-mode=preferred"))
                    .collect();
                if filtered.is_empty() {
                    "ssl-mode=disabled".to_string()
                } else {
                    format!("ssl-mode=disabled&{}", filtered.join("&"))
                }
            }
            DatabaseType::Postgres | DatabaseType::Redshift | DatabaseType::MongoDb => {
                value.trim_start_matches('?').to_string()
            }
            _ => value.trim_start_matches('?').to_string(),
        }
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
    let rest = url.strip_prefix("jdbc:")?;

    // jdbc:oracle:thin:@host:port:SID  or  jdbc:oracle:thin:@//host:port/service
    if let Some(after) = rest.strip_prefix("oracle:") {
        let at_pos = after.find('@')?;
        let after_at = &after[at_pos + 1..];
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

pub fn rewrite_jdbc_url_host(url: &str, new_host: &str, new_port: u16) -> String {
    let Some((old_host, old_port)) = parse_jdbc_host_port(url) else {
        return url.to_string();
    };
    let old_authority = format!("{old_host}:{old_port}");
    let new_authority = format!("{new_host}:{new_port}");
    url.replacen(&old_authority, &new_authority, 1)
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
    use super::{default_ssh_connect_timeout_secs, ConnectionConfig, DatabaseType, ProxyType};

    fn mysql_config(username: &str, password: &str, database: Option<&str>) -> ConnectionConfig {
        ConnectionConfig {
            id: "id".to_string(),
            name: "name".to_string(),
            db_type: DatabaseType::Mysql,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "10.1.2.3".to_string(),
            port: 2883,
            username: username.to_string(),
            password: password.to_string(),
            database: database.map(str::to_string),
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_password: String::new(),
            ssh_key_path: String::new(),
            ssh_key_passphrase: String::new(),
            ssh_expose_lan: false,
            ssh_connect_timeout_secs: default_ssh_connect_timeout_secs(),
            proxy_enabled: false,
            proxy_type: ProxyType::Socks5,
            proxy_host: String::new(),
            proxy_port: 1080,
            proxy_username: String::new(),
            proxy_password: String::new(),
            ssl: false,
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
        }
    }

    fn mongodb_config(username: &str, password: &str, database: Option<&str>) -> ConnectionConfig {
        let mut config = mysql_config(username, password, database);
        config.db_type = DatabaseType::MongoDb;
        config.port = 17000;
        config
    }

    #[test]
    fn ssh_connect_timeout_defaults_for_legacy_config() {
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

        assert_eq!(config.ssh_connect_timeout_secs, default_ssh_connect_timeout_secs());
        assert_eq!(config.effective_ssh_connect_timeout_secs(), default_ssh_connect_timeout_secs());
    }

    #[test]
    fn proxy_fields_default_for_legacy_config() {
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

        assert_eq!(config.proxy_enabled, false);
        assert_eq!(config.proxy_type, ProxyType::Socks5);
        assert_eq!(config.proxy_host, "");
        assert_eq!(config.proxy_port, 1080);
        assert_eq!(config.proxy_username, "");
        assert_eq!(config.proxy_password, "");
    }

    #[test]
    fn visible_databases_round_trips_through_connection_config() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "name",
            "db_type": "mysql",
            "host": "10.1.2.3",
            "port": 3306,
            "username": "root",
            "password": "",
            "database": null,
            "visible_databases": ["app", "billing"]
        }))
        .unwrap();

        let saved = serde_json::to_value(config).unwrap();

        assert_eq!(saved["visible_databases"], serde_json::json!(["app", "billing"]));
    }

    #[test]
    fn duckdb_attached_databases_round_trip_through_connection_config() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id",
            "name": "DuckDB",
            "db_type": "duckdb",
            "host": "/tmp/main.duckdb",
            "port": 0,
            "username": "",
            "password": "",
            "database": null,
            "attached_databases": [{ "name": "analytics", "path": "/tmp/analytics.duckdb" }]
        }))
        .unwrap();

        let saved = serde_json::to_value(config).unwrap();

        assert_eq!(
            saved["attached_databases"],
            serde_json::json!([{ "name": "analytics", "path": "/tmp/analytics.duckdb" }])
        );
    }

    #[test]
    fn ssh_connect_timeout_zero_uses_default() {
        let mut config = mysql_config("root", "", None);
        config.ssh_connect_timeout_secs = 0;

        assert_eq!(config.effective_ssh_connect_timeout_secs(), default_ssh_connect_timeout_secs());
    }

    #[test]
    fn mysql_url_encodes_oceanbase_username() {
        let config = mysql_config("user@tenant#cluster", "secret", None);

        assert_eq!(
            config.connection_url(),
            "mysql://user%40tenant%23cluster:secret@10.1.2.3:2883?ssl-mode=preferred&charset=utf8mb4"
        );
    }

    #[test]
    fn oceanbase_profile_uses_bare_mysql_connection_options() {
        let mut config = mysql_config("user@tenant#cluster", "secret", None);
        config.driver_profile = Some("oceanbase".to_string());

        assert!(config.needs_bare_mysql());
        assert_eq!(config.connection_url(), "mysql://user%40tenant%23cluster:secret@10.1.2.3:2883?ssl-mode=disabled");
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
    fn mysql_url_encodes_password_and_database() {
        let config = mysql_config("root", "p@ss:word#1", Some("db/name"));

        assert_eq!(
            config.connection_url(),
            "mysql://root:p%40ss%3Aword%231@10.1.2.3:2883/db%2Fname?ssl-mode=preferred&charset=utf8mb4"
        );
    }

    #[test]
    fn mysql_url_appends_custom_params() {
        let mut config = mysql_config("root", "secret", Some("test"));
        config.url_params = Some("charset=utf8mb4".to_string());

        assert_eq!(
            config.connection_url(),
            "mysql://root:secret@10.1.2.3:2883/test?ssl-mode=preferred&charset=utf8mb4"
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
    fn postgres_url_defaults_to_postgres_database_when_omitted() {
        let mut config = mysql_config("root", "secret", None);
        config.db_type = DatabaseType::Postgres;

        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:2883/postgres");
    }

    #[test]
    fn postgres_url_defaults_to_postgres_database_when_empty() {
        let mut config = mysql_config("root", "secret", Some(""));
        config.db_type = DatabaseType::Postgres;

        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:2883/postgres");
    }

    #[test]
    fn redshift_url_defaults_to_dev_database_when_empty() {
        let mut config = mysql_config("awsuser", "secret", Some(""));
        config.db_type = DatabaseType::Redshift;

        assert_eq!(config.connection_url(), "postgres://awsuser:secret@10.1.2.3:2883/dev");
    }

    #[test]
    fn cockroachdb_url_defaults_to_defaultdb_database() {
        let mut config = mysql_config("root", "secret", None);
        config.db_type = DatabaseType::Postgres;
        config.driver_profile = Some("cockroachdb".to_string());

        assert_eq!(config.connection_url(), "postgres://root:secret@10.1.2.3:2883/defaultdb");
    }

    #[test]
    fn gaussdb_url_defaults_to_postgres_database() {
        let mut config = mysql_config("gaussdb", "secret", None);
        config.db_type = DatabaseType::Gaussdb;

        assert_eq!(config.connection_url(), "gaussdb://gaussdb:secret@10.1.2.3:2883/postgres");
    }

    #[test]
    fn yashandb_url_defaults_to_yasdb_database() {
        let mut config = mysql_config("sys", "secret", None);
        config.db_type = DatabaseType::Yashandb;

        assert_eq!(config.connection_url(), "yashandb://sys:secret@10.1.2.3:2883/yasdb");
    }

    #[test]
    fn mongodb_form_url_without_params_does_not_force_topology_or_auth() {
        let config = mongodb_config("root", "secret", Some("admin"));

        assert_eq!(config.connection_url(), "mongodb://root:secret@10.1.2.3:17000/admin");
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

        assert_eq!(url, "mysql://10.1.2.3:2883/db%2Fname?ssl-mode=preferred&charset=utf8mb4");
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
    fn redacted_mongodb_url_keeps_custom_params_without_credentials() {
        let mut config = mongodb_config("root", "secret", Some("admin"));
        config.url_params = Some("authSource=admin&authMechanism=SCRAM-SHA-1".to_string());

        let url = config.redacted_connection_url();

        assert_eq!(url, "mongodb://10.1.2.3:17000/admin?authSource=admin&authMechanism=SCRAM-SHA-1");
        assert!(!url.contains("root"));
        assert!(!url.contains("secret"));
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
