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
//! records the window's geometry in AppKit points in its own file,
//! `.window-geometry.json`, next to the plugin's. It cannot share the plugin's
//! file: the plugin serializes its in-memory cache over the whole file on every
//! save (including the one at exit) without reading it first, so any extra
//! field there is dropped. On macOS, whose displays share one point frame, DBX
//! restores that geometry with `LogicalPosition`/`LogicalSize`, which tao
//! applies without converting. Other platforms keep the plugin's physical round
//! trip.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow,
    WindowEvent,
};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::window_geometry::{
    clean_scale_factor, fit_logical, matching_monitor, offset_in_monitor, shared_frame_base, LogicalRect, MonitorRect,
    PhysicalWindowRect,
};

/// DBX's own geometry file in the app config directory, keyed by window label.
const GEOMETRY_FILENAME: &str = ".window-geometry.json";
const MAIN_WINDOW_LABEL: &str = "main";
/// Quiet period after the last move/resize before the frame is written.
const GEOMETRY_SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

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
}

/// Window position/size in the shared point frame (AppKit points, origin at
/// the main display's top-left) plus the factor the window reported. The
/// position is absolute, so it names the display the window was on; a display
/// that is gone on restore is handled by `fit_logical`.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Serialize)]
pub(crate) struct WindowGeometry {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) scale_factor: f64,
}

impl WindowGeometry {
    /// The window frame as reported (outer position and inner size, both
    /// `points × factor` on macOS) back in points.
    pub(crate) fn from_reported(rect: PhysicalWindowRect, scale_factor: f64) -> Self {
        let factor = clean_scale_factor(scale_factor);
        Self {
            x: rect.x as f64 / factor,
            y: rect.y as f64 / factor,
            width: rect.width as f64 / factor,
            height: rect.height as f64 / factor,
            scale_factor: factor,
        }
    }

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
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let state = load_main_window_state(app);
    let stored = load_main_window_geometry(app);
    if state.is_none() && stored.is_none() {
        return;
    }
    let monitors = monitor_rects(&window);
    let primary = window.primary_monitor().ok().flatten().map(|monitor| MonitorRect::from(&monitor));

    if let Some(state) = &state {
        let _ = window.set_decorations(state.decorated);
    }
    // Only macOS has one logical frame for all displays (AppKit points), which
    // is the setup issue #13168 is about. Elsewhere displays have separate pixel
    // origins, so the pre-existing physical path is kept.
    let geometry = cfg!(target_os = "macos")
        .then(|| shared_frame_base(primary.as_ref()).and_then(|_| restore_geometry(stored, state.as_ref(), &monitors)))
        .flatten();
    match geometry.filter(|geometry| set_logical_geometry(&window, geometry)) {
        // No plugin save here: tao applies the frame asynchronously, so the
        // plugin would still read the window's initial default frame and
        // write that to its file. Its cache follows the Resized/Moved events.
        Some(geometry) => persist_logical_geometry(app, &geometry),
        None => {
            if let Some(state) = &state {
                restore_physical_window_state(&window, state, &monitors);
            }
        }
    }
    if let Some(state) = state {
        if state.maximized {
            let _ = window.maximize();
        }
        if state.fullscreen {
            let _ = window.set_fullscreen(true);
        }
    }
}

/// Geometry to restore on macOS, in the shared point frame.
///
/// DBX's own entry already holds points and is used as is. Without one (first
/// start after upgrading, or the file was removed) the plugin's pixels are the
/// only record: on macOS those are AppKit points × the factor the window
/// reported at save time, so they are matched to a display by their pixels and
/// divided by that display's factor. Either way the result is fitted onto a
/// display that exists now.
fn restore_geometry(
    stored: Option<WindowGeometry>,
    state: Option<&PersistedWindowState>,
    monitors: &[MonitorRect],
) -> Option<WindowGeometry> {
    let (geometry, factor) = match stored.filter(WindowGeometry::is_usable) {
        Some(stored) => {
            let (width, height) = sane_logical_size(stored.width, stored.height);
            (LogicalRect { width, height, ..stored.logical() }, clean_scale_factor(stored.scale_factor))
        }
        None => {
            let pixels = saved_physical_rect(state?);
            let monitor = matching_monitor(pixels, monitors)?;
            let factor = monitor.scale_factor;
            let (width, height) = sane_window_size((pixels.width, pixels.height), factor);
            let rect = PhysicalWindowRect { width, height, ..pixels };
            (point_frame(rect, factor, &monitor), factor)
        }
    };
    let fitted = fit_logical(geometry, monitors);
    Some(WindowGeometry { x: fitted.x, y: fitted.y, width: fitted.width, height: fitted.height, scale_factor: factor })
        .filter(WindowGeometry::is_usable)
}

/// `sane_window_size` for a size already in points.
fn sane_logical_size(width: f64, height: f64) -> (f64, f64) {
    let sane = |value: f64, min: u32, default: u32| if value >= f64::from(min) { value } else { f64::from(default) };
    (sane(width, MIN_WINDOW_SIZE.0, DEFAULT_WINDOW_SIZE.0), sane(height, MIN_WINDOW_SIZE.1, DEFAULT_WINDOW_SIZE.1))
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
    if let Some(geometry) = current_main_window_geometry(app) {
        persist_logical_geometry(app, &geometry);
        let _ = app.save_window_state(persisted_main_window_state_flags());
    }
}

/// Keeps DBX's geometry file current while the main window moves or resizes.
/// The quit paths above skip a maximized or fullscreen window, and a crash or
/// a killed process skips them entirely; without this the file could then be
/// older than the plugin's and restore a previous session's frame. Saves are
/// debounced and read the window when they run, so a burst of events (a drag,
/// a fullscreen or maximize animation) stores only the frame it settles on.
/// Only macOS restores from the file, so other platforms skip the writes.
pub(crate) fn track_main_window_geometry<R: Runtime>(app: &AppHandle<R>) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let app = app.clone();
    let generation = Arc::new(AtomicU64::new(0));
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }
        let scheduled = generation.fetch_add(1, Ordering::SeqCst) + 1;
        let (app, generation) = (app.clone(), generation.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(GEOMETRY_SAVE_DEBOUNCE).await;
            if generation.load(Ordering::SeqCst) != scheduled {
                return;
            }
            if let Some(geometry) = current_main_window_geometry(&app) {
                persist_logical_geometry(&app, &geometry);
            }
        });
    });
}

/// The main window's frame in points, or `None` when it is hidden, minimized,
/// maximized or fullscreen (none of which is the frame to restore).
fn current_main_window_geometry<R: Runtime>(app: &AppHandle<R>) -> Option<WindowGeometry> {
    let window = app.get_webview_window(MAIN_WINDOW_LABEL)?;
    let normal = window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false)
        && !window.is_maximized().unwrap_or(false)
        && !window.is_fullscreen().unwrap_or(false);
    if !normal {
        return None;
    }
    let (position, size, scale_factor) =
        (window.outer_position().ok()?, window.inner_size().ok()?, window.scale_factor().ok()?);
    let rect = PhysicalWindowRect { x: position.x, y: position.y, width: size.width, height: size.height };
    Some(WindowGeometry::from_reported(rect, scale_factor)).filter(WindowGeometry::is_usable)
}

/// Writes the main window's entry into DBX's geometry file, keeping any other
/// entries. The plugin never touches this file.
fn persist_logical_geometry<R: Runtime>(app: &AppHandle<R>, geometry: &WindowGeometry) {
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    let path = dir.join(GEOMETRY_FILENAME);
    let existing = fs::read(&path).ok();
    if let Some(encoded) = updated_geometry_file(existing.as_deref(), MAIN_WINDOW_LABEL, geometry) {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(path, encoded);
    }
}

/// The geometry file's contents with `label` set to `geometry`. An unreadable
/// existing file is replaced rather than blocking the save.
fn updated_geometry_file(existing: Option<&[u8]>, label: &str, geometry: &WindowGeometry) -> Option<Vec<u8>> {
    let mut entries = existing
        .and_then(|bytes| serde_json::from_slice::<BTreeMap<String, serde_json::Value>>(bytes).ok())
        .unwrap_or_default();
    entries.insert(label.to_string(), serde_json::to_value(geometry).ok()?);
    serde_json::to_vec_pretty(&entries).ok()
}

fn load_main_window_geometry<R: Runtime>(app: &AppHandle<R>) -> Option<WindowGeometry> {
    let path = app.path().app_config_dir().ok()?.join(GEOMETRY_FILENAME);
    parse_geometry_file(&fs::read(path).ok()?, MAIN_WINDOW_LABEL)
}

fn parse_geometry_file(bytes: &[u8], label: &str) -> Option<WindowGeometry> {
    let mut entries: BTreeMap<String, serde_json::Value> = serde_json::from_slice(bytes).ok()?;
    serde_json::from_value::<WindowGeometry>(entries.remove(label)?).ok().filter(WindowGeometry::is_usable)
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
