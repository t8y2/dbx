use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;

use super::connection::AppState;

static DOWNLOADS: LazyLock<Mutex<HashMap<String, CancellationToken>>> = LazyLock::new(Mutex::default);

#[tauri::command]
pub fn cancel_plugin_download(plugin_id: String, download_id: String) -> Result<(), String> {
    if let Some(token) = DOWNLOADS.lock().map_err(|error| error.to_string())?.get(&format!("{plugin_id}:{download_id}"))
    {
        token.cancel();
    }
    Ok(())
}

struct DownloadGuard(String);

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut downloads) = DOWNLOADS.lock() {
            downloads.remove(&self.0);
        }
    }
}

#[tauri::command]
pub async fn download_plugin_file(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    download_id: String,
    file_name: String,
    mut params: Value,
    on_progress: Channel<Value>,
) -> Result<Option<String>, String> {
    let download_uuid = uuid::Uuid::parse_str(&download_id).map_err(|error| error.to_string())?;
    let input = params.as_object_mut().ok_or("Download params must be an object")?;
    input.insert("downloadId".into(), json!(download_id));
    let control = json!({
        "downloadId": download_id,
        "connectionId": params.get("connectionId"),
        "providerId": params.get("providerId"),
    });
    let cancel = CancellationToken::new();
    let key = format!("{plugin_id}:{download_id}");
    {
        let mut downloads = DOWNLOADS.lock().map_err(|error| error.to_string())?;
        if downloads.contains_key(&key) || downloads.len() >= 8 {
            return Err("Too many active downloads or duplicate download ID".into());
        }
        downloads.insert(key.clone(), cancel.clone());
    }
    let _guard = DownloadGuard(key);
    let file_name = file_name.rsplit(['/', '\\']).next().filter(|name| !name.is_empty()).unwrap_or("download.bin");
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(file_name).save_file(move |path| {
        let _ = sender.send(path);
    });
    let chosen = receiver.await.map_err(|error| error.to_string())?;
    let Some(chosen) = chosen else { return Ok(None) };
    if cancel.is_cancelled() {
        return Ok(None);
    }
    let destination = chosen.into_path().map_err(|error| error.to_string())?;
    let mut output = super::plugin_download_file::DownloadFile::new(destination.clone(), &download_uuid.to_string())
        .map_err(|error| error.to_string())?;
    let host = state.plugin_host.clone();
    let task = async {
        let metadata: Value = host
            .invoke(&plugin_id, "filesystem/download/open", params.clone(), None, Some(Duration::from_secs(120)))
            .await?;
        let total = metadata.get("size").and_then(Value::as_u64).unwrap_or(0);
        let mut transferred = 0u64;
        loop {
            if cancel.is_cancelled() {
                return Ok(None);
            }
            let chunk: Value = host
                .invoke(&plugin_id, "filesystem/download/read", control.clone(), None, Some(Duration::from_secs(120)))
                .await?;
            let encoded = chunk.get("dataBase64").and_then(Value::as_str).ok_or("Invalid download chunk")?;
            if encoded.len() > 1_398_104 {
                return Err("Plugin download chunk exceeds 1 MiB".to_string());
            }
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|error| error.to_string())?;
            let done = chunk.get("done").and_then(Value::as_bool).ok_or("Missing download completion flag")?;
            if bytes.is_empty() && !done {
                return Err("Plugin download made no progress".into());
            }
            output.write_all(&bytes).map_err(|error| error.to_string())?;
            transferred += bytes.len() as u64;
            on_progress
                .send(json!({"downloadId": download_id, "sent": transferred, "total": total}))
                .map_err(|error| error.to_string())?;
            if done {
                break;
            }
        }
        if params.get("archive").and_then(Value::as_bool) != Some(true) && transferred != total {
            return Err("Plugin download size does not match object metadata".into());
        }
        if cancel.is_cancelled() {
            return Ok(None);
        }
        output.commit().map_err(|error| error.to_string())?;
        Ok(Some(destination.to_string_lossy().into_owned()))
    };
    let result = tokio::select! {
        result = task => result,
        _ = cancel.cancelled() => Ok(None),
    };
    let _: Result<Value, _> =
        host.invoke(&plugin_id, "filesystem/download/close", control, None, Some(Duration::from_secs(10))).await;
    result
}
