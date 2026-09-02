use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};

pub const TAB_DRAG_PREVIEW_RELEASE_EVENT: &str = "dbx:tab-drag-preview-release";

#[derive(Default)]
pub struct TabDragPreviewState {
    active: Mutex<Option<ActivePreview>>,
}

struct ActivePreview {
    transfer_id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTabDragPreviewRequest {
    pub transfer_id: String,
    pub source_window_label: String,
    pub title: String,
    pub left: i32,
    pub top: i32,
    pub width: i32,
    pub height: i32,
    pub grab_x: i32,
    pub grab_y: i32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabDragPreviewRelease {
    transfer_id: String,
    source_window_label: String,
    cursor_x: i32,
    cursor_y: i32,
    left: i32,
    top: i32,
}

#[tauri::command]
pub fn start_tab_drag_preview(app: AppHandle, request: StartTabDragPreviewRequest) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    return windows::start(app, request);

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, request);
        Err("native tab drag preview is only implemented on Windows".to_string())
    }
}

#[tauri::command]
pub fn stop_tab_drag_preview(app: AppHandle, transfer_id: String) {
    if let Some(active) =
        app.state::<TabDragPreviewState>().active.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).as_ref()
    {
        if active.transfer_id == transfer_id {
            active.cancelled.store(true, Ordering::Release);
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::*;
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    pub fn start(app: AppHandle, request: StartTabDragPreviewRequest) -> Result<(), String> {
        let state = app.state::<TabDragPreviewState>();
        let cancelled = Arc::new(AtomicBool::new(false));
        {
            let mut active = state.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if active.is_some() {
                return Err("a tab drag preview is already active".to_string());
            }
            *active = Some(ActivePreview { transfer_id: request.transfer_id.clone(), cancelled: cancelled.clone() });
        }

        let app_for_loop = app.clone();
        thread::spawn(move || run_drag_loop(app_for_loop, request, cancelled));
        Ok(())
    }

    fn run_drag_loop(app: AppHandle, request: StartTabDragPreviewRequest, cancelled: Arc<AtomicBool>) {
        let mut released = false;
        let mut final_cursor_x = request.left + request.grab_x;
        let mut final_cursor_y = request.top + request.grab_y;
        let mut final_left = request.left;
        let mut final_top = request.top;
        while !cancelled.load(Ordering::Acquire) {
            let mut cursor = POINT { x: 0, y: 0 };
            unsafe {
                GetCursorPos(&mut cursor);
            }
            final_cursor_x = cursor.x;
            final_cursor_y = cursor.y;
            final_left = cursor.x - request.grab_x;
            final_top = cursor.y - request.grab_y;
            if unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } & (0x8000u16 as i16) == 0 {
                released = true;
                break;
            }
            thread::sleep(Duration::from_millis(16));
        }

        let state = app.state::<TabDragPreviewState>();
        let was_active = {
            let mut active = state.active.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            active.as_ref().is_some_and(|preview| preview.transfer_id == request.transfer_id) && active.take().is_some()
        };
        if released && was_active && !cancelled.load(Ordering::Acquire) {
            let _ = app.emit(
                TAB_DRAG_PREVIEW_RELEASE_EVENT,
                TabDragPreviewRelease {
                    transfer_id: request.transfer_id,
                    source_window_label: request.source_window_label,
                    cursor_x: final_cursor_x,
                    cursor_y: final_cursor_y,
                    left: final_left,
                    top: final_top,
                },
            );
        }
    }
}
