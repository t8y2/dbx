//! Opt-in regression. Only newly generated fixture tables are created/dropped.
//! Supply disposable native connection JSON and an installed agent directory;
//! no endpoint, account, or password belongs in this source file.

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::table_import::{import_table_file_core, TableImportRequest};
use dbx_core::transfer::{
    execute_on_pool, execute_read_on_pool, quote_string_literal, transfer_table, TransferRequest,
};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

fn config(variable: &str, id: &str) -> ConnectionConfig {
    let mut value: Value = serde_json::from_str(&std::env::var(variable).expect(variable)).expect("connection JSON");
    value["id"] = json!(id);
    value["name"] = json!(id);
    let config: ConnectionConfig = serde_json::from_value(value).expect("connection configuration");
    assert_eq!(config.db_type, DatabaseType::Xugu);
    config
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[tokio::test]
#[ignore = "requires disposable Xugu source/target configs, schemas and native agent directory"]
async fn live_xugu_text_transfer_retains_exact_escapes_across_pages_and_modes() {
    let source = config("DBX_LIVE_XUGU_TEXT_SOURCE_CONFIG", "xugu-text-source");
    let target = config("DBX_LIVE_XUGU_TEXT_TARGET_CONFIG", "xugu-text-target");
    let source_schema = std::env::var("DBX_LIVE_XUGU_TEXT_SOURCE_SCHEMA").expect("source schema");
    let target_schema = std::env::var("DBX_LIVE_XUGU_TEXT_TARGET_SCHEMA").expect("target schema");
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        PathBuf::from(std::env::var("DBX_LIVE_XUGU_TEXT_AGENT_DIR").expect("agent directory")),
        env!("CARGO_PKG_VERSION"),
    ));
    for cfg in [&source, &target] {
        state.configs.write().await.insert(cfg.id.clone(), cfg.clone());
    }
    let src_pool = state.get_or_create_pool(&source.id, source.database.as_deref()).await.unwrap();
    let dst_pool = state.get_or_create_pool(&target.id, target.database.as_deref()).await.unwrap();
    let table = format!("DBX_TEXT_{}", uuid::Uuid::new_v4().simple().to_string()[..8].to_uppercase());
    let src = format!("{}.{}", quote(&source_schema), quote(&table));
    let dst = format!("{}.{}", quote(&target_schema), quote(&table));
    let same_database_dst = format!("{}.{}", quote(&target_schema), quote(&table));
    let snapshot = |name: &str| {
        format!(
        "SELECT ID,V,L,CAST(J AS CLOB),B,CASE WHEN L IS NULL THEN 'NULL' WHEN LENGTH(L)=0 THEN 'EMPTY' ELSE 'VALUE' END FROM {name} ORDER BY ID"
    )
    };
    let checks: Result<(), String> = async {
        execute_on_pool(&state, &src_pool, &format!("CREATE TABLE {src} (ID INT PRIMARY KEY,V VARCHAR(500),L CLOB,J JSON,B BLOB)")).await?;
        let document = r#"{"path":"C:\\tmp\\o'clock","quoted":"\"value\"","line":"a\nb","unicode":"\u4e2d","items":[1,null,true]}"#;
        let texts = [
            "hello\\world!".to_string(),
            "中文\\path\\o'clock\\\nactual\ttab\r\nnext".to_string(),
            "large\\'\"中文\n".repeat(20_000),
            String::new(),
            "unused: SQL NULL row".to_string(),
            r"literal\n\r\t\u4e2d\\end\".to_string(),
        ];
        for id in 1..=1007 {
            let text = texts.get(id - 1).cloned().unwrap_or_else(|| format!("row-{id}\\path\\'中文"));
            let v = if id == 3 { "large payload" } else { &text };
            let values = if id == 5 { "NULL,NULL,NULL,NULL".to_string() } else {
                format!("{},{},{},HEXTORAW('005C27FF')", quote_string_literal(v), quote_string_literal(&text), quote_string_literal(document))
            };
            execute_on_pool(&state, &src_pool, &format!("INSERT INTO {src} VALUES ({id},{values})")).await?;
        }
        let expected = execute_read_on_pool(&state, &src_pool, &snapshot(&src)).await?.rows;
        if expected.len() != 1007 || expected[0][2].as_str() != Some("hello\\world!") {
            return Err("Source fixture did not retain the independently supplied text".into());
        }
        let mut request: TransferRequest = serde_json::from_value(json!({
            "transferId":uuid::Uuid::new_v4().to_string(),
            "sourceConnectionId":source.id,"sourceDatabase":source.database,"sourceSchema":source_schema,
            "targetConnectionId":target.id,"targetDatabase":target.database,"targetSchema":target_schema,
            "tables":[table],"createTable":true,"content":"structureAndData","objects":[],"mode":"append",
            "targetTableNameCase":"preserve","targetColumnNameCase":"preserve","quoteTargetColumnNames":true,
            "ownershipPolicy":"preserve","batchSize":100
        })).unwrap();
        let same_endpoint = source.host == target.host && source.port == target.port;
        for same_connection in if same_endpoint { vec![false, true] } else { vec![false] } {
            if same_connection {
                request.target_connection_id = source.id.clone();
                request.mode = dbx_core::transfer::TransferMode::Overwrite;
                request.create_table = false;
                request.content = dbx_core::transfer::TransferContent::DataOnly;
            }
            let target_key = state.get_or_create_pool(&request.target_connection_id, target.database.as_deref()).await?;
            let moved = transfer_table(&state, &request, &table, 0, &DatabaseType::Xugu, &DatabaseType::Xugu,
                &src_pool, &target_key, &HashMap::new(), &mut Vec::new(), None, |_| {}).await?;
            if moved != 1007 || execute_read_on_pool(&state, &dst_pool, &snapshot(&dst)).await?.rows != expected {
                return Err(format!("Exact value comparison failed (same_connection={same_connection})"));
            }
        }
        // A duplicate append must fail without altering the existing rows.
        request.target_connection_id = target.id.clone();
        request.mode = dbx_core::transfer::TransferMode::Append;
        let error = transfer_table(&state, &request, &table, 0, &DatabaseType::Xugu, &DatabaseType::Xugu,
            &src_pool, &dst_pool, &HashMap::new(), &mut Vec::new(), None, |_| {}).await;
        if error.is_ok() || execute_read_on_pool(&state, &dst_pool, &snapshot(&dst)).await?.rows != expected {
            return Err("Duplicate append did not preserve target contents".into());
        }
        // One native Agent session cannot keep a cursor open while writing.
        // Exercise its LIMIT/OFFSET path using two schemas in the same DB.
        if same_endpoint && source.database != target.database && source_schema != target_schema {
            let mut same_database_request = request.clone();
            same_database_request.target_connection_id = source.id.clone();
            same_database_request.target_database = source.database.clone().unwrap();
            same_database_request.create_table = true;
            same_database_request.content = dbx_core::transfer::TransferContent::StructureAndData;
            let result = transfer_table(&state, &same_database_request, &table, 0,
                &DatabaseType::Xugu, &DatabaseType::Xugu, &src_pool, &src_pool,
                &HashMap::new(), &mut Vec::new(), None, |_| {}).await;
            let rows = execute_read_on_pool(&state, &src_pool, &snapshot(&same_database_dst)).await;
            execute_on_pool(&state, &src_pool, &format!("DROP TABLE IF EXISTS {same_database_dst}")).await?;
            if result? != 1007 || rows?.rows != expected {
                return Err("Same-session paginated transfer changed source values".into());
            }
        }
        // Exercise the public JSON-file import path, which shares the literal
        // encoder with transfer. Leave BLOB NULL and compare every text value.
        let file = dir.path().join("escaped-text.json");
        let imported_rows = expected.iter().map(|row| json!({
            "ID":row[0],"V":row[1],"L":if row[5]==json!("EMPTY") {json!("")} else {row[2].clone()},"J":row[3]
        })).collect::<Vec<_>>();
        std::fs::write(&file, serde_json::to_vec(&imported_rows).unwrap()).unwrap();
        let import: TableImportRequest = serde_json::from_value(json!({
            "importId":uuid::Uuid::new_v4().to_string(),"connectionId":target.id,
            "database":target.database,"schema":target_schema,"table":table,
            "filePath":file.to_string_lossy(),"sourceFormat":"json","mode":"truncate","createTable":false,"batchSize":37,
            "mappings":[{"sourceColumn":"ID","targetColumn":"ID"},{"sourceColumn":"V","targetColumn":"V"},
                {"sourceColumn":"L","targetColumn":"L"},{"sourceColumn":"J","targetColumn":"J"}]
        })).unwrap();
        let summary = import_table_file_core(&state, &import, &DatabaseType::Xugu, &dst_pool,
            |_| Box::pin(async {false}), |_| {}).await?;
        let after_import = execute_read_on_pool(&state, &dst_pool, &snapshot(&dst)).await?.rows;
        if summary.rows_imported != 1007 || summary.rows_failed != 0 || after_import.len() != expected.len()
            || after_import.iter().zip(&expected).any(|(actual, original)| actual[..4] != original[..4] || actual[5] != original[5]) {
            return Err("JSON-file import did not preserve all source text values".into());
        }
        Ok(())
    }.await;
    for (pool, name) in [(&src_pool, &src), (&dst_pool, &dst)] {
        execute_on_pool(&state, pool, &format!("DROP TABLE IF EXISTS {name}")).await.expect("fixture cleanup");
    }
    checks.expect("Xugu text round trip");
}
