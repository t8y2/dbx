use crate::agent_catalog;
use crate::models::connection::DatabaseType;

pub fn agent_key(db_type: &DatabaseType, driver_profile: Option<&str>) -> Option<&'static str> {
    agent_catalog::agent_key(db_type, driver_profile)
}

pub fn is_agent_type(db_type: &DatabaseType) -> bool {
    agent_catalog::is_agent_type(db_type)
}

pub fn is_single_connection_pool(db_type: &DatabaseType) -> bool {
    matches!(
        db_type,
        DatabaseType::Sqlite
            | DatabaseType::DuckDb
            | DatabaseType::Rqlite
            | DatabaseType::Turso
            | DatabaseType::MongoDb
            | DatabaseType::Oracle
            | DatabaseType::Dameng
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
            | DatabaseType::Goldendb
            | DatabaseType::Yashandb
            | DatabaseType::Firebird
            | DatabaseType::Iris
            | DatabaseType::OceanbaseOracle
            | DatabaseType::Access
            | DatabaseType::Jdbc
    )
}

pub fn is_metadata_connection_scoped(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Mysql)
}

pub fn skips_tcp_probe(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Sqlite | DatabaseType::DuckDb | DatabaseType::Turso | DatabaseType::Jdbc)
        || is_agent_type(db_type)
}
