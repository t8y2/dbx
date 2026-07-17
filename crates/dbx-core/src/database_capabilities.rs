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
            | DatabaseType::CloudflareD1
            | DatabaseType::MongoDb
            | DatabaseType::Oracle
            | DatabaseType::Dameng
            | DatabaseType::Kingbase
            | DatabaseType::Highgo
            | DatabaseType::Vastbase
            | DatabaseType::Goldendb
            | DatabaseType::Yashandb
            | DatabaseType::Oscar
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
    matches!(
        db_type,
        DatabaseType::Sqlite
            | DatabaseType::DuckDb
            | DatabaseType::Turso
            | DatabaseType::CloudflareD1
            | DatabaseType::Jdbc
            | DatabaseType::MessageQueue
    ) || is_agent_type(db_type)
}

/// Database types whose connection backs onto a single local file (or may, in the
/// case of H2 file mode). Used to decide whether to expose a "reveal in file
/// manager" affordance. Whether the H2 connection is actually in file mode must
/// be determined separately by parsing the JDBC URL.
pub fn is_local_file_db_type(db_type: &DatabaseType) -> bool {
    matches!(db_type, DatabaseType::Sqlite | DatabaseType::DuckDb | DatabaseType::Access | DatabaseType::H2)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_file_db_types_match_expected_set() {
        assert!(is_local_file_db_type(&DatabaseType::Sqlite));
        assert!(is_local_file_db_type(&DatabaseType::DuckDb));
        assert!(is_local_file_db_type(&DatabaseType::Access));
        assert!(is_local_file_db_type(&DatabaseType::H2));
    }

    #[test]
    fn non_local_file_db_types_rejected() {
        assert!(!is_local_file_db_type(&DatabaseType::Mysql));
        assert!(!is_local_file_db_type(&DatabaseType::Postgres));
        assert!(!is_local_file_db_type(&DatabaseType::Redis));
        assert!(!is_local_file_db_type(&DatabaseType::MongoDb));
        assert!(!is_local_file_db_type(&DatabaseType::Turso));
        assert!(!is_local_file_db_type(&DatabaseType::CloudflareD1));
        assert!(!is_local_file_db_type(&DatabaseType::Rqlite));
    }

    #[test]
    fn cloudflare_d1_uses_a_single_http_pool_without_tcp_probe() {
        assert!(is_single_connection_pool(&DatabaseType::CloudflareD1));
        assert!(skips_tcp_probe(&DatabaseType::CloudflareD1));
    }
}
