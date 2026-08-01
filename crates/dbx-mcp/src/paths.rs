use std::path::PathBuf;

pub const STORAGE_DB_FILE_NAME: &str = "dbx.db";

/// Mirrors `dirs::data_dir()` (same call the Tauri desktop app makes) so MCP/CLI and the desktop
/// app resolve the same `dbx.db`, including under `XDG_DATA_HOME` on Linux.
pub fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("DBX_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }

    let base = dirs::data_dir()
        .ok_or_else(|| "Unable to resolve the user data directory. Set DBX_DATA_DIR explicitly.".to_string())?;
    Ok(base.join("com.dbx.app"))
}

pub fn storage_db_path() -> Result<PathBuf, String> {
    Ok(app_data_dir()?.join(STORAGE_DB_FILE_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_data_dir_wins() {
        let original = std::env::var_os("DBX_DATA_DIR");
        std::env::set_var("DBX_DATA_DIR", "/tmp/dbx-mcp-data");
        assert_eq!(app_data_dir().unwrap(), PathBuf::from("/tmp/dbx-mcp-data"));
        match original {
            Some(value) => std::env::set_var("DBX_DATA_DIR", value),
            None => std::env::remove_var("DBX_DATA_DIR"),
        }
    }
}
