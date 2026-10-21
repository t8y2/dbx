use serde::Deserialize;
use std::fs;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Must match `minWidth`/`minHeight` and `width`/`height` of the main window in
/// `tauri.conf.json`. Logical pixels.
const MIN_WINDOW_SIZE: (u32, u32) = (900, 600);
const DEFAULT_WINDOW_SIZE: (u32, u32) = (1280, 800);

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

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
struct PersistedWindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    prev_x: i32,
    prev_y: i32,
    maximized: bool,
    decorated: bool,
    fullscreen: bool,
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

/// The window-state plugin caches `Resized` events without a non-zero check, so
/// a transient 0x0 or minimized-sized event can end up in the state file, and
/// `set_size` does not enforce the window's minimum size. Resizing is capped
/// below by the minimum, so a persisted size under it (at 1x scale, the lowest
/// physical size that minimum can have) is corrupt and falls back to the default.
pub(crate) fn sane_window_size(saved: (u32, u32), default_scale: f64) -> (u32, u32) {
    if saved.0 >= MIN_WINDOW_SIZE.0 && saved.1 >= MIN_WINDOW_SIZE.1 {
        return saved;
    }
    let scale = if default_scale.is_finite() && default_scale >= 1.0 { default_scale } else { 1.0 };
    ((DEFAULT_WINDOW_SIZE.0 as f64 * scale).round() as u32, (DEFAULT_WINDOW_SIZE.1 as f64 * scale).round() as u32)
}

pub(crate) fn enforce_main_window_bounds<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if enforce_window_bounds(&window) {
            let _ = app.save_window_state(persisted_main_window_state_flags());
        }
    }
}

pub(crate) fn restore_main_window_state<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Some(state) = load_main_window_state(app) else {
        return;
    };

    let persisted_rect = persisted_window_rect(state);
    let (width, height) =
        sane_window_size((persisted_rect.width, persisted_rect.height), window.scale_factor().unwrap_or(1.0));
    let saved_rect = PhysicalWindowRect { width, height, ..persisted_rect };
    let monitors = window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|monitor| PhysicalMonitorRect {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect::<Vec<_>>();
    let fallback_monitor =
        window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten()).map(|monitor| {
            PhysicalMonitorRect {
                x: monitor.position().x,
                y: monitor.position().y,
                width: monitor.size().width,
                height: monitor.size().height,
            }
        });
    let monitor = matching_monitor(saved_rect, &monitors).or(fallback_monitor);
    let restored_rect = monitor.and_then(|monitor| corrected_window_rect(saved_rect, monitor)).unwrap_or(saved_rect);

    let _ = window.set_decorations(state.decorated);
    let restored = window
        .set_size(PhysicalSize::new(restored_rect.width, restored_rect.height))
        .and_then(|_| window.set_position(PhysicalPosition::new(restored_rect.x, restored_rect.y)))
        .is_ok();

    if restored && restored_rect != persisted_rect {
        let _ = app.save_window_state(persisted_main_window_state_flags());
    }
    if state.maximized {
        let _ = window.maximize();
    }
    if state.fullscreen {
        let _ = window.set_fullscreen(true);
    }
}

pub(crate) fn persisted_main_window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::DECORATIONS | StateFlags::FULLSCREEN
}

fn load_main_window_state<R: Runtime>(app: &AppHandle<R>) -> Option<PersistedWindowState> {
    let path = app.path().app_config_dir().ok()?.join(app.filename());
    let states: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    serde_json::from_value(states.get("main")?.clone()).ok()
}

fn persisted_window_rect(state: PersistedWindowState) -> PhysicalWindowRect {
    let (x, y) = if state.maximized { (state.prev_x, state.prev_y) } else { (state.x, state.y) };
    PhysicalWindowRect { x, y, width: state.width, height: state.height }
}

fn matching_monitor(window: PhysicalWindowRect, monitors: &[PhysicalMonitorRect]) -> Option<PhysicalMonitorRect> {
    monitors
        .iter()
        .copied()
        .find(|monitor| monitor_contains_point(*monitor, window.x, window.y))
        .or_else(|| monitors.iter().copied().find(|monitor| rects_intersect(window, *monitor)))
}

fn monitor_contains_point(monitor: PhysicalMonitorRect, x: i32, y: i32) -> bool {
    let x = i64::from(x);
    let y = i64::from(y);
    let left = i64::from(monitor.x);
    let top = i64::from(monitor.y);
    x >= left && x < left + i64::from(monitor.width) && y >= top && y < top + i64::from(monitor.height)
}

fn rects_intersect(window: PhysicalWindowRect, monitor: PhysicalMonitorRect) -> bool {
    let window_left = i64::from(window.x);
    let window_top = i64::from(window.y);
    let window_right = window_left + i64::from(window.width);
    let window_bottom = window_top + i64::from(window.height);
    let monitor_left = i64::from(monitor.x);
    let monitor_top = i64::from(monitor.y);
    let monitor_right = monitor_left + i64::from(monitor.width);
    let monitor_bottom = monitor_top + i64::from(monitor.height);

    window_left < monitor_right
        && window_right > monitor_left
        && window_top < monitor_bottom
        && window_bottom > monitor_top
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
    use super::{
        corrected_window_rect, matching_monitor, persisted_window_rect, sane_window_size, PersistedWindowState,
        PhysicalMonitorRect, PhysicalWindowRect,
    };
    use tauri_plugin_window_state::StateFlags;

    #[test]
    fn persisted_state_excludes_window_visibility() {
        let flags = super::persisted_main_window_state_flags();

        assert!(flags.contains(StateFlags::SIZE));
        assert!(flags.contains(StateFlags::POSITION));
        assert!(!flags.contains(StateFlags::VISIBLE));
    }

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

    #[test]
    fn repairs_oversized_maximized_window_and_restores_maximized_state() {
        let saved = PersistedWindowState {
            width: 7120,
            height: 2082,
            x: 0,
            y: 88,
            prev_x: 0,
            prev_y: 176,
            maximized: true,
            decorated: true,
            fullscreen: false,
        };
        let saved_rect = persisted_window_rect(saved);
        let monitor = PhysicalMonitorRect { x: 0, y: 0, width: 3600, height: 2338 };

        assert_eq!(
            corrected_window_rect(saved_rect, monitor),
            Some(PhysicalWindowRect { x: 0, y: 176, width: 3600, height: 2082 })
        );
    }

    #[test]
    fn chooses_monitor_containing_saved_window_origin() {
        let window = PhysicalWindowRect { x: -900, y: -1200, width: 2560, height: 1600 };
        let monitors = [
            PhysicalMonitorRect { x: 0, y: 0, width: 3600, height: 2338 },
            PhysicalMonitorRect { x: -1007, y: -1440, width: 3440, height: 1440 },
        ];

        assert_eq!(matching_monitor(window, &monitors), Some(monitors[1]));
    }

    #[test]
    fn keeps_persisted_size_at_or_above_the_minimum() {
        assert_eq!(sane_window_size((1280, 800), 1.0), (1280, 800));
        assert_eq!(sane_window_size((900, 600), 2.0), (900, 600));
    }

    #[test]
    fn replaces_corrupt_persisted_size_with_the_scaled_default() {
        for corrupt in [(0, 0), (160, 28), (440, 68), (1280, 0), (0, 800), (899, 800), (1280, 599)] {
            assert_eq!(sane_window_size(corrupt, 1.0), (1280, 800), "{corrupt:?}");
            assert_eq!(sane_window_size(corrupt, 2.0), (2560, 1600), "{corrupt:?}");
        }
        assert_eq!(sane_window_size((0, 0), f64::NAN), (1280, 800));
        assert_eq!(sane_window_size((0, 0), 0.0), (1280, 800));
    }
}
