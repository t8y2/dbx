//! Display-space conversions for window geometry (issue #13168).
//!
//! A window reports its position/size as `logical value × the factor of the
//! display it is on`, while Tauri reports every monitor rect as `its logical
//! bounds × its own factor`. `LogicalPosition/LogicalSize` are passed through
//! untouched, so a physical rect is meaningful only together with the factor it
//! was captured at: reading 1x pixels at 2x, as `tauri-plugin-window-state`
//! does when it cannot find the saved display, halves them.

/// A physical-pixel rectangle: a window outer frame reported at one factor, or
/// a display in the origin-relative space of that factor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PhysicalWindowRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

/// The same rectangle in logical units (`scale_factor = 1`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LogicalRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// A display as Tauri reports it, plus its own scale factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct MonitorRect {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) scale_factor: f64,
}

impl From<&tauri::Monitor> for MonitorRect {
    fn from(monitor: &tauri::Monitor) -> Self {
        let (position, size) = (*monitor.position(), *monitor.size());
        Self {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            scale_factor: clean_scale_factor(monitor.scale_factor()),
        }
    }
}

impl MonitorRect {
    pub(crate) fn contains_point(&self, x: i32, y: i32) -> bool {
        let (x, y, left, top) = (i64::from(x), i64::from(y), i64::from(self.x), i64::from(self.y));
        x >= left && x < left + i64::from(self.width) && y >= top && y < top + i64::from(self.height)
    }

    /// The same display, ignoring its factor (which may have changed since).
    pub(crate) fn is_same_display(&self, other: &Self) -> bool {
        self.x == other.x && self.y == other.y && self.width == other.width && self.height == other.height
    }

    /// The display's bounds in logical units.
    pub(crate) fn logical(&self) -> LogicalRect {
        to_logical(
            PhysicalWindowRect { x: self.x, y: self.y, width: self.width, height: self.height },
            self.scale_factor,
        )
    }
}

/// Logical values are only meaningful with a positive finite factor.
pub(crate) fn clean_scale_factor(scale_factor: f64) -> f64 {
    if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    }
}

/// Physical → logical at an explicit factor.
pub(crate) fn to_logical(rect: PhysicalWindowRect, scale_factor: f64) -> LogicalRect {
    let factor = clean_scale_factor(scale_factor);
    LogicalRect {
        x: rect.x as f64 / factor,
        y: rect.y as f64 / factor,
        width: rect.width as f64 / factor,
        height: rect.height as f64 / factor,
    }
}

/// `rect`'s origin relative to `monitor`, in points. On macOS a reported
/// position is `AppKit points × the window's factor`, while display origins
/// from `MonitorRect::logical` are points, so dividing by the window's factor
/// gives the saved logical position. Equal factors give the plain point
/// difference.
pub(crate) fn offset_in_monitor(rect: PhysicalWindowRect, factor: f64, monitor: &MonitorRect) -> (f64, f64) {
    let factor = clean_scale_factor(factor);
    let origin = monitor.logical();
    (rect.x as f64 / factor - origin.x, rect.y as f64 / factor - origin.y)
}

/// The display a saved physical rect was on: the one containing its origin,
/// else the one it overlaps most, else the nearest one.
/// Logical minimum of the main window, used to reject the impossible reading
/// of a legacy physical rect at the wrong display factor.
const MIN_LOGICAL_WINDOW_SIZE: (u32, u32) = (900, 600);

fn plausible_logical_size(rect: PhysicalWindowRect, monitor: &MonitorRect) -> bool {
    let factor = clean_scale_factor(monitor.scale_factor);
    rect.width as f64 / factor >= f64::from(MIN_LOGICAL_WINDOW_SIZE.0)
        && rect.height as f64 / factor >= f64::from(MIN_LOGICAL_WINDOW_SIZE.1)
}

pub(crate) fn matching_monitor(rect: PhysicalWindowRect, monitors: &[MonitorRect]) -> Option<MonitorRect> {
    // A legacy state file has pixels only. Mixed-DPI physical monitor boxes
    // overlap, so prefer the display whose factor yields a size the window
    // could actually have had. The issue's 1280x800 px state is 1280x800 pt at
    // 1x (valid) but 640x400 pt at 2x (below the minimum), which picks the
    // external display instead of the built-in one.
    if let Some(containing) =
        monitors.iter().find(|monitor| plausible_logical_size(rect, monitor) && monitor.contains_point(rect.x, rect.y))
    {
        return Some(*containing);
    }
    if let Some(containing) = monitors.iter().find(|monitor| monitor.contains_point(rect.x, rect.y)) {
        return Some(*containing);
    }
    let (left, top) = (i64::from(rect.x), i64::from(rect.y));
    let (right, bottom) = (left + i64::from(rect.width), top + i64::from(rect.height));
    let overlap = |monitor: &MonitorRect| {
        let (m_left, m_top) = (i64::from(monitor.x), i64::from(monitor.y));
        let (m_right, m_bottom) = (m_left + i64::from(monitor.width), m_top + i64::from(monitor.height));
        (right.min(m_right) - left.max(m_left)).max(0) * (bottom.min(m_bottom) - top.max(m_top)).max(0)
    };
    if let Some(best) = monitors.iter().copied().filter(|monitor| overlap(monitor) > 0).max_by_key(overlap) {
        return Some(best);
    }
    monitors.iter().copied().min_by_key(|monitor| {
        let (m_left, m_top) = (i64::from(monitor.x), i64::from(monitor.y));
        let (m_right, m_bottom) = (m_left + i64::from(monitor.width), m_top + i64::from(monitor.height));
        let (gap_x, gap_y) = ((m_left - right).max(left - m_right).max(0), (m_top - bottom).max(top - m_bottom).max(0));
        gap_x * gap_x + gap_y * gap_y
    })
}

/// The display a logical rect is on: the one containing its origin, else the
/// one it overlaps most, else the first.
pub(crate) fn monitor_for_logical(rect: LogicalRect, monitors: &[MonitorRect]) -> Option<MonitorRect> {
    monitors
        .iter()
        .find(|monitor| {
            let bounds = monitor.logical();
            rect.x >= bounds.x
                && rect.x < bounds.x + bounds.width
                && rect.y >= bounds.y
                && rect.y < bounds.y + bounds.height
        })
        .or_else(|| monitors.iter().find(|monitor| overlaps_logical(rect, &monitor.logical())))
        .or(monitors.first())
        .copied()
}

fn overlaps_logical(a: LogicalRect, b: &LogicalRect) -> bool {
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

/// Caps `rect`'s size to the display it is on and centers it back onto that
/// display when it would fall outside (the logical twin of the physical clamp).
pub(crate) fn fit_logical(rect: LogicalRect, monitors: &[MonitorRect]) -> LogicalRect {
    let Some(bounds) = monitor_for_logical(rect, monitors).map(|monitor| monitor.logical()) else {
        return rect;
    };
    let width = rect.width.min(bounds.width);
    let height = rect.height.min(bounds.height);
    LogicalRect {
        x: centered_axis(rect.x, width, bounds.x, bounds.width),
        y: centered_axis(rect.y, height, bounds.y, bounds.height),
        width,
        height,
    }
}

fn centered_axis(start: f64, length: f64, monitor_start: f64, monitor_length: f64) -> f64 {
    let slack = (monitor_length - length).max(0.0);
    if start < monitor_start || start > monitor_start + slack {
        monitor_start + (slack / 2.0).round()
    } else {
        start
    }
}

/// Origin of the one logical frame shared by all displays, given `primary`.
/// On macOS every origin is AppKit points relative to the main display's
/// top-left, and Tauri reports each origin multiplied by its own factor, so a
/// display above or left of the main one shows up as a negative logical origin
/// and a shared frame is in use. Windows and X11 keep separate pixel origins,
/// which a display left of or above the primary also makes negative, so this
/// only holds when the primary sits at `(0, 0)` and nothing reports a negative
/// origin — the macOS setup, where logical positions really are points.
pub(crate) fn shared_frame_base(monitors: &[MonitorRect], primary: Option<&MonitorRect>) -> Option<LogicalRect> {
    let primary = primary?.logical();
    let shared = monitors.iter().all(|monitor| {
        let origin = monitor.logical();
        origin.x >= 0.0 && origin.y >= 0.0
    });
    (shared && primary.x == 0.0 && primary.y == 0.0).then_some(primary)
}
