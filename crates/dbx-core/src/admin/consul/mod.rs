mod acl;
mod agent;
mod archive;
mod blocking;
mod bulk;
mod capabilities;
mod catalog;
mod client;
mod config;
mod enterprise;
mod health;
mod kv;
pub mod mesh;
mod operator;
mod response;
mod search;
mod session;
mod status;
#[cfg(test)]
mod test_support;
mod tools;
mod txn;
mod types;

pub use acl::*;
pub use agent::*;
pub use archive::{
    consul_export_bundle_core, consul_import_execute_core, consul_import_preview_core, ConsulBundleEntry,
    ConsulBundleScope, ConsulExportRequest, ConsulExportScopeKind, ConsulImportConflictPolicy, ConsulImportOperation,
    ConsulImportOutcome, ConsulImportPreview, ConsulImportPreviewRow, ConsulImportReport, ConsulImportRequest,
    ConsulImportResultItem, ConsulKvBundle,
};
pub use blocking::{
    consul_blocking_query_core, consul_cancel_blocking_core, consul_domain_watch_core, ConsulBlockingRequest,
    ConsulBlockingResponse, ConsulDomainWatchItems, ConsulDomainWatchRequest, ConsulDomainWatchResponse,
    ConsulDomainWatchTarget,
};
pub use bulk::{
    consul_delete_prefix_execute_core, consul_delete_prefix_preview_core, ConsulDeleteCandidate, ConsulDeleteOutcome,
    ConsulDeletePrefixPreview, ConsulDeletePrefixReport, ConsulDeletePrefixRequest, ConsulDeleteResultItem,
};
pub use capabilities::{consul_capabilities_core, ConsulCapabilities, ConsulCapabilityStatus};
pub use catalog::*;
pub use client::ConsulClient;
pub use config::{ConsulAgentTarget, ConsulConfig, ConsulConsistency, ConsulScope};
pub use enterprise::*;
pub use health::*;
pub use kv::{
    consul_acquire_lock_core, consul_delete_core, consul_get_core, consul_list_prefix_core, consul_list_recursive_core,
    consul_put_core, consul_release_lock_core, ConsulKvRecord, ConsulLockRequest, ConsulLockResponse,
    ConsulRecursiveListResponse, MAX_RECURSIVE_ENTRIES, MAX_RECURSIVE_VALUE_BYTES,
};
pub use operator::*;
pub use response::ConsulResponseMetadata;
pub use search::{
    consul_cancel_search_core, consul_search_core, consul_search_progress_core, ConsulSearchMatch,
    ConsulSearchProgress, ConsulSearchRequest, ConsulSearchResponse,
};
pub use session::*;
pub use status::*;
pub use tools::*;
pub use txn::{
    consul_rename_key_core, consul_txn_core, ConsulTxnError, ConsulTxnKvOperation, ConsulTxnKvResult, ConsulTxnRequest,
    ConsulTxnResult, ConsulTxnVerb, MAX_TXN_OPERATIONS,
};

async fn ensure_writable(state: &crate::connection::AppState, connection_id: &str, action: &str) -> Result<(), String> {
    if let Some(name) = crate::query::connection_readonly_name(state, connection_id).await {
        return Err(format!(
            "CONSUL_READ_ONLY: connection '{name}' has read-only protection enabled. {action} blocked."
        ));
    }
    Ok(())
}

#[cfg(test)]
mod contract_tests {
    #[test]
    fn low_level_mutations_are_not_public_outside_the_consul_module() {
        let modules = [
            (include_str!("kv.rs"), &["acquire_lock", "release_lock", "put_key", "delete_key"] as &[&str]),
            (include_str!("txn.rs"), &["txn"] as &[&str]),
            (
                include_str!("agent.rs"),
                &[
                    "register_agent_service",
                    "deregister_agent_service",
                    "set_agent_service_maintenance",
                    "register_agent_check",
                    "deregister_agent_check",
                    "update_ttl_check",
                ] as &[&str],
            ),
            (include_str!("session.rs"), &["create_session", "renew_session", "destroy_session"] as &[&str]),
        ];

        for (source, methods) in modules {
            for method in methods {
                assert!(
                    source.contains(&format!("pub(super) async fn {method}")),
                    "{method} must remain module-private so callers cannot bypass Core read-only checks"
                );
                assert!(!source.contains(&format!("pub async fn {method}")), "{method} must not be publicly callable");
            }
        }
    }
}
