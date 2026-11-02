use crate::agent_catalog;
use crate::database_manifest;
use crate::models::connection::DatabaseType;

pub fn agent_key(db_type: &DatabaseType, driver_profile: Option<&str>) -> Option<&'static str> {
    agent_catalog::agent_key(db_type, driver_profile)
}

pub fn is_agent_type(db_type: &DatabaseType) -> bool {
    database_manifest::is_agent_runtime(db_type)
}

pub fn is_single_connection_pool(db_type: &DatabaseType) -> bool {
    database_manifest::entry(db_type).is_some_and(|entry| entry.single_connection_pool)
}

pub fn is_metadata_connection_scoped(db_type: &DatabaseType) -> bool {
    database_manifest::entry(db_type).is_some_and(|entry| entry.metadata_connection_scoped)
}

pub fn skips_tcp_probe(db_type: &DatabaseType) -> bool {
    database_manifest::entry(db_type).is_some_and(|entry| entry.skip_tcp_probe) || is_agent_type(db_type)
}

/// Database types whose connection backs onto a single local file (or may, in the
/// case of H2 file mode). Used to decide whether to expose a "reveal in file
/// manager" affordance. Whether the H2 connection is actually in file mode must
/// be determined separately by parsing the JDBC URL.
pub fn is_local_file_db_type(db_type: &DatabaseType) -> bool {
    database_manifest::entry(db_type).is_some_and(|entry| entry.local_file)
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

    #[test]
    fn manifest_connection_capabilities_are_used_for_every_registered_driver() {
        for entry in database_manifest::entries() {
            assert_eq!(
                is_single_connection_pool(&entry.db_type),
                entry.single_connection_pool,
                "single connection pool drift for {:?}",
                entry.db_type
            );
            assert_eq!(
                is_metadata_connection_scoped(&entry.db_type),
                entry.metadata_connection_scoped,
                "metadata scope drift for {:?}",
                entry.db_type
            );
            assert!(
                skips_tcp_probe(&entry.db_type) || !is_agent_type(&entry.db_type),
                "agent driver {:?} must skip the TCP probe",
                entry.db_type
            );
        }
    }
}
