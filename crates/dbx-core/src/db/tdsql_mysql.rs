use crate::models::connection::{ConnectionConfig, DatabaseType};

pub const DRIVER_PROFILE: &str = "tdsql";

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
}

pub fn is_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::Mysql
        && driver_profile.is_some_and(|profile| profile.eq_ignore_ascii_case(DRIVER_PROFILE))
}

pub(crate) fn preserves_proxy_directive_for_database_type(db_type: DatabaseType) -> bool {
    db_type == DatabaseType::Mysql
}

pub(crate) fn proxy_directive_start(statement: &str, executable_start: usize) -> Option<usize> {
    let prefix = statement.get(..executable_start)?.trim_end();
    prefix.strip_suffix("/*proxy*/").map(|before| before.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_is_isolated_from_standard_mysql() {
        assert!(is_profile(&DatabaseType::Mysql, Some("TDSQL")));
        assert!(!is_profile(&DatabaseType::Mysql, None));
        assert!(!is_profile(&DatabaseType::Postgres, Some("tdsql")));
    }

    #[test]
    fn proxy_directive_is_available_only_to_mysql_parsing() {
        assert!(preserves_proxy_directive_for_database_type(DatabaseType::Mysql));
        assert!(!preserves_proxy_directive_for_database_type(DatabaseType::Postgres));
    }

    #[test]
    fn proxy_directive_must_be_exact_and_adjacent_to_executable_sql() {
        let exact = "/*proxy*/ \n\tSHOW PROXY STATUS";
        let executable_start = exact.find("SHOW").unwrap();
        assert_eq!(proxy_directive_start(exact, executable_start), Some(0));

        let ordinary = "/* proxy */\nSHOW PROXY STATUS";
        let executable_start = ordinary.find("SHOW").unwrap();
        assert_eq!(proxy_directive_start(ordinary, executable_start), None);

        let separated = "/*proxy*/\n/* audit */\nSHOW PROXY STATUS";
        let executable_start = separated.find("SHOW").unwrap();
        assert_eq!(proxy_directive_start(separated, executable_start), None);
    }
}
