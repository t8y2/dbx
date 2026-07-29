use dbx_core::config::{TraceEntry, TraceRingBuffer};

// ---- Trace commands ----

#[tauri::command]
#[allow(dead_code)]
pub fn trace_export_command(entries: Vec<TraceEntry>, capacity: Option<usize>) -> Result<String, String> {
    let cap = capacity.unwrap_or(1000);
    let mut buf = TraceRingBuffer::new(cap);
    for entry in entries {
        buf.push(entry);
    }
    buf.export_json()
}

#[tauri::command]
#[allow(dead_code)]
pub fn trace_stats_command(entries: Vec<TraceEntry>) -> dbx_core::config::TraceStats {
    let mut buf = TraceRingBuffer::new(entries.len().max(1));
    for entry in entries {
        buf.push(entry);
    }
    buf.stats()
}
