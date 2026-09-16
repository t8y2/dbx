use dbx_core::plugins::{
    PluginMarketplace, PluginMarketplaceInstallRequest, PluginSignatureStatus, OFFICIAL_PLUGIN_REPOSITORY_ID,
};

const APP_VERSION: &str = "0.5.68";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("plugin marketplace smoke failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let store = tempfile::tempdir().map_err(|error| error.to_string())?;
    let marketplace = PluginMarketplace::new(store.path().to_path_buf(), APP_VERSION)?;
    let results = marketplace.fetch_catalogs().await;
    let official = results
        .iter()
        .find(|result| result.repository.id == OFFICIAL_PLUGIN_REPOSITORY_ID)
        .ok_or("Official DBX Marketplace result is missing")?;
    if let Some(error) = &official.error {
        return Err(error.clone());
    }
    let catalog = official.catalog.as_ref().ok_or("Official DBX Marketplace catalog is missing")?;
    let mut arguments = std::env::args().skip(1);
    let Some(plugin_id) = arguments.next() else {
        println!("plugin marketplace smoke passed: fetched {} official catalog entries", catalog.plugins.len());
        return Ok(());
    };
    let version = arguments.next();
    if arguments.next().is_some() {
        return Err("Usage: plugin_marketplace_smoke [plugin-id] [version]".to_string());
    }
    if !catalog.plugins.iter().any(|plugin| plugin.id == plugin_id) {
        return Err(format!("Official DBX Marketplace does not list '{plugin_id}'"));
    }
    let installed = marketplace
        .install(PluginMarketplaceInstallRequest {
            repository_id: OFFICIAL_PLUGIN_REPOSITORY_ID.to_string(),
            plugin_id: plugin_id.clone(),
            version,
        })
        .await?;
    if installed.plugin.manifest.id != plugin_id {
        return Err(format!("Expected plugin '{plugin_id}', got '{}'", installed.plugin.manifest.id));
    }
    match installed.signature {
        PluginSignatureStatus::Trusted { key_id } => {
            println!("plugin marketplace smoke passed: catalog -> release download -> sha256 -> signature {key_id} -> install");
        }
        signature => return Err(format!("Unexpected marketplace signature status: {signature:?}")),
    }
    Ok(())
}
