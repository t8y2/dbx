use std::future::Future;
use std::thread;

pub mod agents;
pub mod ai;
pub mod app_settings;
pub mod cloud_sync;
pub mod connection;
#[allow(dead_code, unused_imports)]
mod connection_secrets;
pub mod csv_export;
pub mod data_compare;
pub mod database_export;
pub mod deep_link;
pub mod etcd_cmd;
pub mod external_db;
pub mod external_sql;
pub mod history;
pub mod kafka_cmd;
pub mod keychain;
pub mod mcp;
pub mod mcp_bridge;
pub mod mongo_cmd;
pub mod plugins;
pub mod query;
pub mod query_cancel;
pub mod redis_cmd;
pub mod saved_sql;
pub mod schema;
pub mod schema_cache;
pub mod schema_diff;
pub mod sql_file;
pub mod system_fonts;
pub mod tab_runtime_cache;
pub mod table_export;
pub mod table_import;
pub mod text_export;
pub mod transfer;
pub mod update;
pub mod xlsx_export;

pub(crate) fn spawn_local_async<F, Fut>(name: &'static str, future_factory: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = ()> + 'static,
{
    thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
            Ok(runtime) => runtime,
            Err(e) => {
                log::error!("Failed to start {name} runtime: {e}");
                return;
            }
        };

        runtime.block_on(future_factory());
    });
}
