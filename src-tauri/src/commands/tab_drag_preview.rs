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
    use std::sync::mpsc::sync_channel;
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, CreateSolidBrush, DeleteObject, DrawTextW, EndPaint, FillRect, FrameRect, SetBkMode, SetTextColor,
        UpdateWindow, DT_END_ELLIPSIS, DT_SINGLELINE, DT_VCENTER, PAINTSTRUCT, TRANSPARENT,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, GetCursorPos, GetWindowTextW, RegisterClassExW,
        SetLayeredWindowAttributes, SetWindowPos, ShowWindow, HTTRANSPARENT, LWA_ALPHA, MA_NOACTIVATE, SWP_NOACTIVATE,
        SWP_SHOWWINDOW, SW_SHOWNOACTIVATE, WM_ERASEBKGND, WM_MOUSEACTIVATE, WM_NCHITTEST, WM_PAINT, WNDCLASSEXW,
        WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
    };

    const PREVIEW_CLASS: &str = "DBXTabDragPreviewHost";

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

        let hwnd = create_preview_window(&app, &request)?;
        let app_for_loop = app.clone();
        thread::spawn(move || run_drag_loop(app_for_loop, request, hwnd, cancelled));
        Ok(())
    }

    fn create_preview_window(app: &AppHandle, request: &StartTabDragPreviewRequest) -> Result<isize, String> {
        let (sender, receiver) = sync_channel(1);
        let request = StartTabDragPreviewRequest {
            transfer_id: request.transfer_id.clone(),
            source_window_label: request.source_window_label.clone(),
            title: request.title.clone(),
            left: request.left,
            top: request.top,
            width: request.width.max(1),
            height: request.height.max(1),
            grab_x: request.grab_x,
            grab_y: request.grab_y,
        };
        app.run_on_main_thread(move || {
            let result = unsafe {
                let class_name = wide(PREVIEW_CLASS);
                let instance = GetModuleHandleW(std::ptr::null());
                let class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(preview_window_proc),
                    hInstance: instance,
                    lpszClassName: class_name.as_ptr(),
                    ..Default::default()
                };
                RegisterClassExW(&class);
                let title = wide(&request.title);
                let hwnd = CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
                    class_name.as_ptr(),
                    title.as_ptr(),
                    WS_POPUP,
                    request.left,
                    request.top,
                    request.width,
                    request.height,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    instance,
                    std::ptr::null(),
                );
                if hwnd.is_null() {
                    Err("CreateWindowExW failed for the tab drag preview".to_string())
                } else {
                    SetLayeredWindowAttributes(hwnd, 0, 232, LWA_ALPHA);
                    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    UpdateWindow(hwnd);
                    Ok(hwnd as isize)
                }
            };
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        receiver.recv().map_err(|error| error.to_string())?
    }

    fn run_drag_loop(app: AppHandle, request: StartTabDragPreviewRequest, hwnd: isize, cancelled: Arc<AtomicBool>) {
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
            let left = final_left;
            let top = final_top;
            let _ = app.run_on_main_thread(move || unsafe {
                SetWindowPos(hwnd as HWND, std::ptr::null_mut(), left, top, 0, 0, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            });

            if unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } & (0x8000u16 as i16) == 0 {
                released = true;
                break;
            }
            thread::sleep(Duration::from_millis(16));
        }

        let _ = app.run_on_main_thread(move || unsafe {
            DestroyWindow(hwnd as HWND);
        });
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

    unsafe extern "system" fn preview_window_proc(
        hwnd: HWND,
        message: u32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        match message {
            WM_NCHITTEST => HTTRANSPARENT as LRESULT,
            WM_MOUSEACTIVATE => MA_NOACTIVATE as LRESULT,
            WM_ERASEBKGND => 1,
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let hdc = BeginPaint(hwnd, &mut paint);
                let mut rect = RECT::default();
                GetClientRect(hwnd, &mut rect);
                let border = CreateSolidBrush(0x00525252 as COLORREF);
                let body = CreateSolidBrush(0x00222222 as COLORREF);
                let icon = CreateSolidBrush(0x0000B887 as COLORREF);
                FrameRect(hdc, &rect, border);
                FillRect(hdc, &rect, body);
                let icon_rect = RECT {
                    left: rect.left + 9,
                    top: rect.top + 10,
                    right: (rect.left + 21).min(rect.right),
                    bottom: (rect.top + 22).min(rect.bottom),
                };
                FillRect(hdc, &icon_rect, icon);
                SetBkMode(hdc, TRANSPARENT as i32);
                SetTextColor(hdc, 0x00F5F5F5);
                let mut title = [0_u16; 256];
                let title_length = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32).max(0) as usize;
                let mut text_rect = rect;
                text_rect.left = icon_rect.right + 8;
                text_rect.right -= 24;
                DrawTextW(
                    hdc,
                    title.as_ptr(),
                    title_length as i32,
                    &mut text_rect,
                    DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS,
                );
                SetTextColor(hdc, 0x00999999);
                let close = wide("×");
                let mut close_rect = rect;
                close_rect.left = (close_rect.right - 20).max(close_rect.left);
                DrawTextW(hdc, close.as_ptr(), -1, &mut close_rect, DT_SINGLELINE | DT_VCENTER);
                DeleteObject(border as _);
                DeleteObject(body as _);
                DeleteObject(icon as _);
                EndPaint(hwnd, &paint);
                0
            }
            _ => DefWindowProcW(hwnd, message, w_param, l_param),
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }
}
