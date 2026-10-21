use crate::models::connection::DatabaseType;
use crate::table_import::{
    mapping_indexes_for_columns, sql_import_is_current_timestamp_value, ImportSqlBatch, TableImportColumnMapping,
};
use crate::transfer::generate_insert_typed;

use super::sql_limits::build_sql_batches;

/// Sentinel used to carry the "current timestamp" import marker through
/// `generate_insert_typed` (which only renders literals), replaced back with
/// the CURRENT_TIMESTAMP keyword afterwards. Control-character framing keeps
/// it from appearing in user data; if it ever does, we fail closed instead of
/// silently rewriting the cell.
const D1_CURRENT_TIMESTAMP_TOKEN: &str = "\u{1}dbx_current_timestamp\u{1}";

pub(crate) fn build_import_insert_batches(
    rows: &[Vec<serde_json::Value>],
    source_columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    max_rows: usize,
) -> Result<Vec<ImportSqlBatch>, String> {
    let mapped = mapping_indexes_for_columns(source_columns, mappings)?;
    let columns = mapped.iter().map(|(_, target)| target.clone()).collect::<Vec<_>>();
    let column_types = columns
        .iter()
        .map(|column| {
            target_column_types
                .iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(column))
                .map(|(_, data_type)| data_type.clone())
        })
        .collect::<Vec<_>>();
    if rows.iter().any(|row| {
        row.iter()
            .any(|value| matches!(value, serde_json::Value::String(text) if text.contains(D1_CURRENT_TIMESTAMP_TOKEN)))
    }) {
        return Err("import data contains a reserved expression token".to_string());
    }
    let rows = rows
        .iter()
        .map(|row| {
            mapped
                .iter()
                .map(|(source_index, _)| {
                    let value = row.get(*source_index).cloned().unwrap_or(serde_json::Value::Null);
                    if sql_import_is_current_timestamp_value(&value) {
                        serde_json::Value::String(D1_CURRENT_TIMESTAMP_TOKEN.to_string())
                    } else {
                        value
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    build_sql_batches(rows.len(), max_rows, "import row", |range| {
        generate_insert_typed(&columns, &column_types, &rows[range], table, schema, &DatabaseType::CloudflareD1, None)
    })
    .map(|batches| {
        batches
            .into_iter()
            .map(|batch| {
                let sql = batch.sql.replace(&format!("'{}'", D1_CURRENT_TIMESTAMP_TOKEN), "CURRENT_TIMESTAMP");
                ImportSqlBatch { sql, row_count: batch.item_count }
            })
            .collect()
    })
}

pub(crate) fn build_streaming_import_insert_batch(
    rows: &[Vec<serde_json::Value>],
    source_columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    max_rows: usize,
) -> Result<Option<ImportSqlBatch>, String> {
    let batches =
        build_import_insert_batches(rows, source_columns, mappings, target_column_types, table, schema, max_rows)?;
    if batches.is_empty() {
        return Ok(None);
    }
    let row_count = batches.iter().map(|batch| batch.row_count).sum();
    let sql = batches.into_iter().map(|batch| batch.sql).collect::<Vec<_>>().join(";\n");
    Ok(Some(ImportSqlBatch { sql, row_count }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_import_joins_individually_size_limited_statements() {
        let rows = vec![vec![serde_json::json!("a".repeat(60_000))], vec![serde_json::json!("b".repeat(60_000))]];
        let columns = vec!["value".to_string()];
        let mappings = vec![TableImportColumnMapping {
            source_column: "value".to_string(),
            target_column: "value".to_string(),
            target_data_type: None,
        }];

        let batch = crate::table_import::build_import_insert_batch_from_rows(
            &rows,
            &columns,
            &mappings,
            &[],
            "events",
            "main",
            &DatabaseType::CloudflareD1,
        )
        .unwrap()
        .unwrap();

        assert_eq!(batch.row_count, 2);
        assert_eq!(batch.sql.split(";\n").count(), 2);
        assert!(batch.sql.split(";\n").all(|statement| statement.len() <= super::super::MAX_SQL_STATEMENT_BYTES));
    }

    #[test]
    fn sql_import_current_timestamp_marker_becomes_the_keyword() {
        let marker = serde_json::json!({ "$dbxSqlImportExpression": "currentTimestamp" });
        let rows = vec![vec![serde_json::Value::from(1), marker]];
        let columns = vec!["id".to_string(), "created_at".to_string()];
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "id".to_string(),
                target_column: "id".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "created_at".to_string(),
                target_column: "created_at".to_string(),
                target_data_type: None,
            },
        ];

        let batch = crate::table_import::build_import_insert_batch_from_rows(
            &rows,
            &columns,
            &mappings,
            &[],
            "events",
            "main",
            &DatabaseType::CloudflareD1,
        )
        .unwrap()
        .unwrap();

        assert!(batch.sql.contains("CURRENT_TIMESTAMP"), "sql: {}", batch.sql);
        assert!(!batch.sql.contains("$dbxSqlImportExpression"), "sql: {}", batch.sql);
        assert!(!batch.sql.contains(D1_CURRENT_TIMESTAMP_TOKEN), "sql: {}", batch.sql);
    }

    #[test]
    fn row_data_containing_the_sentinel_token_fails_closed() {
        let rows = vec![vec![serde_json::Value::String(D1_CURRENT_TIMESTAMP_TOKEN.to_string())]];
        let columns = vec!["payload".to_string()];
        let mappings = vec![TableImportColumnMapping {
            source_column: "payload".to_string(),
            target_column: "payload".to_string(),
            target_data_type: None,
        }];

        let result = crate::table_import::build_import_insert_batch_from_rows(
            &rows,
            &columns,
            &mappings,
            &[],
            "events",
            "main",
            &DatabaseType::CloudflareD1,
        );

        assert!(
            result.is_err(),
            "expected reserved-token rejection, got: {:?}",
            result.ok().flatten().map(|batch| batch.sql)
        );
    }
}
