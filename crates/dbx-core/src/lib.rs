pub mod agent_catalog;
pub mod agent_connection;
pub mod agent_events;
pub mod agent_explain;
pub mod agent_kv;
pub mod agent_loop;
pub mod agent_manager;
pub mod agent_runtime;
pub mod agent_service;
pub mod agent_tools;
pub mod ai;
pub mod ai_cli_agent;
pub mod ai_codex_cli;
pub mod changelog;
pub mod cloud_sync;
pub mod connection;
pub mod connection_secrets;
pub mod csv_export;
pub mod data_compare;
pub mod data_grid_sql;
pub mod database_capabilities;
pub mod database_export;
pub mod database_search_sql;
pub mod db;
pub mod db_admin_sql;
pub mod document_ops;
pub mod driver_runtime;
pub mod external;
pub mod history;
pub mod jdbc;
pub mod models;
pub mod mongo_ops;
#[cfg(feature = "mq-admin")]
pub mod mq;
pub mod nacos;
pub mod object_source_sql;
pub mod path_utils;
pub mod plugins;
pub mod process;
pub mod production_safety;
pub mod query;
pub mod query_cancel;
pub mod query_execution_sql;
pub mod query_result_export;
pub mod query_result_sql;
pub mod redis_ops;
pub mod saved_sql;
pub mod schema;
pub mod schema_diff;
pub mod sql;
pub mod sql_analysis;
pub mod sql_dialect;
pub mod sql_editability;
pub mod sql_file_import;
pub mod sql_risk;
pub mod sqlite_backup;
pub(crate) mod sqlserver_temporal;
pub mod ssh_config;
pub mod storage;
pub mod table_export;
pub mod table_import;
pub mod table_structure_sql;
pub mod text_export;
pub mod token_usage;
pub mod transfer;
pub mod types;
pub mod update;
pub mod xlsx_export;

pub const R2_CDN_BASE: &str = "https://dl.dbxio.com/";
pub const GITHUB_RELEASE_DOWNLOAD_PREFIX: &str = "https://github.com/t8y2/dbx/releases/download/";
pub const CNB_RELEASE_DOWNLOAD_PREFIX: &str = "https://cnb.cool/dbxio.com/dbx/-/releases/download/";
pub const ATOMGIT_RELEASE_DOWNLOAD_PREFIX: &str = "https://atomgit.com/t8y2/dbx/releases/download/";

#[derive(Clone, Copy, Debug, Default, serde::Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum DownloadSource {
    #[default]
    Official,
    Cnb,
    Atomgit,
}

impl DownloadSource {
    pub fn download_candidate_urls(self, github_url: &str, r2_path: &str) -> Result<Vec<String>, String> {
        match self {
            Self::Official => Ok(download_candidate_urls(github_url, r2_path)),
            Self::Cnb => Ok(vec![
                rewrite_github_release_url(github_url, CNB_RELEASE_DOWNLOAD_PREFIX)?,
                format!("{R2_CDN_BASE}{r2_path}"),
            ]),
            Self::Atomgit => Ok(vec![
                rewrite_github_release_url(github_url, ATOMGIT_RELEASE_DOWNLOAD_PREFIX)?,
                format!("{R2_CDN_BASE}{r2_path}"),
            ]),
        }
    }
}

fn rewrite_github_release_url(url: &str, target_prefix: &str) -> Result<String, String> {
    if url.starts_with(target_prefix) {
        return Ok(url.to_string());
    }
    url.strip_prefix(GITHUB_RELEASE_DOWNLOAD_PREFIX)
        .map(|path| format!("{target_prefix}{path}"))
        .ok_or_else(|| format!("Unsupported DBX release download URL: {url}"))
}

pub fn download_candidate_urls(github_url: &str, r2_path: &str) -> Vec<String> {
    vec![format!("{R2_CDN_BASE}{r2_path}"), github_url.to_string()]
}

use std::pin::Pin;

type ResponseFuture = Pin<Box<dyn std::future::Future<Output = Result<reqwest::Response, String>> + Send>>;

pub async fn race_download(
    client: &reqwest::Client,
    github_url: &str,
    r2_path: &str,
    user_agent: &str,
) -> Result<reqwest::Response, String> {
    use futures::future::select_ok;

    let urls = download_candidate_urls(github_url, r2_path);
    let mut futs: Vec<ResponseFuture> = Vec::with_capacity(urls.len());

    for url in urls {
        let client = client.clone();
        let ua = user_agent.to_string();
        futs.push(Box::pin(async move {
            client
                .get(&url)
                .header(reqwest::header::USER_AGENT, ua)
                .header(reqwest::header::ACCEPT_ENCODING, "identity")
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| format!("{e}"))
        }) as ResponseFuture);
    }

    match select_ok(futs).await {
        Ok((resp, _)) => Ok(resp),
        Err(last_err) => Err(last_err),
    }
}

#[cfg(test)]
mod tests {
    use super::{download_candidate_urls, DownloadSource};

    #[test]
    fn download_candidates_exclude_third_party_github_proxy() {
        let urls = download_candidate_urls(
            "https://github.com/t8y2/dbx/releases/latest/download/latest.json",
            "releases/latest/latest.json",
        );

        assert_eq!(
            urls,
            vec![
                "https://dl.dbxio.com/releases/latest/latest.json",
                "https://github.com/t8y2/dbx/releases/latest/download/latest.json",
            ]
        );
    }

    #[test]
    fn mirror_download_candidates_rewrite_release_urls() {
        let github_url = "https://github.com/t8y2/dbx/releases/download/agents-latest/agent-registry.json";
        assert_eq!(
            DownloadSource::Cnb.download_candidate_urls(github_url, "agents/agent-registry.json").unwrap(),
            vec![
                "https://cnb.cool/dbxio.com/dbx/-/releases/download/agents-latest/agent-registry.json",
                "https://dl.dbxio.com/agents/agent-registry.json",
            ]
        );
        assert_eq!(
            DownloadSource::Atomgit.download_candidate_urls(github_url, "agents/agent-registry.json").unwrap(),
            vec![
                "https://atomgit.com/t8y2/dbx/releases/download/agents-latest/agent-registry.json",
                "https://dl.dbxio.com/agents/agent-registry.json",
            ]
        );
    }
}
