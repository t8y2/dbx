use dbx_core::connection::AppState;
use dbx_core::db::mysql;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;
use dbx_core::transfer::{
    transfer_table, TransferContent, TransferMode, TransferOwnershipPolicy, TransferRequest, TransferTableNameCase,
};
use serde_json::json;
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
        content: TransferContent::default(),
        objects: Vec::new(),
        mode,
        target_table_name_case: TransferTableNameCase::Preserve,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 2,
    }
}

async fn query_text(pool: &mysql::MySqlPool, sql: &str) -> String {
    mysql::execute_query(pool, sql, false).await.unwrap().rows[0][0].as_str().unwrap().to_string()
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
    let state = AppState::new(storage);
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
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
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
            content: TransferContent::default(),
            objects: Vec::new(),
            mode: TransferMode::Append,
            target_table_name_case: TransferTableNameCase::Preserve,
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
    let state = AppState::new(storage);
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
