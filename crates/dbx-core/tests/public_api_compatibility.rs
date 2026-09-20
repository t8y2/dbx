use std::any::TypeId;

fn assert_same_type<Legacy: 'static, Extracted: 'static>() {
    assert_eq!(TypeId::of::<Legacy>(), TypeId::of::<Extracted>());
}

#[test]
fn extracted_crates_preserve_legacy_type_identity() {
    assert_same_type::<dbx_core::models::connection::ConnectionConfig, dbx_types::models::connection::ConnectionConfig>(
    );
    assert_same_type::<dbx_core::models::connection::DatabaseType, dbx_types::models::connection::DatabaseType>();
    assert_same_type::<dbx_core::types::QueryResult, dbx_types::types::QueryResult>();
    assert_same_type::<dbx_core::db::mysql::MySqlPool, dbx_drivers::db::mysql::MySqlPool>();
    assert_same_type::<dbx_core::db::agent_driver::AgentDriverClient, dbx_drivers::db::agent_driver::AgentDriverClient>(
    );
    assert_same_type::<dbx_core::schema_diff::SchemaDiffPreparation, dbx_sql::schema_diff::SchemaDiffPreparation>();
    assert_same_type::<
        dbx_core::table_structure_sql::TableStructureSqlOptions,
        dbx_sql::table_structure_sql::TableStructureSqlOptions,
    >();
    assert_same_type::<dbx_core::csv_export::CsvQuoteMode, dbx_formats::csv_export::CsvQuoteMode>();
    assert_same_type::<dbx_core::plugins::PluginManifest, dbx_plugin_runtime::plugins::PluginManifest>();
    assert_same_type::<dbx_core::ai::AiProvider, dbx_ai_provider::ai::AiProvider>();
    assert_same_type::<dbx_core::db::ssh_prompt::SshPromptRequest, dbx_platform::ssh_prompt::SshPromptRequest>();
    assert_same_type::<dbx_core::db::ssh_prompt::UserInputRequest, dbx_platform::ssh_prompt::UserInputRequest>();
}

#[test]
fn business_directories_preserve_legacy_namespaces() {
    assert_same_type::<dbx_core::storage::Storage, dbx_core::persistence::storage::Storage>();
    assert_same_type::<dbx_core::query_cancel::RunningTaskMetadata, dbx_core::query::query_cancel::RunningTaskMetadata>(
    );
}
