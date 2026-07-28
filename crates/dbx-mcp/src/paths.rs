use std::path::PathBuf;

pub const STORAGE_DB_FILE_NAME: &str = "dbx.db";

pub fn app_data_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("DBX_DATA_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path));
    }

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve the user home directory. Set DBX_DATA_DIR explicitly.".to_string())?;

    #[cfg(target_os = "macos")]
    return Ok(home.join("Library/Application Support/com.dbx.app"));

    #[cfg(target_os = "windows")]
    return Ok(std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Roaming"))
        .join("com.dbx.app"));

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Ok(home.join(".local/share/com.dbx.app"));
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
