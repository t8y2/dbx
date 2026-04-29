use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub database: Option<String>,
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
}

fn default_ssh_port() -> u16 { 22 }

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
}

impl ConnectionConfig {
    pub fn connection_url(&self) -> String {
        self.connection_url_with_host(&self.host, self.port)
    }

    pub fn connection_url_with_host(&self, host: &str, port: u16) -> String {
        let db_part = self.database.as_deref().map(|d| format!("/{d}")).unwrap_or_default();

        match self.db_type {
            DatabaseType::Sqlite | DatabaseType::DuckDb => {
                format!("{}?mode=rwc", self.host)
            }
            DatabaseType::Redis => {
                if self.password.is_empty() {
                    format!("redis://{host}:{port}/")
                } else {
                    format!("redis://:{}@{host}:{port}/", self.password)
                }
            }
            DatabaseType::Mysql => format!(
                "mysql://{}:{}@{host}:{port}{db_part}",
                self.username, self.password
            ),
            DatabaseType::Postgres => format!(
                "postgres://{}:{}@{host}:{port}{db_part}",
                self.username, self.password
            ),
            DatabaseType::ClickHouse => format!(
                "http://{host}:{port}{db_part}"
            ),
            DatabaseType::SqlServer => format!(
                "server=tcp:{host},{port};user={};password={};database={}",
                self.username, self.password, self.database.as_deref().unwrap_or("master")
            ),
            DatabaseType::MongoDb => {
                if self.username.is_empty() {
                    format!("mongodb://{host}:{port}{db_part}")
                } else {
                    format!("mongodb://{}:{}@{host}:{port}{db_part}", self.username, self.password)
                }
            }
        }
    }
}
