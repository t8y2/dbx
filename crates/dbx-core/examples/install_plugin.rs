//! One-shot plugin installer for local DBX app stores:
//!   cargo run -p dbx-core --example install_plugin -- <plugins-root> <dbxp> <app-version> [--rollback-plugin <id>]
use dbx_core::plugins::{PluginInstallPolicy, PluginPackageInstaller};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: install_plugin <plugins-root> <package.dbxp> <app-version>");
        std::process::exit(2);
    }
    let installer = PluginPackageInstaller::new(std::path::PathBuf::from(&args[0]), &args[2]).expect("installer");
    match installer.install_file(std::path::Path::new(&args[1]), PluginInstallPolicy::LocalDevelopment) {
        Ok(result) => {
            let response = result.response();
            println!(
                "installed {} v{} (previous: {:?}, signature: {:?}, sha256: {})",
                response.plugin.manifest.id,
                response.plugin.manifest.version,
                response.previous_version,
                response.signature,
                response.package_sha256
            );
        }
        Err(error) => {
            eprintln!("install failed: {error}");
            std::process::exit(1);
        }
    }
}
