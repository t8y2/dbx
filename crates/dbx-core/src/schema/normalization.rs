use crate::db;
use crate::models::connection::{ConnectionConfig, DatabaseType};
use std::collections::HashSet;

pub(super) fn filter_table_infos(
    tables: Vec<db::TableInfo>,
    filter: Option<&str>,
    limit: Option<usize>,
) -> Vec<db::TableInfo> {
    let filter = filter.unwrap_or("").to_lowercase();
    let limit = limit.unwrap_or(usize::MAX);
    tables
        .into_iter()
        .filter(|table| filter.is_empty() || table.name.to_lowercase().contains(&filter))
        .take(limit)
        .collect()
}

pub(super) fn filter_table_infos_for_config(
    tables: Vec<db::TableInfo>,
    filter: Option<&str>,
    limit: Option<usize>,
    config: Option<&ConnectionConfig>,
) -> Vec<db::TableInfo> {
    filter_table_infos(filter_yashandb_recyclebin_tables(tables, config), filter, limit)
}

pub(super) fn filter_yashandb_recyclebin_tables(
    tables: Vec<db::TableInfo>,
    config: Option<&ConnectionConfig>,
) -> Vec<db::TableInfo> {
    if !is_yashandb_config(config) {
        return tables;
    }
    tables.into_iter().filter(|table| !is_recyclebin_object_name(&table.name)).collect()
}

pub(super) fn filter_yashandb_recyclebin_objects(
    objects: Vec<db::ObjectInfo>,
    config: Option<&ConnectionConfig>,
) -> Vec<db::ObjectInfo> {
    if !is_yashandb_config(config) {
        return objects;
    }
    objects.into_iter().filter(|object| !is_recyclebin_object_name(&object.name)).collect()
}

fn is_yashandb_config(config: Option<&ConnectionConfig>) -> bool {
    config.is_some_and(|config| config.db_type == DatabaseType::Yashandb)
}

fn is_recyclebin_object_name(name: &str) -> bool {
    name.to_ascii_uppercase().starts_with("BIN$")
}

pub(super) fn filter_objects_by_types(
    objects: Vec<db::ObjectInfo>,
    object_types: Option<&[String]>,
) -> Vec<db::ObjectInfo> {
    let Some(object_types) = object_types else {
        return objects;
    };
    if object_types.is_empty() {
        return objects;
    }
    let wanted: HashSet<String> =
        object_types.iter().map(|object_type| normalize_object_info_type(object_type)).collect();
    objects.into_iter().filter(|object| wanted.contains(&normalize_object_info_type(&object.object_type))).collect()
}

fn normalize_object_info_type(object_type: &str) -> String {
    let value = object_type.to_ascii_uppercase().replace(' ', "_");
    if value.contains("PACKAGE_BODY") {
        "PACKAGE_BODY".to_string()
    } else if value.contains("PACKAGE") {
        "PACKAGE".to_string()
    } else if value.contains("VIEW") {
        "VIEW".to_string()
    } else if value.contains("PROC") {
        "PROCEDURE".to_string()
    } else if value.contains("FUNC") {
        "FUNCTION".to_string()
    } else {
        "TABLE".to_string()
    }
}

pub(super) fn filter_completion_objects(objects: Vec<db::ObjectInfo>) -> Vec<db::ObjectInfo> {
    objects
        .into_iter()
        .filter(|object| {
            let object_type = object.object_type.to_ascii_uppercase();
            object_type.contains("PROCEDURE") || object_type.contains("FUNCTION") || object_type.contains("TRIGGER")
        })
        .collect()
}

pub(super) fn deduplicate_column_infos(columns: Vec<db::ColumnInfo>) -> Vec<db::ColumnInfo> {
    let mut result: Vec<db::ColumnInfo> = Vec::with_capacity(columns.len());
    for column in columns {
        if let Some(existing) = result.iter_mut().find(|existing| existing.name == column.name) {
            existing.is_primary_key |= column.is_primary_key;
            existing.is_nullable &= column.is_nullable;
            merge_optional_string(&mut existing.column_default, column.column_default);
            merge_optional_string(&mut existing.extra, column.extra);
            merge_optional_string(&mut existing.comment, column.comment);
            if existing.numeric_precision.is_none() {
                existing.numeric_precision = column.numeric_precision;
            }
            if existing.numeric_scale.is_none() {
                existing.numeric_scale = column.numeric_scale;
            }
            if existing.character_maximum_length.is_none() {
                existing.character_maximum_length = column.character_maximum_length;
            }
            if existing.data_type.trim().is_empty() && !column.data_type.trim().is_empty() {
                existing.data_type = column.data_type;
            }
        } else {
            result.push(column);
        }
    }
    result
}

fn merge_optional_string(target: &mut Option<String>, candidate: Option<String>) {
    let Some(candidate) = candidate else {
        return;
    };
    if candidate.trim().is_empty() {
        if target.is_none() {
            *target = Some(candidate);
        }
        return;
    }
    if target.as_ref().is_none_or(|value| value.trim().is_empty()) {
        *target = Some(candidate);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::connection::{default_redis_key_separator, ConnectionConfig};

    fn test_connection_config(db_type: DatabaseType) -> ConnectionConfig {
        ConnectionConfig {
            id: "test".to_string(),
            name: "test".to_string(),
            db_type,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            host: "127.0.0.1".to_string(),
            port: 5432,
            username: "user".to_string(),
            password: "secret".to_string(),
            database: Some("demo".to_string()),
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: default_redis_key_separator(),
            etcd_endpoints: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
        }
    }

    fn test_column(name: &str, comment: Option<&str>, is_primary_key: bool) -> db::ColumnInfo {
        db::ColumnInfo {
            name: name.to_string(),
            data_type: "VARCHAR".to_string(),
            is_nullable: true,
            column_default: None,
            is_primary_key,
            extra: None,
            comment: comment.map(|value| value.to_string()),
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
        }
    }

    #[test]
    fn deduplicates_columns_and_preserves_later_comment() {
        let columns = deduplicate_column_infos(vec![
            test_column("ID", None, false),
            test_column("ID", Some("source primary key"), true),
            test_column("TFBH", Some(""), false),
            test_column("TFBH", Some("ledger number"), false),
        ]);

        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].name, "ID");
        assert_eq!(columns[0].comment.as_deref(), Some("source primary key"));
        assert!(columns[0].is_primary_key);
        assert_eq!(columns[1].name, "TFBH");
        assert_eq!(columns[1].comment.as_deref(), Some("ledger number"));
    }

    #[test]
    fn filters_list_objects_by_normalized_object_types() {
        let objects = vec![
            db::ObjectInfo {
                name: "orders".to_string(),
                object_type: "BASE TABLE".to_string(),
                schema: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
            },
            db::ObjectInfo {
                name: "active_orders".to_string(),
                object_type: "MATERIALIZED VIEW".to_string(),
                schema: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
            },
            db::ObjectInfo {
                name: "payroll".to_string(),
                object_type: "PACKAGE BODY".to_string(),
                schema: None,
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
            },
        ];

        let filtered = filter_objects_by_types(objects, Some(&["VIEW".to_string(), "PACKAGE_BODY".to_string()]));

        assert_eq!(
            filtered.iter().map(|object| object.name.as_str()).collect::<Vec<_>>(),
            ["active_orders", "payroll"]
        );
    }

    #[test]
    fn filters_yashandb_recyclebin_tables() {
        let tables = vec![
            db::TableInfo {
                name: "USERS".to_string(),
                table_type: "TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
            db::TableInfo {
                name: "BIN$abc123==$0".to_string(),
                table_type: "TABLE".to_string(),
                comment: None,
                parent_schema: None,
                parent_name: None,
            },
        ];

        let filtered =
            filter_yashandb_recyclebin_tables(tables.clone(), Some(&test_connection_config(DatabaseType::Yashandb)));
        let oracle = filter_yashandb_recyclebin_tables(tables, Some(&test_connection_config(DatabaseType::Oracle)));

        assert_eq!(filtered.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), ["USERS"]);
        assert_eq!(oracle.len(), 2);
    }

    #[test]
    fn filters_yashandb_recyclebin_objects() {
        let objects = vec![
            db::ObjectInfo {
                name: "ORDERS".to_string(),
                object_type: "TABLE".to_string(),
                schema: Some("HR".to_string()),
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
            },
            db::ObjectInfo {
                name: "bin$deleted".to_string(),
                object_type: "TABLE".to_string(),
                schema: Some("HR".to_string()),
                comment: None,
                created_at: None,
                updated_at: None,
                parent_schema: None,
                parent_name: None,
            },
        ];

        let filtered =
            filter_yashandb_recyclebin_objects(objects, Some(&test_connection_config(DatabaseType::Yashandb)));

        assert_eq!(filtered.iter().map(|object| object.name.as_str()).collect::<Vec<_>>(), ["ORDERS"]);
    }
}
