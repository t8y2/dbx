use crate::models::connection::DatabaseType;
use crate::table_import::{mapping_indexes_for_columns, ImportSqlBatch, TableImportColumnMapping};
use crate::transfer::{generate_insert_typed, quote_identifier, ImportConflictHandling};

use super::sql_limits::build_sql_batches;

pub(crate) fn build_import_insert_batches(
    rows: &[Vec<serde_json::Value>],
    source_columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    max_rows: usize,
    conflict_handling: ImportConflictHandling,
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
    let rows = rows
        .iter()
        .map(|row| {
            mapped
                .iter()
                .map(|(source_index, _)| row.get(*source_index).cloned().unwrap_or(serde_json::Value::Null))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    build_sql_batches(rows.len(), max_rows, "import row", |range| {
        // The conflict clause is appended inside the render closure so the
        // statement-size budget accounts for it.
        let sql = generate_insert_typed(
            &columns,
            &column_types,
            &rows[range],
            table,
            schema,
            &DatabaseType::CloudflareD1,
            None,
        );
        append_import_conflict_clause(sql, &conflict_handling, &columns)
    })
    .map(|batches| {
        batches.into_iter().map(|batch| ImportSqlBatch { sql: batch.sql, row_count: batch.item_count }).collect()
    })
}

/// Appends the D1 (SQLite-family) conflict clause to a rendered INSERT statement.
fn append_import_conflict_clause(
    sql: String,
    conflict_handling: &ImportConflictHandling,
    columns: &[String],
) -> String {
    match conflict_handling {
        ImportConflictHandling::None => sql,
        ImportConflictHandling::SkipExisting => format!("{sql}\nON CONFLICT DO NOTHING"),
        ImportConflictHandling::Upsert { key_columns } => {
            if key_columns.is_empty() {
                return sql;
            }
            let key_list = key_columns
                .iter()
                .map(|column| quote_identifier(column, &DatabaseType::CloudflareD1))
                .collect::<Vec<_>>()
                .join(", ");
            let non_key_columns: Vec<&String> = columns.iter().filter(|column| !key_columns.contains(column)).collect();
            if non_key_columns.is_empty() {
                format!("{sql}\nON CONFLICT ({key_list}) DO NOTHING")
            } else {
                let update_set = non_key_columns
                    .iter()
                    .map(|column| {
                        let quoted = quote_identifier(column, &DatabaseType::CloudflareD1);
                        format!("{quoted} = EXCLUDED.{quoted}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{sql}\nON CONFLICT ({key_list}) DO UPDATE SET {update_set}")
            }
        }
    }
}

pub(crate) fn build_streaming_import_insert_batch(
    rows: &[Vec<serde_json::Value>],
    source_columns: &[String],
    mappings: &[TableImportColumnMapping],
    target_column_types: &[(String, String)],
    table: &str,
    schema: &str,
    max_rows: usize,
    conflict_handling: ImportConflictHandling,
) -> Result<Option<ImportSqlBatch>, String> {
    let batches = build_import_insert_batches(
        rows,
        source_columns,
        mappings,
        target_column_types,
        table,
        schema,
        max_rows,
        conflict_handling,
    )?;
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
    fn import_batches_append_d1_conflict_clauses() {
        let rows = vec![vec![serde_json::json!(1), serde_json::json!("a")]];
        let columns = vec!["id".to_string(), "name".to_string()];
        let mappings = vec![
            TableImportColumnMapping {
                source_column: "id".to_string(),
                target_column: "id".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "name".to_string(),
                target_column: "name".to_string(),
                target_data_type: None,
            },
        ];

        let skip = build_import_insert_batches(
            &rows,
            &columns,
            &mappings,
            &[],
            "events",
            "main",
            100,
            ImportConflictHandling::SkipExisting,
        )
        .unwrap();
        assert_eq!(skip.len(), 1);
        assert!(skip[0].sql.ends_with("ON CONFLICT DO NOTHING"), "{}", skip[0].sql);

        let upsert = build_import_insert_batches(
            &rows,
            &columns,
            &mappings,
            &[],
            "events",
            "main",
            100,
            ImportConflictHandling::Upsert { key_columns: vec!["id".to_string()] },
        )
        .unwrap();
        assert_eq!(upsert.len(), 1);
        assert!(
            upsert[0].sql.ends_with("ON CONFLICT (\"id\") DO UPDATE SET \"name\" = EXCLUDED.\"name\""),
            "{}",
            upsert[0].sql
        );
    }
}
