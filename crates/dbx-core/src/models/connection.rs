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
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub sysdba: bool,
    #[serde(default)]
    pub connection_string: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    Gaussdb,
}

impl ConnectionConfig {
    pub fn needs_bare_mysql(&self) -> bool {
        matches!(self.db_type, DatabaseType::Doris | DatabaseType::StarRocks)
            || self
                .driver_profile
                .as_deref()
                .map(|p| p.to_lowercase())
                .is_some_and(|p| matches!(p.as_str(), "doris" | "starrocks" | "selectdb" | "tdengine"))
    }

    pub fn connection_url(&self) -> String {
        self.connection_url_with_host(&self.host, self.port)
    }

    pub fn redacted_connection_url(&self) -> String {
        self.redacted_connection_url_with_host(&self.host, self.port)
    }

    pub fn redacted_connection_url_with_host(&self, host: &str, port: u16) -> String {
        let host = bracket_ipv6(host);
        let db_part = self
            .database
            .as_deref()
            .filter(|d| !d.is_empty())
            .map(|d| format!("/{}", encode_url_part(d)))
            .unwrap_or_default();
        let params = self.normalized_url_params();

        match self.db_type {
            DatabaseType::Sqlite | DatabaseType::DuckDb => {
                format!("{}?mode=rwc", self.host)
            }
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
            DatabaseType::Elasticsearch => format!("http://{host}:{port}"),
            DatabaseType::Dameng => format!("dm://{host}:{port}{db_part}"),
            DatabaseType::Gaussdb => format!("gaussdb://{host}:{port}{db_part}"),
        }
    }

    pub fn connection_url_with_host(&self, host: &str, port: u16) -> String {
        let host = bracket_ipv6(host);
        let db_part = self
            .database
            .as_deref()
            .filter(|d| !d.is_empty())
            .map(|d| format!("/{}", encode_url_part(d)))
            .unwrap_or_default();
        let username = encode_url_part(&self.username);
        let password = encode_url_part(&self.password);
        let params = self.normalized_url_params();

        match self.db_type {
            DatabaseType::Sqlite | DatabaseType::DuckDb => {
                format!("{}?mode=rwc", self.host)
            }
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
            DatabaseType::Elasticsearch => format!("http://{host}:{port}"),
            DatabaseType::Dameng => {
                format!("dm://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Gaussdb => {
                format!("gaussdb://{}:{}@{host}:{port}{db_part}", username, password)
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
    use super::{ConnectionConfig, DatabaseType};

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
            color: None,
            ssh_enabled: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_password: String::new(),
            ssh_key_path: String::new(),
            ssh_key_passphrase: String::new(),
            ssh_expose_lan: false,
            ssl: false,
            sysdba: false,
            connection_string: None,
        }
    }

    fn mongodb_config(username: &str, password: &str, database: Option<&str>) -> ConnectionConfig {
        let mut config = mysql_config(username, password, database);
        config.db_type = DatabaseType::MongoDb;
        config.port = 17000;
        config
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
}
