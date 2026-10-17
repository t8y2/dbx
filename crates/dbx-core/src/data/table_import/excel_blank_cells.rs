use super::*;

fn column_uses_generated_value(column: &crate::db::ColumnInfo, db_type: &DatabaseType) -> bool {
    column.extra.as_deref().is_some_and(|extra| {
        let extra = extra.to_ascii_lowercase();
        extra.contains("auto_increment")
            || extra.contains("autoincrement")
            || extra.contains("identity")
            || extra.contains("generated")
            || extra.contains("computed")
    }) || (*db_type == DatabaseType::SqlServer
        && matches!(column.data_type.trim().to_ascii_lowercase().as_str(), "timestamp" | "rowversion"))
}

fn column_is_computed(column: &crate::db::ColumnInfo, db_type: &DatabaseType) -> bool {
    let extra = column.extra.as_deref();
    let normalized = extra.unwrap_or_default().trim().to_ascii_lowercase();
    let parts = normalized.split_whitespace().collect::<Vec<_>>();
    let generated_identity = matches!(
        parts.as_slice(),
        ["generated", "always", "as", "identity", ..] | ["generated", "by", "default", "as", "identity", ..]
    );
    extra.is_some_and(|extra| extra.to_ascii_lowercase().contains("computed"))
        || (crate::data::transfer::is_mysql_generated_column_extra(extra) && !generated_identity)
        || (*db_type == DatabaseType::SqlServer
            && matches!(column.data_type.trim().to_ascii_lowercase().as_str(), "timestamp" | "rowversion"))
}

fn sqlserver_identity_insert_scope(table: &str, sql: &str) -> String {
    // Keep both toggles and the write in one session, including error cleanup.
    format!("BEGIN TRY\nSET IDENTITY_INSERT {table} ON;\n{sql};\nSET IDENTITY_INSERT {table} OFF;\nEND TRY\nBEGIN CATCH\nSET IDENTITY_INSERT {table} OFF;\nTHROW;\nEND CATCH")
}

/// Compile the policy from live target metadata, never from client-provided
/// defaults or preview values. The database evaluates defaults itself.
pub(super) struct ExcelImportPolicy {
    plan: CompiledImportPlan,
    columns: Vec<crate::db::ColumnInfo>,
    db_type: DatabaseType,
}

impl ExcelImportPolicy {
    pub(super) fn new(
        source_columns: &[String],
        mappings: &[TableImportColumnMapping],
        target_columns: &[crate::db::ColumnInfo],
        db_type: &DatabaseType,
    ) -> Result<Self, String> {
        let target_types =
            target_columns.iter().map(|column| (column.name.clone(), column.data_type.clone())).collect::<Vec<_>>();
        let plan = compile_import_plan(source_columns, mappings, &target_types)?;
        for column in target_columns {
            if !column.is_nullable
                && column.column_default.is_none()
                && !column_uses_generated_value(column, db_type)
                && !plan.target_columns.iter().any(|name| name.eq_ignore_ascii_case(&column.name))
            {
                return Err(format!(
                    "Excel import required target column '{}' has no mapping and no default",
                    column.name
                ));
            }
        }
        let columns = plan
            .target_columns
            .iter()
            .map(|name| {
                target_columns.iter().find(|column| column.name.eq_ignore_ascii_case(name)).cloned().ok_or_else(|| {
                    format!("Cannot verify Excel blank-cell policy: target column '{name}' metadata is unavailable")
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { plan, columns, db_type: *db_type })
    }

    fn omitted_columns(
        &self,
        rows: &[Vec<serde_json::Value>],
        metadata: &ExcelImportMetadata,
    ) -> Result<Vec<Vec<usize>>, String> {
        if rows.len() != metadata.blank_cells.len() || rows.len() != metadata.row_numbers.len() {
            return Err("Excel import cell provenance is incomplete".to_string());
        }
        rows.iter().enumerate().map(|(row_index, row)| {
            let row_number = metadata.row_numbers[row_index];
            let blanks = &metadata.blank_cells[row_index];
            let mut omitted = Vec::new();
            for (target_index, source_index) in self.plan.mapped_source_indexes.iter().enumerate() {
                let column = &self.columns[target_index];
                let value = row.get(*source_index).ok_or_else(|| "Excel import row is shorter than its column mapping".to_string())?;
                if blanks.contains(source_index) && column_is_computed(column, &self.db_type) {
                    omitted.push(target_index);
                    continue;
                }
                if column.is_nullable { continue; }
                if blanks.contains(source_index) {
                    let generated = column_uses_generated_value(column, &self.db_type);
                    if column.column_default.is_some() || generated {
                        omitted.push(target_index);
                    } else {
                        return Err(format!("Excel row {row_number}, column '{}': blank cell cannot be imported into a NOT NULL column without a default", column.name));
                    }
                } else if value.is_null() {
                    return Err(format!("Excel row {row_number}, column '{}': explicit NULL cannot be imported into a NOT NULL column", column.name));
                }
            }
            Ok(omitted)
        }).collect()
    }

    pub(super) fn validate(
        &self,
        rows: &[Vec<serde_json::Value>],
        metadata: &ExcelImportMetadata,
    ) -> Result<(), String> {
        self.omitted_columns(rows, metadata).map(|_| ())
    }

    pub(super) fn can_use_full_column_plan(
        &self,
        rows: &[Vec<serde_json::Value>],
        metadata: &ExcelImportMetadata,
    ) -> Result<bool, String> {
        Ok(self.omitted_columns(rows, metadata)?.iter().all(Vec::is_empty))
    }

    fn update_columns(&self) -> Vec<String> {
        self.plan
            .target_columns
            .iter()
            .zip(&self.columns)
            .filter(|(_, column)| !column_is_computed(column, &self.db_type))
            .map(|(name, _)| name.clone())
            .collect()
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn sql_batches(
        &self,
        rows: &[Vec<serde_json::Value>],
        metadata: &ExcelImportMetadata,
        table: &str,
        schema: &str,
        db_type: &DatabaseType,
        kingbase_oracle_mode: bool,
        conflict_policy: TableImportConflictPolicy,
        primary_key_columns: &[String],
        date_time_format: Option<&str>,
        hard_sql_bytes: Option<usize>,
    ) -> Result<Vec<ImportSqlBatch>, String> {
        let omitted = self.omitted_columns(rows, metadata)?;
        let mut batches = Vec::new();
        let mut start = 0;
        while start < rows.len() {
            let mut end = start + 1;
            // Group only adjacent equal column lists: changing source order can
            // change duplicate-key and update-existing import behavior.
            while end < rows.len() && omitted[end] == omitted[start] {
                end += 1;
            }
            let included =
                (0..self.plan.target_columns.len()).filter(|index| !omitted[start].contains(index)).collect::<Vec<_>>();
            let plan = CompiledImportPlan {
                mapped_source_indexes: included.iter().map(|&index| self.plan.mapped_source_indexes[index]).collect(),
                target_columns: included.iter().map(|&index| self.plan.target_columns[index].clone()).collect(),
                column_types: included.iter().map(|&index| self.plan.column_types[index].clone()).collect(),
            };
            let identity_table = (*db_type == DatabaseType::SqlServer
                && included.iter().any(|&index| {
                    crate::data::transfer::is_identity_column_extra(self.columns[index].extra.as_deref())
                }))
            .then(|| qualified_table(table, schema, db_type, None));
            let group_hard_sql_bytes = match (&identity_table, hard_sql_bytes) {
                (Some(table), Some(limit)) => {
                    let overhead =
                        crate::data::transfer::sql_text_bytes(&sqlserver_identity_insert_scope(table, ""), db_type);
                    Some(
                        limit
                            .checked_sub(overhead)
                            .filter(|limit| *limit > 0)
                            .ok_or_else(|| "Excel IDENTITY_INSERT scope exceeds the SQL size limit".to_string())?,
                    )
                }
                _ => hard_sql_bytes,
            };
            let batch_start = batches.len();
            if plan.target_columns.is_empty() {
                let sql = self.default_row_sql(table, schema, db_type, conflict_policy, primary_key_columns)?;
                if group_hard_sql_bytes
                    .is_some_and(|limit| crate::data::transfer::sql_text_bytes(&sql, db_type) > limit)
                {
                    return Err("Excel default-row INSERT exceeds the SQL size limit".to_string());
                }
                batches.extend((start..end).map(|_| ImportSqlBatch { sql: sql.clone(), row_count: 1 }));
            } else if conflict_policy == TableImportConflictPolicy::UpdateExisting {
                let value_rows =
                    import_value_rows_sql(&rows[start..end], &plan, db_type, kingbase_oracle_mode, date_time_format);
                let limits =
                    SqlBatchLimits::for_database(db_type, end - start).with_hard_sql_bytes(group_hard_sql_bytes);
                batches.extend(
                    crate::data::transfer::generate_primary_key_upsert_sql_batches_from_value_rows_with_update_columns(
                        &plan.target_columns,
                        &self.update_columns(),
                        &value_rows,
                        table,
                        schema,
                        db_type,
                        None,
                        limits,
                        primary_key_columns,
                    )?
                    .into_iter()
                    .map(|(sql, row_count)| ImportSqlBatch { sql, row_count }),
                );
            } else {
                batches.extend(build_import_insert_batches_with_plan(
                    &rows[start..end],
                    &plan,
                    table,
                    schema,
                    db_type,
                    kingbase_oracle_mode,
                    conflict_policy,
                    primary_key_columns,
                    date_time_format,
                    group_hard_sql_bytes,
                )?);
            }
            if let Some(table) = identity_table {
                for batch in &mut batches[batch_start..] {
                    batch.sql = sqlserver_identity_insert_scope(&table, &batch.sql);
                }
            }
            start = end;
        }
        Ok(batches)
    }

    fn default_row_sql(
        &self,
        table: &str,
        schema: &str,
        db_type: &DatabaseType,
        conflict_policy: TableImportConflictPolicy,
        primary_key_columns: &[String],
    ) -> Result<String, String> {
        let sqlite = matches!(db_type, DatabaseType::Sqlite | DatabaseType::CloudflareD1);
        if (sqlite || *db_type == DatabaseType::SqlServer) && conflict_policy == TableImportConflictPolicy::Error {
            return Ok(format!("INSERT INTO {} DEFAULT VALUES", qualified_table(table, schema, db_type, None)));
        }
        let (columns, values) = if sqlite {
            // SQLite disallows UPSERT after DEFAULT VALUES. Its PRAGMA dflt_value
            // is the live SQL expression, evaluated by SQLite. Generated integer
            // IDs receive NULL so SQLite allocates them. Only unique conflicts
            // are suppressed; CHECK and NOT NULL failures remain errors.
            let writable =
                self.columns.iter().filter(|column| !column_is_computed(column, db_type)).collect::<Vec<_>>();
            if writable.is_empty() {
                return Err("Excel default-only conflict handling requires a writable target column".to_string());
            }
            (
                writable.iter().map(|column| column.name.clone()).collect::<Vec<_>>(),
                writable
                    .iter()
                    .map(|column| column.column_default.as_deref().unwrap_or("NULL"))
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        } else {
            (self.plan.target_columns.clone(), vec!["DEFAULT"; self.plan.target_columns.len()].join(", "))
        };
        let value_rows = vec![format!("({values})")];
        let limits = SqlBatchLimits::for_database(db_type, 1);
        let batches = if conflict_policy == TableImportConflictPolicy::UpdateExisting {
            crate::data::transfer::generate_primary_key_upsert_sql_batches_from_value_rows_with_update_columns(
                &columns,
                &self.update_columns(),
                &value_rows,
                table,
                schema,
                db_type,
                None,
                limits,
                primary_key_columns,
            )?
        } else {
            crate::data::transfer::generate_insert_typed_sql_batches_from_value_rows_with_options(
                &columns,
                &value_rows,
                table,
                schema,
                db_type,
                None,
                limits,
                conflict_policy == TableImportConflictPolicy::Skip,
            )?
        };
        batches.into_iter().next().map(|(sql, _)| sql).ok_or_else(|| "Excel default-row INSERT is empty".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, nullable: bool, default: Option<&str>) -> crate::db::ColumnInfo {
        crate::db::ColumnInfo {
            name: name.into(),
            data_type: "TEXT".into(),
            is_nullable: nullable,
            column_default: default.map(str::to_string),
            ..Default::default()
        }
    }

    fn policy(columns: Vec<crate::db::ColumnInfo>) -> ExcelImportPolicy {
        policy_for_database(columns, DatabaseType::Sqlite)
    }

    fn policy_for_database(columns: Vec<crate::db::ColumnInfo>, db_type: DatabaseType) -> ExcelImportPolicy {
        let names = columns.iter().map(|column| column.name.clone()).collect::<Vec<_>>();
        let mappings = names
            .iter()
            .map(|name| TableImportColumnMapping {
                source_column: name.clone(),
                target_column: name.clone(),
                target_data_type: None,
            })
            .collect::<Vec<_>>();
        ExcelImportPolicy::new(&names, &mappings, &columns, &db_type).unwrap()
    }

    #[test]
    fn sqlserver_excel_identity_and_blank_defaults_are_session_scoped() {
        let mut id = column("id", false, None);
        id.data_type = "int".into();
        id.extra = Some("identity(1,1)".into());
        let policy = policy_for_database(vec![id, column("value", false, Some("N'default'"))], DatabaseType::SqlServer);
        let rows = vec![
            vec![serde_json::json!(7), serde_json::json!("provided")],
            vec![serde_json::json!(8), serde_json::Value::Null],
            vec![serde_json::Value::Null, serde_json::json!("generated id")],
        ];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![], vec![1], vec![0]], row_numbers: vec![2, 3, 4] };
        let batches = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "dbo",
                &DatabaseType::SqlServer,
                false,
                TableImportConflictPolicy::Error,
                &[],
                None,
                None,
            )
            .unwrap();
        assert!(policy
            .can_use_full_column_plan(
                &rows[..1],
                &ExcelImportMetadata { blank_cells: vec![vec![]], row_numbers: vec![2] }
            )
            .unwrap());
        assert!(!policy.can_use_full_column_plan(&rows, &metadata).unwrap());
        assert_eq!(batches.len(), 3);
        for batch in &batches[..2] {
            let on =
                batch.sql.find("SET IDENTITY_INSERT [dbo].[items] ON;").expect("explicit IDs require IDENTITY_INSERT");
            let insert = batch.sql.find("INSERT INTO [dbo].[items]").unwrap();
            let off = batch.sql.find("SET IDENTITY_INSERT [dbo].[items] OFF;").unwrap();
            assert!(on < insert && insert < off);
            assert!(batch.sql.contains("BEGIN CATCH\nSET IDENTITY_INSERT [dbo].[items] OFF;\nTHROW;"));
        }
        assert!(batches[1].sql.contains("INSERT INTO [dbo].[items] ([id])"));
        assert!(batches[2].sql.contains("INSERT INTO [dbo].[items] ([value])"));
        assert!(!batches[2].sql.contains("IDENTITY_INSERT"));
    }

    #[test]
    fn sqlserver_excel_default_only_identity_uses_default_values() {
        let mut id = column("id", false, None);
        id.extra = Some("identity(1,1)".into());
        let policy = policy_for_database(vec![id], DatabaseType::SqlServer);
        let batches = policy
            .sql_batches(
                &[vec![serde_json::Value::Null]],
                &ExcelImportMetadata { blank_cells: vec![vec![0]], row_numbers: vec![2] },
                "items",
                "dbo",
                &DatabaseType::SqlServer,
                false,
                TableImportConflictPolicy::Error,
                &[],
                None,
                None,
            )
            .unwrap();
        assert_eq!(batches[0].sql, "INSERT INTO [dbo].[items] DEFAULT VALUES");
    }

    #[test]
    fn sqlserver_identity_scope_counts_utf16_bytes_when_splitting_batches() {
        let mut id = column("id", false, None);
        id.extra = Some("identity(1,1)".into());
        let policy = policy_for_database(vec![id, column("value", false, None)], DatabaseType::SqlServer);
        let row = vec![serde_json::json!(7), serde_json::json!("Unicode 中文")];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![]], row_numbers: vec![2] };
        let generate = |rows: &[Vec<serde_json::Value>], metadata: &ExcelImportMetadata, limit| {
            policy.sql_batches(
                rows,
                metadata,
                "items",
                "dbo",
                &DatabaseType::SqlServer,
                false,
                TableImportConflictPolicy::Error,
                &[],
                None,
                limit,
            )
        };
        let single = generate(std::slice::from_ref(&row), &metadata, None).unwrap();
        let limit = single[0].sql.encode_utf16().count() * 2;
        assert!(generate(std::slice::from_ref(&row), &metadata, Some(limit - 1)).is_err());
        let two = generate(
            &[row.clone(), row],
            &ExcelImportMetadata { blank_cells: vec![vec![], vec![]], row_numbers: vec![2, 3] },
            Some(limit),
        )
        .unwrap();
        assert_eq!(two.len(), 2);
        assert!(two.iter().all(|batch| batch.sql.encode_utf16().count() * 2 <= limit));
    }

    #[test]
    fn update_existing_omits_generated_assignments_and_keeps_default_updates() {
        let mut generated = column("derived", false, None);
        generated.extra = Some("generated always as (length(value)) stored".into());
        let policy = policy(vec![column("id", false, None), column("value", false, Some("'default'")), generated]);
        let rows = vec![
            vec![serde_json::json!(1), serde_json::Value::Null, serde_json::Value::Null],
            vec![serde_json::json!(2), serde_json::json!("new"), serde_json::Value::Null],
        ];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![1, 2], vec![2]], row_numbers: vec![2, 3] };
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL DEFAULT 'default',derived INTEGER GENERATED ALWAYS AS (length(value)) STORED NOT NULL); INSERT INTO items(id,value) VALUES(1,'old')").unwrap();
        let batches = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::UpdateExisting,
                &["id".into()],
                None,
                None,
            )
            .unwrap();
        for batch in batches {
            db.execute_batch(&batch.sql).unwrap();
        }
        assert_eq!(
            db.query_row("SELECT value,derived FROM items WHERE id=1", [], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?
            )))
            .unwrap(),
            ("default".into(), 7)
        );
        assert_eq!(db.query_row("SELECT derived FROM items WHERE id=2", [], |row| row.get::<_, i64>(0)).unwrap(), 3);
    }

    #[test]
    fn nullable_generated_blanks_are_omitted_but_default_generated_columns_remain_writable() {
        let mut derived = column("derived", true, None);
        derived.extra = Some("STORED GENERATED".into());
        let mut value = column("value", false, Some("'default'"));
        value.extra = Some("DEFAULT_GENERATED".into());
        let policy = policy(vec![column("id", false, None), value, derived]);
        let rows = vec![vec![serde_json::json!(1), serde_json::Value::Null, serde_json::Value::Null]];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![1, 2]], row_numbers: vec![2] };
        let batches = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::UpdateExisting,
                &["id".into()],
                None,
                None,
            )
            .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL DEFAULT 'default',derived INTEGER GENERATED ALWAYS AS (length(value)) STORED); INSERT INTO items(id,value) VALUES(1,'old')").unwrap();
        db.execute_batch(&batches[0].sql).unwrap();
        assert_eq!(
            db.query_row("SELECT value,derived FROM items", [], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?
            )))
            .unwrap(),
            ("default".into(), 7)
        );
    }

    #[test]
    fn computed_expression_referencing_identity_is_not_an_identity_column() {
        let mut derived = column("derived", false, None);
        derived.extra = Some("generated always as (identity + 1) stored".into());
        let policy = policy_for_database(
            vec![column("id", false, None), column("identity", false, None), derived],
            DatabaseType::Postgres,
        );
        let batches = policy
            .sql_batches(
                &[vec![serde_json::json!(1), serde_json::json!(17), serde_json::Value::Null]],
                &ExcelImportMetadata { blank_cells: vec![vec![2]], row_numbers: vec![2] },
                "items",
                "",
                &DatabaseType::Postgres,
                false,
                TableImportConflictPolicy::UpdateExisting,
                &["id".into()],
                None,
                None,
            )
            .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY,identity INTEGER NOT NULL,derived INTEGER GENERATED ALWAYS AS (identity+1) STORED NOT NULL); INSERT INTO items(id,identity) VALUES(1,1)").unwrap();
        db.execute_batch(&batches[0].sql).unwrap();
        assert_eq!(db.query_row("SELECT derived FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 18);
    }

    #[test]
    fn default_only_upsert_omits_computed_assignments_without_dropping_identity_defaults() {
        let mut derived = column("derived", false, None);
        derived.extra = Some("generated always as (length(value)) stored".into());
        let policy = policy(vec![column("id", false, Some("0")), column("value", false, Some("'default'")), derived]);
        let rows = vec![vec![serde_json::Value::Null; 3]];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![0, 1, 2]], row_numbers: vec![2] };
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY DEFAULT 0,value TEXT NOT NULL DEFAULT 'default',derived INTEGER GENERATED ALWAYS AS (length(value)) STORED NOT NULL); INSERT INTO items(id,value) VALUES(0,'old')").unwrap();
        let batches = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::UpdateExisting,
                &["id".into()],
                None,
                None,
            )
            .unwrap();
        db.execute_batch(&batches[0].sql).unwrap();
        assert_eq!(
            db.query_row("SELECT value,derived FROM items", [], |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?
            )))
            .unwrap(),
            ("default".into(), 7)
        );

        let mut id = column("id", false, None);
        id.extra = Some("generated by default as identity".into());
        let identity = policy_for_database(vec![id, column("value", false, Some("'default'"))], DatabaseType::Sqlite);
        let batches = identity
            .sql_batches(
                &[vec![serde_json::Value::Null; 2]],
                &ExcelImportMetadata { blank_cells: vec![vec![0, 1]], row_numbers: vec![2] },
                "identity_items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::Skip,
                &[],
                None,
                None,
            )
            .unwrap();
        db.execute_batch("CREATE TABLE identity_items(id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,value TEXT NOT NULL DEFAULT 'default')").unwrap();
        db.execute_batch(&batches[0].sql).unwrap();
        assert_eq!(db.query_row("SELECT id FROM identity_items", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn blank_cells_use_database_defaults_and_nullable_cells_keep_null() {
        let policy = policy(vec![
            column("id", false, None),
            column("icon", false, Some("")),
            column("amount", false, Some("17")),
            column("created", false, Some("CURRENT_TIMESTAMP")),
            column("note", true, Some("fallback")),
        ]);
        let rows = vec![
            vec![
                serde_json::json!(1),
                serde_json::json!(""),
                serde_json::json!(23),
                serde_json::json!("provided"),
                serde_json::Value::Null,
            ],
            vec![
                serde_json::json!(2),
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
                serde_json::Value::Null,
            ],
            vec![
                serde_json::json!(3),
                serde_json::json!("normal"),
                serde_json::json!(24),
                serde_json::json!("provided"),
                serde_json::json!("note"),
            ],
        ];
        let metadata =
            ExcelImportMetadata { blank_cells: vec![vec![4], vec![1, 2, 3, 4], vec![]], row_numbers: vec![2, 4, 5] };
        let batches = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::Error,
                &[],
                None,
                None,
            )
            .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(id INTEGER NOT NULL, icon TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL DEFAULT 17, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, note TEXT DEFAULT 'fallback')").unwrap();
        for batch in batches {
            db.execute_batch(&batch.sql).unwrap();
        }
        let actual: (String, i64, String, Option<String>) = db
            .query_row("SELECT icon,amount,created,note FROM items WHERE id=2", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap();
        assert_eq!(actual.0, "");
        assert_eq!(actual.1, 17);
        assert!(!actual.2.is_empty());
        assert!(actual.3.is_none());
        let explicit: String = db.query_row("SELECT icon FROM items WHERE id=1", [], |row| row.get(0)).unwrap();
        assert_eq!(explicit, "");
        assert_eq!(db.query_row("SELECT COUNT(*) FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 3);
    }

    #[test]
    fn errors_identify_physical_row_and_distinguish_explicit_null() {
        let rows = vec![vec![serde_json::Value::Null]];
        let blank = ExcelImportMetadata { blank_cells: vec![vec![0]], row_numbers: vec![19] };
        let required = policy(vec![column("required", false, None)]);
        let error = required.validate(&rows, &blank).unwrap_err();
        assert!(error.contains("Excel row 19"));
        assert!(error.contains("required"));
        assert!(error.contains("without a default"));
        let with_default = policy(vec![column("required", false, Some("''"))]);
        with_default.validate(&rows, &blank).unwrap();
        let explicit_null = ExcelImportMetadata { blank_cells: vec![vec![]], row_numbers: vec![19] };
        assert!(with_default.validate(&rows, &explicit_null).unwrap_err().contains("explicit NULL"));
    }

    #[test]
    fn default_column_groups_preserve_source_order_for_duplicate_keys() {
        let policy = policy(vec![column("id", false, None), column("value", false, Some("'default'"))]);
        let rows = vec![
            vec![serde_json::json!(1), serde_json::json!("first")],
            vec![serde_json::json!(1), serde_json::Value::Null],
            vec![serde_json::json!(1), serde_json::json!("last")],
        ];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![], vec![1], vec![]], row_numbers: vec![2, 3, 4] };
        let batches = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::UpdateExisting,
                &["id".into()],
                None,
                None,
            )
            .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL DEFAULT 'default')").unwrap();
        for batch in batches {
            db.execute_batch(&batch.sql).unwrap();
        }
        assert_eq!(db.query_row("SELECT value FROM items", [], |row| row.get::<_, String>(0)).unwrap(), "last");
    }

    #[test]
    fn update_existing_assigns_database_default_even_when_insert_omits_the_column() {
        let policy = policy(vec![column("id", false, None), column("value", false, Some("'default'"))]);
        let rows = vec![vec![serde_json::json!(1), serde_json::Value::Null]];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![1]], row_numbers: vec![2] };
        let batches = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::UpdateExisting,
                &["id".into()],
                None,
                None,
            )
            .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT NOT NULL DEFAULT 'default'); INSERT INTO items VALUES(1,'old')").unwrap();
        for batch in batches {
            db.execute_batch(&batch.sql).unwrap();
        }
        assert_eq!(db.query_row("SELECT value FROM items", [], |row| row.get::<_, String>(0)).unwrap(), "default");
    }

    #[test]
    fn sqlite_autoincrement_blank_ids_are_generated_by_the_database() {
        let mut id = column("id", false, None);
        id.extra = Some("autoincrement".into());
        let policy = policy(vec![id, column("name", false, None)]);
        let rows = vec![vec![serde_json::Value::Null, serde_json::json!("new")]];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![0]], row_numbers: vec![2] };
        let batches = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::Error,
                &[],
                None,
                None,
            )
            .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL)")
            .unwrap();
        for batch in batches {
            db.execute_batch(&batch.sql).unwrap();
        }
        assert_eq!(db.query_row("SELECT id FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }
    #[test]
    fn unmapped_computed_and_rowversion_columns_do_not_require_excel_values() {
        let mut computed = column("computed", false, None);
        computed.extra = Some("computed".into());
        let mut version = column("version", false, None);
        version.data_type = "rowversion".into();
        let names = vec!["name".into()];
        let mappings = vec![TableImportColumnMapping {
            source_column: "name".into(),
            target_column: "name".into(),
            target_data_type: None,
        }];
        ExcelImportPolicy::new(
            &names,
            &mappings,
            &[column("name", false, None), computed, version],
            &DatabaseType::SqlServer,
        )
        .unwrap();
    }

    #[test]
    fn default_only_duplicate_skipping_does_not_hide_other_constraints() {
        let policy = policy(vec![column("value", false, Some("'default'"))]);
        let rows = vec![vec![serde_json::Value::Null]];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![0]], row_numbers: vec![2] };
        let sqlite = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::Skip,
                &[],
                None,
                None,
            )
            .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(value TEXT NOT NULL DEFAULT 'default' UNIQUE)").unwrap();
        db.execute_batch(&sqlite[0].sql).unwrap();
        db.execute_batch(&sqlite[0].sql).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM items", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        let failing = rusqlite::Connection::open_in_memory().unwrap();
        failing
            .execute_batch("CREATE TABLE items(value TEXT NOT NULL DEFAULT 'default' CHECK(value<>'default'))")
            .unwrap();
        assert!(failing.execute_batch(&sqlite[0].sql).is_err());
        for (db_type, expected) in [
            (DatabaseType::Mysql, "ON DUPLICATE KEY UPDATE"),
            (DatabaseType::Kingbase, "ON CONFLICT DO NOTHING"),
            (DatabaseType::OpenGauss, "ON DUPLICATE KEY UPDATE"),
        ] {
            let batches = policy
                .sql_batches(
                    &rows,
                    &metadata,
                    "items",
                    "",
                    &db_type,
                    false,
                    TableImportConflictPolicy::Skip,
                    &[],
                    None,
                    None,
                )
                .unwrap();
            assert!(batches[0].sql.contains(expected));
            assert!(!batches[0].sql.contains("IGNORE"));
        }
    }
    #[test]
    fn default_only_update_existing_evaluates_database_defaults() {
        let policy = policy(vec![column("id", false, Some("0")), column("value", false, Some("'default'"))]);
        let rows = vec![vec![serde_json::Value::Null, serde_json::Value::Null]];
        let metadata = ExcelImportMetadata { blank_cells: vec![vec![0, 1]], row_numbers: vec![2] };
        let batches = policy
            .sql_batches(
                &rows,
                &metadata,
                "items",
                "",
                &DatabaseType::Sqlite,
                false,
                TableImportConflictPolicy::UpdateExisting,
                &["id".into()],
                None,
                None,
            )
            .unwrap();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE items(id INTEGER NOT NULL DEFAULT 0 PRIMARY KEY,value TEXT NOT NULL DEFAULT 'default'); INSERT INTO items VALUES(0,'old')").unwrap();
        for batch in batches {
            db.execute_batch(&batch.sql).unwrap();
        }
        assert_eq!(
            db.query_row("SELECT value FROM items WHERE id=0", [], |row| row.get::<_, String>(0)).unwrap(),
            "default"
        );
    }
}
