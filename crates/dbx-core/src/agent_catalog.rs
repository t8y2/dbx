use std::collections::HashSet;

use crate::database_manifest;
use crate::models::connection::DatabaseType;

pub fn agent_key(db_type: &DatabaseType, driver_profile: Option<&str>) -> Option<&'static str> {
    let entry = database_manifest::entry(db_type)?;
    if let Some(driver_profile) = driver_profile {
        if let Some(profile) =
            entry.driver_profiles.iter().find(|profile| profile.profile.eq_ignore_ascii_case(driver_profile))
        {
            return Some(profile.agent_key.as_str());
        }
    }
    entry.agent_key.as_deref()
}

pub fn is_agent_type(db_type: &DatabaseType) -> bool {
    database_manifest::is_agent_runtime(db_type)
}

pub fn driver_store_entries() -> impl Iterator<Item = (&'static str, &'static str)> {
    let mut entries = database_manifest::entries()
        .iter()
        .flat_map(|entry| {
            let base = entry.driver_store_visible.then(|| {
                entry
                    .agent_key
                    .as_deref()
                    .map(|key| (entry.driver_store_order.unwrap_or(u32::MAX), key, entry.label.as_str()))
            });
            let profiles = entry.driver_profiles.iter().filter(|profile| profile.store_visible).map(|profile| {
                (
                    profile.store_order.unwrap_or(u32::MAX),
                    profile.package_key.as_deref().unwrap_or(profile.agent_key.as_str()),
                    profile.label.as_str(),
                )
            });
            let managed = entry
                .managed_drivers
                .iter()
                .filter(|driver| driver.store_visible)
                .map(|driver| (driver.store_order.unwrap_or(u32::MAX), driver.key.as_str(), driver.label.as_str()));
            base.flatten().into_iter().chain(profiles).chain(managed)
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|(order, _, _)| *order);

    let mut seen = HashSet::new();
    entries.into_iter().filter(move |(_, key, _)| seen.insert(*key)).map(|(_, key, label)| (key, label))
}

pub fn label_for_key(agent_key: &str) -> Option<&'static str> {
    for entry in database_manifest::entries() {
        if entry.agent_key.as_deref() == Some(agent_key) {
            return Some(entry.label.as_str());
        }
        if let Some(profile) = entry
            .driver_profiles
            .iter()
            .find(|profile| profile.package_key.as_deref() == Some(agent_key) || profile.agent_key == agent_key)
        {
            return Some(profile.label.as_str());
        }
        if let Some(driver) = entry.managed_drivers.iter().find(|driver| driver.key == agent_key) {
            return Some(driver.label.as_str());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn h2_profiles_share_the_same_agent() {
        assert_eq!(agent_key(&DatabaseType::H2, None), Some("h2"));
        assert_eq!(agent_key(&DatabaseType::H2, Some("h2")), Some("h2"));
        assert_eq!(agent_key(&DatabaseType::H2, Some("h2-legacy")), Some("h2"));
        assert_eq!(agent_key(&DatabaseType::H2, Some("h2-v1")), Some("h2"));
        assert_eq!(agent_key(&DatabaseType::H2, Some("h2-v2")), Some("h2"));
        assert_eq!(agent_key(&DatabaseType::H2, Some("h2-v3")), Some("h2"));
        assert_eq!(agent_key(&DatabaseType::H2, Some("h2-custom")), Some("h2"));
        assert_eq!(label_for_key("h2-legacy"), Some("H2 2.1 Legacy"));
        assert!(!driver_store_entries().any(|(key, _)| key == "h2-legacy"));
    }

    #[test]
    fn duckdb_is_available_in_driver_store_without_using_agent_runtime() {
        assert!(driver_store_entries().any(|(key, label)| key == "duckdb" && label == "DuckDB"));
        assert_eq!(label_for_key("duckdb"), Some("DuckDB"));
        assert!(!is_agent_type(&DatabaseType::DuckDb));
    }

    #[test]
    fn sqlite_ssh_worker_is_available_in_driver_store_without_using_agent_runtime() {
        assert!(driver_store_entries().any(|(key, label)| key == "sqlite-worker" && label == "SQLite SSH Worker"));
        assert_eq!(label_for_key("sqlite-worker"), Some("SQLite SSH Worker"));
        assert!(!is_agent_type(&DatabaseType::Sqlite));
    }

    #[test]
    fn impala_reuses_hive_agent_without_duplicate_store_entry() {
        assert_eq!(agent_key(&DatabaseType::Impala, None), Some("hive"));
        assert_eq!(driver_store_entries().filter(|(key, _)| *key == "hive").count(), 1);
    }

    #[test]
    fn kyuubi_reuses_hive_agent_without_duplicate_store_entry() {
        assert_eq!(agent_key(&DatabaseType::Kyuubi, None), Some("hive"));
        assert_eq!(driver_store_entries().filter(|(key, _)| *key == "hive").count(), 1);
    }

    #[test]
    fn manifest_agent_keys_match_catalog_defaults() {
        for entry in database_manifest::entries().iter().filter(|entry| entry.agent_key.is_some()) {
            assert_eq!(
                agent_key(&entry.db_type, None),
                entry.agent_key.as_deref(),
                "agent key drift for {:?}",
                entry.db_type
            );
        }
    }
}
