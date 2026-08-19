//! 整库 SQL 导出的端到端回归测试（元数据并发预取后输出必须与逐表查询一致）。
//! 需要本机 Docker；不可用时自动跳过。

mod support;

use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::storage::Storage;
use support::{postgres_test_config, psql, start_docker_postgres};

#[test]
fn database_export_writes_structure_and_data_for_all_tables() {
    let handle = std::thread::Builder::new()
        .name("database-export-prefetch".to_string())
        .stack_size(8 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build database export prefetch test runtime")
                .block_on(run_database_export_writes_structure_and_data_for_all_tables());
        })
        .expect("spawn database export prefetch test thread");
    if let Err(panic) = handle.join() {
        std::panic::resume_unwind(panic);
    }
}

async fn run_database_export_writes_structure_and_data_for_all_tables() {
    let Some(container) = start_docker_postgres("dbx-export-prefetch") else {
        return;
    };

    psql(
        &container,
        "CREATE TABLE parent (id INT PRIMARY KEY, label TEXT NOT NULL);\
         CREATE TABLE child (id INT PRIMARY KEY, parent_id INT REFERENCES parent(id), note TEXT);\
         CREATE TABLE standalone_a (id INT PRIMARY KEY, payload JSONB);\
         CREATE TABLE standalone_b (id INT PRIMARY KEY, created_at TIMESTAMPTZ);\
         CREATE TABLE empty_table (id INT PRIMARY KEY);\
         INSERT INTO parent VALUES (1, 'alpha'), (2, 'beta');\
         INSERT INTO child VALUES (10, 1, 'first-child'), (11, 2, NULL);\
         INSERT INTO standalone_a VALUES (100, '{\"k\": \"v\"}');\
         INSERT INTO standalone_b VALUES (200, '2024-05-06T07:08:09Z');",
    );

    let dir = std::env::temp_dir().join(format!("dbx-export-prefetch-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);

    let connection_id = "export-prefetch-conn";
    state.configs.write().await.insert(connection_id.to_string(), postgres_test_config(connection_id, container.port));

    let file_path = dir.join("export.sql");
    let request = DatabaseExportRequest {
        export_id: format!("export-prefetch-{}", uuid::Uuid::new_v4()),
        connection_id: connection_id.to_string(),
        database: "postgres".to_string(),
        schema: "public".to_string(),
        file_path: file_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: false,
        include_create_database: false,
        drop_table_if_exists: true,
        omit_auto_increment: false,
        fail_on_error: true,
        snapshot_session_id: None,
        batch_size: 1000,
    };

    export_database_sql_core(&state, &request, |_progress| {}).await.expect("export should succeed");

    let exported = std::fs::read_to_string(&file_path).expect("read exported file");

    for table in ["parent", "child", "standalone_a", "standalone_b", "empty_table"] {
        assert!(
            exported.contains(&format!("CREATE TABLE \"public\".\"{table}\"")),
            "exported SQL should contain CREATE TABLE for {table}:\n{exported}"
        );
    }
    assert!(!exported.contains("-- ERROR"), "exported SQL should not contain errors:\n{exported}");

    for expected in ["'alpha'", "'beta'", "'first-child'", "\"k\"", "2024-05-06"] {
        assert!(exported.contains(expected), "exported SQL should contain literal {expected}:\n{exported}");
    }

    // 依赖排序：被引用的 parent 必须先于 child 建表
    let parent_pos = exported.find("CREATE TABLE \"public\".\"parent\"").unwrap();
    let child_pos = exported.find("CREATE TABLE \"public\".\"child\"").unwrap();
    assert!(parent_pos < child_pos, "parent table DDL should precede child table DDL");

    // 空表只导结构不导数据
    assert!(
        !exported.contains("INSERT INTO \"public\".\"empty_table\""),
        "empty table should not produce INSERT statements"
    );
}
