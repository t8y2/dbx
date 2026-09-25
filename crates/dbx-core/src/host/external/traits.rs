use async_trait::async_trait;

use super::types::{ExternalCapabilities, ExternalColumnDef, ExternalTableRef, ExternalTableSnapshot};

/// Trait for external tabular data sources.
#[async_trait]
pub trait ExternalTabularSource: Send + Sync + std::fmt::Debug {
    fn capabilities(&self) -> ExternalCapabilities;

    async fn list_tables(&self) -> Result<Vec<ExternalTableRef>, String>;

    async fn get_columns(&self, table: &ExternalTableRef) -> Result<Vec<ExternalColumnDef>, String>;

    async fn load_table(&self, table: &ExternalTableRef) -> Result<ExternalTableSnapshot, String>;

    async fn source_version(&self, table: &ExternalTableRef) -> Result<String, String>;

    async fn test_connection(&self) -> Result<String, String>;

    fn display_name(&self) -> String;
}
