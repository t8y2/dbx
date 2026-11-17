use serde::Deserialize;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::Emitter;
use tauri::{AppHandle, Manager};

#[cfg(any(target_os = "windows", target_os = "macos"))]
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
// Other platforms accept the IPC request but use the frontend drag fallback.
#[cfg_attr(not(any(target_os = "windows", target_os = "macos")), allow(dead_code))]
pub struct StartTabDragPreviewRequest {
    pub transfer_id: String,
    pub source_window_label: String,
    pub left: i32,
    pub top: i32,
    pub grab_x: i32,
    pub grab_y: i32,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
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
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    return native::start(app, request);

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, request);
        Err("native tab drag release detection is unavailable on this platform".to_string())
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

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod native {
    use super::*;
    use std::thread;
    use std::time::{Duration, Instant};

    #[cfg(target_os = "macos")]
    fn pointer_state(app: &AppHandle) -> Option<(i32, i32, bool)> {
        let position = app.cursor_position().ok()?;
        let held = objc2_app_kit::NSEvent::pressedMouseButtons() & 1 != 0;
        Some((position.x.round() as i32, position.y.round() as i32, held))
    }

    #[cfg(target_os = "windows")]
    fn pointer_state(_app: &AppHandle) -> Option<(i32, i32, bool)> {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
        use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
        let mut position = POINT { x: 0, y: 0 };
        if unsafe { GetCursorPos(&mut position) } == 0 {
            return None;
        }
        let held = unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } & (0x8000u16 as i16) != 0;
        Some((position.x, position.y, held))
    }

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
        let started = Instant::now();
        while !cancelled.load(Ordering::Acquire) && started.elapsed() < Duration::from_secs(120) {
            let Some((x, y, held)) = pointer_state(&app) else {
                break;
            };
            final_cursor_x = x;
            final_cursor_y = y;
            final_left = x - request.grab_x;
            final_top = y - request.grab_y;
            if !held {
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
