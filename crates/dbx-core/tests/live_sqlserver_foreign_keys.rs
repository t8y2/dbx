use std::time::Duration;

/// `sys.foreign_keys.delete_referential_action` and `update_referential_action` are
/// `tinyint`, which tiberius decodes as `ColumnData::U8`. Reading them with
/// `row.get::<i32>()` panicked and aborted the process, so schema comparison crashed
/// on the first table that owned a foreign key. This covers the live read path.
#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_foreign_key_referential_actions_are_read_from_tinyint_columns() {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT")
        .expect("DBX_LIVE_SQLSERVER_PORT")
        .parse()
        .expect("valid DBX_LIVE_SQLSERVER_PORT");
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());

    let mut client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(15))
            .await
            .expect("connect SQL Server");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let parent_table = format!("dbx_fk_parent_{suffix}");
    let cascade_child_table = format!("dbx_fk_cascade_child_{suffix}");
    let set_null_child_table = format!("dbx_fk_setnull_child_{suffix}");

    let cleanup = format!(
        "DROP TABLE IF EXISTS [dbo].[{cascade_child_table}];\
         DROP TABLE IF EXISTS [dbo].[{set_null_child_table}];\
         DROP TABLE IF EXISTS [dbo].[{parent_table}];"
    );
    let _ = dbx_core::db::sqlserver::execute_batch(&mut client, &cleanup).await;

    let setup = format!(
        "CREATE TABLE [dbo].[{parent_table}] (\
             [id] INT NOT NULL CONSTRAINT [PK_{parent_table}] PRIMARY KEY CLUSTERED ([id] ASC)\
         );\
         CREATE TABLE [dbo].[{cascade_child_table}] (\
             [id] INT NOT NULL CONSTRAINT [PK_{cascade_child_table}] PRIMARY KEY CLUSTERED ([id] ASC),\
             [parent_id] INT NULL,\
             CONSTRAINT [FK_{cascade_child_table}_parent] FOREIGN KEY ([parent_id])\
                 REFERENCES [dbo].[{parent_table}] ([id]) ON DELETE CASCADE ON UPDATE NO ACTION\
         );\
         CREATE TABLE [dbo].[{set_null_child_table}] (\
             [id] INT NOT NULL CONSTRAINT [PK_{set_null_child_table}] PRIMARY KEY CLUSTERED ([id] ASC),\
             [parent_id] INT NULL,\
             CONSTRAINT [FK_{set_null_child_table}_parent] FOREIGN KEY ([parent_id])\
                 REFERENCES [dbo].[{parent_table}] ([id]) ON DELETE SET NULL ON UPDATE SET DEFAULT\
         );"
    );
    dbx_core::db::sqlserver::execute_batch(&mut client, &setup).await.expect("create foreign key fixtures");

    let exercise = async {
        let cascade = dbx_core::db::sqlserver::list_foreign_keys(&mut client, "dbo", &cascade_child_table).await?;
        assert_eq!(cascade.len(), 1, "expected one foreign key on the cascade child table");
        assert_eq!(cascade[0].ref_table, parent_table);
        assert_eq!(cascade[0].ref_column.as_str(), "id");
        assert_eq!(cascade[0].column.as_str(), "parent_id");
        assert_eq!(cascade[0].on_delete.as_deref(), Some("CASCADE"));
        assert_eq!(cascade[0].on_update, None, "ON UPDATE NO ACTION is the default and stays unset");

        let set_null = dbx_core::db::sqlserver::list_foreign_keys(&mut client, "dbo", &set_null_child_table).await?;
        assert_eq!(set_null.len(), 1, "expected one foreign key on the set-null child table");
        assert_eq!(set_null[0].on_delete.as_deref(), Some("SET NULL"));
        assert_eq!(set_null[0].on_update.as_deref(), Some("SET DEFAULT"));

        let parent = dbx_core::db::sqlserver::list_foreign_keys(&mut client, "dbo", &parent_table).await?;
        assert!(parent.is_empty(), "parent table owns no outbound foreign keys");

        // Mirror the schema comparison loop, which loads every table's metadata and
        // DDL one table at a time and used to abort on the first table with a
        // foreign key.
        let tables = dbx_core::db::sqlserver::list_tables(&mut client, "dbo", None, None, None).await?;
        for table in tables.iter().filter(|table| table.table_type.eq_ignore_ascii_case("BASE TABLE")) {
            dbx_core::db::sqlserver::list_foreign_keys(&mut client, "dbo", &table.name)
                .await
                .unwrap_or_else(|error| panic!("list_foreign_keys failed for {}: {error}", table.name));
            dbx_core::schema::build_sqlserver_ddl(&mut client, "dbo", &table.name)
                .await
                .unwrap_or_else(|error| panic!("build_sqlserver_ddl failed for {}: {error}", table.name));
        }

        Ok::<(), String>(())
    }
    .await;

    let cleanup_result = dbx_core::db::sqlserver::execute_batch(&mut client, &cleanup).await;
    exercise.expect("read referential actions from tinyint catalog columns");
    cleanup_result.expect("drop foreign key fixtures");
}
