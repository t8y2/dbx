//! Unit tests for issue #13168: the display-space helpers in `window_geometry`
//! together with the window-state logic that restores the main window.

use crate::window_geometry::{
    fit_logical, matching_monitor, monitor_for_logical, offset_in_monitor, shared_frame_base, to_logical, LogicalRect,
    MonitorRect, PhysicalWindowRect,
};
use crate::window_state_guard::{
    corrected_window_rect, parse_geometry_file, restore_geometry, sane_window_size, updated_geometry_file,
    PersistedWindowState, WindowGeometry,
};
use tauri_plugin_window_state::StateFlags;

fn rect(x: i32, y: i32, width: u32, height: u32) -> PhysicalWindowRect {
    PhysicalWindowRect { x, y, width, height }
}

fn logical(x: f64, y: f64, width: f64, height: f64) -> LogicalRect {
    LogicalRect { x, y, width, height }
}

fn monitor(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> MonitorRect {
    MonitorRect { x, y, width, height, scale_factor }
}

/// Issue #13168: a 2x built-in main display (1728×1117 pt) plus a 1x external
/// display to its right, whose points start at (1728, -323). Tauri reports
/// each origin multiplied by that display's factor, so `MonitorRect::logical`
/// gives back the AppKit points.
fn mixed_dpi() -> Vec<MonitorRect> {
    vec![monitor(0, 0, 3456, 2234, 2.0), monitor(1728, -323, 2560, 1440, 1.0)]
}

/// A 2x built-in main display (1800×1169 pt) with a 1x 3440×1440 external
/// display placed above it and shifted left, so its points start at
/// (-890, -1440): both coordinates negative.
fn external_above_left() -> Vec<MonitorRect> {
    vec![monitor(0, 0, 3600, 2338, 2.0), monitor(-890, -1440, 3440, 1440, 1.0)]
}

fn legacy_state(x: i32, y: i32, width: u32, height: u32) -> PersistedWindowState {
    PersistedWindowState {
        width,
        height,
        x,
        y,
        prev_x: x,
        prev_y: y,
        maximized: false,
        decorated: true,
        fullscreen: false,
    }
}

#[test]
fn persisted_state_excludes_window_visibility() {
    let flags = crate::window_state_guard::persisted_main_window_state_flags();
    assert!(flags.contains(StateFlags::SIZE));
    assert!(flags.contains(StateFlags::POSITION));
    assert!(!flags.contains(StateFlags::VISIBLE));
}

#[test]
fn keeps_persisted_size_at_or_above_the_minimum() {
    assert_eq!(sane_window_size((1280, 800), 1.0), (1280, 800));
    // 900x600 px at 2x is 450x300 pt, below the logical minimum; the old
    // physical check let it through, the logical one falls back to the default.
    assert_eq!(sane_window_size((900, 600), 2.0), (2560, 1600));
    assert_eq!(sane_window_size((1800, 1200), 2.0), (1800, 1200));
    assert_eq!(sane_window_size((3150, 2168), 2.0), (3150, 2168));
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

#[test]
fn to_logical_divides_by_the_factor() {
    assert_eq!(to_logical(rect(2368, 183, 1280, 800), 1.0), logical(2368.0, 183.0, 1280.0, 800.0));
    assert_eq!(to_logical(rect(2368, 183, 1280, 800), 2.0), logical(1184.0, 91.5, 640.0, 400.0));
    assert_eq!(to_logical(rect(33, 7, 1281, 801), 2.0), logical(16.5, 3.5, 640.5, 400.5));
    assert_eq!(to_logical(rect(1184, 91, 640, 400), 1.25), logical(947.2, 72.8, 512.0, 320.0));
    for factor in [0.0, -2.0, f64::NAN, f64::INFINITY] {
        assert_eq!(to_logical(rect(-10, 20, 100, 50), factor), logical(-10.0, 20.0, 100.0, 50.0), "{factor}");
    }
}

#[test]
fn monitor_bounds_are_points_through_each_monitor_factor() {
    let monitors = mixed_dpi();
    let (built_in, external) = (monitors[0].logical(), monitors[1].logical());
    assert_eq!((built_in.x, built_in.y, built_in.width, built_in.height), (0.0, 0.0, 1728.0, 1117.0));
    assert_eq!((external.x, external.y, external.width, external.height), (1728.0, -323.0, 2560.0, 1440.0));
}

#[test]
fn offset_is_the_saved_point_position_at_each_factor() {
    let monitors = mixed_dpi();
    // On the 1x external display a reported position is its points.
    assert_eq!(offset_in_monitor(rect(2368, 183, 1280, 800), 1.0, &monitors[1]), (640.0, 506.0));
    // On the 2x built-in display 3150×2168 px are 1575×1084 pt at (152, 33).
    assert_eq!(offset_in_monitor(rect(304, 66, 3150, 2168), 2.0, &monitors[0]), (152.0, 33.0));
    // The 1x pixels read at 2x are 640×400 pt at (1184, 91.5): the issue.
    assert_eq!(offset_in_monitor(rect(2368, 183, 1280, 800), 2.0, &monitors[0]), (1184.0, 91.5));
}

#[test]
fn matching_monitor_prefers_origin_then_overlap_then_distance() {
    let monitors = mixed_dpi();
    assert_eq!(matching_monitor(rect(2368, 183, 1280, 800), &monitors), Some(monitors[1]));
    assert_eq!(matching_monitor(rect(100, 100, 1280, 800), &monitors), Some(monitors[0]));
    // Origin above both displays, overlapping only the external one.
    assert_eq!(matching_monitor(rect(3600, -700, 400, 200), &monitors), Some(monitors[1]));
    assert_eq!(matching_monitor(rect(1500, 900, 2000, 600), &monitors), Some(monitors[0]));
    // Outside both: the nearest display wins.
    assert_eq!(matching_monitor(rect(9000, 4000, 100, 100), &monitors), Some(monitors[1]));
    assert_eq!(matching_monitor(rect(-5000, 4000, 100, 100), &monitors), Some(monitors[0]));
    assert_eq!(matching_monitor(rect(0, 0, 10, 10), &[]), None);
}

#[test]
fn logical_monitor_lookup_uses_points() {
    let monitors = mixed_dpi();
    assert_eq!(monitor_for_logical(logical(2368.0, 183.0, 1280.0, 800.0), &monitors), Some(monitors[1]));
    assert_eq!(monitor_for_logical(logical(152.0, 33.0, 1575.0, 1084.0), &monitors), Some(monitors[0]));
    // The reported symptom lands on the built-in display, where the pre-fix
    // code left the window.
    assert_eq!(monitor_for_logical(logical(1184.0, 91.5, 640.0, 400.0), &monitors), Some(monitors[0]));
    assert_eq!(monitor_for_logical(logical(5000.0, 5000.0, 100.0, 100.0), &monitors), Some(monitors[0]));
}

#[test]
fn fit_logical_keeps_or_centers_like_the_physical_clamp() {
    let monitors = mixed_dpi();
    let inside = logical(152.0, 33.0, 1575.0, 1084.0);
    assert_eq!(fit_logical(inside, &monitors), inside);
    // Above the display: centered in it.
    let above = logical(59.0, -521.0, 756.0, 433.0);
    // x is inside the built-in display, so only the vertical axis is centered.
    assert_eq!(fit_logical(above, &monitors), logical(59.0, 342.0, 756.0, 433.0));
    // Larger than the display: shrunk, kept at its origin.
    let huge = logical(10.0, 20.0, 4000.0, 3000.0);
    // Equal to the display: the out-of-range origin is centered to 0.
    assert_eq!(fit_logical(huge, &monitors), logical(0.0, 0.0, 1728.0, 1117.0));
    // No displays: unchanged.
    assert_eq!(fit_logical(above, &[]), above);
}

#[test]
fn corrected_window_rect_still_clamps_physical_frames() {
    let built_in = MonitorRect { x: 0, y: 0, width: 1512, height: 982, scale_factor: 2.0 };
    // Restored above the screen: back onto the display.
    assert_eq!(corrected_window_rect(rect(118, -1042, 1512, 866), built_in), Some(rect(0, 58, 1512, 866)));
    // Fits: untouched.
    assert_eq!(corrected_window_rect(rect(80, 60, 1280, 800), built_in), None);
    // Larger than the display: shrunk.
    let small = MonitorRect { x: 0, y: 0, width: 1440, height: 900, scale_factor: 1.0 };
    assert_eq!(corrected_window_rect(rect(-200, -120, 4096, 2160), small), Some(rect(0, 0, 1440, 900)));
}

#[test]
fn issue_13168_restores_the_frame_saved_on_the_1x_display() {
    // Closed at (2368, 183) at 1280×800 px on the 1x external display and
    // reopened with the main (2x) display current: pre-fix the pixels were read
    // at 2x, giving 640×400 pt at (1184, 91.5). In the point frame the same
    // window is 1280×800 pt at (2368, 183), on its own display.
    let monitors = mixed_dpi();
    let saved = rect(2368, 183, 1280, 800);
    let external = matching_monitor(saved, &monitors).expect("saved on the external display");
    let origin = external.logical();
    let (x, y) = offset_in_monitor(saved, external.scale_factor, &external);
    let stored = WindowGeometry {
        x,
        y,
        width: saved.width as f64 / external.scale_factor,
        height: saved.height as f64 / external.scale_factor,
        scale_factor: external.scale_factor,
    };
    assert!(stored.is_usable());
    let point = stored.logical();
    let placed = fit_logical(logical(origin.x + point.x, origin.y + point.y, point.width, point.height), &monitors);
    assert_eq!(placed, logical(2368.0, 183.0, 1280.0, 800.0));
    assert_eq!(monitor_for_logical(placed, &monitors), Some(monitors[1]));
}

#[test]
fn issue_13168_restores_the_frame_of_a_window_closed_on_the_2x_display() {
    let monitors = mixed_dpi();
    let saved = rect(304, 66, 3150, 2168);
    let built_in = matching_monitor(saved, &monitors).expect("saved on the built-in display");
    let origin = built_in.logical();
    let (x, y) = offset_in_monitor(saved, built_in.scale_factor, &built_in);
    let placed = fit_logical(
        logical(origin.x + x, origin.y + y, saved.width as f64 / 2.0, saved.height as f64 / 2.0),
        &monitors,
    );
    assert_eq!(placed, logical(152.0, 33.0, 1575.0, 1084.0));
}

#[test]
fn the_halved_restore_is_the_reported_symptom() {
    // What `set_position(Physical…)`/`set_size(Physical…)` did to 1x pixels at 2x.
    assert_eq!(to_logical(rect(2368, 183, 1280, 800), 2.0), logical(1184.0, 91.5, 640.0, 400.0));
}

#[test]
fn shared_frame_only_needs_the_main_display_at_the_origin() {
    // Both layouts are the macOS shared point frame: the issue's (external
    // display at y = -323) and one placed above-left of the main display.
    for monitors in [mixed_dpi(), external_above_left()] {
        assert_eq!(shared_frame_base(monitors.first()), Some(monitors[0].logical()));
    }
    assert_eq!(shared_frame_base(Some(&monitor(1920, 0, 1920, 1080, 1.0))), None);
    assert_eq!(shared_frame_base(None), None);
}

#[test]
fn stored_geometry_is_absolute_points() {
    // On the 1x external display a reported frame is its points.
    let external = WindowGeometry::from_reported(rect(-500, -1200, 2000, 1100), 1.0);
    assert_eq!(external.logical(), logical(-500.0, -1200.0, 2000.0, 1100.0));
    // On the 2x built-in display a reported frame is points × 2.
    let built_in = WindowGeometry::from_reported(rect(582, 244, 3000, 1800), 2.0);
    assert_eq!(built_in.logical(), logical(291.0, 122.0, 1500.0, 900.0));
    assert_eq!(built_in.scale_factor, 2.0);
}

#[test]
fn stored_geometry_round_trips_on_every_display() {
    let monitors = external_above_left();
    for (reported, factor) in [(rect(-500, -1200, 2000, 1100), 1.0), (rect(582, 244, 3000, 1800), 2.0)] {
        let stored = WindowGeometry::from_reported(reported, factor);
        assert_eq!(restore_geometry(Some(stored), None, &monitors), Some(stored), "{reported:?} at {factor}");
    }
}

#[test]
fn a_window_closed_on_the_external_display_reopens_there_at_full_size() {
    // Before the fix the stored position was relative to its display and read
    // back as absolute, and this layout skipped the logical path altogether.
    let monitors = external_above_left();
    let stored = WindowGeometry::from_reported(rect(-500, -1200, 2000, 1100), 1.0);
    let restored = restore_geometry(Some(stored), None, &monitors).expect("restorable");
    assert_eq!(restored.logical(), logical(-500.0, -1200.0, 2000.0, 1100.0));
    assert_eq!(monitor_for_logical(restored.logical(), &monitors), Some(monitors[1]));
}

#[test]
fn stored_geometry_wins_over_the_plugin_pixels() {
    let monitors = external_above_left();
    let stored = WindowGeometry::from_reported(rect(582, 244, 3000, 1800), 2.0);
    let state = legacy_state(582, 244, 2560, 1600);
    assert_eq!(restore_geometry(Some(stored), Some(&state), &monitors), Some(stored));
}

#[test]
fn a_window_on_a_disconnected_display_is_centered_on_the_main_display() {
    let stored = WindowGeometry::from_reported(rect(-500, -1200, 2000, 1100), 1.0);
    let built_in_only = vec![monitor(0, 0, 3600, 2338, 2.0)];
    let restored = restore_geometry(Some(stored), None, &built_in_only).expect("restorable");
    // Capped to the 1800×1169 pt display and centered on it.
    assert_eq!(restored.logical(), logical(0.0, 35.0, 1800.0, 1100.0));
}

#[test]
fn corrupt_stored_size_falls_back_to_the_default() {
    let stored = WindowGeometry { x: 100.0, y: 100.0, width: 160.0, height: 28.0, scale_factor: 2.0 };
    let restored = restore_geometry(Some(stored), None, &external_above_left()).expect("restorable");
    assert_eq!(restored.logical(), logical(100.0, 100.0, 1280.0, 800.0));
}

#[test]
fn without_stored_geometry_the_plugin_pixels_are_read_at_their_display_factor() {
    let monitors = external_above_left();
    // The user's actual state file: 2560×1600 px at (582, 244) on the 2x display.
    let restored = restore_geometry(None, Some(&legacy_state(582, 244, 2560, 1600)), &monitors).expect("restorable");
    assert_eq!(restored.logical(), logical(291.0, 122.0, 1280.0, 800.0));
    assert_eq!(restore_geometry(None, None, &monitors), None);
}

#[test]
fn geometry_file_keeps_other_entries_and_survives_garbage() {
    let geometry = WindowGeometry::from_reported(rect(582, 244, 3000, 1800), 2.0);
    let fresh = updated_geometry_file(None, "main", &geometry).expect("encoded");
    assert_eq!(parse_geometry_file(&fresh, "main"), Some(geometry));

    let other = br#"{"other":{"x":1.0,"y":2.0,"width":1000.0,"height":700.0,"scale_factor":1.0}}"#;
    let merged = updated_geometry_file(Some(other), "main", &geometry).expect("encoded");
    assert_eq!(parse_geometry_file(&merged, "main"), Some(geometry));
    assert!(parse_geometry_file(&merged, "other").is_some());

    let replaced = updated_geometry_file(Some(b"not json"), "main", &geometry).expect("encoded");
    assert_eq!(parse_geometry_file(&replaced, "main"), Some(geometry));

    assert_eq!(parse_geometry_file(b"not json", "main"), None);
    assert_eq!(parse_geometry_file(br#"{"main":{"x":0.0}}"#, "main"), None);
    let unusable = br#"{"main":{"x":0.0,"y":0.0,"width":0.0,"height":800.0,"scale_factor":2.0}}"#;
    assert_eq!(parse_geometry_file(unusable, "main"), None);
}
