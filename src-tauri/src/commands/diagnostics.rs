use serde::Serialize;
use sysinfo::{MemoryRefreshKind, ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessMemoryInfo {
    pub resident_bytes: u64,
    pub virtual_bytes: u64,
    pub total_memory_bytes: u64,
    pub used_memory_bytes: u64,
}

#[tauri::command]
pub fn get_process_memory_info() -> ProcessMemoryInfo {
    let process_refresh = ProcessRefreshKind::new().with_memory();
    let mut system = System::new_with_specifics(
        RefreshKind::new().with_memory(MemoryRefreshKind::new()).with_processes(process_refresh),
    );
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, process_refresh);
    let process = system.process(sysinfo::Pid::from(std::process::id() as usize));

    ProcessMemoryInfo {
        resident_bytes: process.map(|value| value.memory()).unwrap_or_default(),
        virtual_bytes: process.map(|value| value.virtual_memory()).unwrap_or_default(),
        total_memory_bytes: system.total_memory(),
        used_memory_bytes: system.used_memory(),
    }
}
