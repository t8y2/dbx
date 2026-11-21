//! Serves installed plugin UI assets over the `dbx-plugin` scheme so the
//! sandboxed workbench document can lazy-load code-split chunks at runtime.
//!
//! URLs carry the plugin id as the first path segment with a fixed host
//! (`dbx-plugin://localhost/<plugin-id>/<asset-path>`). The fixed host keeps
//! the WebView2-mapped form (`http://dbx-plugin.localhost/...`) a single
//! constant origin, which the sandbox CSP can allow without wildcard hosts.

use std::{sync::Arc, time::Duration};

use base64::Engine;
use dbx_core::plugins::PluginRegistry;
use percent_encoding::percent_decode_str;
use serde::Deserialize;
use tauri::http::{HeaderValue, Method, Response, StatusCode, Uri};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};
use uuid::Uuid;

use crate::commands::{connection::AppState, plugin_media::PluginMediaState};

pub const PLUGIN_UI_SCHEME: &str = "dbx-plugin";

/// Registered on the app builder; see `lib.rs`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let method = request.method().clone();
    let uri = request.uri().clone();
    if let Some((plugin_id, token)) = parse_plugin_media_uri(&uri) {
        let app_state = ctx.app_handle().try_state::<Arc<AppState>>().map(|state| state.inner().clone());
        let media_state = ctx.app_handle().try_state::<PluginMediaState>().map(|state| state.inner().clone());
        let range = request.headers().get("range").and_then(|value| value.to_str().ok()).map(str::to_string);
        tauri::async_runtime::spawn(async move {
            let response = match (app_state, media_state) {
                (Some(app_state), Some(media_state)) => {
                    serve_plugin_media(&app_state, &media_state, &plugin_id, &token, &method, range).await
                }
                _ => error_response(StatusCode::SERVICE_UNAVAILABLE, "Plugin media service is unavailable"),
            };
            responder.respond(response);
        });
        return;
    }
    let registry = ctx.app_handle().try_state::<Arc<AppState>>().map(|state| state.plugins.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let response = match registry {
            Some(registry) => serve_plugin_ui_asset(&registry, &method, &uri),
            None => error_response(StatusCode::SERVICE_UNAVAILABLE, "Plugin registry is unavailable"),
        };
        responder.respond(response);
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginMediaChunk {
    #[serde(default)]
    data_base64: String,
    size: u64,
    #[serde(default)]
    offset: u64,
    #[serde(default)]
    length: u64,
    #[serde(default)]
    partial: bool,
    #[serde(default)]
    range_not_satisfiable: bool,
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    etag: String,
}

async fn serve_plugin_media(
    app_state: &Arc<AppState>,
    media_state: &PluginMediaState,
    plugin_id: &str,
    token: &str,
    method: &Method,
    range: Option<String>,
) -> Response<Vec<u8>> {
    if method != Method::GET && method != Method::HEAD {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "Plugin media only supports GET and HEAD");
    }
    let Some(source) = media_state.get(plugin_id, token) else {
        return error_response(StatusCode::NOT_FOUND, "Plugin media URL expired or was closed");
    };
    let mut params = source.params;
    let Some(values) = params.as_object_mut() else {
        return error_response(StatusCode::BAD_REQUEST, "Plugin media parameters are invalid");
    };
    values.insert("head".to_string(), serde_json::Value::Bool(method == Method::HEAD));
    if let Some(range) = range {
        values.insert("range".to_string(), serde_json::Value::String(range));
    }
    let result = match app_state
        .plugin_host
        .invoke(plugin_id, &source.method, params, None, Some(Duration::from_secs(30)))
        .await
    {
        Ok(result) => result,
        Err(error) => {
            log::warn!("[{PLUGIN_UI_SCHEME}] plugin media request failed for {plugin_id}: {error}");
            return error_response(StatusCode::BAD_GATEWAY, "Plugin media request failed");
        }
    };
    let chunk: PluginMediaChunk = match serde_json::from_value(result) {
        Ok(chunk) => chunk,
        Err(error) => {
            log::warn!("[{PLUGIN_UI_SCHEME}] invalid plugin media response for {plugin_id}: {error}");
            return error_response(StatusCode::BAD_GATEWAY, "Plugin media response was invalid");
        }
    };
    if chunk.range_not_satisfiable {
        let mut response =
            error_response(StatusCode::RANGE_NOT_SATISFIABLE, "Requested media range is not satisfiable");
        if let Ok(value) = HeaderValue::from_str(&format!("bytes */{}", chunk.size)) {
            response.headers_mut().insert("content-range", value);
        }
        return response;
    }
    let bytes = if method == Method::HEAD {
        Vec::new()
    } else {
        match base64::engine::general_purpose::STANDARD.decode(&chunk.data_base64) {
            Ok(bytes) => bytes,
            Err(error) => {
                log::warn!("[{PLUGIN_UI_SCHEME}] invalid plugin media bytes for {plugin_id}: {error}");
                return error_response(StatusCode::BAD_GATEWAY, "Plugin media bytes were invalid");
            }
        }
    };
    if method == Method::GET && bytes.len() as u64 != chunk.length {
        return error_response(StatusCode::BAD_GATEWAY, "Plugin media response length was invalid");
    }
    media_response(chunk, bytes, method == Method::HEAD)
}

fn media_response(chunk: PluginMediaChunk, bytes: Vec<u8>, head: bool) -> Response<Vec<u8>> {
    let partial = chunk.partial || (!head && chunk.length < chunk.size);
    let mut response = Response::new(if head { Vec::new() } else { bytes });
    *response.status_mut() = if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
    let headers = response.headers_mut();
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert("accept-ranges", HeaderValue::from_static("bytes"));
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    let content_type = if chunk.content_type.is_empty() { "application/octet-stream" } else { &chunk.content_type };
    headers.insert(
        "content-type",
        HeaderValue::from_str(content_type).unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    let content_length = if head { chunk.size } else { chunk.length };
    if let Ok(value) = HeaderValue::from_str(&content_length.to_string()) {
        headers.insert("content-length", value);
    }
    if partial && chunk.length > 0 {
        let end = chunk.offset + chunk.length - 1;
        if let Ok(value) = HeaderValue::from_str(&format!("bytes {}-{end}/{}", chunk.offset, chunk.size)) {
            headers.insert("content-range", value);
        }
    }
    if !chunk.etag.is_empty() {
        if let Ok(value) = HeaderValue::from_str(&chunk.etag) {
            headers.insert("etag", value);
        }
    }
    response
}

fn parse_plugin_media_uri(uri: &Uri) -> Option<(String, String)> {
    let (plugin_id, asset_path) = parse_plugin_ui_uri(uri)?;
    let token =
        asset_path.strip_prefix("__media/").or_else(|| asset_path.rsplit_once("/__media/").map(|(_, token)| token))?;
    Uuid::parse_str(token).ok()?;
    Some((plugin_id, token.to_string()))
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

    #[test]
    fn media_urls_require_scoped_uuid_tokens() {
        let parsed =
            parse_plugin_media_uri(&uri("dbx-plugin://localhost/sample/__media/550e8400-e29b-41d4-a716-446655440000"));
        assert_eq!(parsed, Some(("sample".to_string(), "550e8400-e29b-41d4-a716-446655440000".to_string())));
        let nested = parse_plugin_media_uri(&uri(
            "dbx-plugin://localhost/sample/ui/__media/550e8400-e29b-41d4-a716-446655440000",
        ));
        assert_eq!(nested, parsed);
        assert!(parse_plugin_media_uri(&uri("dbx-plugin://localhost/sample/__media/not-a-token")).is_none());
        assert!(parse_plugin_media_uri(&uri("dbx-plugin://localhost/sample/ui/index.html")).is_none());
    }

    #[test]
    fn media_response_sets_range_headers() {
        let response = media_response(
            PluginMediaChunk {
                data_base64: String::new(),
                size: 100,
                offset: 10,
                length: 20,
                partial: true,
                range_not_satisfiable: false,
                content_type: "video/mp4".to_string(),
                etag: "etag".to_string(),
            },
            vec![0; 20],
            false,
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["accept-ranges"], "bytes");
        assert_eq!(response.headers()["content-range"], "bytes 10-29/100");
        assert_eq!(response.headers()["content-length"], "20");
        assert_eq!(response.body().len(), 20);
    }
}
