use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const BACKGROUND_IMAGE_BASE_NAME: &str = "background-image";
pub(crate) const BACKGROUND_IMAGE_MAX_BYTES: u64 = 20 * 1024 * 1024;
const SUPPORTED_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "bmp", "gif"];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundImageInfo {
    pub stored_path: String,
    pub file_name: String,
}

fn background_image_extension(source: &Path) -> Result<String, String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "unsupported background image: missing file extension".to_string())?;
    if SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        Ok(extension)
    } else {
        Err(format!("unsupported background image extension: {extension} (allowed: png, jpg, jpeg, webp, bmp, gif)"))
    }
}

fn background_image_path(data_dir: &Path, extension: &str) -> PathBuf {
    data_dir.join(format!("{BACKGROUND_IMAGE_BASE_NAME}.{extension}"))
}

fn is_background_image_path(path: &Path) -> bool {
    path.file_name().and_then(|value| value.to_str()).is_some_and(|name| name.starts_with(BACKGROUND_IMAGE_BASE_NAME))
}

fn remove_stale_background_images(data_dir: &Path, keep_extension: Option<&str>) {
    for extension in SUPPORTED_EXTENSIONS {
        if Some(extension) == keep_extension {
            continue;
        }
        let candidate = background_image_path(data_dir, extension);
        if candidate.exists() {
            if let Err(error) = std::fs::remove_file(&candidate) {
                log::warn!("Failed to remove stale background image {}: {error}", candidate.display());
            }
        }
    }
}

fn copy_background_image_into(data_dir: &Path, source: &Path, extension: &str) -> Result<PathBuf, String> {
    let metadata =
        std::fs::metadata(source).map_err(|error| format!("failed to read background image metadata: {error}"))?;
    if metadata.len() > BACKGROUND_IMAGE_MAX_BYTES {
        return Err("background image exceeds the 20 MB size limit".to_string());
    }
    let target = background_image_path(data_dir, extension);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("failed to create data dir: {error}"))?;
    }
    std::fs::copy(source, &target).map_err(|error| format!("failed to copy background image: {error}"))?;
    remove_stale_background_images(data_dir, Some(extension));
    Ok(target)
}

/// Copies the picked image into the resolved data dir so the background
/// survives the original file being moved or deleted. The data dir must be
/// resolved here (portable mode / DBX_DATA_DIR override) — the frontend only
/// knows the default app data dir.
#[tauri::command]
pub async fn save_background_image(app: AppHandle, source_path: String) -> Result<BackgroundImageInfo, String> {
    let source = PathBuf::from(&source_path);
    let extension = background_image_extension(&source)?;
    let file_name = source.file_name().and_then(|value| value.to_str()).unwrap_or("background image").to_string();
    let default_data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let data_dir = crate::data_dir::resolve_data_dir_with_mode(default_data_dir).data_dir;

    let stored_path =
        tauri::async_runtime::spawn_blocking(move || copy_background_image_into(&data_dir, &source, &extension))
            .await
            .map_err(|error| format!("background image copy task failed: {error}"))??;

    Ok(BackgroundImageInfo { stored_path: stored_path.to_string_lossy().to_string(), file_name })
}

#[tauri::command]
pub async fn clear_background_image(stored_path: String) -> Result<(), String> {
    let path = PathBuf::from(&stored_path);
    // The stored path always points at <data_dir>/background-image.<ext>; the
    // file-name guard keeps a corrupted config from deleting arbitrary files.
    if !is_background_image_path(&path) {
        return Err("refusing to clear unexpected background image path".to_string());
    }
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| format!("failed to remove background image: {error}"))?;
    }
    Ok(())
}

/// Returns the stored copy's bytes as base64. Reads go through an app command
/// because the fs plugin's granted scopes don't reliably cover the resolved
/// data dir (fs:allow-read-file ships without path scopes).
#[tauri::command]
pub async fn read_background_image(stored_path: String) -> Result<String, String> {
    let path = PathBuf::from(&stored_path);
    if !is_background_image_path(&path) {
        return Err("refusing to read unexpected background image path".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|error| format!("failed to read background image: {error}"))?;
        Ok(BASE64_STANDARD.encode(bytes))
    })
    .await
    .map_err(|error| format!("background image read task failed: {error}"))?
}

/// Existence probe for the settings dialog's stale-file hint.
#[tauri::command]
pub async fn check_background_image(stored_path: String) -> Result<bool, String> {
    let path = PathBuf::from(&stored_path);
    if !is_background_image_path(&path) {
        return Ok(false);
    }
    Ok(path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!("dbx-tauri-{label}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn background_image_extension_accepts_supported_and_rejects_others() {
        assert_eq!(background_image_extension(Path::new("/tmp/wall.png")).unwrap(), "png");
        assert_eq!(background_image_extension(Path::new("C:\\pic.JPG")).unwrap(), "jpg");
        assert!(background_image_extension(Path::new("no-extension")).is_err());
        assert!(background_image_extension(Path::new("vector.svg")).is_err());
    }

    #[test]
    fn copy_keeps_current_extension_and_cleans_stale_copies() {
        let temp = TempDir::new("background-image-copy");
        let data_dir = temp.0.join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(background_image_path(&data_dir, "png"), b"old").unwrap();
        let source = temp.0.join("fresh.jpg");
        std::fs::write(&source, b"new").unwrap();

        let stored = copy_background_image_into(&data_dir, &source, "jpg").unwrap();

        assert_eq!(stored, background_image_path(&data_dir, "jpg"));
        assert!(stored.exists());
        assert!(!background_image_path(&data_dir, "png").exists());
    }

    #[test]
    fn copy_rejects_oversized_images() {
        let temp = TempDir::new("background-image-size");
        let source = temp.0.join("big.png");
        std::fs::write(&source, vec![0u8; BACKGROUND_IMAGE_MAX_BYTES as usize + 1]).unwrap();

        let error = copy_background_image_into(&temp.0, &source, "png").unwrap_err();

        assert!(error.contains("20 MB"));
        assert!(!background_image_path(&temp.0, "png").exists());
    }

    #[test]
    fn clear_guard_rejects_unexpected_file_names() {
        assert!(is_background_image_path(Path::new("/data/background-image.png")));
        assert!(!is_background_image_path(Path::new("/data/important.db")));
        assert!(!is_background_image_path(Path::new("/data/dbx.db")));
    }
}
