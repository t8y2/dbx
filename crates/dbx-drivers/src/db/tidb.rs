use crate::models::connection::{ConnectionConfig, DatabaseType};

pub const DRIVER_PROFILE: &str = "tidb";

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
}

pub fn is_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::Mysql
        && driver_profile.is_some_and(|profile| profile.eq_ignore_ascii_case(DRIVER_PROFILE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_is_isolated_from_standard_mysql() {
        assert!(is_profile(&DatabaseType::Mysql, Some("TiDB")));
        assert!(!is_profile(&DatabaseType::Mysql, None));
        assert!(!is_profile(&DatabaseType::Postgres, Some("tidb")));
    }
}
