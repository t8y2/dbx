#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<String>, String> {
    Ok(dbx_core::jdbc::list_system_fonts())
}
