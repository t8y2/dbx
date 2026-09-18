use crate::models::connection::{ConnectionConfig, DatabaseType};

pub use super::mysql_compatible::{
    get_columns_show_from as get_catalog_columns, list_catalog_indexes, list_catalogs,
    list_databases_show_from as list_catalog_databases, list_indexes_with_ddl_fallback as list_indexes,
    list_tables_show_from as list_catalog_tables, show_create_table_ddl_from as get_catalog_table_ddl,
};

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
}

pub fn is_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::Doris
        || (*db_type == DatabaseType::Mysql
            && driver_profile
                .is_some_and(|profile| matches!(profile.to_ascii_lowercase().as_str(), "doris" | "selectdb")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_matches_doris_and_selectdb_only() {
        assert!(is_profile(&DatabaseType::Doris, None));
        assert!(is_profile(&DatabaseType::Mysql, Some("DORIS")));
        assert!(is_profile(&DatabaseType::Mysql, Some("selectdb")));
        assert!(!is_profile(&DatabaseType::Mysql, Some("starrocks")));
        assert!(!is_profile(&DatabaseType::Postgres, Some("doris")));
    }
}
