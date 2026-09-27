use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::{InstalledPlugin, PluginRegistry};

const MAX_PLUGIN_UI_ASSET_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct PluginUiAsset {
    pub content_type: String,
    pub bytes: Vec<u8>,
    pub etag: String,
}

impl PluginRegistry {
    pub fn read_asset(&self, plugin_id: &str, relative_path: &str) -> Result<PluginUiAsset, String> {
        let plugin = self.find_plugin(plugin_id)?.ok_or_else(|| format!("Plugin '{plugin_id}' is not installed"))?;
        let relative = validate_asset_path(relative_path)?;
        let path = plugin.path.join(relative);
        read_asset_file(plugin_id, &plugin.path, &path)
    }

    pub fn read_ui_entry(&self, plugin_id: &str) -> Result<PluginUiAsset, String> {
        let plugin = self.compatible_ui_plugin(plugin_id)?;
        let entry = plugin
            .compatibility
            .ui_entry
            .as_ref()
            .ok_or_else(|| format!("Plugin '{plugin_id}' does not provide a UI entrypoint"))?;
        let root = plugin
            .compatibility
            .ui_root
            .as_ref()
            .ok_or_else(|| format!("Plugin '{plugin_id}' does not provide a UI root"))?;
        read_asset_file(plugin_id, root, entry)
    }

    pub fn read_ui_asset(&self, plugin_id: &str, relative_path: &str) -> Result<PluginUiAsset, String> {
        let plugin = self.compatible_ui_plugin(plugin_id)?;
        let root = plugin
            .compatibility
            .ui_root
            .as_ref()
            .ok_or_else(|| format!("Plugin '{plugin_id}' does not provide a UI root"))?;
        let relative = validate_asset_path(relative_path)?;
        let path = root.join(relative);
        read_asset_file(plugin_id, root, &path)
    }

    fn compatible_ui_plugin(&self, plugin_id: &str) -> Result<InstalledPlugin, String> {
        let plugin = self.find_plugin(plugin_id)?.ok_or_else(|| format!("Plugin '{plugin_id}' is not installed"))?;
        if !plugin.compatibility.compatible {
            return Err(format!("Plugin '{plugin_id}' is incompatible: {}", plugin.compatibility.errors.join("; ")));
        }
        if plugin.manifest.entrypoints.ui.is_none() {
            return Err(format!("Plugin '{plugin_id}' does not provide a UI entrypoint"));
        }
        Ok(plugin)
    }
}

fn read_asset_file(plugin_id: &str, root: &Path, path: &Path) -> Result<PluginUiAsset, String> {
    let canonical_root = std::fs::canonicalize(root)
        .map_err(|error| format!("Failed to resolve plugin asset root {}: {error}", root.display()))?;
    let canonical_path = std::fs::canonicalize(path)
        .map_err(|error| format!("Plugin UI asset does not exist {}: {error}", path.display()))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(format!("Plugin asset escapes plugin '{plugin_id}': {}", path.display()));
    }
    let metadata = std::fs::metadata(&canonical_path).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err(format!("Plugin UI asset is not a file: {}", canonical_path.display()));
    }
    if metadata.len() > MAX_PLUGIN_UI_ASSET_BYTES {
        return Err(format!("Plugin UI asset exceeds {MAX_PLUGIN_UI_ASSET_BYTES} bytes"));
    }
    let bytes = std::fs::read(&canonical_path).map_err(|error| error.to_string())?;
    let etag = format!("\"{}\"", hex_digest(Sha256::digest(&bytes)));
    Ok(PluginUiAsset { content_type: content_type(&canonical_path).to_string(), bytes, etag })
}

fn validate_asset_path(relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("Plugin UI asset path must be a non-empty relative path".to_string());
    }
    if path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(format!("Plugin UI asset path is unsafe: {relative_path}"));
    }
    Ok(path.to_path_buf())
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    use std::fmt::Write as _;

    bytes.as_ref().iter().fold(String::with_capacity(64), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

#[cfg(test)]
mod tests {
    use super::PluginRegistry;

    #[test]
    fn serves_assets_inside_declared_ui_root() {
        let root = tempfile::tempdir().unwrap();
        let plugin_dir = root.path().join("sample");
        std::fs::create_dir_all(plugin_dir.join("ui")).unwrap();
        std::fs::write(plugin_dir.join("ui/index.html"), "<h1>Hello</h1>").unwrap();
        std::fs::write(plugin_dir.join("ui/app.js"), "console.log('hello')").unwrap();
        std::fs::write(
            plugin_dir.join("manifest.json"),
            serde_json::json!({
                "manifest_version": 1,
                "id": "sample",
                "name": "Sample",
                "version": "1.0.0",
                "publisher": "dbx",
                "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
                "entrypoints": { "ui": { "root": "ui", "entry": "ui/index.html" } }
            })
            .to_string(),
        )
        .unwrap();
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");

        let entry = registry.read_ui_entry("sample").unwrap();
        assert_eq!(entry.content_type, "text/html; charset=utf-8");
        assert_eq!(entry.bytes, b"<h1>Hello</h1>");
        assert!(registry.read_ui_asset("sample", "app.js").is_ok());
        assert!(registry.read_ui_asset("sample", "../manifest.json").is_err());
    }

    #[test]
    fn serves_package_assets_without_a_ui_entrypoint() {
        let root = tempfile::tempdir().unwrap();
        let plugin_dir = root.path().join("sample");
        std::fs::create_dir_all(plugin_dir.join("assets")).unwrap();
        std::fs::write(plugin_dir.join("assets/icon.svg"), "<svg/>").unwrap();
        std::fs::write(
            plugin_dir.join("manifest.json"),
            serde_json::json!({
                "manifest_version": 1,
                "id": "sample",
                "name": "Sample",
                "version": "1.0.0",
                "publisher": "dbx",
                "engines": { "dbx": ">=0.1.0", "host_api": "^1.0" },
                "icon": "assets/icon.svg"
            })
            .to_string(),
        )
        .unwrap();
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");

        let icon = registry.read_asset("sample", "assets/icon.svg").unwrap();
        assert_eq!(icon.content_type, "image/svg+xml");
        assert_eq!(icon.bytes, b"<svg/>");
        assert!(registry.read_asset("sample", "../outside.svg").is_err());
    }
}
