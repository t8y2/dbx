use mysql_async::prelude::*;

use crate::models::connection::{ConnectionConfig, DatabaseType};
use crate::types::{DorisPartitionInfo, DorisPartitionsResult};

pub use super::mysql_compatible::{
    get_columns_show_from as get_catalog_columns, list_catalog_indexes, list_catalogs,
    list_databases_show_from as list_catalog_databases, list_indexes_with_ddl_fallback as list_indexes,
    list_tables_show_from as list_catalog_tables, show_create_table_ddl_from as get_catalog_table_ddl,
};

use super::mysql::{get_conn_with_timeout, get_opt_str, get_str_by_name, quote_identifier, MySqlPool};

pub fn is_config(config: &ConnectionConfig) -> bool {
    is_profile(&config.db_type, config.driver_profile.as_deref())
}

pub fn is_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::Doris
        || (*db_type == DatabaseType::Mysql
            && driver_profile
                .is_some_and(|profile| matches!(profile.to_ascii_lowercase().as_str(), "doris" | "selectdb")))
}

/// Native Doris semantics only. SelectDB shares metadata/catalog handling but
/// must not inherit Doris-specific query preflight or opaque-state safeguards.
pub fn is_native_profile(db_type: &DatabaseType, driver_profile: Option<&str>) -> bool {
    *db_type == DatabaseType::Doris
        || (*db_type == DatabaseType::Mysql
            && driver_profile.is_some_and(|profile| profile.eq_ignore_ascii_case("doris")))
}

/// `SHOW PARTITIONS FROM <db>.<table>` for an internal-catalog table.
///
/// Doris only documents a two-part table reference here; a three-part
/// `catalog.db.table` is deliberately not emitted, because external catalogs
/// need a session-level `SET CATALOG` that must not leak into a pooled
/// connection.
pub fn show_partitions_sql(database: &str, table: &str) -> String {
    let table = quote_identifier(table);
    if database.trim().is_empty() {
        format!("SHOW PARTITIONS FROM {table}")
    } else {
        format!("SHOW PARTITIONS FROM {}.{table}", quote_identifier(database))
    }
}

pub async fn list_table_partitions(
    pool: &MySqlPool,
    database: &str,
    table: &str,
) -> Result<Vec<DorisPartitionInfo>, String> {
    let sql = show_partitions_sql(database, table);
    let mut conn = get_conn_with_timeout(pool, pool.checkout_timeout()).await?;
    let result = conn.query_iter(&sql).await.map_err(|error| error.to_string())?;
    let rows: Vec<mysql_async::Row> = result.collect_and_drop().await.map_err(|error| error.to_string())?;
    Ok(rows.iter().filter_map(partition_from_row).collect())
}

fn partition_from_row(row: &mysql_async::Row) -> Option<DorisPartitionInfo> {
    let name = get_str_by_name(row, "PartitionName");
    if name.trim().is_empty() {
        return None;
    }
    let buckets_raw = get_opt_str(row, "Buckets")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| get_opt_u32(row, "Buckets").map(|value| value.to_string()));
    let data_size = get_opt_str(row, "DataSize")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| get_opt_u64(row, "DataSize").map(|value| value.to_string()));
    Some(DorisPartitionInfo {
        partition_id: get_opt_i64(row, "PartitionId"),
        name,
        visible_version: get_opt_i64(row, "VisibleVersion"),
        visible_version_time: get_opt_str(row, "VisibleVersionTime"),
        state: get_opt_str(row, "State"),
        partition_key: get_opt_str(row, "PartitionKey"),
        range: get_opt_str(row, "Range"),
        distribution_key: get_opt_str(row, "DistributionKey"),
        buckets: buckets_raw.as_deref().and_then(parse_bucket_count),
        buckets_raw,
        replication_num: get_opt_u32(row, "ReplicationNum"),
        storage_medium: get_opt_str(row, "StorageMedium"),
        data_size_bytes: data_size.as_deref().and_then(parse_data_size),
        data_size,
        is_mutable: get_opt_bool(row, "IsMutable"),
        is_in_memory: get_opt_bool(row, "IsInMemory"),
        replica_allocation: get_opt_str(row, "ReplicaAllocation"),
        last_consistency_check_time: get_opt_str(row, "LastConsistencyCheckTime"),
    })
}

fn get_opt_i64(row: &mysql_async::Row, name: &str) -> Option<i64> {
    row.get_opt::<i64, _>(name)
        .and_then(|result| result.ok())
        .or_else(|| get_opt_str(row, name).and_then(|value| value.trim().parse().ok()))
}

fn get_opt_u64(row: &mysql_async::Row, name: &str) -> Option<u64> {
    row.get_opt::<u64, _>(name)
        .and_then(|result| result.ok())
        .or_else(|| get_opt_i64(row, name).and_then(|value| u64::try_from(value).ok()))
        .or_else(|| get_opt_str(row, name).and_then(|value| value.trim().parse().ok()))
}

fn get_opt_u32(row: &mysql_async::Row, name: &str) -> Option<u32> {
    get_opt_u64(row, name).and_then(|value| u32::try_from(value).ok())
}

fn get_opt_bool(row: &mysql_async::Row, name: &str) -> Option<bool> {
    row.get_opt::<bool, _>(name)
        .and_then(|result| result.ok())
        .or_else(|| get_opt_i64(row, name).map(|value| value != 0))
        .or_else(|| {
            get_opt_str(row, name)
                .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        })
}

/// `Buckets` is normally an integer, but automatic bucket scaling can expose a
/// composite form. Keep the leading integer for display/sorting and retain the
/// raw text separately.
fn parse_bucket_count(raw: &str) -> Option<u32> {
    let digits: String = raw.trim().chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

/// `DataSize` is human-readable text (`27.396 KB`, `806.000 B`). Parse it for
/// sorting only; the UI keeps showing the server's original string.
fn parse_data_size(raw: &str) -> Option<u64> {
    let trimmed = raw.trim();
    let split = trimmed.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(trimmed.len());
    let (number, unit) = trimmed.split_at(split);
    let number: f64 = number.parse().ok()?;
    if !number.is_finite() || number < 0.0 {
        return None;
    }
    let multiplier = match unit.trim().to_ascii_uppercase().as_str() {
        "" | "B" => 1.0,
        "KB" => 1024.0,
        "MB" => 1024.0 * 1024.0,
        "GB" => 1024.0 * 1024.0 * 1024.0,
        "TB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((number * multiplier).round() as u64)
}

/// Build the stable "not supported here" response used by the core dispatcher.
pub fn unsupported_partitions(reason: &str) -> DorisPartitionsResult {
    DorisPartitionsResult { supported: false, reason: Some(reason.to_string()), partitions: Vec::new() }
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

    #[test]
    fn native_profile_excludes_selectdb_and_other_mysql_profiles() {
        assert!(is_native_profile(&DatabaseType::Doris, None));
        assert!(is_native_profile(&DatabaseType::Mysql, Some("DORIS")));
        assert!(!is_native_profile(&DatabaseType::Mysql, Some("selectdb")));
        assert!(!is_native_profile(&DatabaseType::Mysql, Some("starrocks")));
        assert!(!is_native_profile(&DatabaseType::Mysql, None));
    }

    #[test]
    fn partition_sql_quotes_each_identifier() {
        assert_eq!(show_partitions_sql("demo", "orders"), "SHOW PARTITIONS FROM `demo`.`orders`");
        assert_eq!(show_partitions_sql("", "orders"), "SHOW PARTITIONS FROM `orders`");
        assert_eq!(show_partitions_sql("demo`x", "order's"), "SHOW PARTITIONS FROM `demo``x`.`order's`");
    }

    #[test]
    fn bucket_text_keeps_numeric_prefix_only() {
        assert_eq!(parse_bucket_count("10"), Some(10));
        assert_eq!(parse_bucket_count(" 3 "), Some(3));
        assert_eq!(parse_bucket_count("1/3"), Some(1));
        assert_eq!(parse_bucket_count("AUTO"), None);
        assert_eq!(parse_bucket_count(""), None);
    }

    #[test]
    fn data_size_text_parses_known_units() {
        assert_eq!(parse_data_size("806.000 B"), Some(806));
        assert_eq!(parse_data_size("27.396 KB"), Some(28054));
        assert_eq!(parse_data_size("1.5 GB"), Some(1_610_612_736));
        assert_eq!(parse_data_size("0.000"), Some(0));
        assert_eq!(parse_data_size("unknown"), None);
        assert_eq!(parse_data_size("-1 KB"), None);
    }

    #[test]
    fn maps_show_partitions_columns_by_name() {
        use std::sync::Arc;

        use mysql_common::constants::ColumnType;
        use mysql_common::packets::Column;
        use mysql_common::row::new_row;
        use mysql_common::value::Value;

        let columns: Arc<[Column]> = vec![
            Column::new(ColumnType::MYSQL_TYPE_LONGLONG).with_name(b"PartitionId"),
            Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(b"PartitionName"),
            Column::new(ColumnType::MYSQL_TYPE_LONGLONG).with_name(b"VisibleVersion"),
            Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(b"State"),
            Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(b"Range"),
            Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(b"DistributionKey"),
            Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(b"Buckets"),
            Column::new(ColumnType::MYSQL_TYPE_LONGLONG).with_name(b"ReplicationNum"),
            Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(b"StorageMedium"),
            Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(b"DataSize"),
            Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(b"IsMutable"),
        ]
        .into();
        let row = new_row(
            vec![
                Value::Int(170307),
                Value::Bytes("p202401".into()),
                Value::Int(4),
                Value::Bytes("NORMAL".into()),
                Value::Bytes("[types: [DATE]; keys: [2024-01-01]; )".into()),
                Value::Bytes("order_id".into()),
                Value::Bytes("10".into()),
                Value::Int(3),
                Value::Bytes("SSD".into()),
                Value::Bytes("1.5 GB".into()),
                Value::Bytes("true".into()),
            ],
            columns,
        );
        let info = partition_from_row(&row).expect("row should map");
        assert_eq!(info.partition_id, Some(170_307));
        assert_eq!(info.name, "p202401");
        assert_eq!(info.visible_version, Some(4));
        assert_eq!(info.state.as_deref(), Some("NORMAL"));
        assert_eq!(info.range.as_deref(), Some("[types: [DATE]; keys: [2024-01-01]; )"));
        assert_eq!(info.distribution_key.as_deref(), Some("order_id"));
        assert_eq!(info.buckets, Some(10));
        assert_eq!(info.buckets_raw.as_deref(), Some("10"));
        assert_eq!(info.replication_num, Some(3));
        assert_eq!(info.storage_medium.as_deref(), Some("SSD"));
        assert_eq!(info.data_size.as_deref(), Some("1.5 GB"));
        assert_eq!(info.data_size_bytes, Some(1_610_612_736));
        assert_eq!(info.is_mutable, Some(true));
    }

    #[test]
    fn missing_version_columns_do_not_break_row_mapping() {
        use std::sync::Arc;

        use mysql_common::constants::ColumnType;
        use mysql_common::packets::Column;
        use mysql_common::row::new_row;
        use mysql_common::value::Value;

        let columns: Arc<[Column]> =
            vec![Column::new(ColumnType::MYSQL_TYPE_VAR_STRING).with_name(b"PartitionName")].into();
        let row = new_row(vec![Value::Bytes("p1".into())], columns);
        let info = partition_from_row(&row).expect("row should map");
        assert_eq!(info.name, "p1");
        assert_eq!(info.buckets, None);
        assert_eq!(info.data_size, None);
        assert_eq!(info.is_mutable, None);
    }

    #[test]
    fn unsupported_result_is_distinguishable_from_empty() {
        let result = unsupported_partitions("external_catalog");
        assert!(!result.supported);
        assert_eq!(result.reason.as_deref(), Some("external_catalog"));
        assert!(result.partitions.is_empty());
    }
}
