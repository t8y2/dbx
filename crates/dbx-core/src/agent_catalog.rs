use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AgentCatalogEntry {
    pub db_type: DatabaseType,
    pub key: &'static str,
    pub label: &'static str,
    pub store_visible: bool,
    pub profiles: &'static [AgentDriverProfile],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentDriverProfile {
    pub profile: &'static str,
    pub key: &'static str,
    pub label: &'static str,
    pub store_visible: bool,
}

const ORACLE_PROFILES: &[AgentDriverProfile] = &[
    AgentDriverProfile { profile: "oracle-legacy", key: "oracle", label: "Oracle", store_visible: false },
    AgentDriverProfile { profile: "oracle-10g", key: "oracle", label: "Oracle", store_visible: false },
];

const GBASE_PROFILES: &[AgentDriverProfile] = &[
    AgentDriverProfile { profile: "gbase8s", key: "gbase8s", label: "GBase 8s", store_visible: true },
    AgentDriverProfile { profile: "gbase8a", key: "gbase8a", label: "GBase 8a", store_visible: true },
];

const MONGODB_PROFILES: &[AgentDriverProfile] = &[AgentDriverProfile {
    profile: "mongodb-legacy",
    key: "mongodb",
    label: "MongoDB (Legacy)",
    store_visible: false,
}];

const AGENT_CATALOG: &[AgentCatalogEntry] = &[
    AgentCatalogEntry {
        db_type: DatabaseType::Dameng,
        key: "dameng",
        label: "达梦 DM8",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Kingbase,
        key: "kingbase",
        label: "人大金仓 KingbaseES",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Highgo,
        key: "highgo",
        label: "瀚高 HighGo",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Vastbase,
        key: "vastbase",
        label: "Vastbase",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Goldendb,
        key: "goldendb",
        label: "GoldenDB",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Databend,
        key: "databend",
        label: "Databend",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Databricks,
        key: "databricks",
        label: "Databricks SQL",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::SapHana,
        key: "saphana",
        label: "SAP HANA",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Teradata,
        key: "teradata",
        label: "Teradata",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Vertica,
        key: "vertica",
        label: "Vertica",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Firebird,
        key: "firebird",
        label: "Firebird",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Exasol,
        key: "exasol",
        label: "Exasol",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::OceanbaseOracle,
        key: "oceanbase-oracle",
        label: "OceanBase Oracle Mode",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Gbase,
        key: "gbase8a",
        label: "GBase 8a",
        store_visible: true,
        profiles: GBASE_PROFILES,
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Access,
        key: "access",
        label: "Microsoft Access",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Oracle,
        key: "oracle",
        label: "Oracle",
        store_visible: true,
        profiles: ORACLE_PROFILES,
    },
    AgentCatalogEntry { db_type: DatabaseType::H2, key: "h2", label: "H2", store_visible: true, profiles: &[] },
    AgentCatalogEntry {
        db_type: DatabaseType::Snowflake,
        key: "snowflake",
        label: "Snowflake",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Trino,
        key: "trino",
        label: "Trino",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Hive,
        key: "hive",
        label: "Apache Hive",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry { db_type: DatabaseType::Db2, key: "db2", label: "IBM DB2", store_visible: true, profiles: &[] },
    AgentCatalogEntry {
        db_type: DatabaseType::Informix,
        key: "informix",
        label: "IBM Informix",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::InfluxDb,
        key: "influxdb",
        label: "InfluxDB",
        store_visible: false,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Neo4j,
        key: "neo4j",
        label: "Neo4j",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Cassandra,
        key: "cassandra",
        label: "Apache Cassandra",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Bigquery,
        key: "bigquery",
        label: "Google BigQuery",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Kylin,
        key: "kylin",
        label: "Apache Kylin",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Sundb,
        key: "sundb",
        label: "SunDB",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Yashandb,
        key: "yashandb",
        label: "崖山 YashanDB",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Tdengine,
        key: "tdengine",
        label: "TDengine",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Xugu,
        key: "xugu",
        label: "虚谷 XuguDB",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Iotdb,
        key: "iotdb",
        label: "Apache IoTDB",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry { db_type: DatabaseType::Etcd, key: "etcd", label: "etcd", store_visible: true, profiles: &[] },
    AgentCatalogEntry {
        db_type: DatabaseType::ZooKeeper,
        key: "zookeeper",
        label: "Apache ZooKeeper",
        store_visible: true,
        profiles: &[],
    },
    AgentCatalogEntry {
        db_type: DatabaseType::MongoDb,
        key: "mongodb",
        label: "MongoDB (Legacy)",
        store_visible: true,
        profiles: MONGODB_PROFILES,
    },
    AgentCatalogEntry {
        db_type: DatabaseType::Iris,
        key: "iris",
        label: "InterSystems IRIS",
        store_visible: true,
        profiles: &[],
    },
];

pub fn entries() -> &'static [AgentCatalogEntry] {
    AGENT_CATALOG
}

pub fn agent_key(db_type: &DatabaseType, driver_profile: Option<&str>) -> Option<&'static str> {
    let entry = entry_for_db_type(db_type)?;
    if let Some(driver_profile) = driver_profile {
        if let Some(profile) = entry.profiles.iter().find(|profile| profile.profile == driver_profile) {
            return Some(profile.key);
        }
    }
    Some(entry.key)
}

pub fn is_agent_type(db_type: &DatabaseType) -> bool {
    entry_for_db_type(db_type).is_some()
}

pub fn driver_store_entries() -> impl Iterator<Item = (&'static str, &'static str)> {
    entries().iter().flat_map(|entry| {
        let base = entry.store_visible.then_some((entry.key, entry.label));
        let profiles =
            entry.profiles.iter().filter(|profile| profile.store_visible).map(|profile| (profile.key, profile.label));
        base.into_iter().chain(profiles)
    })
}

pub fn label_for_key(agent_key: &str) -> Option<&'static str> {
    for entry in entries() {
        if entry.key == agent_key {
            return Some(entry.label);
        }
        if let Some(profile) = entry.profiles.iter().find(|profile| profile.key == agent_key) {
            return Some(profile.label);
        }
    }
    None
}

fn entry_for_db_type(db_type: &DatabaseType) -> Option<&'static AgentCatalogEntry> {
    entries().iter().find(|entry| entry.db_type == *db_type)
}
