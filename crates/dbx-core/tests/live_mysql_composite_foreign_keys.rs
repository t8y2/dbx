//! Run with DBX_LIVE_MYSQL_URL pointing to a disposable MySQL 5.7 or 8.4 instance.
//! Creates unique databases and drops only those created by this test.
use dbx_core::db::mysql::{self, MySqlPool};
use dbx_core::models::connection::DatabaseType;
use dbx_core::schema_diff::{
    prepare_schema_diff, SchemaDiffPreparation, SchemaDiffPreparationOptions, TableSchemaDetail,
};
use mysql_async::prelude::Queryable;
use std::time::Duration;

async fn compare(pool: &MySqlPool, source: &str, target: &str) -> Result<SchemaDiffPreparation, String> {
    let source_tables = mysql::list_tables(pool, source).await?;
    let target_tables = mysql::list_tables(pool, target).await?;
    let mut sides = Vec::new();
    for (database, tables) in [(source, &source_tables), (target, &target_tables)] {
        let mut details = Vec::new();
        for table in tables {
            details.push(TableSchemaDetail {
                name: table.name.clone(),
                columns: mysql::get_columns(pool, database, &table.name).await?,
                indexes: mysql::list_indexes(pool, database, &table.name).await?,
                foreign_keys: mysql::list_foreign_keys(pool, database, &table.name).await?,
                triggers: mysql::list_triggers(pool, database, &table.name).await?,
                ddl: Some(mysql::show_create_table_ddl(pool, database, &table.name).await?),
            });
        }
        sides.push(details);
    }
    let target_details = sides.pop().unwrap();
    let source_details = sides.pop().unwrap();
    Ok(prepare_schema_diff(SchemaDiffPreparationOptions {
        source_tables,
        target_tables,
        source_details,
        target_details,
        database_type: DatabaseType::Mysql,
        target_schema: Some(target.into()),
        ..Default::default()
    }))
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_URL on a disposable MySQL 5.7 or 8.4 instance"]
async fn original_quartz_composite_foreign_keys_round_trip() -> Result<(), String> {
    let url = std::env::var("DBX_LIVE_MYSQL_URL").expect("set DBX_LIVE_MYSQL_URL to a disposable instance");
    let pool = mysql::connect(&url, Duration::from_secs(10)).await?;
    let mut conn = pool.get_conn().await.map_err(|error| error.to_string())?;
    let version: String = conn.query_first("SELECT VERSION()").await.map_err(|e| e.to_string())?.unwrap();
    assert!(version.starts_with("5.7.") || version.starts_with("8.4."), "unsupported test version: {version}");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source = format!("dbx_fk_source_{suffix}");
    let target = format!("dbx_fk_target_{suffix}");
    let mut created = Vec::new();
    let result: Result<(), String> = async {
        for database in [&source, &target] {
            conn.query_drop(format!("CREATE DATABASE `{database}`")).await.map_err(|e| e.to_string())?;
            created.push(database.clone());
            conn.query_drop(format!("USE `{database}`")).await.map_err(|e| e.to_string())?;
            conn.query_drop(include_str!("fixtures/qrtz.sql")).await.map_err(|e| e.to_string())?;
        }
        // Native driver rows must remain column pairs for navigation and other consumers.
        let rows = mysql::list_foreign_keys(&pool, &source, "qrtz_blob_triggers").await?;
        if rows.iter().map(|fk| (fk.column.as_str(), fk.ref_column.as_str())).collect::<Vec<_>>()
            != vec![("sched_name", "sched_name"), ("trigger_name", "trigger_name"), ("trigger_group", "trigger_group")]
        {
            return Err(format!("driver lost ordered pairs: {rows:?}"));
        }
        for _ in 0..3 {
            for other in [&source, &target] {
                let prepared = compare(&pool, &source, other).await?;
                if !prepared.diffs.is_empty() || !prepared.sync_sql.trim().is_empty() {
                    return Err(format!(
                        "equivalent schema falsely differs: {}",
                        serde_json::to_string(&prepared).unwrap()
                    ));
                }
            }
        }
        conn.query_drop(format!(
            "ALTER TABLE `{target}`.`qrtz_blob_triggers` DROP FOREIGN KEY `qrtz_blob_triggers_ibfk_1`"
        )).await.map_err(|e| e.to_string())?;
        conn.query_drop(format!(
            "ALTER TABLE `{target}`.`qrtz_blob_triggers` ADD CONSTRAINT `qrtz_blob_triggers_ibfk_1` FOREIGN KEY (`sched_name`,`trigger_name`,`trigger_group`) \
             REFERENCES `{target}`.`qrtz_triggers` (`sched_name`,`trigger_name`,`trigger_group`) ON DELETE CASCADE"
        ))
        .await
        .map_err(|e| e.to_string())?;
        let changed = compare(&pool, &source, &target).await?;
        if changed.diffs.len() != 1 || changed.diffs[0].foreign_keys.as_ref().map(Vec::len) != Some(1) {
            return Err(format!("expected one changed constraint: {:?}", changed.diffs));
        }
        if changed.sync_sql.matches("DROP FOREIGN KEY").count() != 1
            || changed.sync_sql.matches("ADD CONSTRAINT").count() != 1
            || !changed.sync_sql.contains("(`sched_name`, `trigger_name`, `trigger_group`)")
        {
            return Err(format!("incomplete composite SQL: {}", changed.sync_sql));
        }
        conn.query_drop(&changed.sync_sql).await.map_err(|e| e.to_string())?;
        let converged = compare(&pool, &source, &target).await?;
        if !converged.diffs.is_empty() || !converged.sync_sql.trim().is_empty() {
            return Err(format!("sync did not converge: {:?}", converged.diffs));
        }
        let final_rows = mysql::list_foreign_keys(&pool, &target, "qrtz_blob_triggers").await?;
        if final_rows.len() != rows.len()
            || final_rows.iter().zip(&rows).any(|(actual, expected)| {
                actual.column != expected.column || actual.ref_column != expected.ref_column
                    || actual.on_delete != expected.on_delete || actual.on_update != expected.on_update
            }) {
            return Err(format!("incorrect final metadata: {final_rows:?}"));
        }
        Ok(())
    }
    .await;
    // MySQL DDL does not roll back: cleanup uses only successfully created names.
    for database in created.into_iter().rev() {
        conn.query_drop(format!("DROP DATABASE `{database}`")).await.map_err(|e| e.to_string())?;
    }
    result
}
