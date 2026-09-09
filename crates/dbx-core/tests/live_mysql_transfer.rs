use dbx_core::connection::AppState;
use dbx_core::db::mysql;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;
use dbx_core::transfer::{
    drop_backup_tables, execute_on_pool, rename_tables_to_backup, sort_tables_by_fk_dependency_with_foreign_keys,
    transfer_table, TransferContent, TransferMode, TransferOwnershipPolicy, TransferRequest, TransferTableNameCase,
};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

fn live_mysql_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_MYSQL_TRANSFER_HOST").expect("DBX_LIVE_MYSQL_TRANSFER_HOST");
    let port =
        std::env::var("DBX_LIVE_MYSQL_TRANSFER_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3306);
    let username = std::env::var("DBX_LIVE_MYSQL_TRANSFER_USER").unwrap_or_else(|_| "root".to_string());
    let password = std::env::var("DBX_LIVE_MYSQL_TRANSFER_PASSWORD").expect("DBX_LIVE_MYSQL_TRANSFER_PASSWORD");

    serde_json::from_value(json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MySQL transfer config should deserialize")
}

fn live_cross_version_mysql_config(id: &str, prefix: &str) -> ConnectionConfig {
    let host = std::env::var(format!("DBX_LIVE_MYSQL_TRANSFER_{prefix}_HOST"))
        .unwrap_or_else(|_| panic!("DBX_LIVE_MYSQL_TRANSFER_{prefix}_HOST"));
    let port = std::env::var(format!("DBX_LIVE_MYSQL_TRANSFER_{prefix}_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3306);
    let username =
        std::env::var(format!("DBX_LIVE_MYSQL_TRANSFER_{prefix}_USER")).unwrap_or_else(|_| "root".to_string());
    let password = std::env::var(format!("DBX_LIVE_MYSQL_TRANSFER_{prefix}_PASSWORD"))
        .unwrap_or_else(|_| panic!("DBX_LIVE_MYSQL_TRANSFER_{prefix}_PASSWORD"));

    serde_json::from_value(json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live cross-version MySQL transfer config should deserialize")
}

fn mysql_url(config: &ConnectionConfig) -> String {
    format!("mysql://{}:{}@{}:{}", config.username, config.password, config.host, config.port)
}

fn transfer_request(
    transfer_id: String,
    connection_id: &str,
    source_database: &str,
    target_database: &str,
    mode: TransferMode,
) -> TransferRequest {
    TransferRequest {
        transfer_id,
        source_connection_id: connection_id.to_string(),
        source_database: source_database.to_string(),
        source_schema: source_database.to_string(),
        source_catalog: None,
        target_connection_id: connection_id.to_string(),
        target_database: target_database.to_string(),
        target_schema: target_database.to_string(),
        target_catalog: None,
        tables: vec!["spatial_matrix".to_string()],
        create_table: false,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 2,
    }
}

async fn query_text(pool: &mysql::MySqlPool, sql: &str) -> String {
    mysql::execute_query(pool, sql, false).await.unwrap().rows[0][0].as_str().unwrap().to_string()
}

/// `COUNT(*)` over one `information_schema` view, which is the shape every structural
/// assertion in the `drop_target_before_create` tests below needs (does the table exist,
/// does the column exist, was the index rebuilt, is the foreign key back).
async fn schema_count(pool: &mysql::MySqlPool, from_and_where: &str) -> String {
    query_text(pool, &format!("SELECT CAST(COUNT(*) AS CHAR) FROM information_schema.{from_and_where}")).await
}

#[test]
#[ignore = "requires disposable MySQL 8.0.33 source and 8.0.45 target endpoints via DBX_LIVE_MYSQL_TRANSFER_SOURCE_*/TARGET_* variables"]
fn live_mysql_cross_version_transfer_completes_on_small_stack() {
    std::thread::Builder::new()
        .name("live-mysql-transfer-small-stack".to_string())
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(run_live_mysql_cross_version_transfer_completes_on_small_stack());
        })
        .unwrap()
        .join()
        .unwrap();
}

async fn run_live_mysql_cross_version_transfer_completes_on_small_stack() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_connection_id = format!("small-stack-source-{suffix}");
    let target_connection_id = format!("small-stack-target-{suffix}");
    let source_database = format!("dbx_stack_src_{}", &suffix[..12]);
    let target_database = format!("dbx_stack_dst_{}", &suffix[..12]);
    let source_config = live_cross_version_mysql_config(&source_connection_id, "SOURCE");
    let target_config = live_cross_version_mysql_config(&target_connection_id, "TARGET");
    let source_setup_pool = mysql::connect(&mysql_url(&source_config), Duration::from_secs(10)).await.unwrap();
    let target_setup_pool = mysql::connect(&mysql_url(&target_config), Duration::from_secs(10)).await.unwrap();

    mysql::execute_query(
        &source_setup_pool,
        &format!(
            "CREATE DATABASE {source_database} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\
             CREATE TABLE {source_database}.title_task (\
               id VARCHAR(32) NOT NULL, deleted BIT(1) NOT NULL DEFAULT b'0', creator BIGINT NOT NULL,\
               create_time DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updater BIGINT DEFAULT NULL,\
               update_time DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\
               creator_name VARCHAR(255), updater_name VARCHAR(255), task_name VARCHAR(100),\
               title_level VARCHAR(100), task_year INT, review_result VARCHAR(100),\
               review_mode TINYINT NOT NULL DEFAULT 0, score_snapshot_json TEXT,\
               task_start_time DATETIME, task_end_time DATETIME, task_status INT DEFAULT 0,\
               is_remove_highest_score INT DEFAULT 0, is_remove_minimum_score INT DEFAULT 0,\
               task_files TEXT, task_level VARCHAR(30), org_id BIGINT, org_code VARCHAR(255),\
               org_name VARCHAR(255), school_id BIGINT, school_name VARCHAR(255),\
               province_code VARCHAR(50), province_name VARCHAR(255), city_code VARCHAR(50),\
               city_name VARCHAR(255), area_code VARCHAR(50), area_name VARCHAR(255),\
               PRIMARY KEY (id), KEY idx_task_name (task_name), KEY idx_task_year (task_year),\
               KEY idx_task_status (task_status), KEY idx_org_id (org_id), KEY idx_org_code (org_code)\
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;\
             INSERT INTO {source_database}.title_task \
               (id, deleted, creator, review_result, review_mode, score_snapshot_json) VALUES\
               ('small-stack-default', b'0', 1, 'pending', 0, '{{\"score\":88}}'),\
               ('small-stack-non-default', b'0', 2, 'approved', 2, '{{\"score\":95}}')"
        ),
        true,
    )
    .await
    .unwrap();
    mysql::execute_query(&target_setup_pool, &format!("CREATE DATABASE {target_database}"), false).await.unwrap();

    let task_tmp = std::path::PathBuf::from(
        std::env::var("DBX_LIVE_MYSQL_TRANSFER_TMP_DIR").expect("DBX_LIVE_MYSQL_TRANSFER_TMP_DIR"),
    );
    let dir = task_tmp.join(format!("small-stack-transfer-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(source_connection_id.clone(), source_config);
    state.configs.write().await.insert(target_connection_id.clone(), target_config);
    let source_pool_key = state.get_or_create_pool(&source_connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&target_connection_id, Some(&target_database)).await.unwrap();
    let request = TransferRequest {
        transfer_id: format!("small-stack-transfer-{suffix}"),
        source_connection_id,
        source_database: source_database.clone(),
        source_schema: source_database.clone(),
        source_catalog: None,
        target_connection_id,
        target_database: target_database.clone(),
        target_schema: target_database.clone(),
        target_catalog: None,
        tables: vec!["title_task".to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };

    let test_result = async {
        let transferred = transfer_table(
            &state,
            &request,
            "title_task",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(transferred, 2);
        assert_eq!(
            query_text(
                &target_setup_pool,
                &format!(
                    "SELECT CAST(COUNT(*) AS CHAR) FROM information_schema.columns \
                     WHERE table_schema = '{target_database}' AND table_name = 'title_task'"
                ),
            )
            .await,
            "32"
        );
        assert_eq!(
            query_text(
                &target_setup_pool,
                &format!(
                    "SELECT GROUP_CONCAT(CONCAT(id, ':', review_mode) ORDER BY id SEPARATOR ',') \
                     FROM {target_database}.title_task"
                ),
            )
            .await,
            "small-stack-default:0,small-stack-non-default:2"
        );
        let review_mode = mysql::execute_query(
            &target_setup_pool,
            &format!(
                "SELECT ordinal_position, column_type, is_nullable, column_default \
                 FROM information_schema.columns WHERE table_schema = '{target_database}' \
                 AND table_name = 'title_task' AND column_name = 'review_mode'"
            ),
            false,
        )
        .await?;
        assert_eq!(review_mode.rows.len(), 1);
        assert_eq!(review_mode.rows[0][0], json!("13"));
        assert_eq!(review_mode.rows[0][1], json!("tinyint"));
        assert_eq!(review_mode.rows[0][2], json!("NO"));
        assert_eq!(review_mode.rows[0][3], json!("0"));
        Ok::<_, String>(())
    }
    .await;

    mysql::execute_query(&source_setup_pool, &format!("DROP DATABASE {source_database}"), false).await.unwrap();
    mysql::execute_query(&target_setup_pool, &format!("DROP DATABASE {target_database}"), false).await.unwrap();
    source_setup_pool.disconnect().await.unwrap();
    target_setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
    test_result.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8 endpoints via DBX_LIVE_MYSQL_TRANSFER_* variables"]
async fn live_mysql_transfer_keeps_columns_whose_comment_mentions_foreign_key() {
    // #7660: the deferred-FK DDL rewrite used to delete any `SHOW CREATE
    // TABLE` line containing " FOREIGN KEY ", including column definitions
    // whose COMMENT text merely mentions the words — silently dropping those
    // columns from the created target table.
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_connection_id = format!("live-mysql8-transfer-{suffix}");
    let target_connection_id = format!("live-mysql8-transfer-dst-{suffix}");
    let source_database = format!("dbx_7660_src_{}", &suffix[..12]);
    let target_database = format!("dbx_7660_dst_{}", &suffix[..12]);
    let source_config = live_mysql_config(&source_connection_id);
    let target_config = live_mysql_config(&target_connection_id);
    let source_setup_pool = mysql::connect(&mysql_url(&source_config), Duration::from_secs(10)).await.unwrap();
    let target_setup_pool = mysql::connect(&mysql_url(&target_config), Duration::from_secs(10)).await.unwrap();

    mysql::execute_query(
        &source_setup_pool,
        &format!(
            "CREATE DATABASE `{source_database}` CHARACTER SET utf8mb4;\
             CREATE TABLE `{source_database}`.`org` (\
               id BIGINT NOT NULL,\
               name VARCHAR(64) DEFAULT NULL,\
               PRIMARY KEY (id)\
             ) ENGINE=InnoDB;\
             CREATE TABLE `{source_database}`.`title_task` (\
               `id` varchar(32) NOT NULL,\
               `review_result` varchar(100) DEFAULT NULL,\
               `review_mode` tinyint NOT NULL DEFAULT '0' COMMENT 'foreign key of review flow',\
               `score_snapshot_json` text COMMENT 'snapshot json, see foreign key docs',\
               `task_status` int DEFAULT '0',\
               `org_id` bigint DEFAULT NULL,\
               PRIMARY KEY (`id`),\
               KEY `idx_task_status` (`task_status`),\
               KEY `fk_title_task_org` (`org_id`),\
               CONSTRAINT `fk_title_task_org` FOREIGN KEY (`org_id`) REFERENCES `{source_database}`.`org` (`id`)\
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\
             INSERT INTO `{source_database}`.`org` VALUES (1, 'hq'), (2, 'branch');\
             INSERT INTO `{source_database}`.`title_task` VALUES \
               ('t1', 'pass', 1, 'score=9', 0, 1),\
               ('t2', NULL, 0, NULL, 1, 2)"
        ),
        true,
    )
    .await
    .unwrap();
    mysql::execute_query(
        &target_setup_pool,
        &format!("CREATE DATABASE `{target_database}` CHARACTER SET utf8mb4"),
        false,
    )
    .await
    .unwrap();

    let task_tmp = std::path::PathBuf::from(
        std::env::var("DBX_LIVE_MYSQL_TRANSFER_TMP_DIR").expect("DBX_LIVE_MYSQL_TRANSFER_TMP_DIR"),
    );
    let dir = task_tmp.join(format!("live-mysql-fk-comment-transfer-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(source_connection_id.clone(), source_config);
    state.configs.write().await.insert(target_connection_id.clone(), target_config);
    let source_pool_key = state.get_or_create_pool(&source_connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&target_connection_id, Some(&target_database)).await.unwrap();
    let request = TransferRequest {
        transfer_id: format!("live-mysql-fk-comment-transfer-{suffix}"),
        source_connection_id,
        source_database: source_database.clone(),
        source_schema: source_database.clone(),
        source_catalog: None,
        target_connection_id,
        target_database: target_database.clone(),
        target_schema: target_database.clone(),
        target_catalog: None,
        tables: vec!["org".to_string(), "title_task".to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    let test_result = async {
        let mut pending_fk_alters: Vec<(String, String)> = Vec::new();
        assert_eq!(
            transfer_table(
                &state,
                &request,
                "org",
                0,
                &DatabaseType::Mysql,
                &DatabaseType::Mysql,
                &source_pool_key,
                &target_pool_key,
                &std::collections::HashMap::new(),
                &mut pending_fk_alters,
                None,
                |_| {},
            )
            .await?,
            2
        );
        assert_eq!(
            transfer_table(
                &state,
                &request,
                "title_task",
                1,
                &DatabaseType::Mysql,
                &DatabaseType::Mysql,
                &source_pool_key,
                &target_pool_key,
                &std::collections::HashMap::new(),
                &mut pending_fk_alters,
                None,
                |_| {},
            )
            .await?,
            2
        );
        assert_eq!(pending_fk_alters.len(), 1, "alters: {pending_fk_alters:?}");
        for (_, statement) in &pending_fk_alters {
            dbx_core::transfer::execute_on_pool_with_max_rows(&state, &target_pool_key, statement, None).await.unwrap();
        }

        let ddl_result = mysql::execute_query(
            &target_setup_pool,
            &format!("SHOW CREATE TABLE `{target_database}`.`title_task`"),
            false,
        )
        .await?;
        let target_ddl = ddl_result.rows[0][1].as_str().unwrap();
        assert!(target_ddl.contains("`review_mode` tinyint NOT NULL DEFAULT '0'"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("`score_snapshot_json` text"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("COMMENT 'foreign key of review flow'"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("KEY `idx_task_status` (`task_status`)"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("CONSTRAINT `fk_title_task_org` FOREIGN KEY"), "ddl: {target_ddl}");
        assert_eq!(
            query_text(
                &target_setup_pool,
                &format!(
                    "SELECT GROUP_CONCAT(CONCAT(id, ':', review_mode, ':', IFNULL(score_snapshot_json, 'N')) \
                     ORDER BY id SEPARATOR '|') FROM `{target_database}`.`title_task`"
                ),
            )
            .await,
            "t1:1:score=9|t2:0:N"
        );
        Ok::<_, String>(())
    }
    .await;

    let source_cleanup =
        mysql::execute_query(&source_setup_pool, &format!("DROP DATABASE `{source_database}`"), false).await;
    let target_cleanup =
        mysql::execute_query(&target_setup_pool, &format!("DROP DATABASE `{target_database}`"), false).await;
    source_setup_pool.disconnect().await.unwrap();
    target_setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
    source_cleanup.unwrap();
    target_cleanup.unwrap();
    test_result.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable MySQL 8 source and 5.7 target endpoints via DBX_LIVE_MYSQL_TRANSFER_SOURCE_*/TARGET_* variables"]
async fn live_mysql_transfer_downgrades_unsupported_source_collations() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_connection_id = format!("live-mysql8-transfer-{suffix}");
    let target_connection_id = format!("live-mysql57-transfer-{suffix}");
    let source_database = format!("dbx_6023_src_{}", &suffix[..12]);
    let target_database = format!("dbx_6023_dst_{}", &suffix[..12]);
    let modern_target_database = format!("dbx_6023_modern_{}", &suffix[..12]);
    let source_config = live_cross_version_mysql_config(&source_connection_id, "SOURCE");
    let target_config = live_cross_version_mysql_config(&target_connection_id, "TARGET");
    let source_setup_pool = mysql::connect(&mysql_url(&source_config), Duration::from_secs(10)).await.unwrap();
    let target_setup_pool = mysql::connect(&mysql_url(&target_config), Duration::from_secs(10)).await.unwrap();

    mysql::execute_query(
        &source_setup_pool,
        &format!(
            "CREATE DATABASE `{source_database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\
             CREATE DATABASE `{modern_target_database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;\
             CREATE TABLE `{source_database}`.`transfer_probe` (\
               id BIGINT NOT NULL AUTO_INCREMENT,\
               code VARCHAR(64) COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'x' COMMENT 'probe',\
               legacy VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,\
               normalized VARCHAR(64) GENERATED ALWAYS AS (lower(code)) STORED,\
               updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\
               PRIMARY KEY (id), UNIQUE KEY uk_code (code), KEY idx_legacy (legacy)\
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='issue 6023';\
             INSERT INTO `{source_database}`.`transfer_probe` (code, legacy) VALUES ('AbC', 'legacy')"
        ),
        true,
    )
    .await
    .unwrap();
    mysql::execute_query(
        &target_setup_pool,
        &format!("CREATE DATABASE `{target_database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"),
        false,
    )
    .await
    .unwrap();

    let task_tmp = std::path::PathBuf::from(
        std::env::var("DBX_LIVE_MYSQL_TRANSFER_TMP_DIR").expect("DBX_LIVE_MYSQL_TRANSFER_TMP_DIR"),
    );
    let dir = task_tmp.join(format!("live-mysql-collation-transfer-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(source_connection_id.clone(), source_config);
    state.configs.write().await.insert(target_connection_id.clone(), target_config);
    let source_pool_key = state.get_or_create_pool(&source_connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&target_connection_id, Some(&target_database)).await.unwrap();
    let modern_target_pool_key =
        state.get_or_create_pool(&source_connection_id, Some(&modern_target_database)).await.unwrap();
    let request = TransferRequest {
        transfer_id: format!("live-mysql-collation-transfer-{suffix}"),
        source_connection_id,
        source_database: source_database.clone(),
        source_schema: source_database.clone(),
        source_catalog: None,
        target_connection_id,
        target_database: target_database.clone(),
        target_schema: target_database.clone(),
        target_catalog: None,
        tables: vec!["transfer_probe".to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    let test_result = async {
        let transferred = transfer_table(
            &state,
            &request,
            "transfer_probe",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(transferred, 1);
        let ddl_result = mysql::execute_query(
            &target_setup_pool,
            &format!("SHOW CREATE TABLE `{target_database}`.`transfer_probe`"),
            false,
        )
        .await?;
        let target_ddl = ddl_result.rows[0][1].as_str().unwrap();
        assert!(!target_ddl.contains("utf8mb4_0900_ai_ci"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("COLLATE utf8mb4_unicode_ci"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("AUTO_INCREMENT"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("GENERATED ALWAYS AS"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("ON UPDATE CURRENT_TIMESTAMP"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("UNIQUE KEY `uk_code`"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("KEY `idx_legacy`"), "ddl: {target_ddl}");
        assert!(target_ddl.contains("COMMENT='issue 6023'"), "ddl: {target_ddl}");
        assert_eq!(
            query_text(
                &target_setup_pool,
                &format!("SELECT CONCAT(code, ':', legacy, ':', normalized) FROM `{target_database}`.`transfer_probe`"),
            )
            .await,
            "AbC:legacy:abc"
        );

        let modern_request = TransferRequest {
            transfer_id: format!("live-mysql-modern-collation-transfer-{suffix}"),
            source_connection_id: request.source_connection_id.clone(),
            source_database: source_database.clone(),
            source_schema: source_database.clone(),
            source_catalog: None,
            target_connection_id: request.source_connection_id.clone(),
            target_database: modern_target_database.clone(),
            target_schema: modern_target_database.clone(),
            target_catalog: None,
            tables: vec!["transfer_probe".to_string()],
            create_table: true,
            drop_target_before_create: false,
            drop_target_confirmed: false,
            content: TransferContent::default(),
            objects: Vec::new(),
            mode: TransferMode::Append,
            target_table_name_case: TransferTableNameCase::Preserve,
            quote_target_column_names: true,
            ownership_policy: TransferOwnershipPolicy::Preserve,
            batch_size: 10,
        };
        assert_eq!(
            transfer_table(
                &state,
                &modern_request,
                "transfer_probe",
                0,
                &DatabaseType::Mysql,
                &DatabaseType::Mysql,
                &source_pool_key,
                &modern_target_pool_key,
                &std::collections::HashMap::new(),
                &mut Vec::new(),
                None,
                |_| {},
            )
            .await?,
            1
        );
        let modern_ddl = mysql::execute_query(
            &source_setup_pool,
            &format!("SHOW CREATE TABLE `{modern_target_database}`.`transfer_probe`"),
            false,
        )
        .await?
        .rows[0][1]
            .as_str()
            .unwrap()
            .to_string();
        assert!(modern_ddl.contains("utf8mb4_0900_ai_ci"), "ddl: {modern_ddl}");
        Ok::<_, String>(())
    }
    .await;

    let source_cleanup = mysql::execute_query(
        &source_setup_pool,
        &format!("DROP DATABASE `{source_database}`; DROP DATABASE `{modern_target_database}`"),
        true,
    )
    .await;
    let target_cleanup =
        mysql::execute_query(&target_setup_pool, &format!("DROP DATABASE `{target_database}`"), false).await;
    source_setup_pool.disconnect().await.unwrap();
    target_setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
    source_cleanup.unwrap();
    target_cleanup.unwrap();
    test_result.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable MySQL 5.7+ endpoint via DBX_LIVE_MYSQL_TRANSFER_* variables"]
async fn live_mysql_transfer_preserves_spatial_values_and_modes() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-transfer-{suffix}");
    let source_database = format!("dbx_transfer_src_{}", &suffix[..12]);
    let target_database = format!("dbx_transfer_dst_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    let setup = format!(
        "CREATE DATABASE `{source_database}`;\
         CREATE DATABASE `{target_database}`;\
         CREATE TABLE `{source_database}`.`spatial_matrix` (\
             id INT PRIMARY KEY, name VARCHAR(32), payload VARBINARY(8), created_at DATETIME,\
             g GEOMETRY NULL, p POINT NULL, ls LINESTRING NULL, poly POLYGON NULL,\
             mp MULTIPOINT NULL, mls MULTILINESTRING NULL, mpoly MULTIPOLYGON NULL,\
             gc GEOMETRYCOLLECTION NULL\
         );\
         CREATE TABLE `{target_database}`.`spatial_matrix` LIKE `{source_database}`.`spatial_matrix`;\
         INSERT INTO `{source_database}`.`spatial_matrix` VALUES (\
             1, 'alpha', 0x00FF, '2026-08-12 10:20:30',\
             ST_GeomFromText('POINT(1 2)', 4326), ST_GeomFromText('POINT(3 4)', 4326),\
             ST_GeomFromText('LINESTRING(0 0,1 1)', 4326),\
             ST_GeomFromText('POLYGON((0 0,0 1,1 1,0 0))', 4326),\
             ST_GeomFromText('MULTIPOINT((0 0),(1 1))', 4326),\
             ST_GeomFromText('MULTILINESTRING((0 0,1 1))', 4326),\
             ST_GeomFromText('MULTIPOLYGON(((0 0,0 1,1 1,0 0)))', 4326),\
             ST_GeomFromText('GEOMETRYCOLLECTION(POINT(1 1))', 4326)\
         ), (2, 'nulls', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL), (\
             3, 'omega', 0xCAFE, '2026-08-12 11:22:33',\
             ST_GeomFromText('LINESTRING(2 2,3 3)', 3857), ST_GeomFromText('POINT(5 6)', 3857),\
             ST_GeomFromText('LINESTRING(4 4,5 5)', 3857),\
             ST_GeomFromText('POLYGON((2 2,2 3,3 3,2 2))', 3857),\
             ST_GeomFromText('MULTIPOINT((2 2),(3 3))', 3857),\
             ST_GeomFromText('MULTILINESTRING((2 2,3 3))', 3857),\
             ST_GeomFromText('MULTIPOLYGON(((2 2,2 3,3 3,2 2)))', 3857),\
             ST_GeomFromText('GEOMETRYCOLLECTION(POINT(2 2))', 3857)\
         )"
    );
    mysql::execute_query(&setup_pool, &setup, true).await.unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-transfer-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), config);
    let source_pool_key = state.get_or_create_pool(&connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&connection_id, Some(&target_database)).await.unwrap();

    let test_result = async {
        let append = transfer_table(
            &state,
            &transfer_request(
                format!("live-mysql-transfer-append-{suffix}"),
                &connection_id,
                &source_database,
                &target_database,
                TransferMode::Append,
            ),
            "spatial_matrix",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(append, 3);
        assert_eq!(
            query_text(
                &setup_pool,
                &format!(
                    "SELECT CAST(CONCAT((SELECT COUNT(*) FROM `{target_database}`.`spatial_matrix`), ':', \
                     ST_AsText(p), ':', ST_SRID(p), ':', HEX(payload), ':', \
                     DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s'), ':', \
                     (SELECT SUM(g IS NULL) FROM `{target_database}`.`spatial_matrix`)) AS CHAR) \
                     FROM `{target_database}`.`spatial_matrix` WHERE id=1"
                ),
            )
            .await,
            "3:POINT(3 4):4326:00FF:2026-08-12 10:20:30:1"
        );
        let spatial_types = query_text(
            &setup_pool,
            &format!(
                "SELECT CAST(CONCAT_WS('|', ST_AsText(g), ST_AsText(p), ST_AsText(ls), ST_AsText(poly), \
                 ST_AsText(mp), ST_AsText(mls), ST_AsText(mpoly), ST_AsText(gc)) AS CHAR) \
                 FROM `{target_database}`.`spatial_matrix` WHERE id=1"
            ),
        )
        .await;
        assert_eq!(
            spatial_types,
            "POINT(1 2)|POINT(3 4)|LINESTRING(0 0,1 1)|POLYGON((0 0,0 1,1 1,0 0))|MULTIPOINT((0 0),(1 1))|MULTILINESTRING((0 0,1 1))|MULTIPOLYGON(((0 0,0 1,1 1,0 0)))|GEOMETRYCOLLECTION(POINT(1 1))"
        );

        mysql::execute_query(
            &setup_pool,
            &format!("INSERT INTO `{target_database}`.`spatial_matrix` (id, name) VALUES (99, 'stale')"),
            false,
        )
        .await?;
        let overwrite = transfer_table(
            &state,
            &transfer_request(
                format!("live-mysql-transfer-overwrite-{suffix}"),
                &connection_id,
                &source_database,
                &target_database,
                TransferMode::Overwrite,
            ),
            "spatial_matrix",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(overwrite, 3);
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(CONCAT(COUNT(*), ':', SUM(id=99)) AS CHAR) FROM `{target_database}`.`spatial_matrix`"),
            )
            .await,
            "3:0"
        );

        mysql::execute_query(
            &setup_pool,
            &format!("UPDATE `{source_database}`.`spatial_matrix` SET name='updated' WHERE id=1"),
            false,
        )
        .await?;
        let upsert = transfer_table(
            &state,
            &transfer_request(
                format!("live-mysql-transfer-upsert-{suffix}"),
                &connection_id,
                &source_database,
                &target_database,
                TransferMode::Upsert,
            ),
            "spatial_matrix",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(upsert, 3);
        assert_eq!(
            query_text(
                &setup_pool,
                &format!(
                    "SELECT CAST(CONCAT(name, ':', ST_AsText(p), ':', ST_SRID(p)) AS CHAR) \
                     FROM `{target_database}`.`spatial_matrix` WHERE id=1"
                ),
            )
            .await,
            "updated:POINT(3 4):4326"
        );
        Ok::<_, String>(())
    }
    .await;

    let cleanup = mysql::execute_query(
        &setup_pool,
        &format!("DROP DATABASE `{source_database}`; DROP DATABASE `{target_database}`"),
        true,
    )
    .await;
    setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
    cleanup.unwrap();
    test_result.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable MySQL 5.7+ endpoint via DBX_LIVE_MYSQL_TRANSFER_* variables"]
async fn live_mysql_transfer_structure_overwrite_rejects_incompatible_target_columns() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-transfer-struct-{suffix}");
    let source_database = format!("dbx_transfer_struct_src_{}", &suffix[..12]);
    let target_database = format!("dbx_transfer_struct_dst_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    let setup = format!(
        "CREATE DATABASE `{source_database}`;\
         CREATE DATABASE `{target_database}`;\
         CREATE TABLE `{source_database}`.`orders` (\
             id INT PRIMARY KEY, name VARCHAR(32), extra_col VARCHAR(32)\
         );\
         INSERT INTO `{source_database}`.`orders` VALUES (1, 'alpha', 'x');\
         CREATE TABLE `{target_database}`.`orders` (\
             id INT PRIMARY KEY, name VARCHAR(32)\
         );\
         INSERT INTO `{target_database}`.`orders` (id, name) VALUES (99, 'stale');\
         CREATE TABLE `{source_database}`.`required_orders` (\
             id INT PRIMARY KEY, name VARCHAR(32)\
         );\
         INSERT INTO `{source_database}`.`required_orders` VALUES (1, 'alpha');\
         CREATE TABLE `{target_database}`.`required_orders` (\
             id INT PRIMARY KEY, name VARCHAR(32), required_code VARCHAR(32) NOT NULL\
         );\
         INSERT INTO `{target_database}`.`required_orders` (id, name, required_code) VALUES (99, 'stale', 'keep')"
    );
    mysql::execute_query(&setup_pool, &setup, true).await.unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-transfer-struct-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), config);
    let source_pool_key = state.get_or_create_pool(&connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&connection_id, Some(&target_database)).await.unwrap();

    // Mirrors the UI: "structure + data" content always requests create_table,
    // and the reporter picked overwrite mode. The target table already exists
    // with a column that's missing from the source ("orders" lacks extra_col).
    let request = TransferRequest {
        transfer_id: format!("live-mysql-transfer-struct-overwrite-{suffix}"),
        source_connection_id: connection_id.clone(),
        source_database: source_database.clone(),
        source_schema: source_database.clone(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: target_database.clone(),
        target_schema: target_database.clone(),
        target_catalog: None,
        tables: vec!["orders".to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Overwrite,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    let test_result = async {
        let result = transfer_table(
            &state,
            &request,
            "orders",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await;

        let error = result.expect_err("expected transfer to reject the incompatible target structure");
        assert!(error.contains("extra_col"), "unexpected missing-source-column error: {error}");

        // The pre-existing target row must survive: a column-mismatch error must
        // be raised BEFORE the destructive TRUNCATE, not surface only after the
        // target has already been wiped by an insert that was doomed to fail.
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`orders` WHERE id=99"),
            )
            .await,
            "1",
            "target row was destroyed by TRUNCATE despite the transfer failing"
        );

        let required_request = TransferRequest {
            transfer_id: format!("live-mysql-transfer-required-target-overwrite-{suffix}"),
            source_connection_id: connection_id.clone(),
            source_database: source_database.clone(),
            source_schema: source_database.clone(),
            source_catalog: None,
            target_connection_id: connection_id.clone(),
            target_database: target_database.clone(),
            target_schema: target_database.clone(),
            target_catalog: None,
            tables: vec!["required_orders".to_string()],
            create_table: true,
            drop_target_before_create: false,
            drop_target_confirmed: false,
            content: TransferContent::default(),
            objects: Vec::new(),
            mode: TransferMode::Overwrite,
            target_table_name_case: TransferTableNameCase::Preserve,
            quote_target_column_names: true,
            ownership_policy: TransferOwnershipPolicy::Preserve,
            batch_size: 10,
        };
        let required_result = transfer_table(
            &state,
            &required_request,
            "required_orders",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await;
        let required_error = required_result.expect_err("expected transfer to reject a required target-only column");
        assert!(required_error.contains("required_code"), "unexpected required-target-column error: {required_error}");
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`required_orders` WHERE id=99"),
            )
            .await,
            "1",
            "target row was destroyed by TRUNCATE despite the required target column mismatch"
        );
        Ok::<_, String>(())
    }
    .await;

    let cleanup = mysql::execute_query(
        &setup_pool,
        &format!("DROP DATABASE `{source_database}`; DROP DATABASE `{target_database}`"),
        true,
    )
    .await;
    setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
    cleanup.unwrap();
    test_result.unwrap();
}

#[tokio::test]
#[ignore = "requires a disposable MySQL 5.7+ endpoint via DBX_LIVE_MYSQL_TRANSFER_* variables"]
async fn live_mysql_transfer_structure_only_rejects_incompatible_target_columns() {
    // #7660: structure-only transfers onto a preexisting target used to skip
    // the incompatible-structure validation entirely and report success while
    // the target quietly kept missing source columns.
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-transfer-structonly-{suffix}");
    let source_database = format!("dbx_transfer_structonly_src_{}", &suffix[..12]);
    let target_database = format!("dbx_transfer_structonly_dst_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    let setup = format!(
        "CREATE DATABASE `{source_database}`;\
         CREATE DATABASE `{target_database}`;\
         CREATE TABLE `{source_database}`.`orders` (\
             id INT PRIMARY KEY, name VARCHAR(32), extra_col VARCHAR(32)\
         );\
         CREATE TABLE `{target_database}`.`orders` (\
             id INT PRIMARY KEY, name VARCHAR(32)\
         )"
    );
    mysql::execute_query(&setup_pool, &setup, true).await.unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-transfer-structonly-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), config);
    let source_pool_key = state.get_or_create_pool(&connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&connection_id, Some(&target_database)).await.unwrap();

    let request = TransferRequest {
        transfer_id: format!("live-mysql-transfer-structonly-{suffix}"),
        source_connection_id: connection_id.clone(),
        source_database: source_database.clone(),
        source_schema: source_database.clone(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: target_database.clone(),
        target_schema: target_database.clone(),
        target_catalog: None,
        tables: vec!["orders".to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::StructureOnly,
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    let test_result = async {
        let result = transfer_table(
            &state,
            &request,
            "orders",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await;
        let error = result.expect_err("structure-only transfer onto an incompatible preexisting target should fail");
        assert!(error.contains("missing column(s) extra_col"), "error should name the missing column: {error}");
        Ok::<_, String>(())
    }
    .await;

    let cleanup = mysql::execute_query(
        &setup_pool,
        &format!("DROP DATABASE `{source_database}`; DROP DATABASE `{target_database}`"),
        true,
    )
    .await;
    setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
    cleanup.unwrap();
    test_result.unwrap();
}

/// Parent/child foreign key topology: the rename pre-pass must run children-first so that
/// each referencing table is renamed before the table it points to, and the foreign key
/// must be rebuilt after the main pass completes.
#[tokio::test]
#[ignore = "requires a disposable MySQL 5.7+ endpoint via DBX_LIVE_MYSQL_TRANSFER_* variables"]
async fn live_mysql_transfer_drop_target_parent_child_foreign_key() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-parent-child-{suffix}");
    let source_database = format!("dbx_parent_child_src_{}", &suffix[..12]);
    let target_database = format!("dbx_parent_child_dst_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    // Parent table `departments` referenced by child table `employees`. Both have stale target
    // rows that the drop-recreate must replace.
    let setup = format!(
        "CREATE DATABASE `{source_database}`;\
         CREATE DATABASE `{target_database}`;\
         CREATE TABLE `{source_database}`.`departments` (id INT PRIMARY KEY, name VARCHAR(32));\
         CREATE TABLE `{source_database}`.`employees` (\
             id INT PRIMARY KEY, name VARCHAR(32), dept_id INT, \
             CONSTRAINT `fk_emp_dept` FOREIGN KEY (dept_id) REFERENCES `departments`(id)\
         );\
         INSERT INTO `{source_database}`.`departments` VALUES (10, 'Engineering'), (20, 'Sales');\
         INSERT INTO `{source_database}`.`employees` VALUES (1, 'Alice', 10), (2, 'Bob', 20);\
         CREATE TABLE `{target_database}`.`departments` (id INT PRIMARY KEY, name VARCHAR(32));\
         CREATE TABLE `{target_database}`.`employees` (\
             id INT PRIMARY KEY, name VARCHAR(32), dept_id INT, \
             CONSTRAINT `fk_emp_dept` FOREIGN KEY (dept_id) REFERENCES `departments`(id)\
         );\
         INSERT INTO `{target_database}`.`departments` VALUES (99, 'Stale');\
         INSERT INTO `{target_database}`.`employees` VALUES (98, 'Obsolete', 99)"
    );
    mysql::execute_query(&setup_pool, &setup, true).await.unwrap();
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-parent-child-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), config);
    let source_pool_key = state.get_or_create_pool(&connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&connection_id, Some(&target_database)).await.unwrap();

    let request = TransferRequest {
        transfer_id: format!("live-mysql-parent-child-{suffix}"),
        source_connection_id: connection_id.clone(),
        source_database: source_database.clone(),
        source_schema: source_database.clone(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: target_database.clone(),
        target_schema: target_database.clone(),
        target_catalog: None,
        tables: vec!["departments".to_string(), "employees".to_string()],
        create_table: true,
        drop_target_before_create: true,
        drop_target_confirmed: true,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    let test_result = async {
        // The rename pre-pass must order by foreign key dependencies, children first.
        let known_fks = sort_tables_by_fk_dependency_with_foreign_keys(
            &state,
            &connection_id,
            &request.target_database,
            &request.target_schema,
            &request.tables,
            false, // parents_first = false → children-first order
        )
        .await?;
        let (tables_for_rename, fk_map) = known_fks;
        assert_eq!(
            tables_for_rename,
            vec!["employees", "departments"],
            "children-first order: child must be renamed before parent"
        );

        let backup_names = rename_tables_to_backup(
            &state,
            &request,
            &tables_for_rename,
            DatabaseType::Mysql,
            &target_pool_key,
            |_| {},
        )
        .await?;
        assert_eq!(backup_names.len(), 2, "both preexisting targets must be backed up");

        // Main pass: transfer both tables in parents-first order.
        let mut pending_fk_alters: Vec<(String, String)> = Vec::new();
        for (i, table) in request.tables.iter().enumerate() {
            transfer_table(
                &state,
                &request,
                table,
                i,
                &DatabaseType::Mysql,
                &DatabaseType::Mysql,
                &source_pool_key,
                &target_pool_key,
                &fk_map,
                &mut pending_fk_alters,
                Some(&backup_names),
                |_| {},
            )
            .await?;
        }

        // Stale rows replaced by source data.
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`departments` WHERE id=99")
            )
            .await,
            "0"
        );
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`employees` WHERE id=98")
            )
            .await,
            "0"
        );
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`departments` WHERE id IN (10,20)")
            )
            .await,
            "2"
        );
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`employees` WHERE id IN (1,2)")
            )
            .await,
            "2"
        );

        // Restore the foreign key: this is where the deferred `ADD CONSTRAINT fk_emp_dept` runs.
        for (table, alter_sql) in pending_fk_alters {
            if let Err(e) = execute_on_pool(&state, &target_pool_key, &alter_sql).await {
                return Err(format!("Failed to restore foreign key on table {}: {}", table, e));
            }
        }

        // Every original table must still be recoverable after the required FK restoration.
        for backup in backup_names.values() {
            assert_eq!(
                schema_count(
                    &setup_pool,
                    &format!("TABLES WHERE TABLE_SCHEMA = '{target_database}' AND TABLE_NAME = '{backup}'")
                )
                .await,
                "1"
            );
        }
        drop_backup_tables(&state, &request, DatabaseType::Mysql, &target_pool_key, &backup_names, &tables_for_rename)
            .await?;

        // Foreign key is back and enforces referential integrity.
        assert_eq!(
            schema_count(
                &setup_pool,
                &format!(
                    "KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = '{target_database}' \
                     AND TABLE_NAME = 'employees' AND CONSTRAINT_NAME = 'fk_emp_dept'"
                )
            )
            .await,
            "1",
            "foreign key constraint must be rebuilt"
        );

        Ok::<_, String>(())
    }
    .await;

    let cleanup = mysql::execute_query(
        &setup_pool,
        &format!("DROP DATABASE `{source_database}`; DROP DATABASE `{target_database}`"),
        true,
    )
    .await;
    setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
    cleanup.unwrap();
    test_result.unwrap();
}

/// Fix A verification: when `drop_target_before_create=true` and the target has incompatible
/// structure (extra columns not in source), the DROP-then-CREATE flow rebuilds the table to
/// match the source, replacing the incompatible structure. This is the MySQL counterpart to
/// `live_postgres_transfer_drop_target_rebuilds_structure_and_indexes`.
#[tokio::test]
#[ignore = "requires live MySQL connection via DBX_LIVE_MYSQL_TRANSFER_* env vars"]
async fn live_mysql_transfer_drop_target_rebuilds_incompatible_structure() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("mysql-drop-rebuild-{suffix}");
    let source_database = format!("dbx_drop_src_{}", &suffix[..12]);
    let target_database = format!("dbx_drop_tgt_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    // Source: products(id, name) with 1 row
    // Target: incompatible products(id, name, extra_col, another_col) with stale row
    let setup = format!(
        "CREATE DATABASE `{source_database}`;\
         CREATE DATABASE `{target_database}`;\
         CREATE TABLE `{source_database}`.`products` (id INT PRIMARY KEY, name VARCHAR(32));\
         INSERT INTO `{source_database}`.`products` VALUES (1, 'Widget');\
         CREATE TABLE `{target_database}`.`products` (\
             id INT PRIMARY KEY, name VARCHAR(32), extra_col VARCHAR(16), another_col INT\
         );\
         INSERT INTO `{target_database}`.`products` VALUES (99, 'Stale', 'obsolete', 42)"
    );
    mysql::execute_query(&setup_pool, &setup, true).await.unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-mysql-drop-rebuild-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), config);
    let source_pool_key = state.get_or_create_pool(&connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&connection_id, Some(&target_database)).await.unwrap();

    let request = TransferRequest {
        transfer_id: format!("drop-rebuild-{suffix}"),
        source_connection_id: connection_id.clone(),
        source_database: source_database.clone(),
        source_schema: source_database.clone(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: target_database.clone(),
        target_schema: target_database.clone(),
        target_catalog: None,
        tables: vec!["products".to_string()],
        create_table: true,
        drop_target_before_create: true,
        drop_target_confirmed: true,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    let test_result = async {
        // Rename pre-pass: backup the incompatible target table
        let backup_names =
            rename_tables_to_backup(&state, &request, &request.tables, DatabaseType::Mysql, &target_pool_key, |_| {})
                .await?;
        assert_eq!(backup_names.len(), 1, "preexisting target must be backed up");
        let backup_name = backup_names.get("products").unwrap();

        // Backup table exists with the old structure
        assert_eq!(
            schema_count(
                &setup_pool,
                &format!("TABLES WHERE TABLE_SCHEMA = '{target_database}' AND TABLE_NAME = '{backup_name}'")
            )
            .await,
            "1",
            "backup table must exist after rename"
        );
        assert_eq!(
            schema_count(
                &setup_pool,
                &format!(
                    "COLUMNS WHERE TABLE_SCHEMA = '{target_database}' \
                     AND TABLE_NAME = '{backup_name}' AND COLUMN_NAME = 'extra_col'"
                )
            )
            .await,
            "1",
            "backup retains old structure with extra_col"
        );

        // Main transfer: rebuilds table to match source (id, name only)
        transfer_table(
            &state,
            &request,
            "products",
            0,
            &DatabaseType::Mysql,
            &DatabaseType::Mysql,
            &source_pool_key,
            &target_pool_key,
            &std::collections::HashMap::new(),
            &mut Vec::new(),
            Some(&backup_names),
            |_| {},
        )
        .await?;

        // Rebuilt table matches source structure: only id, name
        assert_eq!(
            schema_count(
                &setup_pool,
                &format!(
                    "COLUMNS WHERE TABLE_SCHEMA = '{target_database}' \
                     AND TABLE_NAME = 'products'"
                )
            )
            .await,
            "2",
            "rebuilt table must have exactly 2 columns from source"
        );
        assert_eq!(
            schema_count(
                &setup_pool,
                &format!(
                    "COLUMNS WHERE TABLE_SCHEMA = '{target_database}' \
                     AND TABLE_NAME = 'products' AND COLUMN_NAME = 'extra_col'"
                )
            )
            .await,
            "0",
            "extra_col must be gone after rebuild"
        );
        assert_eq!(
            schema_count(
                &setup_pool,
                &format!(
                    "COLUMNS WHERE TABLE_SCHEMA = '{target_database}' \
                     AND TABLE_NAME = 'products' AND COLUMN_NAME = 'another_col'"
                )
            )
            .await,
            "0",
            "another_col must be gone after rebuild"
        );

        // Stale row replaced with source data
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`products` WHERE id=99")
            )
            .await,
            "0",
            "stale row must be gone"
        );
        assert_eq!(
            query_text(&setup_pool, &format!("SELECT name FROM `{target_database}`.`products` WHERE id=1")).await,
            "Widget",
            "source row must be present"
        );

        // Cleanup: drop backup
        drop_backup_tables(&state, &request, DatabaseType::Mysql, &target_pool_key, &backup_names, &request.tables)
            .await?;

        assert_eq!(
            schema_count(
                &setup_pool,
                &format!("TABLES WHERE TABLE_SCHEMA = '{target_database}' AND TABLE_NAME = '{backup_name}'")
            )
            .await,
            "0",
            "backup must be dropped after successful transfer"
        );

        Ok::<_, String>(())
    }
    .await;

    let cleanup = mysql::execute_query(
        &setup_pool,
        &format!("DROP DATABASE `{source_database}`; DROP DATABASE `{target_database}`"),
        true,
    )
    .await;
    setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
    cleanup.unwrap();
    test_result.unwrap();
}

/// Verifies external incoming foreign key rejection: when a table outside the transfer selection
/// references a table in the transfer, `drop_target_before_create` must be blocked because
/// dropping the referenced table would break the external constraint.
#[tokio::test]
#[ignore = "requires live MySQL connection via DBX_LIVE_MYSQL_TRANSFER_* env vars"]
async fn live_mysql_transfer_drop_target_rejects_external_incoming_fk() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("mysql-external-fk-{suffix}");
    let database = format!("dbx_ext_fk_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    // Table `categories` will be in the transfer; table `products` is OUTSIDE the transfer
    // and references `categories`. This external incoming FK must block drop_target.
    let setup = format!(
        "CREATE DATABASE `{database}`;\
         CREATE TABLE `{database}`.`categories` (id INT PRIMARY KEY, name VARCHAR(32));\
         CREATE TABLE `{database}`.`products` (\
             id INT PRIMARY KEY, name VARCHAR(32), category_id INT, \
             CONSTRAINT `fk_product_category` FOREIGN KEY (category_id) REFERENCES `categories`(id)\
         );\
         INSERT INTO `{database}`.`categories` VALUES (1, 'Electronics');\
         INSERT INTO `{database}`.`products` VALUES (100, 'Laptop', 1)"
    );
    mysql::execute_query(&setup_pool, &setup, true).await.unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-mysql-ext-fk-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), config);
    let pool_key = state.get_or_create_pool(&connection_id, Some(&database)).await.unwrap();

    let request = TransferRequest {
        transfer_id: format!("ext-fk-{suffix}"),
        source_connection_id: connection_id.clone(),
        source_database: database.clone(),
        source_schema: database.clone(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: database.clone(),
        target_schema: database.clone(),
        target_catalog: None,
        tables: vec!["categories".to_string()], // Only categories, not products
        create_table: true,
        drop_target_before_create: true,
        drop_target_confirmed: true,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    // Attempt rename pre-pass: should detect external incoming FK and reject
    let rename_result =
        rename_tables_to_backup(&state, &request, &request.tables, DatabaseType::Mysql, &pool_key, |_| {}).await;

    assert!(rename_result.is_err(), "rename must reject when external incoming FK exists");
    let error = rename_result.unwrap_err();
    assert!(
        error.contains("fk_product_category") || error.contains("products") || error.contains("incoming"),
        "error must mention external constraint or incoming FK, got: {error}"
    );

    // Original table unharmed
    assert_eq!(
        query_text(&setup_pool, &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{database}`.`categories`")).await,
        "1",
        "original table must survive the rejected rename"
    );

    mysql::execute_query(&setup_pool, &format!("DROP DATABASE `{database}`"), true).await.unwrap();
    setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}

/// A circular FK graph has no valid sequential DROP order. Rebuild must restore both new FKs
/// while every backup still exists, then safely remove only the backup graph.
#[tokio::test]
#[ignore = "requires live MySQL connection via DBX_LIVE_MYSQL_TRANSFER_* env vars"]
async fn live_mysql_transfer_drop_target_circular_foreign_keys() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("mysql-circular-fk-{suffix}");
    let source_database = format!("dbx_circ_src_{}", &suffix[..12]);
    let target_database = format!("dbx_circ_tgt_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    // Circular FK: users.group_id -> groups.id, groups.owner_id -> users.id
    let setup = format!(
        "CREATE DATABASE `{source_database}`;\
         CREATE DATABASE `{target_database}`;\
         CREATE TABLE `{source_database}`.`users` (id INT PRIMARY KEY, name VARCHAR(32), group_id INT);\
         CREATE TABLE `{source_database}`.`groups` (id INT PRIMARY KEY, name VARCHAR(32), owner_id INT);\
         ALTER TABLE `{source_database}`.`users` ADD CONSTRAINT `fk_user_group` \
             FOREIGN KEY (group_id) REFERENCES `groups`(id) ON UPDATE CASCADE ON DELETE RESTRICT;\
         ALTER TABLE `{source_database}`.`groups` ADD CONSTRAINT `fk_group_owner` \
             FOREIGN KEY (owner_id) REFERENCES `users`(id) ON UPDATE RESTRICT ON DELETE CASCADE;\
         INSERT INTO `{source_database}`.`users` VALUES (1, 'Alice', NULL);\
         INSERT INTO `{source_database}`.`groups` VALUES (10, 'Admins', 1);\
         UPDATE `{source_database}`.`users` SET group_id = 10 WHERE id = 1;\
         CREATE TABLE `{target_database}`.`users` (id INT PRIMARY KEY, name VARCHAR(32), group_id INT);\
         CREATE TABLE `{target_database}`.`groups` (id INT PRIMARY KEY, name VARCHAR(32), owner_id INT);\
         ALTER TABLE `{target_database}`.`users` ADD CONSTRAINT `fk_user_group` \
             FOREIGN KEY (group_id) REFERENCES `groups`(id) ON UPDATE CASCADE ON DELETE RESTRICT;\
         ALTER TABLE `{target_database}`.`groups` ADD CONSTRAINT `fk_group_owner` \
             FOREIGN KEY (owner_id) REFERENCES `users`(id) ON UPDATE RESTRICT ON DELETE CASCADE;\
         INSERT INTO `{target_database}`.`users` VALUES (99, 'Stale', NULL);\
         INSERT INTO `{target_database}`.`groups` VALUES (98, 'Obsolete', 99);\
         UPDATE `{target_database}`.`users` SET group_id = 98 WHERE id = 99"
    );
    mysql::execute_query(&setup_pool, &setup, true).await.unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-mysql-circular-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), config);
    let source_pool_key = state.get_or_create_pool(&connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&connection_id, Some(&target_database)).await.unwrap();

    let request = TransferRequest {
        transfer_id: format!("circular-{suffix}"),
        source_connection_id: connection_id.clone(),
        source_database: source_database.clone(),
        source_schema: source_database.clone(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: target_database.clone(),
        target_schema: target_database.clone(),
        target_catalog: None,
        tables: vec!["users".to_string(), "groups".to_string()],
        create_table: true,
        drop_target_before_create: true,
        drop_target_confirmed: true,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    let test_result = async {
        // Sorting alone cannot break a cycle; renaming must retain the backup relationships.
        let (tables_for_rename, fk_map) = sort_tables_by_fk_dependency_with_foreign_keys(
            &state,
            &connection_id,
            &request.target_database,
            &request.target_schema,
            &request.tables,
            false,
        )
        .await?;

        // Backup FKs must remain enforceable while their original names are freed for the new tables.
        let backup_names = rename_tables_to_backup(
            &state,
            &request,
            &tables_for_rename,
            DatabaseType::Mysql,
            &target_pool_key,
            |_| {},
        )
        .await?;
        assert_eq!(backup_names.len(), 2, "both tables must be backed up");

        for (table, referenced_table, update_rule, delete_rule) in [
            ("users", "groups", "CASCADE", "RESTRICT"),
            ("groups", "users", "RESTRICT", "CASCADE"),
        ] {
            let backup = &backup_names[table];
            let referenced_backup = &backup_names[referenced_table];
            assert_eq!(
                schema_count(
                    &setup_pool,
                    &format!(
                        "REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = '{target_database}' \
                         AND TABLE_NAME = '{backup}' AND REFERENCED_TABLE_NAME = '{referenced_backup}' \
                         AND UPDATE_RULE = '{update_rule}' AND DELETE_RULE = '{delete_rule}'"
                    )
                )
                .await,
                "1",
                "backup FK for {table} must preserve both its referenced backup and update/delete rules"
            );
        }

        // Main transfer
        let mut pending_fk_alters: Vec<(String, String)> = Vec::new();
        for (i, table) in request.tables.iter().enumerate() {
            transfer_table(
                &state,
                &request,
                table,
                i,
                &DatabaseType::Mysql,
                &DatabaseType::Mysql,
                &source_pool_key,
                &target_pool_key,
                &fk_map,
                &mut pending_fk_alters,
                Some(&backup_names),
                |_| {},
            )
            .await?;
        }

        // Data transferred correctly
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`users` WHERE id=1")
            )
            .await,
            "1"
        );
        assert_eq!(
            query_text(
                &setup_pool,
                &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`groups` WHERE id=10")
            )
            .await,
            "1"
        );

        // Required FK restoration precedes cleanup, so a restoration failure retains all originals.
        for (table, alter_sql) in pending_fk_alters {
            execute_on_pool(&state, &target_pool_key, &alter_sql)
                .await
                .map_err(|e| format!("Failed to restore FK on {table} while backups are retained: {e}"))?;
        }
        for (table, id, name) in [("users", 99, "Stale"), ("groups", 98, "Obsolete")] {
            let backup = &backup_names[table];
            assert_eq!(
                query_text(&setup_pool, &format!("SELECT name FROM `{target_database}`.`{backup}` WHERE id = {id}")).await,
                name,
                "original data must remain available after all new FKs are restored"
            );
        }
        for (table, referenced_table, constraint, update_rule, delete_rule) in [
            ("users", "groups", "fk_user_group", "CASCADE", "RESTRICT"),
            ("groups", "users", "fk_group_owner", "RESTRICT", "CASCADE"),
        ] {
            assert_eq!(
                schema_count(
                    &setup_pool,
                    &format!(
                        "REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = '{target_database}' \
                         AND TABLE_NAME = '{table}' AND REFERENCED_TABLE_NAME = '{referenced_table}' \
                         AND CONSTRAINT_NAME = '{constraint}' AND UPDATE_RULE = '{update_rule}' AND DELETE_RULE = '{delete_rule}'"
                    )
                )
                .await,
                "1",
                "new FK for {table} must point at the new table with its source rules before backups are dropped"
            );
        }

        // Cleanup must handle the backup-only cycle without affecting restored target constraints.
        drop_backup_tables(&state, &request, DatabaseType::Mysql, &target_pool_key, &backup_names, &tables_for_rename)
            .await?;

        // Both backups gone
        for table in &request.tables {
            let backup_name = backup_names.get(table).unwrap();
            assert_eq!(
                schema_count(
                    &setup_pool,
                    &format!("TABLES WHERE TABLE_SCHEMA = '{target_database}' AND TABLE_NAME = '{backup_name}'")
                )
                .await,
                "0",
                "backup {backup_name} must be dropped"
            );
        }

        // Circular FK constraints restored
        assert_eq!(
            schema_count(
                &setup_pool,
                &format!(
                    "KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = '{target_database}' \
                     AND CONSTRAINT_NAME IN ('fk_user_group', 'fk_group_owner')"
                )
            )
            .await,
            "2",
            "both FK constraints must be restored"
        );

        let invalid_insert = mysql::execute_query(
            &setup_pool,
            &format!("INSERT INTO `{target_database}`.`users` VALUES (7, 'invalid', 999)"),
            false,
        )
        .await
        .expect_err("restored FK must reject missing references after backup cleanup");
        assert!(invalid_insert.to_lowercase().contains("foreign key"), "{invalid_insert}");

        Ok::<_, String>(())
    }
    .await;

    let cleanup = mysql::execute_query(
        &setup_pool,
        &format!("DROP DATABASE `{source_database}`; DROP DATABASE `{target_database}`"),
        true,
    )
    .await;
    setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
    cleanup.unwrap();
    test_result.unwrap();
}

/// Verifies backup retention on transfer failure: when the main transfer fails after the rename
/// pre-pass, the backup tables must be retained so the user can recover. The backup is only
/// dropped when the transfer succeeds.
#[tokio::test]
#[ignore = "requires live MySQL connection via DBX_LIVE_MYSQL_TRANSFER_* env vars"]
async fn live_mysql_transfer_drop_target_retains_backup_on_failure() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("mysql-retain-backup-{suffix}");
    let source_database = format!("dbx_retain_src_{}", &suffix[..12]);
    let target_database = format!("dbx_retain_tgt_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    // Source: orders(id, name)
    // Target: orders(id, name) with a row that will survive the failed transfer
    let setup = format!(
        "CREATE DATABASE `{source_database}`;\
         CREATE DATABASE `{target_database}`;\
         CREATE TABLE `{source_database}`.`orders` (id INT PRIMARY KEY, name VARCHAR(32));\
         INSERT INTO `{source_database}`.`orders` VALUES (1, 'Alpha');\
         CREATE TABLE `{target_database}`.`orders` (id INT PRIMARY KEY, name VARCHAR(32));\
         INSERT INTO `{target_database}`.`orders` VALUES (99, 'Original')"
    );
    mysql::execute_query(&setup_pool, &setup, true).await.unwrap();

    let dir = std::env::temp_dir().join(format!("dbx-mysql-retain-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), config);
    let source_pool_key = state.get_or_create_pool(&connection_id, Some(&source_database)).await.unwrap();
    let target_pool_key = state.get_or_create_pool(&connection_id, Some(&target_database)).await.unwrap();

    let request = TransferRequest {
        transfer_id: format!("retain-{suffix}"),
        source_connection_id: connection_id.clone(),
        source_database: source_database.clone(),
        source_schema: source_database.clone(),
        source_catalog: None,
        target_connection_id: connection_id.clone(),
        target_database: target_database.clone(),
        target_schema: target_database.clone(),
        target_catalog: None,
        tables: vec!["orders".to_string()],
        create_table: true,
        drop_target_before_create: true,
        drop_target_confirmed: true,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 10,
    };

    // Rename pre-pass: backup created
    let backup_names =
        rename_tables_to_backup(&state, &request, &request.tables, DatabaseType::Mysql, &target_pool_key, |_| {})
            .await
            .unwrap();
    let backup_name = backup_names.get("orders").unwrap();

    // Backup exists with original row
    assert_eq!(
        schema_count(
            &setup_pool,
            &format!("TABLES WHERE TABLE_SCHEMA = '{target_database}' AND TABLE_NAME = '{backup_name}'")
        )
        .await,
        "1",
        "backup must exist after rename"
    );
    assert_eq!(
        query_text(
            &setup_pool,
            &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`{backup_name}` WHERE id=99")
        )
        .await,
        "1",
        "backup must contain original data"
    );

    // Simulate transfer failure: corrupt the source pool key to force an error
    let bad_pool_key = format!("{source_pool_key}_nonexistent");
    let transfer_result = transfer_table(
        &state,
        &request,
        "orders",
        0,
        &DatabaseType::Mysql,
        &DatabaseType::Mysql,
        &bad_pool_key, // Intentionally wrong to trigger failure
        &target_pool_key,
        &std::collections::HashMap::new(),
        &mut Vec::new(),
        Some(&backup_names),
        |_| {},
    )
    .await;

    assert!(transfer_result.is_err(), "transfer must fail with bad pool key");

    // Backup still exists after transfer failure (not auto-dropped)
    assert_eq!(
        schema_count(
            &setup_pool,
            &format!("TABLES WHERE TABLE_SCHEMA = '{target_database}' AND TABLE_NAME = '{backup_name}'")
        )
        .await,
        "1",
        "backup must survive transfer failure"
    );
    assert_eq!(
        query_text(&setup_pool, &format!("SELECT name FROM `{target_database}`.`{backup_name}` WHERE id=99")).await,
        "Original",
        "backup data must be intact for recovery"
    );

    // Rebuilt table exists (CREATE succeeded before transfer failed) but is empty
    assert_eq!(
        schema_count(
            &setup_pool,
            &format!("TABLES WHERE TABLE_SCHEMA = '{target_database}' AND TABLE_NAME = 'orders'")
        )
        .await,
        "1",
        "rebuilt table exists (CREATE succeeded)"
    );
    assert_eq!(
        query_text(&setup_pool, &format!("SELECT CAST(COUNT(*) AS CHAR) FROM `{target_database}`.`orders`")).await,
        "0",
        "rebuilt table is empty (transfer failed before data insert)"
    );

    // User can recover by renaming backup back: DROP orders, RENAME backup TO orders
    mysql::execute_query(
        &setup_pool,
        &format!(
            "DROP TABLE `{target_database}`.`orders`; \
                  RENAME TABLE `{target_database}`.`{backup_name}` TO `{target_database}`.`orders`"
        ),
        true,
    )
    .await
    .unwrap();

    assert_eq!(
        query_text(&setup_pool, &format!("SELECT name FROM `{target_database}`.`orders` WHERE id=99")).await,
        "Original",
        "user can recover original data from backup"
    );

    mysql::execute_query(
        &setup_pool,
        &format!("DROP DATABASE `{source_database}`; DROP DATABASE `{target_database}`"),
        true,
    )
    .await
    .unwrap();
    setup_pool.disconnect().await.unwrap();
    let _ = std::fs::remove_dir_all(dir);
}
