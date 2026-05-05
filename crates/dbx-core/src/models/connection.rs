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
}

impl ConnectionConfig {
    pub fn needs_bare_mysql(&self) -> bool {
        matches!(self.db_type, DatabaseType::Doris | DatabaseType::StarRocks)
            || self.driver_profile.as_deref().map(|p| p.to_lowercase())
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
            DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks => format!("mysql://{host}:{port}{db_part}?{params}"),
            DatabaseType::Postgres | DatabaseType::Redshift => {
                let suffix = if params.is_empty() {
                    String::new()
                } else {
                    format!("?{params}")
                };
                format!("postgres://{host}:{port}{db_part}{suffix}")
            }
            DatabaseType::ClickHouse => format!("http://{host}:{port}"),
            DatabaseType::SqlServer => format!(
                "server=tcp:{host},{port};database={}",
                self.database.as_deref().unwrap_or("master")
            ),
            DatabaseType::MongoDb => {
                if let Some(cs) = self.connection_string.as_deref().filter(|s| !s.is_empty()) {
                    return cs.to_string();
                }
                format!("mongodb://{host}:{port}{db_part}")
            }
            DatabaseType::Oracle => format!("oracle://{host}:{port}{db_part}"),
            DatabaseType::Elasticsearch => format!("http://{host}:{port}"),
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
            DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks => format!(
                "mysql://{}:{}@{host}:{port}{db_part}?{params}",
                username, password
            ),
            DatabaseType::Postgres | DatabaseType::Redshift => {
                let suffix = if params.is_empty() {
                    String::new()
                } else {
                    format!("?{params}")
                };
                format!(
                    "postgres://{}:{}@{host}:{port}{db_part}{suffix}",
                    username, password
                )
            }
            DatabaseType::ClickHouse => format!("http://{host}:{port}"),
            DatabaseType::SqlServer => format!(
                "server=tcp:{host},{port};user={};password={};database={}",
                self.username,
                self.password,
                self.database.as_deref().unwrap_or("master")
            ),
            DatabaseType::MongoDb => {
                if let Some(cs) = self.connection_string.as_deref().filter(|s| !s.is_empty()) {
                    return cs.to_string();
                }
                if self.username.is_empty() {
                    format!("mongodb://{host}:{port}{db_part}")
                } else {
                    format!("mongodb://{username}:{password}@{host}:{port}{db_part}")
                }
            }
            DatabaseType::Oracle => {
                format!("oracle://{}:{}@{host}:{port}{db_part}", username, password)
            }
            DatabaseType::Elasticsearch => format!("http://{host}:{port}"),
        }
    }

    fn normalized_url_params(&self) -> String {
        let value = self.url_params.as_deref().unwrap_or("").trim();
        if self.needs_bare_mysql() {
            let v = value.trim_start_matches('?');
            let filtered: Vec<&str> = v.split('&')
                .filter(|p| !p.is_empty() && !p.starts_with("charset=") && !p.starts_with("ssl-mode=preferred"))
                .collect();
            return if filtered.is_empty() { "ssl-mode=disabled".to_string() } else { format!("ssl-mode=disabled&{}", filtered.join("&")) };
        }
        match self.db_type {
            DatabaseType::Mysql => {
                let base = "ssl-mode=preferred&charset=utf8mb4";
                if value.is_empty() {
                    base.to_string()
                } else if value.contains("ssl-mode=") {
                    let v = value.trim_start_matches('?');
                    if v.contains("charset=") { v.to_string() } else { format!("{v}&charset=utf8mb4") }
                } else {
                    let v = value.trim_start_matches('?');
                    if v.contains("charset=") { format!("ssl-mode=preferred&{v}") } else { format!("{base}&{v}") }
                }
            }
            DatabaseType::Doris | DatabaseType::StarRocks => {
                let v = value.trim_start_matches('?');
                let filtered: Vec<&str> = v.split('&')
                    .filter(|p| !p.is_empty() && !p.starts_with("charset=") && !p.starts_with("ssl-mode=preferred"))
                    .collect();
                if filtered.is_empty() { "ssl-mode=disabled".to_string() } else { format!("ssl-mode=disabled&{}", filtered.join("&")) }
            }
            DatabaseType::Postgres | DatabaseType::Redshift => value.trim_start_matches('?').to_string(),
            _ => value.trim_start_matches('?').to_string(),
        }
    }
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
            connection_string: None,
        }
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

        assert_eq!(
            config.connection_url(),
            "postgres://postgres:secret@10.1.2.3:2883/test?sslmode=disable"
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
}
