//! Serves installed plugin UI assets over the `dbx-plugin` scheme so the
//! sandboxed workbench document can lazy-load code-split chunks at runtime.
//!
//! URLs carry the plugin id as the first path segment with a fixed host
//! (`dbx-plugin://localhost/<plugin-id>/<asset-path>`). The fixed host keeps
//! the WebView2-mapped form (`http://dbx-plugin.localhost/...`) a single
//! constant origin, which the sandbox CSP can allow without wildcard hosts.

use std::sync::Arc;

use dbx_core::plugins::PluginRegistry;
use percent_encoding::percent_decode_str;
use tauri::http::{HeaderValue, Method, Response, StatusCode, Uri};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::commands::connection::AppState;

pub const PLUGIN_UI_SCHEME: &str = "dbx-plugin";

/// Registered on the app builder; see `lib.rs`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let registry = ctx.app_handle().try_state::<Arc<AppState>>().map(|state| state.plugins.clone());
    let method = request.method().clone();
    let uri = request.uri().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let response = match registry {
            Some(registry) => serve_plugin_ui_asset(&registry, &method, &uri),
            None => error_response(StatusCode::SERVICE_UNAVAILABLE, "Plugin registry is unavailable"),
        };
        responder.respond(response);
    });
}

pub(crate) fn serve_plugin_ui_asset(registry: &PluginRegistry, method: &Method, uri: &Uri) -> Response<Vec<u8>> {
    if method != Method::GET && method != Method::HEAD {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "Plugin UI assets only support GET and HEAD");
    }
    let Some((plugin_id, asset_path)) = parse_plugin_ui_uri(uri) else {
        return error_response(StatusCode::NOT_FOUND, "Plugin UI asset not found");
    };
    match registry.read_ui_asset(&plugin_id, &asset_path) {
        Ok(asset) => asset_response(&asset.content_type, &asset.etag, &asset.bytes, method == Method::HEAD),
        Err(error) => {
            // The registry error names filesystem paths; keep it in the log, not the response.
            log::warn!("[{PLUGIN_UI_SCHEME}] failed to serve {uri}: {error}");
            error_response(StatusCode::NOT_FOUND, "Plugin UI asset not found")
        }
    }
}

/// Splits `dbx-plugin://localhost/<plugin-id>/<asset-path>` into its parts.
/// The asset path keeps its percent-decoding to the registry's traversal
/// validation, which runs on the decoded components.
pub(crate) fn parse_plugin_ui_uri(uri: &Uri) -> Option<(String, String)> {
    if uri.scheme_str() != Some(PLUGIN_UI_SCHEME) {
        return None;
    }
    let path = uri.path().strip_prefix('/')?;
    let mut segments = path.split('/');
    let plugin_id = segments.next()?;
    if !valid_plugin_id(plugin_id) {
        return None;
    }
    let encoded_rest = segments.collect::<Vec<_>>().join("/");
    if encoded_rest.is_empty() {
        return None;
    }
    let asset_path = percent_decode_str(&encoded_rest).decode_utf8().ok()?.into_owned();
    if asset_path.is_empty() {
        return None;
    }
    Some((plugin_id.to_string(), asset_path))
}

fn valid_plugin_id(plugin_id: &str) -> bool {
    !plugin_id.is_empty()
        && plugin_id.len() <= 200
        && plugin_id.chars().all(|character| character.is_ascii_alphanumeric() || character == '.' || character == '-')
        && !plugin_id.starts_with('.')
        && !plugin_id.ends_with('.')
}

fn asset_response(content_type: &str, etag: &str, bytes: &[u8], head: bool) -> Response<Vec<u8>> {
    let mut response = Response::new(if head { Vec::new() } else { bytes.to_vec() });
    let headers = response.headers_mut();
    // The workbench document is an opaque-origin srcdoc iframe, so module
    // script fetches are CORS-mode with `Origin: null` — only `*` passes.
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert(
        "content-type",
        HeaderValue::from_str(content_type).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    if let Ok(value) = HeaderValue::from_str(etag) {
        headers.insert("etag", value);
    }
    // Plugins update in place; never let a stale chunk outlive its install.
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

fn error_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    let mut response = Response::new(message.as_bytes().to_vec());
    *response.status_mut() = status;
    response.headers_mut().insert("access-control-allow-origin", HeaderValue::from_static("*"));
    response.headers_mut().insert("content-type", HeaderValue::from_static("text/plain; charset=utf-8"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_registry() -> PluginRegistry {
        let root = tempfile::tempdir().unwrap();
        let plugin_dir = root.path().join("sample");
        std::fs::create_dir_all(plugin_dir.join("ui/assets")).unwrap();
        std::fs::write(plugin_dir.join("ui/index.html"), "<h1>Hello</h1>").unwrap();
        std::fs::write(plugin_dir.join("ui/assets/chunk.js"), "console.log('chunk')").unwrap();
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
        // Leak the tempdir so the registry (and the reads below) outlive it.
        std::mem::forget(root);
        PluginRegistry::new_with_app_version(plugin_dir.parent().unwrap().to_path_buf(), "0.5.67")
    }

    fn uri(value: &str) -> Uri {
        value.parse().unwrap()
    }

    fn get(path: &str) -> Response<Vec<u8>> {
        serve_plugin_ui_asset(&test_registry(), &Method::GET, &uri(path))
    }

    #[test]
    fn serves_assets_with_cors_headers() {
        let response = get("dbx-plugin://localhost/sample/assets/chunk.js");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["access-control-allow-origin"], "*");
        assert_eq!(response.headers()["content-type"], "text/javascript; charset=utf-8");
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(response.body().as_slice(), b"console.log('chunk')");
    }

    #[test]
    fn head_returns_headers_without_body() {
        let response = serve_plugin_ui_asset(
            &test_registry(),
            &Method::HEAD,
            &uri("dbx-plugin://localhost/sample/assets/chunk.js"),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.body().is_empty());
        assert_eq!(response.headers()["content-type"], "text/javascript; charset=utf-8");
    }

    #[test]
    fn rejects_non_get_methods() {
        let response =
            serve_plugin_ui_asset(&test_registry(), &Method::POST, &uri("dbx-plugin://localhost/sample/ui/index.html"));
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn rejects_wrong_scheme() {
        assert!(parse_plugin_ui_uri(&uri("http://localhost/sample/ui/index.html")).is_none());
    }

    #[test]
    fn rejects_paths_that_escape_the_plugin() {
        for path in
            ["dbx-plugin://localhost/sample/../secret.txt", "dbx-plugin://localhost/sample/ui/../../manifest.json"]
        {
            let response = get(path);
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "path should be rejected: {path}");
        }
    }

    #[test]
    fn rejects_unknown_plugins_and_empty_paths() {
        assert_eq!(get("dbx-plugin://localhost/other/ui/index.html").status(), StatusCode::NOT_FOUND);
        assert!(parse_plugin_ui_uri(&uri("dbx-plugin://localhost/sample")).is_none());
        assert!(parse_plugin_ui_uri(&uri("dbx-plugin://localhost/")).is_none());
    }

    #[test]
    fn decodes_percent_encoded_paths() {
        let response = get("dbx-plugin://localhost/sample/%69ndex.html");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.body().as_slice(), b"<h1>Hello</h1>");
    }

    #[test]
    fn validates_plugin_ids() {
        assert!(parse_plugin_ui_uri(&uri("dbx-plugin://localhost/..hidden/ui/index.html")).is_none());
        assert!(parse_plugin_ui_uri(&uri("dbx-plugin://localhost/a%20b/ui/index.html")).is_none());
        assert!(parse_plugin_ui_uri(&uri("dbx-plugin://localhost/ok.id-1/ui/index.html")).is_some());
    }
}
