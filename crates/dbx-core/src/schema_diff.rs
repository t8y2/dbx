use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::models::connection::DatabaseType;
use crate::types::{ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo, TriggerInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ColumnInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ColumnInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<IndexInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<IndexInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<ForeignKeyInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ForeignKeyInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<TriggerInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<TriggerInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    #[serde(rename = "type")]
    pub diff_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_type: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<ColumnDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexes: Option<Vec<IndexDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub foreign_keys: Option<Vec<ForeignKeyDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<TriggerDiff>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ddl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_table_comment: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_table_comment: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchemaDetail {
    pub name: String,
    #[serde(default)]
    pub columns: Vec<ColumnInfo>,
    #[serde(default)]
    pub indexes: Vec<IndexInfo>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyInfo>,
    #[serde(default)]
    pub triggers: Vec<TriggerInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ddl: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffPreparationOptions {
    #[serde(default)]
    pub source_tables: Vec<TableInfo>,
    #[serde(default)]
    pub target_tables: Vec<TableInfo>,
    #[serde(default)]
    pub source_details: Vec<TableSchemaDetail>,
    #[serde(default)]
    pub target_details: Vec<TableSchemaDetail>,
    pub database_type: DatabaseType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_schema: Option<String>,
    #[serde(default)]
    pub ignore_comments: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiffPreparation {
    pub diffs: Vec<TableDiff>,
    pub sync_sql: String,
}

pub fn prepare_schema_diff(options: SchemaDiffPreparationOptions) -> SchemaDiffPreparation {
    let diffs = diff_schema(&options);
    let sync_sql = generate_schema_sync_sql(&diffs, options.database_type, options.target_schema.as_deref());
    SchemaDiffPreparation { diffs, sync_sql }
}

fn diff_schema(options: &SchemaDiffPreparationOptions) -> Vec<TableDiff> {
    let source_details: HashMap<&str, &TableSchemaDetail> =
        options.source_details.iter().map(|detail| (detail.name.as_str(), detail)).collect();
    let target_details: HashMap<&str, &TableSchemaDetail> =
        options.target_details.iter().map(|detail| (detail.name.as_str(), detail)).collect();
    let source_table_comments: HashMap<&str, Option<String>> =
        options.source_tables.iter().map(|table| (table.name.as_str(), table.comment.clone())).collect();
    let target_table_comments: HashMap<&str, Option<String>> =
        options.target_tables.iter().map(|table| (table.name.as_str(), table.comment.clone())).collect();

    let source_table_names: Vec<String> = options
        .source_tables
        .iter()
        .filter(|table| table.table_type != "VIEW")
        .map(|table| table.name.clone())
        .collect();
    let target_table_names: Vec<String> = options
        .target_tables
        .iter()
        .filter(|table| table.table_type != "VIEW")
        .map(|table| table.name.clone())
        .collect();
    let source_view_names: Vec<String> = options
        .source_tables
        .iter()
        .filter(|table| table.table_type == "VIEW")
        .map(|table| table.name.clone())
        .collect();
    let target_view_names: Vec<String> = options
        .target_tables
        .iter()
        .filter(|table| table.table_type == "VIEW")
        .map(|table| table.name.clone())
        .collect();

    let (added, removed, common) = diff_names(&source_table_names, &target_table_names);
    let (added_views, removed_views, _) = diff_names(&source_view_names, &target_view_names);
    let mut result = Vec::new();

    for name in added {
        result.push(TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("table".to_string()),
            ddl: source_details.get(name.as_str()).and_then(|detail| detail.ddl.clone()),
            name,
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            source_table_comment: None,
            target_table_comment: None,
        });
    }

    for name in removed {
        result.push(TableDiff {
            diff_type: "removed".to_string(),
            object_type: Some("table".to_string()),
            name,
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            source_table_comment: None,
            target_table_comment: None,
        });
    }

    for name in added_views {
        result.push(TableDiff {
            diff_type: "added".to_string(),
            object_type: Some("view".to_string()),
            name,
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            source_table_comment: None,
            target_table_comment: None,
        });
    }

    for name in removed_views {
        result.push(TableDiff {
            diff_type: "removed".to_string(),
            object_type: Some("view".to_string()),
            name,
            columns: None,
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            source_table_comment: None,
            target_table_comment: None,
        });
    }

    for name in common {
        let Some(source) = source_details.get(name.as_str()) else { continue };
        let Some(target) = target_details.get(name.as_str()) else { continue };
        let column_diffs = diff_columns_with_options(&source.columns, &target.columns, options.ignore_comments);
        let index_diffs = diff_indexes(&source.indexes, &target.indexes);
        let foreign_key_diffs = diff_foreign_keys(&source.foreign_keys, &target.foreign_keys);
        let trigger_diffs = diff_triggers(&source.triggers, &target.triggers);
        let source_comment = source_table_comments.get(name.as_str()).cloned().unwrap_or(None);
        let target_comment = target_table_comments.get(name.as_str()).cloned().unwrap_or(None);
        let comment_changed = !options.ignore_comments
            && source_comment.clone().unwrap_or_default() != target_comment.clone().unwrap_or_default();

        if !column_diffs.is_empty()
            || !index_diffs.is_empty()
            || !foreign_key_diffs.is_empty()
            || !trigger_diffs.is_empty()
            || comment_changed
        {
            result.push(TableDiff {
                diff_type: "modified".to_string(),
                object_type: Some("table".to_string()),
                name,
                columns: (!column_diffs.is_empty()).then_some(column_diffs),
                indexes: (!index_diffs.is_empty()).then_some(index_diffs),
                foreign_keys: (!foreign_key_diffs.is_empty()).then_some(foreign_key_diffs),
                triggers: (!trigger_diffs.is_empty()).then_some(trigger_diffs),
                ddl: None,
                source_table_comment: comment_changed.then_some(source_comment),
                target_table_comment: comment_changed.then_some(target_comment),
            });
        }
    }

    result
}

fn diff_names(source: &[String], target: &[String]) -> (Vec<String>, Vec<String>, Vec<String>) {
    let source_set: HashSet<&str> = source.iter().map(String::as_str).collect();
    let target_set: HashSet<&str> = target.iter().map(String::as_str).collect();
    (
        source.iter().filter(|name| !target_set.contains(name.as_str())).cloned().collect(),
        target.iter().filter(|name| !source_set.contains(name.as_str())).cloned().collect(),
        source.iter().filter(|name| target_set.contains(name.as_str())).cloned().collect(),
    )
}

pub fn diff_columns(source: &[ColumnInfo], target: &[ColumnInfo]) -> Vec<ColumnDiff> {
    diff_columns_with_options(source, target, false)
}

fn diff_columns_with_options(source: &[ColumnInfo], target: &[ColumnInfo], ignore_comments: bool) -> Vec<ColumnDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &ColumnInfo> = target.iter().map(|column| (column.name.as_str(), column)).collect();
    let source_map: HashMap<&str, &ColumnInfo> = source.iter().map(|column| (column.name.as_str(), column)).collect();

    for source_column in source {
        if let Some(target_column) = target_map.get(source_column.name.as_str()) {
            let mut changes = Vec::new();
            if source_column.data_type.to_lowercase() != target_column.data_type.to_lowercase() {
                changes.push(format!("type: {} → {}", target_column.data_type, source_column.data_type));
            }
            if source_column.is_nullable != target_column.is_nullable {
                changes.push(format!(
                    "nullable: {} → {}",
                    if target_column.is_nullable { "YES" } else { "NO" },
                    if source_column.is_nullable { "YES" } else { "NO" }
                ));
            }
            if source_column.column_default.as_deref().unwrap_or_default()
                != target_column.column_default.as_deref().unwrap_or_default()
            {
                changes.push(format!(
                    "default: {} → {}",
                    target_column.column_default.as_deref().unwrap_or("NULL"),
                    source_column.column_default.as_deref().unwrap_or("NULL")
                ));
            }
            if !ignore_comments
                && source_column.comment.as_deref().unwrap_or_default()
                    != target_column.comment.as_deref().unwrap_or_default()
            {
                changes.push(format!(
                    "comment: {} → {}",
                    target_column.comment.as_deref().unwrap_or_default(),
                    source_column.comment.as_deref().unwrap_or_default()
                ));
            }
            if !changes.is_empty() {
                diffs.push(ColumnDiff {
                    diff_type: "modified".to_string(),
                    name: source_column.name.clone(),
                    source: Some(source_column.clone()),
                    target: Some((*target_column).clone()),
                    changes,
                });
            }
        } else {
            diffs.push(ColumnDiff {
                diff_type: "added".to_string(),
                name: source_column.name.clone(),
                source: Some(source_column.clone()),
                target: None,
                changes: Vec::new(),
            });
        }
    }

    for target_column in target {
        if !source_map.contains_key(target_column.name.as_str()) {
            diffs.push(ColumnDiff {
                diff_type: "removed".to_string(),
                name: target_column.name.clone(),
                source: None,
                target: Some(target_column.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_indexes(source: &[IndexInfo], target: &[IndexInfo]) -> Vec<IndexDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &IndexInfo> = target.iter().map(|index| (index.name.as_str(), index)).collect();
    let source_map: HashMap<&str, &IndexInfo> = source.iter().map(|index| (index.name.as_str(), index)).collect();

    for source_index in source {
        if source_index.is_primary {
            continue;
        }
        let Some(target_index) = target_map.get(source_index.name.as_str()) else {
            diffs.push(IndexDiff {
                diff_type: "added".to_string(),
                name: source_index.name.clone(),
                source: Some(source_index.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_index.is_unique != target_index.is_unique {
            changes.push(format!(
                "unique: {} → {}",
                if target_index.is_unique { "YES" } else { "NO" },
                if source_index.is_unique { "YES" } else { "NO" }
            ));
        }
        if source_index.columns.join(",") != target_index.columns.join(",") {
            changes.push(format!("columns: {} → {}", target_index.columns.join(", "), source_index.columns.join(", ")));
        }
        if source_index.index_type.as_deref().unwrap_or_default()
            != target_index.index_type.as_deref().unwrap_or_default()
        {
            changes.push(format!(
                "type: {} → {}",
                target_index.index_type.as_deref().unwrap_or("default"),
                source_index.index_type.as_deref().unwrap_or("default")
            ));
        }
        if source_index.filter.as_deref().unwrap_or_default() != target_index.filter.as_deref().unwrap_or_default() {
            changes.push(format!(
                "filter: {} → {}",
                target_index.filter.as_deref().unwrap_or("none"),
                source_index.filter.as_deref().unwrap_or("none")
            ));
        }
        let source_included = source_index.included_columns.clone().unwrap_or_default();
        let target_included = target_index.included_columns.clone().unwrap_or_default();
        if source_included.join(",") != target_included.join(",") {
            changes.push(format!(
                "include: {} → {}",
                if target_included.is_empty() { "none".to_string() } else { target_included.join(", ") },
                if source_included.is_empty() { "none".to_string() } else { source_included.join(", ") }
            ));
        }
        if !changes.is_empty() {
            diffs.push(IndexDiff {
                diff_type: "modified".to_string(),
                name: source_index.name.clone(),
                source: Some(source_index.clone()),
                target: Some((*target_index).clone()),
                changes,
            });
        }
    }

    for target_index in target {
        if target_index.is_primary {
            continue;
        }
        if !source_map.contains_key(target_index.name.as_str()) {
            diffs.push(IndexDiff {
                diff_type: "removed".to_string(),
                name: target_index.name.clone(),
                source: None,
                target: Some(target_index.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_foreign_keys(source: &[ForeignKeyInfo], target: &[ForeignKeyInfo]) -> Vec<ForeignKeyDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &ForeignKeyInfo> = target.iter().map(|fk| (fk.name.as_str(), fk)).collect();
    let source_map: HashMap<&str, &ForeignKeyInfo> = source.iter().map(|fk| (fk.name.as_str(), fk)).collect();

    for source_fk in source {
        let Some(target_fk) = target_map.get(source_fk.name.as_str()) else {
            diffs.push(ForeignKeyDiff {
                diff_type: "added".to_string(),
                name: source_fk.name.clone(),
                source: Some(source_fk.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_fk.column != target_fk.column {
            changes.push(format!("column: {} → {}", target_fk.column, source_fk.column));
        }
        if source_fk.ref_table != target_fk.ref_table {
            changes.push(format!("ref table: {} → {}", target_fk.ref_table, source_fk.ref_table));
        }
        if source_fk.ref_schema != target_fk.ref_schema {
            changes.push(format!(
                "ref schema: {} → {}",
                target_fk.ref_schema.as_deref().unwrap_or(""),
                source_fk.ref_schema.as_deref().unwrap_or("")
            ));
        }
        if source_fk.ref_column != target_fk.ref_column {
            changes.push(format!("ref column: {} → {}", target_fk.ref_column, source_fk.ref_column));
        }
        if !changes.is_empty() {
            diffs.push(ForeignKeyDiff {
                diff_type: "modified".to_string(),
                name: source_fk.name.clone(),
                source: Some(source_fk.clone()),
                target: Some((*target_fk).clone()),
                changes,
            });
        }
    }

    for target_fk in target {
        if !source_map.contains_key(target_fk.name.as_str()) {
            diffs.push(ForeignKeyDiff {
                diff_type: "removed".to_string(),
                name: target_fk.name.clone(),
                source: None,
                target: Some(target_fk.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

pub fn diff_triggers(source: &[TriggerInfo], target: &[TriggerInfo]) -> Vec<TriggerDiff> {
    let mut diffs = Vec::new();
    let target_map: HashMap<&str, &TriggerInfo> =
        target.iter().map(|trigger| (trigger.name.as_str(), trigger)).collect();
    let source_map: HashMap<&str, &TriggerInfo> =
        source.iter().map(|trigger| (trigger.name.as_str(), trigger)).collect();

    for source_trigger in source {
        let Some(target_trigger) = target_map.get(source_trigger.name.as_str()) else {
            diffs.push(TriggerDiff {
                diff_type: "added".to_string(),
                name: source_trigger.name.clone(),
                source: Some(source_trigger.clone()),
                target: None,
                changes: Vec::new(),
            });
            continue;
        };

        let mut changes = Vec::new();
        if source_trigger.event != target_trigger.event {
            changes.push(format!("event: {} → {}", target_trigger.event, source_trigger.event));
        }
        if source_trigger.timing != target_trigger.timing {
            changes.push(format!("timing: {} → {}", target_trigger.timing, source_trigger.timing));
        }
        if !changes.is_empty() {
            diffs.push(TriggerDiff {
                diff_type: "modified".to_string(),
                name: source_trigger.name.clone(),
                source: Some(source_trigger.clone()),
                target: Some((*target_trigger).clone()),
                changes,
            });
        }
    }

    for target_trigger in target {
        if !source_map.contains_key(target_trigger.name.as_str()) {
            diffs.push(TriggerDiff {
                diff_type: "removed".to_string(),
                name: target_trigger.name.clone(),
                source: None,
                target: Some(target_trigger.clone()),
                changes: Vec::new(),
            });
        }
    }

    diffs
}

fn quote_id(name: &str, db_type: DatabaseType) -> String {
    if matches!(db_type, DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks) {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

fn column_def(col: &ColumnInfo, db_type: DatabaseType) -> String {
    let mut definition = format!("{} {}", quote_id(&col.name, db_type), col.data_type);
    if !col.is_nullable {
        definition.push_str(" NOT NULL");
    }
    if let Some(default) = &col.column_default {
        definition.push_str(&format!(" DEFAULT {default}"));
    }
    if matches!(db_type, DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks) {
        if let Some(comment) = &col.comment {
            definition.push_str(&format!(" COMMENT {}", comment_literal(comment)));
        }
    }
    definition
}

fn qualified_name(name: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    schema
        .map(|schema| format!("{}.{}", quote_id(schema, db_type), quote_id(name, db_type)))
        .unwrap_or_else(|| quote_id(name, db_type))
}

fn drop_index_sql(table_name: &str, index_name: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    let table = qualified_name(table_name, db_type, schema);
    let index = qualified_name(index_name, db_type, schema);
    if matches!(db_type, DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks) {
        format!("DROP INDEX {} ON {table};", quote_id(index_name, db_type))
    } else {
        format!("DROP INDEX IF EXISTS {index};")
    }
}

fn create_index_sql(table_name: &str, index: &IndexInfo, db_type: DatabaseType, schema: Option<&str>) -> String {
    let table = qualified_name(table_name, db_type, schema);
    let columns = index.columns.iter().map(|column| quote_id(column, db_type)).collect::<Vec<_>>().join(", ");
    let unique = if index.is_unique { "UNIQUE " } else { "" };
    let index_type = index.index_type.as_deref().unwrap_or_default();
    let using_clause = if !index_type.is_empty() && db_type == DatabaseType::Postgres {
        format!(" USING {index_type}")
    } else {
        String::new()
    };
    let type_prefix = if !index_type.is_empty() && db_type == DatabaseType::SqlServer {
        format!("{index_type} ")
    } else {
        String::new()
    };
    let included_columns = index.included_columns.clone().unwrap_or_default();
    let include_clause =
        if !included_columns.is_empty() && matches!(db_type, DatabaseType::Postgres | DatabaseType::SqlServer) {
            format!(
                " INCLUDE ({})",
                included_columns.iter().map(|column| quote_id(column, db_type)).collect::<Vec<_>>().join(", ")
            )
        } else {
            String::new()
        };
    let supports_where = matches!(db_type, DatabaseType::Postgres | DatabaseType::SqlServer | DatabaseType::Sqlite);
    let filter = if supports_where { index.filter.as_deref().unwrap_or_default() } else { "" };
    let filter_clause = if filter.is_empty() { String::new() } else { format!(" WHERE {filter}") };
    format!(
        "CREATE {unique}{type_prefix}INDEX {} ON {table}{using_clause} ({columns}){include_clause}{filter_clause};",
        quote_id(&index.name, db_type)
    )
}

fn drop_foreign_key_sql(table_name: &str, fk_name: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    let table = qualified_name(table_name, db_type, schema);
    let fk = quote_id(fk_name, db_type);
    if matches!(db_type, DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks) {
        format!("ALTER TABLE {table} DROP FOREIGN KEY {fk};")
    } else {
        format!("ALTER TABLE {table} DROP CONSTRAINT {fk};")
    }
}

fn add_foreign_key_sql(table_name: &str, fk: &ForeignKeyInfo, db_type: DatabaseType, schema: Option<&str>) -> String {
    let table = qualified_name(table_name, db_type, schema);
    format!(
        "ALTER TABLE {table} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({});",
        quote_id(&fk.name, db_type),
        quote_id(&fk.column, db_type),
        quote_id(&fk.ref_table, db_type),
        quote_id(&fk.ref_column, db_type)
    )
}

fn drop_object_sql(diff: &TableDiff, db_type: DatabaseType, schema: Option<&str>) -> String {
    let object_type = if diff.object_type.as_deref() == Some("view") { "VIEW" } else { "TABLE" };
    format!("DROP {object_type} IF EXISTS {};", qualified_name(&diff.name, db_type, schema))
}

fn comment_literal(comment: &str) -> String {
    format!("'{}'", comment.replace('\'', "''"))
}

fn column_comment_sql(
    table_name: &str,
    column_name: &str,
    comment: &str,
    db_type: DatabaseType,
    schema: Option<&str>,
) -> String {
    if matches!(db_type, DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks) {
        return format!(
            "-- Column comment for {column_name}: use ALTER TABLE ... MODIFY COLUMN to set comment in MySQL"
        );
    }
    let table = qualified_name(table_name, db_type, schema);
    format!("COMMENT ON COLUMN {table}.{} IS {};", quote_id(column_name, db_type), comment_literal(comment))
}

fn table_comment_sql(table_name: &str, comment: &str, db_type: DatabaseType, schema: Option<&str>) -> String {
    let table = qualified_name(table_name, db_type, schema);
    if matches!(db_type, DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks) {
        format!("ALTER TABLE {table} COMMENT = {};", comment_literal(comment))
    } else {
        format!("COMMENT ON TABLE {table} IS {};", comment_literal(comment))
    }
}

pub fn generate_schema_sync_sql(diffs: &[TableDiff], db_type: DatabaseType, schema: Option<&str>) -> String {
    let mut lines = Vec::new();
    let is_mysql = matches!(db_type, DatabaseType::Mysql | DatabaseType::Doris | DatabaseType::StarRocks);

    for diff in diffs {
        let table = qualified_name(&diff.name, db_type, schema);

        if diff.diff_type == "added" && diff.ddl.is_some() {
            lines.push(format!("-- Create {}: {}", diff.object_type.as_deref().unwrap_or("table"), diff.name));
            lines.push(format!("{};", diff.ddl.as_deref().unwrap_or_default()));
            lines.push(String::new());
            continue;
        }

        if diff.diff_type == "added" && diff.object_type.as_deref() == Some("view") {
            lines.push(format!("-- View exists only in source: {}", diff.name));
            lines.push("-- Source view definition is not available from this driver yet.".to_string());
            lines.push(String::new());
            continue;
        }

        if diff.diff_type == "removed" {
            lines.push(format!("-- Drop {}: {}", diff.object_type.as_deref().unwrap_or("table"), diff.name));
            lines.push(drop_object_sql(diff, db_type, schema));
            lines.push(String::new());
            continue;
        }

        if diff.diff_type != "modified" {
            continue;
        }

        let mut parts = Vec::new();
        if let Some(foreign_keys) = &diff.foreign_keys {
            for fk in foreign_keys {
                if fk.diff_type == "removed" || fk.diff_type == "modified" {
                    lines.push(drop_foreign_key_sql(&diff.name, &fk.name, db_type, schema));
                }
            }
        }

        if let Some(columns) = &diff.columns {
            for column in columns {
                match column.diff_type.as_str() {
                    "added" => {
                        if let Some(source) = &column.source {
                            parts.push(format!("  ADD COLUMN {}", column_def(source, db_type)));
                        }
                    }
                    "removed" => {
                        parts.push(format!("  DROP COLUMN {}", quote_id(&column.name, db_type)));
                    }
                    "modified" => {
                        if let Some(source) = &column.source {
                            if is_mysql {
                                parts.push(format!("  MODIFY COLUMN {}", column_def(source, db_type)));
                            } else {
                                let name = quote_id(&column.name, db_type);
                                if column.changes.iter().any(|change| change.starts_with("type:")) {
                                    parts.push(format!("  ALTER COLUMN {name} TYPE {}", source.data_type));
                                }
                                if column.changes.iter().any(|change| change.starts_with("nullable:")) {
                                    parts.push(if source.is_nullable {
                                        format!("  ALTER COLUMN {name} DROP NOT NULL")
                                    } else {
                                        format!("  ALTER COLUMN {name} SET NOT NULL")
                                    });
                                }
                                if column.changes.iter().any(|change| change.starts_with("default:")) {
                                    parts.push(if let Some(default) = &source.column_default {
                                        format!("  ALTER COLUMN {name} SET DEFAULT {default}")
                                    } else {
                                        format!("  ALTER COLUMN {name} DROP DEFAULT")
                                    });
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        if !parts.is_empty() {
            lines.push(format!("-- Alter table: {}", diff.name));
            if is_mysql {
                lines.push(format!("ALTER TABLE {table}"));
                lines.push(format!("{};", parts.join(",\n")));
            } else {
                for part in parts {
                    lines.push(format!("ALTER TABLE {table}{part};"));
                }
            }
            lines.push(String::new());
        }

        if !is_mysql {
            if let Some(columns) = &diff.columns {
                for column in columns {
                    if let Some(source) = &column.source {
                        if column.changes.iter().any(|change| change.starts_with("comment:")) {
                            lines.push(column_comment_sql(
                                &diff.name,
                                &column.name,
                                source.comment.as_deref().unwrap_or_default(),
                                db_type,
                                schema,
                            ));
                        }
                        if column.diff_type == "added" {
                            if let Some(comment) = &source.comment {
                                lines.push(column_comment_sql(&diff.name, &column.name, comment, db_type, schema));
                            }
                        }
                    }
                }
            }
        }

        if diff.source_table_comment.is_some() && diff.source_table_comment != diff.target_table_comment {
            let comment = diff.source_table_comment.as_ref().and_then(|comment| comment.as_deref()).unwrap_or_default();
            lines.push(table_comment_sql(&diff.name, comment, db_type, schema));
        }

        if let Some(indexes) = &diff.indexes {
            for index in indexes {
                match index.diff_type.as_str() {
                    "added" => {
                        if let Some(source) = &index.source {
                            lines.push(create_index_sql(&diff.name, source, db_type, schema));
                        }
                    }
                    "removed" => lines.push(drop_index_sql(&diff.name, &index.name, db_type, schema)),
                    "modified" => {
                        if let Some(source) = &index.source {
                            lines.push(drop_index_sql(&diff.name, &index.name, db_type, schema));
                            lines.push(create_index_sql(&diff.name, source, db_type, schema));
                        }
                    }
                    _ => {}
                }
            }
        }

        if let Some(foreign_keys) = &diff.foreign_keys {
            for fk in foreign_keys {
                if fk.diff_type == "added" || fk.diff_type == "modified" {
                    if let Some(source) = fk.source.as_ref() {
                        lines.push(add_foreign_key_sql(&diff.name, source, db_type, schema));
                    }
                }
            }
        }

        if let Some(triggers) = &diff.triggers {
            for trigger in triggers {
                lines.push(format!(
                    "-- Trigger {}: {} on {}; review trigger definition manually.",
                    trigger.diff_type, trigger.name, diff.name
                ));
            }
        }

        if diff.indexes.as_ref().is_some_and(|indexes| !indexes.is_empty())
            || diff.foreign_keys.as_ref().is_some_and(|foreign_keys| !foreign_keys.is_empty())
            || diff.triggers.as_ref().is_some_and(|triggers| !triggers.is_empty())
        {
            lines.push(String::new());
        }

        if db_type == DatabaseType::Sqlite
            && diff.foreign_keys.as_ref().is_some_and(|foreign_keys| !foreign_keys.is_empty())
        {
            lines.push(format!("-- SQLite foreign key synchronization may require table rebuild for: {}", diff.name));
            lines.push(String::new());
        }
    }

    lines.join("\n").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn index(overrides: IndexInfo) -> IndexInfo {
        IndexInfo {
            name: if overrides.name.is_empty() { "idx_users_email".to_string() } else { overrides.name },
            columns: if overrides.columns.is_empty() { vec!["email".to_string()] } else { overrides.columns },
            is_unique: overrides.is_unique,
            is_primary: overrides.is_primary,
            filter: overrides.filter,
            index_type: overrides.index_type,
            included_columns: overrides.included_columns,
            comment: overrides.comment,
        }
    }

    fn foreign_key(overrides: ForeignKeyInfo) -> ForeignKeyInfo {
        ForeignKeyInfo {
            name: if overrides.name.is_empty() { "orders_user_id_fk".to_string() } else { overrides.name },
            column: if overrides.column.is_empty() { "user_id".to_string() } else { overrides.column },
            ref_schema: overrides.ref_schema,
            ref_table: if overrides.ref_table.is_empty() { "users".to_string() } else { overrides.ref_table },
            ref_column: if overrides.ref_column.is_empty() { "id".to_string() } else { overrides.ref_column },
        }
    }

    fn column(name: &str, data_type: &str, comment: Option<&str>) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable: false,
            column_default: None,
            is_primary_key: false,
            extra: None,
            comment: comment.map(str::to_string),
            numeric_precision: None,
            numeric_scale: None,
            character_maximum_length: None,
        }
    }

    #[test]
    fn detects_modified_indexes_not_only_added_or_removed_indexes() {
        let diffs = diff_indexes(
            &[index(IndexInfo {
                name: "idx_orders_status".to_string(),
                columns: vec!["status".to_string(), "created_at".to_string()],
                is_unique: false,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
            })],
            &[index(IndexInfo {
                name: "idx_orders_status".to_string(),
                columns: vec!["status".to_string()],
                is_unique: true,
                is_primary: false,
                filter: None,
                index_type: None,
                included_columns: None,
                comment: None,
            })],
        );

        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].diff_type, "modified");
        assert_eq!(diffs[0].changes, vec!["unique: YES → NO", "columns: status → status, created_at"]);
    }

    #[test]
    fn detects_foreign_key_additions_removals_and_target_changes() {
        let diffs = diff_foreign_keys(
            &[
                foreign_key(ForeignKeyInfo {
                    name: "orders_user_id_fk".to_string(),
                    column: String::new(),
                    ref_schema: None,
                    ref_table: String::new(),
                    ref_column: String::new(),
                }),
                foreign_key(ForeignKeyInfo {
                    name: "orders_account_id_fk".to_string(),
                    column: "account_id".to_string(),
                    ref_schema: None,
                    ref_table: "accounts".to_string(),
                    ref_column: String::new(),
                }),
            ],
            &[
                foreign_key(ForeignKeyInfo {
                    name: "orders_user_id_fk".to_string(),
                    column: String::new(),
                    ref_schema: None,
                    ref_table: "members".to_string(),
                    ref_column: String::new(),
                }),
                foreign_key(ForeignKeyInfo {
                    name: "orders_region_id_fk".to_string(),
                    column: "region_id".to_string(),
                    ref_schema: None,
                    ref_table: "regions".to_string(),
                    ref_column: String::new(),
                }),
            ],
        );

        let summary: Vec<_> = diffs.iter().map(|diff| (diff.diff_type.as_str(), diff.name.as_str())).collect();
        assert_eq!(
            summary,
            vec![
                ("modified", "orders_user_id_fk"),
                ("added", "orders_account_id_fk"),
                ("removed", "orders_region_id_fk"),
            ]
        );
    }

    #[test]
    fn generates_sync_sql_for_index_and_foreign_key_changes() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: None,
            name: "orders".to_string(),
            columns: None,
            indexes: Some(vec![IndexDiff {
                diff_type: "modified".to_string(),
                name: "idx_orders_status".to_string(),
                source: Some(index(IndexInfo {
                    name: "idx_orders_status".to_string(),
                    columns: vec!["status".to_string(), "created_at".to_string()],
                    is_unique: true,
                    is_primary: false,
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                })),
                target: None,
                changes: Vec::new(),
            }]),
            foreign_keys: Some(vec![ForeignKeyDiff {
                diff_type: "modified".to_string(),
                name: "orders_user_id_fk".to_string(),
                source: Some(foreign_key(ForeignKeyInfo {
                    name: "orders_user_id_fk".to_string(),
                    column: String::new(),
                    ref_schema: None,
                    ref_table: "users".to_string(),
                    ref_column: String::new(),
                })),
                target: None,
                changes: Vec::new(),
            }]),
            triggers: None,
            ddl: None,
            source_table_comment: None,
            target_table_comment: None,
        }];

        assert_eq!(
            generate_schema_sync_sql(&diffs, DatabaseType::Postgres, None),
            [
                "ALTER TABLE \"orders\" DROP CONSTRAINT \"orders_user_id_fk\";",
                "DROP INDEX IF EXISTS \"idx_orders_status\";",
                "CREATE UNIQUE INDEX \"idx_orders_status\" ON \"orders\" (\"status\", \"created_at\");",
                "ALTER TABLE \"orders\" ADD CONSTRAINT \"orders_user_id_fk\" FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\");",
            ]
            .join("\n")
        );
    }

    #[test]
    fn mysql_column_comment_changes_generate_modify_column_sql() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: None,
            name: "users".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "modified".to_string(),
                name: "name".to_string(),
                source: Some(column("name", "varchar(64)", Some("用户姓名"))),
                target: Some(column("name", "varchar(64)", Some("Name"))),
                changes: vec!["comment: Name → 用户姓名".to_string()],
            }]),
            indexes: None,
            foreign_keys: None,
            triggers: None,
            ddl: None,
            source_table_comment: Some(Some("用户表".to_string())),
            target_table_comment: Some(Some("Users".to_string())),
        }];

        assert_eq!(
            generate_schema_sync_sql(&diffs, DatabaseType::Mysql, None),
            [
                "-- Alter table: users",
                "ALTER TABLE `users`",
                "  MODIFY COLUMN `name` varchar(64) NOT NULL COMMENT '用户姓名';",
                "",
                "ALTER TABLE `users` COMMENT = '用户表';",
            ]
            .join("\n")
        );
    }

    #[test]
    fn ignore_comments_skips_column_and_table_comment_diffs() {
        let options = SchemaDiffPreparationOptions {
            source_tables: vec![TableInfo {
                name: "users".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: Some("用户表".to_string()),
                parent_schema: None,
                parent_name: None,
            }],
            target_tables: vec![TableInfo {
                name: "users".to_string(),
                table_type: "BASE TABLE".to_string(),
                comment: Some("Users".to_string()),
                parent_schema: None,
                parent_name: None,
            }],
            source_details: vec![TableSchemaDetail {
                name: "users".to_string(),
                columns: vec![column("name", "varchar(64)", Some("用户姓名"))],
                indexes: Vec::new(),
                foreign_keys: Vec::new(),
                triggers: Vec::new(),
                ddl: None,
            }],
            target_details: vec![TableSchemaDetail {
                name: "users".to_string(),
                columns: vec![column("name", "varchar(64)", Some("Name"))],
                indexes: Vec::new(),
                foreign_keys: Vec::new(),
                triggers: Vec::new(),
                ddl: None,
            }],
            database_type: DatabaseType::Mysql,
            target_schema: None,
            ignore_comments: true,
        };

        let result = prepare_schema_diff(options);
        assert!(result.diffs.is_empty());
        assert!(result.sync_sql.is_empty());
    }

    #[test]
    fn qualifies_generated_schema_sync_sql_with_target_schema() {
        let diffs = vec![TableDiff {
            diff_type: "modified".to_string(),
            object_type: None,
            name: "orders".to_string(),
            columns: Some(vec![ColumnDiff {
                diff_type: "added".to_string(),
                name: "status".to_string(),
                source: Some(ColumnInfo {
                    name: "status".to_string(),
                    data_type: "text".to_string(),
                    is_nullable: true,
                    column_default: None,
                    is_primary_key: false,
                    extra: None,
                    comment: None,
                    numeric_precision: None,
                    numeric_scale: None,
                    character_maximum_length: None,
                }),
                target: None,
                changes: Vec::new(),
            }]),
            indexes: Some(vec![IndexDiff {
                diff_type: "added".to_string(),
                name: "idx_orders_status".to_string(),
                source: Some(index(IndexInfo {
                    name: "idx_orders_status".to_string(),
                    columns: vec!["status".to_string()],
                    is_unique: false,
                    is_primary: false,
                    filter: None,
                    index_type: None,
                    included_columns: None,
                    comment: None,
                })),
                target: None,
                changes: Vec::new(),
            }]),
            foreign_keys: None,
            triggers: None,
            ddl: None,
            source_table_comment: None,
            target_table_comment: None,
        }];

        assert_eq!(
            generate_schema_sync_sql(&diffs, DatabaseType::Postgres, Some("sales")),
            [
                "-- Alter table: orders",
                "ALTER TABLE \"sales\".\"orders\"  ADD COLUMN \"status\" text;",
                "",
                "CREATE INDEX \"idx_orders_status\" ON \"sales\".\"orders\" (\"status\");",
            ]
            .join("\n")
        );
    }
}
