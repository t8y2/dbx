use deadpool_postgres::Pool;

use super::{is_greenplum_server_version, pg_err};
use crate::db;

/// Single-round-trip probe safe on PostgreSQL 8.2–18, Greenplum 5/6/7,
/// Cloudberry, Redshift, CockroachDB, and OpenTenBase.
pub(super) const PROBE_CAPABILITIES_SQL: &str = "SELECT version()::text, \
            COALESCE(NULLIF(current_setting('server_version_num'), ''), '0')::int, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_class c \
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = 'pg_catalog' AND c.relname = 'gp_distribution_policy' \
            ) AS has_gp_distribution_policy, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_class c \
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = 'pg_catalog' AND c.relname = 'pg_partition' \
            ) AS has_gp_classic_partition, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_class c \
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = 'pg_catalog' AND c.relname = 'pg_partitioned_table' \
            ) AS has_pg_declarative_partition, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_proc p \
              JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
              WHERE n.nspname = 'pg_catalog' AND p.proname = 'pg_get_table_distributedby' \
            ) AS has_pg_get_table_distributedby, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_proc p \
              JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
              WHERE n.nspname = 'pg_catalog' AND p.proname = 'pg_get_partition_def' \
            ) AS has_pg_get_partition_def, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_proc p \
              JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
              WHERE n.nspname = 'pg_catalog' AND p.proname = 'pg_get_partition_rule_def' \
            ) AS has_pg_get_partition_rule_def, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_class c \
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = 'pg_catalog' AND c.relname = 'pg_exttable' \
            ) AS has_pg_exttable, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_class c \
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = 'pg_catalog' AND c.relname = 'pg_appendonly' \
            ) AS has_pg_appendonly, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_class c \
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = 'pg_catalog' AND c.relname = 'pg_attribute_encoding' \
            ) AS has_pg_attribute_encoding, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_attribute a \
              JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = 'pg_catalog' AND c.relname = 'pg_class' \
                AND a.attname = 'relstorage' AND NOT a.attisdropped \
            ) AS has_relstorage, \
            EXISTS ( \
              SELECT 1 FROM pg_catalog.pg_attribute a \
              JOIN pg_catalog.pg_class c ON c.oid = a.attrelid \
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = 'pg_catalog' AND c.relname = 'pg_class' \
                AND a.attname = 'relhasoids' AND NOT a.attisdropped \
            ) AS has_relhasoids";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GreenplumPartitionModel {
    ClassicGp6,
    DeclarativeGp7,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GreenplumCapabilities {
    pub is_greenplum: bool,
    pub server_version: String,
    pub server_version_num: Option<i32>,
    pub partition_model: GreenplumPartitionModel,
    pub has_gp_distribution_policy: bool,
    pub has_pg_get_table_distributedby: bool,
    pub has_pg_get_partition_def: bool,
    pub has_pg_get_partition_rule_def: bool,
    pub has_pg_exttable: bool,
    pub has_pg_appendonly: bool,
    pub has_pg_attribute_encoding: bool,
    pub has_relstorage: bool,
    pub has_relhasoids: bool,
}

impl GreenplumCapabilities {
    pub fn is_classic_gp6(&self) -> bool {
        self.partition_model == GreenplumPartitionModel::ClassicGp6
    }
}

/// Probes the connected PostgreSQL-protocol server once to determine whether
/// it is Greenplum and which catalog dialect (GP6 classic vs GP7 declarative)
/// it exposes.
pub async fn probe_capabilities(pool: &Pool) -> Result<GreenplumCapabilities, String> {
    let client = db::postgres::checkout_postgres_client(pool, None, crate::db::connection_timeout()).await?;
    let row = client.query_one(PROBE_CAPABILITIES_SQL, &[]).await.map_err(pg_err)?;

    let server_version = row.try_get::<_, String>(0).map_err(pg_err)?;
    let server_version_num = row.try_get::<_, i32>(1).ok().filter(|value| *value > 0);
    let has_gp_distribution_policy = row.try_get::<_, bool>(2).unwrap_or(false);
    let has_gp_classic_partition = row.try_get::<_, bool>(3).unwrap_or(false);
    let has_pg_declarative_partition = row.try_get::<_, bool>(4).unwrap_or(false);
    let has_pg_get_table_distributedby = row.try_get::<_, bool>(5).unwrap_or(false);
    let has_pg_get_partition_def = row.try_get::<_, bool>(6).unwrap_or(false);
    let has_pg_get_partition_rule_def = row.try_get::<_, bool>(7).unwrap_or(false);
    let has_pg_exttable = row.try_get::<_, bool>(8).unwrap_or(false);
    let has_pg_appendonly = row.try_get::<_, bool>(9).unwrap_or(false);
    let has_pg_attribute_encoding = row.try_get::<_, bool>(10).unwrap_or(false);
    let has_relstorage = row.try_get::<_, bool>(11).unwrap_or(false);
    let has_relhasoids = row.try_get::<_, bool>(12).unwrap_or(false);

    let is_greenplum = is_greenplum_server_version(&server_version);
    let partition_model = if has_pg_declarative_partition {
        GreenplumPartitionModel::DeclarativeGp7
    } else if has_gp_classic_partition {
        GreenplumPartitionModel::ClassicGp6
    } else if server_version_num.is_some_and(|version| version >= 100000) {
        GreenplumPartitionModel::DeclarativeGp7
    } else {
        GreenplumPartitionModel::ClassicGp6
    };

    Ok(GreenplumCapabilities {
        is_greenplum,
        server_version,
        server_version_num,
        partition_model,
        has_gp_distribution_policy,
        has_pg_get_table_distributedby,
        has_pg_get_partition_def,
        has_pg_get_partition_rule_def,
        has_pg_exttable,
        has_pg_appendonly,
        has_pg_attribute_encoding,
        has_relstorage,
        has_relhasoids,
    })
}

#[cfg(test)]
pub(super) fn sample_gp6_caps() -> GreenplumCapabilities {
    GreenplumCapabilities {
        is_greenplum: true,
        server_version: "PostgreSQL 9.4.26 (Greenplum Database 6.26.1 build commit:abc)".to_string(),
        server_version_num: Some(90426),
        partition_model: GreenplumPartitionModel::ClassicGp6,
        has_gp_distribution_policy: true,
        has_pg_get_table_distributedby: true,
        has_pg_get_partition_def: true,
        has_pg_get_partition_rule_def: true,
        has_pg_exttable: true,
        has_pg_appendonly: true,
        has_pg_attribute_encoding: true,
        has_relstorage: true,
        has_relhasoids: true,
    }
}

#[cfg(test)]
pub(super) fn sample_gp7_caps() -> GreenplumCapabilities {
    GreenplumCapabilities {
        is_greenplum: true,
        server_version: "PostgreSQL 12.12 (Greenplum Database 7.1.0 build commit:def)".to_string(),
        server_version_num: Some(120012),
        partition_model: GreenplumPartitionModel::DeclarativeGp7,
        has_gp_distribution_policy: true,
        has_pg_get_table_distributedby: true,
        has_pg_get_partition_def: false,
        has_pg_get_partition_rule_def: false,
        has_pg_exttable: false,
        has_pg_appendonly: true,
        has_pg_attribute_encoding: true,
        has_relstorage: false,
        has_relhasoids: false,
    }
}
