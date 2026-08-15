use crate::models::connection::{ConnectionConfig, DatabaseType};

pub const DRIVER_PROFILE: &str = "tdsql";

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
}

pub fn is_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::Mysql
        && driver_profile.is_some_and(|profile| profile.eq_ignore_ascii_case(DRIVER_PROFILE))
}

pub(crate) fn preserves_leading_directives_for_database_type(db_type: DatabaseType) -> bool {
    db_type == DatabaseType::Mysql
}

pub(crate) fn leading_directive_start(statement: &str, executable_start: usize) -> Option<usize> {
    let prefix = statement.get(..executable_start)?;
    let line_start = prefix.rfind(['\r', '\n']).map_or(0, |index| index + 1);
    let line_prefix = &prefix[line_start..];
    let trimmed_line_start = line_prefix.trim_start();
    if trimmed_line_start.starts_with("/*") && trimmed_line_start.trim_end().ends_with("*/") {
        return Some(line_start + line_prefix.len() - trimmed_line_start.len());
    }

    let trimmed_prefix = prefix.trim_end();
    trimmed_prefix.strip_suffix("/*proxy*/").map(|before| before.len())
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
    fn leading_directives_are_available_only_to_mysql_parsing() {
        assert!(preserves_leading_directives_for_database_type(DatabaseType::Mysql));
        assert!(!preserves_leading_directives_for_database_type(DatabaseType::Postgres));
    }

    #[test]
    fn leading_directives_preserve_same_line_and_exact_proxy_behavior() {
        let exact = "/*proxy*/ \n\tSHOW PROXY STATUS";
        let executable_start = exact.find("SHOW").unwrap();
        assert_eq!(leading_directive_start(exact, executable_start), Some(0));

        let same_line = "  /*sets:allsets */ SELECT 1";
        let executable_start = same_line.find("SELECT").unwrap();
        assert_eq!(leading_directive_start(same_line, executable_start), Some(2));

        let separate_line = "/*sets:allsets */\nSELECT 1";
        let executable_start = separate_line.find("SELECT").unwrap();
        assert_eq!(leading_directive_start(separate_line, executable_start), None);

        let separated = "/*proxy*/\n/* audit */\nSHOW PROXY STATUS";
        let executable_start = separated.find("SHOW").unwrap();
        assert_eq!(leading_directive_start(separated, executable_start), None);
    }
}
