use dbx_core::agent_catalog;
use dbx_core::database_capabilities::{
    agent_key, is_agent_type, is_metadata_connection_scoped, is_single_connection_pool, skips_tcp_probe,
};
use dbx_core::models::connection::DatabaseType;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriverManifest {
    drivers: Vec<DriverManifestEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriverManifestEntry {
    db_type: DatabaseType,
    label: String,
    runtime_mode: String,
    support_level: String,
    capabilities: DriverProductCapabilities,
    #[serde(default)]
    agent_key: Option<String>,
    #[serde(default)]
    single_connection_pool: bool,
    #[serde(default)]
    metadata_connection_scoped: bool,
    #[serde(default)]
    skip_tcp_probe: bool,
    #[serde(default)]
    driver_profiles: Vec<DriverProfileEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriverProductCapabilities {
    query_execution: bool,
    metadata_browse: bool,
    object_browser: bool,
    object_source: bool,
    schema_search: bool,
    diagram: bool,
    table_data_edit: bool,
    table_structure_edit: bool,
    table_import: bool,
    data_transfer: bool,
    sql_file_execution: bool,
    database_create: bool,
    field_lineage: bool,
    sql_explain: bool,
    user_admin: bool,
    driver_management: bool,
}

impl DriverProductCapabilities {
    fn any_enabled(&self) -> bool {
        [
            self.metadata_browse,
            self.query_execution,
            self.object_browser,
            self.object_source,
            self.schema_search,
            self.diagram,
            self.table_data_edit,
            self.table_structure_edit,
            self.table_import,
            self.data_transfer,
            self.sql_file_execution,
            self.database_create,
            self.field_lineage,
            self.sql_explain,
            self.user_admin,
            self.driver_management,
        ]
        .into_iter()
        .any(|enabled| enabled)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriverProfileEntry {
    profile: String,
    label: String,
    agent_key: String,
}

fn driver_manifest() -> DriverManifest {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets").join("database-drivers.manifest.json");
    let json = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!("failed to read driver manifest {}: {err}", path.display());
    });
    serde_json::from_str(&json).expect("driver manifest should be valid JSON")
}

#[test]
fn maps_agent_database_types_to_driver_keys() {
    assert_eq!(agent_key(&DatabaseType::Trino, None), Some("trino"));
    assert_eq!(agent_key(&DatabaseType::Hive, None), Some("hive"));
    assert_eq!(agent_key(&DatabaseType::Tdengine, None), Some("tdengine"));
    assert_eq!(agent_key(&DatabaseType::Iotdb, None), Some("iotdb"));
    assert_eq!(agent_key(&DatabaseType::Yashandb, None), Some("yashandb"));
    assert_eq!(agent_key(&DatabaseType::Databricks, None), Some("databricks"));
    assert_eq!(agent_key(&DatabaseType::SapHana, None), Some("saphana"));
    assert_eq!(agent_key(&DatabaseType::Teradata, None), Some("teradata"));
    assert_eq!(agent_key(&DatabaseType::Vertica, None), Some("vertica"));
    assert_eq!(agent_key(&DatabaseType::Firebird, None), Some("firebird"));
    assert_eq!(agent_key(&DatabaseType::Exasol, None), Some("exasol"));
    assert_eq!(agent_key(&DatabaseType::OceanbaseOracle, None), Some("oceanbase-oracle"));
    assert_eq!(agent_key(&DatabaseType::Gbase, None), Some("gbase"));
    assert_eq!(agent_key(&DatabaseType::Access, None), Some("access"));
    assert_eq!(agent_key(&DatabaseType::Oracle, None), Some("oracle"));
    assert_eq!(agent_key(&DatabaseType::Databend, None), Some("databend"));
    assert_eq!(agent_key(&DatabaseType::InfluxDb, None), Some("influxdb"));
    assert_eq!(agent_key(&DatabaseType::Oracle, Some("oracle-legacy")), Some("oracle-legacy"));
    assert_eq!(agent_key(&DatabaseType::Oracle, Some("oracle-10g")), Some("oracle-10g"));
    assert_eq!(agent_key(&DatabaseType::Postgres, None), None);
}

#[test]
fn classifies_agent_database_types() {
    assert!(is_agent_type(&DatabaseType::Oracle));
    assert!(is_agent_type(&DatabaseType::Trino));
    assert!(is_agent_type(&DatabaseType::Hive));
    assert!(is_agent_type(&DatabaseType::Tdengine));
    assert!(is_agent_type(&DatabaseType::Iotdb));
    assert!(is_agent_type(&DatabaseType::Yashandb));
    assert!(is_agent_type(&DatabaseType::Databricks));
    assert!(is_agent_type(&DatabaseType::SapHana));
    assert!(is_agent_type(&DatabaseType::Teradata));
    assert!(is_agent_type(&DatabaseType::Vertica));
    assert!(is_agent_type(&DatabaseType::Firebird));
    assert!(is_agent_type(&DatabaseType::Exasol));
    assert!(is_agent_type(&DatabaseType::OceanbaseOracle));
    assert!(is_agent_type(&DatabaseType::Gbase));
    assert!(is_agent_type(&DatabaseType::Access));
    assert!(is_agent_type(&DatabaseType::Databend));
    assert!(is_agent_type(&DatabaseType::InfluxDb));
    assert!(!is_agent_type(&DatabaseType::Mysql));
    assert!(!is_agent_type(&DatabaseType::Jdbc));
    assert!(!is_agent_type(&DatabaseType::Gaussdb));
    assert!(!is_agent_type(&DatabaseType::Kwdb));
    assert!(!is_agent_type(&DatabaseType::OpenGauss));
}

#[test]
fn identifies_single_connection_pool_types() {
    assert!(is_single_connection_pool(&DatabaseType::Sqlite));
    assert!(is_single_connection_pool(&DatabaseType::DuckDb));
    assert!(is_single_connection_pool(&DatabaseType::MongoDb));
    assert!(is_single_connection_pool(&DatabaseType::Oracle));
    assert!(is_single_connection_pool(&DatabaseType::Dameng));
    assert!(is_single_connection_pool(&DatabaseType::Access));
    assert!(is_single_connection_pool(&DatabaseType::Yashandb));
    assert!(is_single_connection_pool(&DatabaseType::Firebird));
    assert!(is_single_connection_pool(&DatabaseType::OceanbaseOracle));
    assert!(is_single_connection_pool(&DatabaseType::Jdbc));
    assert!(!is_single_connection_pool(&DatabaseType::Trino));
    assert!(!is_single_connection_pool(&DatabaseType::Postgres));
    assert!(!is_single_connection_pool(&DatabaseType::Kwdb));
}

#[test]
fn identifies_metadata_connections_that_drop_database_scope() {
    assert!(is_metadata_connection_scoped(&DatabaseType::Mysql));
    assert!(!is_metadata_connection_scoped(&DatabaseType::Doris));
    assert!(!is_metadata_connection_scoped(&DatabaseType::StarRocks));
    assert!(!is_metadata_connection_scoped(&DatabaseType::Postgres));
    assert!(!is_metadata_connection_scoped(&DatabaseType::Kwdb));
    assert!(!is_metadata_connection_scoped(&DatabaseType::Oracle));
}

#[test]
fn skips_tcp_probe_for_local_file_plugin_and_agent_types() {
    assert!(skips_tcp_probe(&DatabaseType::Sqlite));
    assert!(skips_tcp_probe(&DatabaseType::DuckDb));
    assert!(skips_tcp_probe(&DatabaseType::Jdbc));
    assert!(skips_tcp_probe(&DatabaseType::Access));
    assert!(skips_tcp_probe(&DatabaseType::H2));
    assert!(skips_tcp_probe(&DatabaseType::Trino));
    assert!(skips_tcp_probe(&DatabaseType::Oracle));
    assert!(skips_tcp_probe(&DatabaseType::Tdengine));
    assert!(skips_tcp_probe(&DatabaseType::Iotdb));
    assert!(skips_tcp_probe(&DatabaseType::Yashandb));
    assert!(skips_tcp_probe(&DatabaseType::Databricks));
    assert!(skips_tcp_probe(&DatabaseType::OceanbaseOracle));
    assert!(skips_tcp_probe(&DatabaseType::Gbase));
    assert!(skips_tcp_probe(&DatabaseType::Databend));
    assert!(skips_tcp_probe(&DatabaseType::InfluxDb));
    assert!(!skips_tcp_probe(&DatabaseType::Postgres));
    assert!(!skips_tcp_probe(&DatabaseType::Mysql));
    assert!(!skips_tcp_probe(&DatabaseType::Gaussdb));
    assert!(!skips_tcp_probe(&DatabaseType::Kwdb));
    assert!(!skips_tcp_probe(&DatabaseType::OpenGauss));
}

#[test]
fn driver_manifest_matches_core_database_capabilities() {
    let manifest = driver_manifest();
    let support_levels = ["connect", "browse", "understand", "operate"];

    for driver in &manifest.drivers {
        assert!(
            support_levels.contains(&driver.support_level.as_str()),
            "invalid support level for {:?}",
            driver.db_type
        );
        assert!(
            driver.capabilities.any_enabled(),
            "database {:?} should declare at least one product capability",
            driver.db_type
        );
        assert_eq!(
            is_agent_type(&driver.db_type),
            driver.runtime_mode == "agent",
            "agent classification mismatch for {:?}",
            driver.db_type
        );
        assert_eq!(
            agent_key(&driver.db_type, None),
            driver.agent_key.as_deref(),
            "agent key mismatch for {:?}",
            driver.db_type
        );
        assert_eq!(
            is_single_connection_pool(&driver.db_type),
            driver.single_connection_pool,
            "single-pool mismatch for {:?}",
            driver.db_type
        );
        assert_eq!(
            is_metadata_connection_scoped(&driver.db_type),
            driver.metadata_connection_scoped,
            "metadata scope mismatch for {:?}",
            driver.db_type
        );
        assert_eq!(
            skips_tcp_probe(&driver.db_type),
            driver.skip_tcp_probe,
            "TCP probe behavior mismatch for {:?}",
            driver.db_type
        );

        for profile in &driver.driver_profiles {
            assert_eq!(
                agent_key(&driver.db_type, Some(&profile.profile)),
                Some(profile.agent_key.as_str()),
                "profile agent key mismatch for {:?}/{}",
                driver.db_type,
                profile.profile
            );
        }
    }
}

#[test]
fn driver_manifest_declares_expected_product_capabilities() {
    let manifest = driver_manifest();
    let find_driver = |db_type: DatabaseType| {
        manifest
            .drivers
            .iter()
            .find(|driver| driver.db_type == db_type)
            .unwrap_or_else(|| panic!("{db_type:?} manifest entry"))
    };

    let mysql = find_driver(DatabaseType::Mysql);
    assert_eq!(mysql.support_level, "operate");
    assert!(mysql.capabilities.schema_search);
    assert!(mysql.capabilities.table_structure_edit);
    assert!(mysql.capabilities.sql_explain);
    assert!(!mysql.capabilities.driver_management);

    let jdbc = find_driver(DatabaseType::Jdbc);
    assert_eq!(jdbc.support_level, "browse");
    assert!(jdbc.capabilities.metadata_browse);
    assert!(jdbc.capabilities.object_browser);
    assert!(jdbc.capabilities.sql_file_execution);
    assert!(!jdbc.capabilities.table_structure_edit);
    assert!(!jdbc.capabilities.user_admin);

    let redis = find_driver(DatabaseType::Redis);
    assert_eq!(redis.support_level, "connect");
    assert!(!redis.capabilities.object_browser);
    assert!(!redis.capabilities.sql_file_execution);
}

#[test]
fn driver_manifest_matches_agent_driver_store_entries() {
    let manifest = driver_manifest();
    let mut expected: std::collections::BTreeMap<&str, &str> = std::collections::BTreeMap::new();
    for driver in manifest.drivers.iter().filter(|driver| driver.runtime_mode == "agent") {
        expected.insert(
            driver.agent_key.as_deref().expect("agent drivers should have an agent key"),
            driver.label.as_str(),
        );
        for profile in &driver.driver_profiles {
            expected.insert(profile.agent_key.as_str(), profile.label.as_str());
        }
    }
    let actual: std::collections::BTreeMap<&str, &str> = agent_catalog::driver_store_entries().collect();

    assert_eq!(actual, expected);
}
