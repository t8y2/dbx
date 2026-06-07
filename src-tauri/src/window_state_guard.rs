use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PhysicalWindowRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PhysicalMonitorRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn corrected_window_rect(
    window: PhysicalWindowRect,
    monitor: PhysicalMonitorRect,
) -> Option<PhysicalWindowRect> {
    let width = window.width.min(monitor.width);
    let height = window.height.min(monitor.height);
    let x = centered_axis_position(window.x, width, monitor.x, monitor.width);
    let y = centered_axis_position(window.y, height, monitor.y, monitor.height);
    let corrected = PhysicalWindowRect { x, y, width, height };

    (corrected != window).then_some(corrected)
}

pub(crate) fn enforce_main_window_bounds<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if enforce_window_bounds(&window) {
            let _ = app.save_window_state(StateFlags::all());
        }
    }
}

fn enforce_window_bounds<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return false;
    }

    let monitor = match window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten()) {
        Some(monitor) => monitor,
        None => return false,
    };
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let window_position = match window.outer_position() {
        Ok(position) => position,
        Err(_) => return false,
    };
    let window_size = match window.outer_size() {
        Ok(size) => size,
        Err(_) => return false,
    };

    let corrected = corrected_window_rect(
        PhysicalWindowRect {
            x: window_position.x,
            y: window_position.y,
            width: window_size.width,
            height: window_size.height,
        },
        PhysicalMonitorRect {
            x: monitor_position.x,
            y: monitor_position.y,
            width: monitor_size.width,
            height: monitor_size.height,
        },
    );

    if let Some(rect) = corrected {
        let _ = window.set_size(PhysicalSize::new(rect.width, rect.height));
        let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
        true
    } else {
        false
    }
}

fn centered_axis_position(window_start: i32, window_length: u32, monitor_start: i32, monitor_length: u32) -> i32 {
    let max_start = monitor_start + monitor_length.saturating_sub(window_length) as i32;
    if window_start < monitor_start || window_start > max_start {
        monitor_start + monitor_length.saturating_sub(window_length) as i32 / 2
    } else {
        window_start
    }
}

#[cfg(test)]
mod tests {
    use super::{corrected_window_rect, PhysicalMonitorRect, PhysicalWindowRect};

    #[test]
    fn moves_window_back_onto_monitor_when_restored_above_screen() {
        let corrected = corrected_window_rect(
            PhysicalWindowRect { x: 118, y: -1042, width: 1512, height: 866 },
            PhysicalMonitorRect { x: 0, y: 0, width: 1512, height: 982 },
        );

        assert_eq!(corrected, Some(PhysicalWindowRect { x: 0, y: 58, width: 1512, height: 866 }));
    }

    #[test]
    fn leaves_window_unchanged_when_it_fits_monitor() {
        let corrected = corrected_window_rect(
            PhysicalWindowRect { x: 80, y: 60, width: 1280, height: 800 },
            PhysicalMonitorRect { x: 0, y: 0, width: 1512, height: 982 },
        );

        assert_eq!(corrected, None);
    }

    #[test]
    fn shrinks_window_that_is_larger_than_monitor() {
        let corrected = corrected_window_rect(
            PhysicalWindowRect { x: -200, y: -120, width: 4096, height: 2160 },
            PhysicalMonitorRect { x: 0, y: 0, width: 1440, height: 900 },
        );

        assert_eq!(corrected, Some(PhysicalWindowRect { x: 0, y: 0, width: 1440, height: 900 }));
    }
}
