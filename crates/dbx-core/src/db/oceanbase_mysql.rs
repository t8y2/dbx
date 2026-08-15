use crate::models::connection::{ConnectionConfig, DatabaseType};

pub const DRIVER_PROFILE: &str = "oceanbase";

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
}

pub fn is_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::Mysql
        && driver_profile.is_some_and(|profile| profile.eq_ignore_ascii_case(DRIVER_PROFILE))
}

pub fn query_timeout_sql(config: &ConnectionConfig, timeout_secs: u64) -> Option<String> {
    if !is_config(config) || timeout_secs == 0 {
        return None;
    }
    Some(format!("SET ob_query_timeout = {}", timeout_secs.saturating_mul(1_000_000)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_is_isolated_from_oracle_mode_and_standard_mysql() {
        assert!(is_profile(&DatabaseType::Mysql, Some("OceanBase")));
        assert!(!is_profile(&DatabaseType::Mysql, None));
        assert!(!is_profile(&DatabaseType::OceanbaseOracle, Some("oceanbase")));
    }

    #[test]
    fn query_timeout_uses_microseconds_and_saturates() {
        let mut config = test_config();
        assert_eq!(query_timeout_sql(&config, 30), Some("SET ob_query_timeout = 30000000".to_string()));
        assert_eq!(query_timeout_sql(&config, u64::MAX), Some(format!("SET ob_query_timeout = {}", u64::MAX)));

        config.driver_profile = None;
        assert_eq!(query_timeout_sql(&config, 30), None);
    }

    fn test_config() -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": "oceanbase",
            "name": "OceanBase",
            "db_type": "mysql",
            "driver_profile": "oceanbase",
            "host": "127.0.0.1",
            "port": 2883,
            "username": "root",
            "password": "",
            "database": "test"
        }))
        .unwrap()
    }
}
