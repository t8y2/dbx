//! Main-window geometry persistence and restore.
//!
//! `tauri-plugin-window-state` saves `outer_position`/`inner_size` as physical
//! pixels (`logical points × the factor of the display the window was on`) and
//! restores them with `set_position(Physical…)`/`set_size(Physical…)`, which
//! tao converts back using the *restoring* window's factor, i.e. the display it
//! was created on. That only round-trips on a display whose factor equals the
//! saving one: after closing DBX on a 1x external display of a mixed-DPI macOS
//! setup, those pixels are read at 2x, so the window lands on the 2x main
//! display at half its size (issue #13168). The plugin's "saved rect
//! intersects a monitor" guard does not notice, because each monitor rect is
//! scaled by that monitor's own factor.
//!
//! DBX keeps the plugin for the file format, flags and event cache, but also
//! records the window's geometry in the same `.window-state.json` entry
//! (`logical`, a field the plugin ignores). On macOS, whose displays share one
//! point frame, it restores that geometry with `LogicalPosition`/`LogicalSize`,
//! which tao applies without converting. Other platforms keep the plugin's
//! physical round trip.

use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::window_geometry::{
    clean_scale_factor, fit_logical, matching_monitor, offset_in_monitor, shared_frame_base, LogicalRect, MonitorRect,
    PhysicalWindowRect,
};

/// Must match `minWidth`/`minHeight` and `width`/`height` of the main window in
/// `tauri.conf.json`. Logical pixels.
const MIN_WINDOW_SIZE: (u32, u32) = (900, 600);
const DEFAULT_WINDOW_SIZE: (u32, u32) = (1280, 800);

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
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
    /// Written by DBX; absent in states written by older builds.
    logical: Option<WindowGeometry>,
}

/// Window logical position/size plus the factor of the display it was on.
/// Positions are relative to that display's logical origin, so they stay valid
/// when the window is recreated on another display.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Serialize)]
pub(crate) struct WindowGeometry {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

impl WindowGeometry {
    pub(crate) fn is_usable(&self) -> bool {
        [self.x, self.y, self.width, self.height, self.scale_factor].iter().all(|value| value.is_finite())
            && self.width > 0.0
            && self.height > 0.0
            && self.scale_factor > 0.0
    }

    pub(crate) fn logical(&self) -> LogicalRect {
        LogicalRect { x: self.x, y: self.y, width: self.width, height: self.height }
    }
}

/// The window-state plugin caches `Resized` events without a non-zero check, so
/// a transient 0x0 or minimized-sized event can end up in the state file, and
/// `set_size` does not enforce the window's minimum size. Resizing is capped
/// below by the minimum, so a persisted size under it (at 1x scale, the lowest
/// physical size that minimum can have) is corrupt and falls back to the default.
pub(crate) fn sane_window_size(saved: (u32, u32), default_scale: f64) -> (u32, u32) {
    let scale = if default_scale.is_finite() && default_scale >= 1.0 { default_scale } else { 1.0 };
    let sane = |value: u32, min: u32, default: u32| if value >= min { value } else { default };
    let (width, height) = (
        sane((saved.0 as f64 / scale).round() as u32, MIN_WINDOW_SIZE.0, DEFAULT_WINDOW_SIZE.0),
        sane((saved.1 as f64 / scale).round() as u32, MIN_WINDOW_SIZE.1, DEFAULT_WINDOW_SIZE.1),
    );
    (((width as f64) * scale).round() as u32, ((height as f64) * scale).round() as u32)
}

pub(crate) fn persisted_main_window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED | StateFlags::DECORATIONS | StateFlags::FULLSCREEN
}

pub(crate) fn enforce_main_window_bounds<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Some(rect) = enforce_window_bounds(&window) {
            let _ = window.set_size(PhysicalSize::new(rect.width, rect.height));
            let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
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
    let monitors = monitor_rects(&window);
    let primary = window.primary_monitor().ok().flatten().map(|monitor| MonitorRect::from(&monitor));

    let _ = window.set_decorations(state.decorated);
    // Only macOS has one logical frame for all displays (AppKit points), which
    // is the setup issue #13168 is about. Elsewhere displays have separate pixel
    // origins, so the pre-existing physical path is kept.
    let geometry = cfg!(target_os = "macos")
        .then(|| shared_frame_base(&monitors, primary.as_ref()).and_then(|_| logical_geometry(&state, &monitors)))
        .flatten()
        .filter(WindowGeometry::is_usable);
    match geometry.filter(|geometry| set_logical_geometry(&window, geometry)) {
        // The plugin's own restore skips the main window, so make its cache and
        // the file agree with the frame just applied.
        Some(geometry) => persist_logical_geometry(app, &geometry),
        None => restore_physical_window_state(&window, &state, &monitors),
    }
    if state.maximized {
        let _ = window.maximize();
    }
    if state.fullscreen {
        let _ = window.set_fullscreen(true);
    }
}

/// Logical geometry to restore on macOS, in the shared point frame.
///
/// A DBX entry holds the window's point position relative to an unknown display
/// plus the factor the window reported: on macOS the same position is reported
/// in every start (the AppKit point frame), so on restore the display it is on
/// is simply the one containing it. A state written by an older build holds the
/// plugin's pixels, which on macOS are AppKit points × the factor the window
/// reported at save time; those land on a display by their pixels, and
/// dividing by that display's factor gives the points back.
fn logical_geometry(state: &PersistedWindowState, monitors: &[MonitorRect]) -> Option<WindowGeometry> {
    let (mut geometry, factor, home) = match state.logical.filter(WindowGeometry::is_usable) {
        Some(logical) => {
            let rect = logical.logical();
            let factor = clean_scale_factor(logical.scale_factor);
            let home = matching_monitor(relative_rect(&rect), monitors);
            (rect, factor, home)
        }
        None => {
            let pixels = saved_physical_rect(state);
            let monitor = matching_monitor(pixels, monitors)?;
            let factor = monitor.scale_factor;
            let (width, height) = sane_window_size((pixels.width, pixels.height), factor);
            let rect = PhysicalWindowRect { width, height, ..pixels };
            (point_frame(rect, factor, &monitor), factor, Some(monitor))
        }
    };
    if !monitor_containing(&geometry, monitors) {
        // Created on another display (or the saved one is gone): keep the
        // offset in the frame of a display that still exists.
        let (target, home) = (monitors.first()?, home?);
        geometry.x += target.logical().x - home.logical().x;
        geometry.y += target.logical().y - home.logical().y;
    }
    let fitted = fit_logical(geometry, monitors);
    Some(WindowGeometry { x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height, scale_factor: factor })
}

fn relative_rect(rect: &LogicalRect) -> PhysicalWindowRect {
    PhysicalWindowRect {
        x: rect.x.round() as i32,
        y: rect.y.round() as i32,
        width: rect.width.max(0.0) as u32,
        height: rect.height.max(0.0) as u32,
    }
}

/// `rect` (reported at `factor`) on `monitor` in the point frame.
fn point_frame(rect: PhysicalWindowRect, factor: f64, monitor: &MonitorRect) -> LogicalRect {
    let factor = clean_scale_factor(factor);
    let origin = monitor.logical();
    let (x, y) = offset_in_monitor(rect, factor, monitor);
    LogicalRect {
        x: origin.x + x,
        y: origin.y + y,
        width: rect.width as f64 / factor,
        height: rect.height as f64 / factor,
    }
}

fn monitor_containing(geometry: &LogicalRect, monitors: &[MonitorRect]) -> bool {
    monitors.iter().any(|monitor| {
        let bounds = monitor.logical();
        geometry.x >= bounds.x
            && geometry.y >= bounds.y
            && geometry.x < bounds.x + bounds.width
            && geometry.y < bounds.y + bounds.height
    })
}

/// `rect` (reported at `factor`) on `monitor` as a stored display-relative geometry.
fn logical_in_monitor(rect: PhysicalWindowRect, factor: f64, monitor: &MonitorRect) -> WindowGeometry {
    let point = point_frame(rect, factor, monitor);
    let origin = monitor.logical();
    WindowGeometry {
        x: point.x - origin.x,
        y: point.y - origin.y,
        width: point.width,
        height: point.height,
        scale_factor: clean_scale_factor(factor),
    }
}

fn set_logical_geometry<R: Runtime>(window: &WebviewWindow<R>, geometry: &WindowGeometry) -> bool {
    window
        .set_size(LogicalSize::new(geometry.width, geometry.height))
        .and_then(|_| window.set_position(LogicalPosition::new(geometry.x, geometry.y)))
        .is_ok()
}

/// Records the main window's geometry in logical units while the window is
/// still visible. macOS quits through `AppHandle::hide` + `app.exit`, and the
/// window-state plugin saves at exit, possibly from a frame that hiding
/// blanked; the answer to the close prompt may also arrive long after it
/// appeared. Callers capture before hiding and when a close is requested;
/// repeats within a minute are skipped, but the first call always stores, so a
/// single quit keeps its exact frame.
pub(crate) fn remember_main_window_geometry<R: Runtime>(app: &AppHandle<R>) {
    static LAST_CAPTURE: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
    let now = std::time::Instant::now();
    if let Ok(mut last) = LAST_CAPTURE.lock() {
        if last.is_some_and(|last| now.duration_since(last) < std::time::Duration::from_secs(60)) {
            return;
        }
        *last = Some(now);
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false)
        && !window.is_maximized().unwrap_or(false)
        && !window.is_fullscreen().unwrap_or(false);
    let (Ok(position), Ok(size), Ok(scale_factor)) =
        (window.outer_position(), window.inner_size(), window.scale_factor())
    else {
        return;
    };
    let rect = PhysicalWindowRect { x: position.x, y: position.y, width: size.width, height: size.height };
    let geometry = visible
        .then(|| {
            matching_monitor(rect, &monitor_rects(&window))
                .map(|monitor| logical_in_monitor(rect, scale_factor, &monitor))
        })
        .flatten()
        .filter(|geometry| geometry.is_usable());
    if let Some(geometry) = geometry {
        persist_logical_geometry(app, &geometry);
    }
}

/// Writes the geometry next to the plugin's fields, then lets the plugin save
/// (it re-reads the file, so the field must be in place first).
fn persist_logical_geometry<R: Runtime>(app: &AppHandle<R>, geometry: &WindowGeometry) {
    let Ok(path) = app.path().app_config_dir().map(|dir| dir.join(app.filename())) else {
        return;
    };
    let Some(mut states) =
        fs::read(&path).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return;
    };
    if let (Some(mut main), Ok(logical)) =
        (states.get_mut("main").map(serde_json::Value::take), serde_json::to_value(geometry))
    {
        main["logical"] = logical;
        states["main"] = main;
    }
    if let Ok(encoded) = serde_json::to_vec_pretty(&states) {
        let _ = fs::write(path, encoded);
    }
    let _ = app.save_window_state(persisted_main_window_state_flags());
}

fn restore_physical_window_state<R: Runtime>(
    window: &WebviewWindow<R>,
    state: &PersistedWindowState,
    monitors: &[MonitorRect],
) {
    let persisted_rect = saved_physical_rect(state);
    let scale_factor = clean_scale_factor(window.scale_factor().unwrap_or(1.0));
    let (width, height) = sane_window_size((persisted_rect.width, persisted_rect.height), scale_factor);
    let saved_rect = PhysicalWindowRect { x: persisted_rect.x, y: persisted_rect.y, width, height };
    let fallback_monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())
        .map(|monitor| MonitorRect::from(&monitor));
    let monitor = matching_monitor(saved_rect, monitors).or(fallback_monitor);
    let restored_rect = monitor.and_then(|monitor| corrected_window_rect(saved_rect, monitor)).unwrap_or(saved_rect);

    let restored = window
        .set_size(PhysicalSize::new(restored_rect.width, restored_rect.height))
        .and_then(|_| window.set_position(PhysicalPosition::new(restored_rect.x, restored_rect.y)))
        .is_ok();

    if restored && restored_rect != persisted_rect {
        let _ = window.app_handle().save_window_state(persisted_main_window_state_flags());
    }
}

/// Last-resort physical placement: clamp the rect onto `monitor`.
pub(crate) fn corrected_window_rect(window: PhysicalWindowRect, monitor: MonitorRect) -> Option<PhysicalWindowRect> {
    let width = window.width.min(monitor.width);
    let height = window.height.min(monitor.height);
    let x = centered_axis(window.x, width, monitor.x, monitor.width);
    let y = centered_axis(window.y, height, monitor.y, monitor.height);
    let corrected = PhysicalWindowRect { x, y, width, height };
    (corrected != window).then_some(corrected)
}

fn centered_axis(window_start: i32, window_length: u32, monitor_start: i32, monitor_length: u32) -> i32 {
    let slack = monitor_length.saturating_sub(window_length);
    let max_start = monitor_start + slack as i32;
    if window_start < monitor_start || window_start > max_start {
        monitor_start + slack as i32 / 2
    } else {
        window_start
    }
}

fn enforce_window_bounds<R: Runtime>(window: &WebviewWindow<R>) -> Option<PhysicalWindowRect> {
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return None;
    }
    let monitor = window.current_monitor().ok().flatten().or_else(|| window.primary_monitor().ok().flatten())?;
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return None;
    };
    let rect = PhysicalWindowRect { x: position.x, y: position.y, width: size.width, height: size.height };
    corrected_window_rect(rect, MonitorRect::from(&monitor))
}

/// Every display Tauri knows, with the special ones appended if missing.
fn monitor_rects<R: Runtime>(window: &WebviewWindow<R>) -> Vec<MonitorRect> {
    let mut monitors =
        window.available_monitors().unwrap_or_default().iter().map(MonitorRect::from).collect::<Vec<_>>();
    for monitor in
        [window.current_monitor().ok().flatten(), window.primary_monitor().ok().flatten()].into_iter().flatten()
    {
        let rect = MonitorRect::from(&monitor);
        if !monitors.iter().any(|known| known.is_same_display(&rect)) {
            monitors.push(rect);
        }
    }
    monitors
}

fn load_main_window_state<R: Runtime>(app: &AppHandle<R>) -> Option<PersistedWindowState> {
    let path = app.path().app_config_dir().ok()?.join(app.filename());
    let states: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    serde_json::from_value(states.get("main")?.clone()).ok()
}

fn saved_physical_rect(state: &PersistedWindowState) -> PhysicalWindowRect {
    let (x, y) = if state.maximized { (state.prev_x, state.prev_y) } else { (state.x, state.y) };
    PhysicalWindowRect { x, y, width: state.width, height: state.height }
}

#[cfg(test)]
#[path = "window_state_guard_tests.rs"]
mod tests;
