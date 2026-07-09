#[cfg(target_os = "macos")]
fn set_macos_traffic_light_position_inner(window: tauri::Window, x: f64, y: f64) -> Result<(), String> {
    let ns_window = window.ns_window().map_err(|err| err.to_string())? as usize;
    window
        .run_on_main_thread(move || unsafe {
            use objc2_app_kit::{NSWindow, NSWindowButton};

            let ns_window = &*(ns_window as *mut NSWindow);
            let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
                return;
            };
            let Some(miniaturize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
                return;
            };
            let zoom = ns_window.standardWindowButton(NSWindowButton::ZoomButton);

            let Some(title_bar_container_view) = close.superview().and_then(|view| view.superview()) else {
                return;
            };

            let close_rect = close.frame();
            let title_bar_frame_height = close_rect.size.height + y;
            let mut title_bar_rect = title_bar_container_view.frame();
            title_bar_rect.size.height = title_bar_frame_height;
            title_bar_rect.origin.y = ns_window.frame().size.height - title_bar_frame_height;
            title_bar_container_view.setFrame(title_bar_rect);

            let space_between = miniaturize.frame().origin.x - close_rect.origin.x;
            let mut buttons = vec![close, miniaturize];
            if let Some(zoom) = zoom {
                buttons.push(zoom);
            }
            for (index, button) in buttons.into_iter().enumerate() {
                let mut rect = button.frame();
                rect.origin.x = x + (index as f64 * space_between);
                button.setFrameOrigin(rect.origin);
            }
        })
        .map_err(|err| err.to_string())
}

#[cfg(not(target_os = "macos"))]
fn set_macos_traffic_light_position_inner(_window: tauri::Window, _x: f64, _y: f64) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn set_macos_traffic_light_position(window: tauri::Window, x: f64, y: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err("Invalid traffic light position".to_string());
    }
    set_macos_traffic_light_position_inner(window, x, y)
}
