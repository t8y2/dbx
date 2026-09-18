use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::*;
use dbx_core::sql_dialect::descriptor::DialectKind;
use dbx_core::types::*;

fn table_info(name: &str, table_type: &str) -> TableInfo {
    TableInfo {
        name: name.to_string(),
        table_type: table_type.to_string(),
        valid: None,
        comment: None,
        parent_schema: None,
        parent_name: None,
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_alter_column_preserves_unchanged_runtime_dependencies() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT")
        .expect("DBX_LIVE_SQLSERVER_PORT")
        .parse()
        .expect("valid DBX_LIVE_SQLSERVER_PORT");
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client = dbx_core::db::sqlserver::connect(
        &host,
        port,
        &user,
        &password,
        Some(&database),
        None,
        std::time::Duration::from_secs(10),
    )
    .await
    .expect("connect SQL Server");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let lookup_table = format!("dbx_dep_lookup_{suffix}");
    let parent_table = format!("dbx_dep_parent_{suffix}");
    let child_table = format!("dbx_dep_child_{suffix}");
    let primary_key = format!("PK_dbx_dep_parent_{suffix}");
    let unique_constraint = format!("UQ_dbx_dep_parent_code_{suffix}");
    let lookup_unique_constraint = format!("UQ_dbx_dep_lookup_code_{suffix}");
    let check_constraint = format!("CK_dbx_dep_parent_values_{suffix}");
    let outbound_foreign_key = format!("FK_dbx_dep_parent_lookup_{suffix}");
    let inbound_foreign_key = format!("FK_dbx_dep_child_parent_{suffix}");
    let ordinary_index = format!("IX_dbx_dep_parent_code_{suffix}");
    let cleanup = format!(
        "DROP TABLE IF EXISTS [dbo].[{child_table}];\
             DROP TABLE IF EXISTS [dbo].[{parent_table}];\
             DROP TABLE IF EXISTS [dbo].[{lookup_table}];"
    );
    let _ = dbx_core::db::sqlserver::execute_batch(&mut client, &cleanup).await;

    let exercise = async {
        let setup = format!(
            "SET ANSI_NULLS ON;\
                 SET QUOTED_IDENTIFIER ON;\
                 SET ANSI_PADDING ON;\
                 SET ANSI_WARNINGS ON;\
                 SET CONCAT_NULL_YIELDS_NULL ON;\
                 SET ARITHABORT ON;\
                 SET NUMERIC_ROUNDABORT OFF;\
                 CREATE TABLE [dbo].[{lookup_table}] (\
                     [code] INT NOT NULL,\
                     CONSTRAINT [{lookup_unique_constraint}] UNIQUE NONCLUSTERED ([code] ASC)\
                 );\
                 CREATE TABLE [dbo].[{parent_table}] (\
                     [id] INT NOT NULL,\
                     [code] INT NOT NULL,\
                     [payload] NVARCHAR(64) NULL,\
                     CONSTRAINT [{primary_key}] PRIMARY KEY CLUSTERED ([id] ASC),\
                     CONSTRAINT [{unique_constraint}] UNIQUE NONCLUSTERED ([code] ASC),\
                     CONSTRAINT [{check_constraint}] CHECK ([id] > 0 AND [code] >= 0),\
                     CONSTRAINT [{outbound_foreign_key}] FOREIGN KEY ([code])\
                         REFERENCES [dbo].[{lookup_table}] ([code])\
                 );\
                 CREATE TABLE [dbo].[{child_table}] (\
                     [id] INT NOT NULL,\
                     [parent_code] INT NULL,\
                     CONSTRAINT [{inbound_foreign_key}] FOREIGN KEY ([parent_code])\
                         REFERENCES [dbo].[{parent_table}] ([code])\
                         ON UPDATE CASCADE ON DELETE SET NULL NOT FOR REPLICATION\
                 );\
                 CREATE NONCLUSTERED INDEX [{ordinary_index}]\
                     ON [dbo].[{parent_table}] ([code] DESC, [id] ASC)\
                     INCLUDE ([payload])\
                     WHERE [code] IS NOT NULL\
                     WITH (PAD_INDEX = ON, FILLFACTOR = 80, STATISTICS_NORECOMPUTE = ON,\
                           ALLOW_ROW_LOCKS = OFF, ALLOW_PAGE_LOCKS = ON)\
                     ON [PRIMARY];"
        );
        dbx_core::db::sqlserver::execute_batch(&mut client, &setup).await?;

        let target_detail = TableSchemaDetail {
            name: parent_table.clone(),
            columns: dbx_core::db::sqlserver::get_columns(&mut client, "dbo", &parent_table).await?,
            indexes: dbx_core::db::sqlserver::list_indexes(&mut client, "dbo", &parent_table).await?,
            foreign_keys: dbx_core::db::sqlserver::list_foreign_keys(&mut client, "dbo", &parent_table).await?,
            triggers: Vec::new(),
            ddl: None,
        };
        let mut source_detail = target_detail.clone();
        let source_id = source_detail
            .columns
            .iter_mut()
            .find(|column| column.name == "id")
            .ok_or_else(|| "live target metadata did not contain id".to_string())?;
        source_id.data_type = "bigint".to_string();
        source_id.numeric_precision = Some(19);
        let source_code = source_detail
            .columns
            .iter_mut()
            .find(|column| column.name == "code")
            .ok_or_else(|| "live target metadata did not contain code".to_string())?;
        source_code.is_nullable = true;

        let prepared = prepare_schema_diff(SchemaDiffPreparationOptions {
            source_tables: vec![table_info(&parent_table, "BASE TABLE")],
            target_tables: vec![table_info(&parent_table, "BASE TABLE")],
            source_details: vec![source_detail],
            target_details: vec![target_detail],
            database_type: DatabaseType::SqlServer,
            target_schema: Some("dbo".to_string()),
            source_dialect: Some(DialectKind::SqlServer),
            target_dialect: Some(DialectKind::SqlServer),
            ..Default::default()
        });

        dbx_core::db::sqlserver::execute_batch(&mut client, "SET QUOTED_IDENTIFIER OFF;").await?;
        dbx_core::db::sqlserver::execute_batch(&mut client, &prepared.sync_sql).await?;
        let verification_sql = format!(
            "DECLARE @parent_id int = OBJECT_ID(N'[dbo].[{parent_table}]');\
                 SELECT\
                   CONVERT(int, CASE WHEN EXISTS (\
                     SELECT 1\
                     FROM sys.indexes AS idx\
                     JOIN sys.stats AS stats\
                       ON stats.object_id = idx.object_id AND stats.stats_id = idx.index_id\
                     JOIN sys.data_spaces AS data_space ON data_space.data_space_id = idx.data_space_id\
                     JOIN sys.index_columns AS key_ic\
                       ON key_ic.object_id = idx.object_id AND key_ic.index_id = idx.index_id\
                     JOIN sys.columns AS key_column\
                       ON key_column.object_id = key_ic.object_id AND key_column.column_id = key_ic.column_id\
                     WHERE idx.object_id = @parent_id\
                       AND idx.name = N'{ordinary_index}'\
                       AND idx.type_desc = N'NONCLUSTERED'\
                       AND idx.is_primary_key = 0 AND idx.is_unique_constraint = 0\
                       AND idx.is_disabled = 0 AND idx.has_filter = 1\
                       AND idx.is_padded = 1 AND idx.fill_factor = 80\
                       AND idx.allow_row_locks = 0 AND idx.allow_page_locks = 1\
                       AND stats.no_recompute = 1 AND data_space.name = N'PRIMARY'\
                       AND key_column.name = N'code' AND key_ic.key_ordinal = 1\
                       AND key_ic.is_descending_key = 1\
                       AND CHARINDEX(N'[code]', idx.filter_definition) > 0\
                       AND EXISTS (\
                         SELECT 1\
                         FROM sys.index_columns AS include_ic\
                         JOIN sys.columns AS include_column\
                           ON include_column.object_id = include_ic.object_id\
                          AND include_column.column_id = include_ic.column_id\
                         WHERE include_ic.object_id = idx.object_id\
                           AND include_ic.index_id = idx.index_id\
                           AND include_ic.is_included_column = 1\
                           AND include_column.name = N'payload'\
                       )\
                   ) THEN 1 ELSE 0 END) AS ordinary_index_ok,\
                   CONVERT(int, CASE WHEN EXISTS (\
                     SELECT 1\
                     FROM sys.key_constraints AS key_constraint\
                     JOIN sys.indexes AS idx\
                       ON idx.object_id = key_constraint.parent_object_id\
                      AND idx.index_id = key_constraint.unique_index_id\
                     JOIN sys.index_columns AS ic\
                       ON ic.object_id = idx.object_id AND ic.index_id = idx.index_id\
                     JOIN sys.columns AS column_info\
                       ON column_info.object_id = ic.object_id AND column_info.column_id = ic.column_id\
                     JOIN sys.types AS column_type ON column_type.user_type_id = column_info.user_type_id\
                     WHERE key_constraint.parent_object_id = @parent_id\
                       AND key_constraint.name = N'{primary_key}'\
                       AND key_constraint.type = N'PK'\
                       AND idx.is_primary_key = 1 AND idx.type_desc = N'CLUSTERED'\
                       AND ic.key_ordinal = 1 AND column_info.name = N'id'\
                       AND column_type.name = N'bigint' AND column_info.is_nullable = 0\
                   ) THEN 1 ELSE 0 END) AS primary_key_ok,\
                   CONVERT(int, CASE WHEN EXISTS (\
                     SELECT 1\
                     FROM sys.check_constraints AS check_constraint\
                     WHERE check_constraint.parent_object_id = @parent_id\
                       AND check_constraint.name = N'{check_constraint}'\
                       AND check_constraint.is_disabled = 0\
                       AND check_constraint.is_not_trusted = 0\
                       AND CHARINDEX(N'[id]', check_constraint.definition) > 0\
                       AND CHARINDEX(N'[code]', check_constraint.definition) > 0\
                   ) THEN 1 ELSE 0 END) AS check_constraint_ok,\
                   CONVERT(int, CASE WHEN EXISTS (\
                     SELECT 1\
                     FROM sys.foreign_keys AS foreign_key\
                     JOIN sys.foreign_key_columns AS fkc\
                       ON fkc.constraint_object_id = foreign_key.object_id\
                     JOIN sys.columns AS child_column\
                       ON child_column.object_id = fkc.parent_object_id\
                      AND child_column.column_id = fkc.parent_column_id\
                     JOIN sys.columns AS parent_column\
                       ON parent_column.object_id = fkc.referenced_object_id\
                      AND parent_column.column_id = fkc.referenced_column_id\
                     WHERE foreign_key.name = N'{inbound_foreign_key}'\
                       AND foreign_key.parent_object_id = OBJECT_ID(N'[dbo].[{child_table}]')\
                       AND foreign_key.referenced_object_id = @parent_id\
                       AND foreign_key.type = N'F'\
                       AND foreign_key.is_disabled = 0 AND foreign_key.is_not_trusted = 1\
                       AND foreign_key.is_not_for_replication = 1\
                       AND foreign_key.update_referential_action_desc = N'CASCADE'\
                       AND foreign_key.delete_referential_action_desc = N'SET_NULL'\
                       AND child_column.name = N'parent_code' AND parent_column.name = N'code'\
                       AND EXISTS (\
                         SELECT 1 FROM sys.key_constraints AS uq\
                         WHERE uq.parent_object_id = @parent_id\
                           AND uq.name = N'{unique_constraint}' AND uq.type = N'UQ'\
                       )\
                   ) THEN 1 ELSE 0 END) AS inbound_foreign_key_ok,\
                   CONVERT(int, CASE WHEN\
                     EXISTS (\
                       SELECT 1 FROM sys.columns AS column_info\
                       JOIN sys.types AS column_type ON column_type.user_type_id = column_info.user_type_id\
                       WHERE column_info.object_id = @parent_id AND column_info.name = N'id'\
                         AND column_type.name = N'bigint' AND column_info.is_nullable = 0\
                     )\
                     AND EXISTS (\
                       SELECT 1 FROM sys.columns AS column_info\
                       JOIN sys.types AS column_type ON column_type.user_type_id = column_info.user_type_id\
                       WHERE column_info.object_id = @parent_id AND column_info.name = N'code'\
                         AND column_type.name = N'int' AND column_info.is_nullable = 1\
                     )\
                   THEN 1 ELSE 0 END) AS altered_columns_ok;"
        );
        let verification = dbx_core::db::sqlserver::execute_query(&mut client, &verification_sql).await?;
        Ok::<_, String>((prepared, verification))
    }
    .await;

    let cleanup_result = dbx_core::db::sqlserver::execute_batch(&mut client, &cleanup).await;
    cleanup_result.expect("drop live SQL Server dependency test tables");
    let (prepared, verification) = exercise.expect("exercise live SQL Server dependency-aware ALTER COLUMN");

    assert_eq!(prepared.diffs.len(), 1, "diffs={:?}", prepared.diffs);
    let table_diff = &prepared.diffs[0];
    assert_eq!(table_diff.diff_type, "modified");
    assert_eq!(table_diff.columns.as_ref().map(Vec::len), Some(2));
    assert!(table_diff.indexes.is_none(), "unchanged indexes must be absent: {table_diff:?}");
    assert!(table_diff.foreign_keys.is_none(), "unchanged foreign keys must be absent: {table_diff:?}");
    assert!(!prepared.sync_sql.contains(&ordinary_index), "index must be discovered at runtime: {}", prepared.sync_sql);
    assert!(
        !prepared.sync_sql.contains(&outbound_foreign_key),
        "foreign keys must be discovered at runtime: {}",
        prepared.sync_sql
    );
    assert!(
        !prepared.sync_sql.contains(&inbound_foreign_key),
        "inbound foreign keys are not represented by the table diff: {}",
        prepared.sync_sql
    );

    assert_eq!(verification.rows.len(), 1, "verification={verification:?}");
    assert_eq!(
        verification.rows[0],
        vec![
            serde_json::json!(1),
            serde_json::json!(1),
            serde_json::json!(1),
            serde_json::json!(1),
            serde_json::json!(1),
        ],
        "columns={:?}, sync_sql={} ",
        verification.columns,
        prepared.sync_sql
    );
}

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable PostgreSQL-family database"]
async fn real_postgres_round_trip_quotes_columns_and_leaves_expressions_bare() {
    // PR #6312 review: exercise the full path end-to-end against a real PostgreSQL server
    // instead of only asserting on generated text. Introspects a table whose unique index
    // mixes a real column with an expression-hostile name ("order item", i.e. exactly the
    // a.attname case the reviewer called out) and a genuine pg_get_indexdef expression key
    // part, generates DDL with the same `create_index_sql` schema-diff sync uses, and
    // executes that DDL back against the database to prove it's actually valid — not just
    // plausible-looking text.
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool =
        dbx_core::db::postgres::connect(&url, std::time::Duration::from_secs(5)).await.expect("connect postgres");
    let schema = format!("dbx_key_expr_{}", uuid::Uuid::new_v4().simple());
    dbx_core::db::postgres::execute_query(&pool, &format!("CREATE SCHEMA {schema}")).await.expect("create schema");

    let exercise = async {
        dbx_core::db::postgres::execute_query(
            &pool,
            &format!(
                "CREATE TABLE {schema}.tankong_data (\
                     \"order item\" integer, data_type text, data_time timestamp, height double precision)"
            ),
        )
        .await?;
        dbx_core::db::postgres::execute_query(
            &pool,
            &format!(
                "CREATE UNIQUE INDEX uq_tankong_sta_type_time ON {schema}.tankong_data \
                     (\"order item\", data_type, data_time, \
                     (COALESCE(height, '-1'::integer::double precision)))"
            ),
        )
        .await?;

        let indexes = dbx_core::db::postgres::list_indexes(&pool, &schema, "tankong_data").await?;
        let index = indexes
            .into_iter()
            .find(|index| index.name == "uq_tankong_sta_type_time")
            .ok_or_else(|| "introspection should return the created index".to_string())?;

        // Regenerate the index DDL through the exact same production function schema-diff
        // sync calls, then execute it back against the real database to prove it's valid.
        let ddl = create_index_sql("tankong_data", &index, DatabaseType::Highgo, Some(&schema));
        dbx_core::db::postgres::execute_query(&pool, &format!("DROP INDEX {schema}.uq_tankong_sta_type_time")).await?;
        dbx_core::db::postgres::execute_query(&pool, &ddl).await?;

        Ok::<_, String>((index, ddl))
    }
    .await;

    let cleanup = dbx_core::db::postgres::execute_query(&pool, &format!("DROP SCHEMA {schema} CASCADE")).await;
    cleanup.expect("drop schema");
    let (index, recreate_ddl) = exercise.expect("exercise real postgres round trip");

    assert_eq!(
        index.columns,
        vec!["order item", "data_type", "data_time", "COALESCE(height, '-1'::integer::double precision)"]
    );
    assert_eq!(index.key_is_expression, vec![false, false, false, true]);
    assert!(recreate_ddl.contains("\"order item\""));
    assert!(recreate_ddl.contains("COALESCE(height, '-1'::integer::double precision)"));
    assert!(!recreate_ddl.contains("\"COALESCE"));
}
