//! Greenplum 6.x (PostgreSQL 9.4 classic partitions) and Greenplum 7.x
//! (PostgreSQL 12 declarative partitions) metadata, partition-tree, and DDL
//! adapter layered on top of the native PostgreSQL driver.

mod ddl;
mod partitions;
mod probe;

use crate::models::connection::{ConnectionConfig, DatabaseType};

pub use ddl::{
    apply_table_modifiers, apply_tree_table_modifiers, table_modifiers, table_modifiers_for_relations,
    Gp6ChildPartitionHeader, Gp6ExternalTableDefinition, Gp7ExternalTableDefinition, TableModifiers,
};
pub use partitions::{
    get_table_partition_status, get_table_partitioning, list_objects, list_table_roots_page_filtered,
    list_tables_filtered, GreenplumPartitionStatus,
};
pub use probe::{probe_capabilities, GreenplumCapabilities, GreenplumPartitionModel};

pub const DRIVER_PROFILE: &str = "greenplum";

/// Future-proof hook for when an explicit `greenplum` connection profile is
/// registered in `plugins/connection-types/profiles/catalog.yaml`.
pub fn is_config(config: &ConnectionConfig) -> bool {
    matches!(config.driver_profile.as_deref(), Some(DRIVER_PROFILE))
}

/// Returns `true` when `config` is eligible for Greenplum dialect routing:
/// either an explicit `greenplum` profile or a plain `postgres` connection
/// (where runtime detection confirms whether the server is Greenplum).
pub fn is_candidate_postgres_config(config: &ConnectionConfig) -> bool {
    if is_config(config) {
        return true;
    }
    config.db_type == DatabaseType::Postgres && matches!(config.driver_profile.as_deref(), None | Some("postgres"))
}

/// Fast-path negative check: when `database_info.product_version` is already
/// populated for a plain `postgres` connection and clearly does not mention
/// Greenplum, skip the probe SQL completely so standard PostgreSQL connections
/// incur zero extra round-trips.
pub fn is_known_non_greenplum_config(config: &ConnectionConfig) -> bool {
    if is_config(config) {
        return false;
    }
    if !is_candidate_postgres_config(config) {
        return true;
    }
    config
        .database_info
        .as_ref()
        .and_then(|info| info.product_version.as_deref())
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .is_some_and(|version| !is_greenplum_server_version(version))
}

/// Detects Greenplum from `SELECT version()` while explicitly excluding
/// Apache Cloudberry (which owns its own dedicated profile and SQL path).
pub fn is_greenplum_server_version(server_version: &str) -> bool {
    let lower = server_version.to_ascii_lowercase();
    lower.contains("greenplum") && !lower.contains("cloudberry")
}

pub(super) fn normalize_schema(schema: &str) -> &str {
    if schema.trim().is_empty() {
        "public"
    } else {
        schema
    }
}

pub(super) fn pg_err(error: tokio_postgres::Error) -> String {
    if let Some(db_err) = error.as_db_error() {
        let mut msg = format!("{}: {} ({})", db_err.severity(), db_err.message(), db_err.code().code());
        if let Some(detail) = db_err.detail().filter(|d| !d.is_empty()) {
            msg.push_str(&format!("; detail: {detail}"));
        }
        if let Some(hint) = db_err.hint().filter(|h| !h.is_empty()) {
            msg.push_str(&format!("; hint: {hint}"));
        }
        msg
    } else {
        error.to_string()
    }
}

pub(super) fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(super) fn split_catalog_lines(value: String) -> Vec<String> {
    value.lines().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect()
}

pub(super) fn quote_sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(super) fn like_contains_pattern(value: &str) -> String {
    if value.is_empty() {
        return "%%".to_string();
    }
    let mut pattern = String::with_capacity(value.len() + 2);
    pattern.push('%');
    for ch in value.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

pub(super) fn like_fuzzy_pattern(value: &str) -> String {
    crate::sql::fuzzy_like_pattern_with_escape(value, |segment| {
        let mut escaped = String::with_capacity(segment.len() + 1);
        for ch in segment.chars() {
            if ch == '\\' || ch == '%' || ch == '_' {
                escaped.push('\\');
            }
            escaped.push(ch);
        }
        escaped
    })
}

pub(super) fn strip_outer_parens(input: &str) -> &str {
    let trimmed = input.trim();
    if !trimmed.starts_with('(') || !trimmed.ends_with(')') {
        return trimmed;
    }
    if super::ddl_scan::find_top_level_paren_close(trimmed, 0) == Some(trimmed.len()) {
        trimmed[1..trimmed.len() - 1].trim()
    } else {
        trimmed
    }
}

pub(super) fn split_bound_items(input: &str) -> Vec<String> {
    split_top_level_commas(input).into_iter().filter(|item| !item.is_empty()).collect()
}

pub(super) fn split_top_level_commas(input: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\'' if !in_double => {
                if in_single && chars.peek() == Some(&'\'') {
                    current.push('\'');
                    current.push('\'');
                    chars.next();
                    continue;
                }
                in_single = !in_single;
                current.push(ch);
            }
            '"' if !in_single => {
                in_double = !in_double;
                current.push(ch);
            }
            '(' if !in_single && !in_double => {
                depth += 1;
                current.push(ch);
            }
            ')' if !in_single && !in_double => {
                depth -= 1;
                current.push(ch);
            }
            ',' if !in_single && !in_double && depth == 0 => {
                items.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    items.push(current.trim().to_string());
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_greenplum_versions_and_excludes_cloudberry_and_plain_postgres() {
        assert!(is_greenplum_server_version(
            "PostgreSQL 9.4.26 (Greenplum Database 6.26.1 build commit:12345) on x86_64-unknown-linux-gnu"
        ));
        assert!(is_greenplum_server_version("PostgreSQL 12.12 (Greenplum Database 7.1.0) on x86_64"));
        assert!(!is_greenplum_server_version("PostgreSQL 14.4 (Apache Cloudberry 1.5.0) on x86_64"));
        assert!(!is_greenplum_server_version("PostgreSQL 16.2 on aarch64-apple-darwin"));
        assert!(!is_greenplum_server_version("PostgreSQL 10.0 (OpenTenBase)"));
    }

    #[test]
    fn gp6_catalog_sql_avoids_pg95_and_pg10_incompatible_constructs() {
        let caps = probe::sample_gp6_caps();
        let sqls = [
            probe::PROBE_CAPABILITIES_SQL.to_string(),
            partitions::gp6_partition_status_sql(true),
            partitions::GP6_PARTITION_TARGET_SQL.to_string(),
            partitions::GP6_PARTITION_LEVELS_SQL.to_string(),
            partitions::GP6_PARTITION_RULES_SQL.to_string(),
            partitions::gp6_partition_stats_sql(true).to_string(),
            ddl::GP6_EXTTABLE_SQL.to_string(),
            ddl::GP6_APPENDONLY_SQL.to_string(),
            ddl::GP6_ATTRIBUTE_ENCODING_SQL.to_string(),
            ddl::GP_DISTRIBUTION_FALLBACK_SQL.to_string(),
            partitions::gp6_tables_sql(Some(100), 0, false, true),
            partitions::gp6_table_roots_page_sql(100, 0, false, true),
            partitions::gp6_partition_descendants_sql(false, true),
            partitions::gp6_object_relations_sql(true),
            ddl::gp6_table_base_modifiers_sql(&caps),
        ];

        for sql in &sqls {
            assert!(!sql.contains("array_position"), "PG 9.5+ array_position forbidden in GP6 SQL: {sql}");
            assert!(!sql.contains("relispartition"), "PG 10+ relispartition forbidden in GP6 SQL: {sql}");
            assert!(!sql.contains("relpartbound"), "PG 10+ relpartbound forbidden in GP6 SQL: {sql}");
            assert!(!sql.contains("pg_get_partkeydef"), "PG 10+ pg_get_partkeydef forbidden in GP6 SQL: {sql}");
            assert!(!sql.contains("= $1::bigint"), "PG 9.4 forbids oid = bigint comparison: {sql}");
        }
    }
}
