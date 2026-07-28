#[cfg(target_os = "macos")]
async fn set_macos_traffic_light_position_inner(
    window: tauri::Window,
    target_x: f64,
    target_center_y: f64,
    ui_scale: f64,
) -> Result<MacosTrafficLightLayout, String> {
    let ns_window = window.ns_window().map_err(|err| err.to_string())? as usize;
    let (tx, rx) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || unsafe {
            use objc2_app_kit::{NSWindow, NSWindowButton};

            let ns_window = &*(ns_window as *mut NSWindow);
            let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
                let _ = tx.send(None);
                return;
            };
            let Some(miniaturize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
                let _ = tx.send(None);
                return;
            };
            let zoom = ns_window.standardWindowButton(NSWindowButton::ZoomButton);

            let Some(title_bar_container_view) = close.superview().and_then(|view| view.superview()) else {
                let _ = tx.send(None);
                return;
            };

            let close_rect = close.frame();
            let window_height = ns_window.frame().size.height;
            let target_window_center_y = target_center_y * ui_scale;
            let target_y = (target_window_center_y - close_rect.size.height / 2.0).max(0.0);
            let title_bar_frame_height = close_rect.size.height + target_y;
            let mut title_bar_rect = title_bar_container_view.frame();
            title_bar_rect.size.height = title_bar_frame_height;
            title_bar_rect.origin.y = window_height - title_bar_frame_height;
            title_bar_container_view.setFrame(title_bar_rect);

            let close_rect = close.frame();
            let current_window_rect =
                close.superview().map(|view| view.convertRect_toView(close_rect, None)).unwrap_or(close_rect);
            let current_center_y =
                window_height - (current_window_rect.origin.y + current_window_rect.size.height / 2.0);
            let center_delta_y = target_window_center_y - current_center_y;
            let space_between = miniaturize.frame().origin.x - close_rect.origin.x;
            let mut buttons = vec![close, miniaturize];
            if let Some(zoom) = zoom {
                buttons.push(zoom);
            }
            for (index, button) in buttons.into_iter().enumerate() {
                let mut rect = button.frame();
                rect.origin.x = target_x + (index as f64 * space_between);
                rect.origin.y -= center_delta_y;
                button.setFrameOrigin(rect.origin);
            }

            let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
                let _ = tx.send(None);
                return;
            };
            let zoom = ns_window.standardWindowButton(NSWindowButton::ZoomButton);
            let close_rect = close.frame();
            let close_window_rect =
                close.superview().map(|view| view.convertRect_toView(close_rect, None)).unwrap_or(close_rect);
            let reserved_button_rect = zoom
                .as_ref()
                .and_then(|button| button.superview().map(|view| view.convertRect_toView(button.frame(), None)))
                .unwrap_or(close_window_rect);
            let button_center_y = window_height - (close_window_rect.origin.y + close_window_rect.size.height / 2.0);
            let _ = tx.send(Some(MacosTrafficLightLayout {
                x: close_window_rect.origin.x,
                y: target_y,
                center_y: button_center_y,
                previous_center_y: current_center_y,
                reserved_inset: reserved_button_rect.origin.x + reserved_button_rect.size.width + 8.0,
            }));
        })
        .map_err(|err| err.to_string())?;
    rx.await.map_err(|err| err.to_string())?.ok_or_else(|| "Unable to locate macOS traffic light buttons".to_string())
}

#[cfg(not(target_os = "macos"))]
async fn set_macos_traffic_light_position_inner(
    _window: tauri::Window,
    x: f64,
    target_center_y: f64,
    ui_scale: f64,
) -> Result<MacosTrafficLightLayout, String> {
    let center_y = target_center_y * ui_scale;
    Ok(MacosTrafficLightLayout { x, y: center_y, center_y, previous_center_y: center_y, reserved_inset: 0.0 })
}

fn validate_macos_traffic_light_position(x: f64, y: f64, scale: f64) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() || !scale.is_finite() || scale <= 0.0 {
        return Err("Invalid traffic light position".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MacosTrafficLightLayout {
    x: f64,
    y: f64,
    center_y: f64,
    previous_center_y: f64,
    reserved_inset: f64,
}

#[tauri::command]
pub async fn set_macos_traffic_light_position(
    window: tauri::Window,
    x: f64,
    y: f64,
    scale: f64,
) -> Result<MacosTrafficLightLayout, String> {
    validate_macos_traffic_light_position(x, y, scale)?;
    // Await AppKit work asynchronously so the main thread can execute the scheduled closure.
    set_macos_traffic_light_position_inner(window, x, y, scale).await
}

#[cfg(test)]
mod tests {
    use super::validate_macos_traffic_light_position;

    #[test]
    fn validates_macos_traffic_light_position_inputs() {
        assert!(validate_macos_traffic_light_position(16.0, 18.0, 1.0).is_ok());
        assert!(validate_macos_traffic_light_position(f64::NAN, 18.0, 1.0).is_err());
        assert!(validate_macos_traffic_light_position(16.0, f64::INFINITY, 1.0).is_err());
        assert!(validate_macos_traffic_light_position(16.0, 18.0, 0.0).is_err());
    }
}
