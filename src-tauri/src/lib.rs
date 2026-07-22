mod commands;
mod data_dir;
mod db;
#[cfg(target_os = "macos")]
mod macos_app_delegate;
mod models;
mod window_state_guard;

use commands::connection::AppState;
use dbx_core::storage::{maybe_import_user_data_db, DesktopIconTheme, DesktopSettings, Storage};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
#[cfg(target_os = "macos")]
use tauri::menu::Menu;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::PageLoadEvent;
use tauri::RunEvent;
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri_plugin_clipboard_manager::ClipboardExt;
#[cfg(any(windows, target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

const DESKTOP_TRAY_ID: &str = "main-tray";
const APP_CLOSE_REQUESTED_EVENT: &str = "dbx-app-close-requested";
#[cfg(target_os = "macos")]
const APP_MENU_QUIT_ID: &str = "app-menu-quit";
#[cfg(target_os = "macos")]
const APP_MENU_COPY_SUPPORT_INFO_ID: &str = "app-menu-copy-support-info";

pub struct CloseBehaviorState {
    confirmed_exit: AtomicBool,
    frontend_ready: AtomicBool,
}

impl CloseBehaviorState {
    fn new() -> Self {
        Self { confirmed_exit: AtomicBool::new(false), frontend_ready: AtomicBool::new(false) }
    }

    pub(crate) fn allow_next_exit(&self) {
        self.confirmed_exit.store(true, Ordering::Relaxed);
    }

    fn take_confirmed_exit(&self) -> bool {
        self.confirmed_exit.swap(false, Ordering::Relaxed)
    }

    pub(crate) fn set_frontend_ready(&self, ready: bool) {
        self.frontend_ready.store(ready, Ordering::Release);
    }

    fn is_frontend_ready(&self) -> bool {
        self.frontend_ready.load(Ordering::Acquire)
    }
}
#[cfg(target_os = "macos")]
const MACOS_TRAY_ICON: tauri::image::Image<'_> = tauri::include_image!("icons/tray-macos-template.png");
#[cfg(target_os = "macos")]
const ABOUT_APP_ICON: tauri::image::Image<'_> = tauri::include_image!("icons/icon.png");
#[cfg(not(target_os = "macos"))]
const BLACK_APP_ICON: tauri::image::Image<'_> = tauri::include_image!("icons/icon-black.png");
#[cfg(target_os = "macos")]
const MACOS_DEFAULT_APP_ICON: &[u8] = include_bytes!("../icons/icon.icns");
#[cfg(target_os = "macos")]
const MACOS_DARK_APP_ICON: &[u8] = include_bytes!("../icons/icon-macos-dark.icns");

pub(crate) fn apply_debug_log_level(debug_logging_enabled: bool) {
    log::set_max_level(if debug_logging_enabled { log::LevelFilter::Debug } else { log::LevelFilter::Off });
}

fn should_hide_window_on_close(target_os: &str) -> bool {
    matches!(target_os, "macos" | "windows")
}

fn should_setup_desktop_tray(target_os: &str, show_tray_icon: bool, linux_appindicator_available: bool) -> bool {
    show_tray_icon
        && (matches!(target_os, "macos" | "windows") || (target_os == "linux" && linux_appindicator_available))
}

#[cfg(target_os = "linux")]
fn linux_appindicator_available() -> bool {
    const APPINDICATOR_LIBRARIES: &[&str] = &["libayatana-appindicator3.so.1", "libappindicator3.so.1"];

    APPINDICATOR_LIBRARIES.iter().any(|library| {
        // tray-icon loads AppIndicator dynamically and panics when neither ABI is
        // installed, so probe the same libraries before entering that code path.
        unsafe { libloading::Library::new(library).is_ok() }
    })
}

#[cfg(not(target_os = "linux"))]
fn linux_appindicator_available() -> bool {
    false
}

#[cfg(test)]
fn uses_application_level_icon(target_os: &str) -> bool {
    target_os == "macos"
}

fn should_show_main_window_after_setup() -> bool {
    true
}

fn should_confirm_app_exit_request(target_os: &str, exit_code: Option<i32>, confirmed_exit: bool) -> bool {
    should_hide_window_on_close(target_os) && exit_code != Some(tauri::RESTART_EXIT_CODE) && !confirmed_exit
}

fn should_fallback_to_native_quit(target: &str, frontend_ready: bool) -> bool {
    target == "quit" && !frontend_ready
}

fn native_window_decorations_override(target_os: &str) -> Option<bool> {
    match target_os {
        "windows" | "linux" => Some(false),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn build_app_menu<R: tauri::Runtime>(app_handle: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app_handle.package_info();
    let app_name = pkg_info.name.clone();
    let about_metadata = AboutMetadata {
        name: Some(app_name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: Some(commands::support_info::format_support_info_for_native_about()),
        icon: Some(ABOUT_APP_ICON),
        ..Default::default()
    };
    let copy_support_info_item =
        MenuItem::with_id(app_handle, APP_MENU_COPY_SUPPORT_INFO_ID, "Copy Support Info", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app_handle, APP_MENU_QUIT_ID, format!("Quit {app_name}"), true, Some("Cmd+Q"))?;

    Menu::with_items(
        app_handle,
        &[
            &Submenu::with_items(
                app_handle,
                app_name,
                true,
                &[
                    &PredefinedMenuItem::about(app_handle, None, Some(about_metadata))?,
                    &copy_support_info_item,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::services(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::hide(app_handle, None)?,
                    &PredefinedMenuItem::hide_others(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &quit_item,
                ],
            )?,
            &Submenu::with_items(app_handle, "File", true, &[&PredefinedMenuItem::close_window(app_handle, None)?])?,
            &Submenu::with_items(
                app_handle,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app_handle, None)?,
                    &PredefinedMenuItem::redo(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::cut(app_handle, None)?,
                    &PredefinedMenuItem::copy(app_handle, None)?,
                    &PredefinedMenuItem::paste(app_handle, None)?,
                    &PredefinedMenuItem::select_all(app_handle, None)?,
                ],
            )?,
            &Submenu::with_items(app_handle, "View", true, &[&PredefinedMenuItem::fullscreen(app_handle, None)?])?,
            &Submenu::with_items(
                app_handle,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app_handle, None)?,
                    &PredefinedMenuItem::maximize(app_handle, None)?,
                    &PredefinedMenuItem::separator(app_handle)?,
                    &PredefinedMenuItem::close_window(app_handle, None)?,
                ],
            )?,
            &Submenu::with_items(app_handle, "Help", true, &[])?,
        ],
    )
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LinuxNvidiaDriver {
    None,
    Nouveau,
    Proprietary,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Debug, Eq, PartialEq)]
struct LinuxDrmRenderDevice {
    device_file: std::path::PathBuf,
    driver: Option<String>,
    boot_vga: bool,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_nvidia_driver_from_state(
    proprietary_control_exists: bool,
    proprietary_proc_exists: bool,
    render_driver: Option<&str>,
) -> LinuxNvidiaDriver {
    if proprietary_control_exists || proprietary_proc_exists {
        LinuxNvidiaDriver::Proprietary
    } else if render_driver.is_some_and(|driver| driver.eq_ignore_ascii_case("nouveau")) {
        LinuxNvidiaDriver::Nouveau
    } else {
        LinuxNvidiaDriver::None
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_selected_drm_render_device<'a>(
    explicit_device_file: Option<&std::path::Path>,
    devices: &'a [LinuxDrmRenderDevice],
) -> Option<&'a LinuxDrmRenderDevice> {
    if let Some(explicit_device_file) = explicit_device_file {
        // WebKit gives this environment override precedence over EGL/DRM discovery.
        return devices.iter().find(|device| device.device_file.as_path() == explicit_device_file);
    }
    // Before WebKit initializes EGL, boot_vga is the best available default-display signal.
    // The sorted first render node mirrors WebKit's final DRM-device fallback.
    devices.iter().find(|device| device.boot_vga).or_else(|| devices.first())
}

#[cfg(target_os = "linux")]
fn linux_drm_render_devices() -> Vec<LinuxDrmRenderDevice> {
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return Vec::new();
    };
    let mut devices = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let node_name = entry.file_name();
            let node_name = node_name.to_str()?;
            let render_index = node_name.strip_prefix("renderD")?;
            if render_index.is_empty() || !render_index.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let device_path = entry.path().join("device");
            let driver = std::fs::read_link(device_path.join("driver"))
                .ok()
                .and_then(|path| path.file_name().and_then(std::ffi::OsStr::to_str).map(str::to_ascii_lowercase));
            let boot_vga = std::fs::read_to_string(device_path.join("boot_vga")).is_ok_and(|value| value.trim() == "1");
            Some(LinuxDrmRenderDevice {
                device_file: std::path::Path::new("/dev/dri").join(node_name),
                driver,
                boot_vga,
            })
        })
        .collect::<Vec<_>>();
    devices.sort_by(|left, right| left.device_file.cmp(&right.device_file));
    devices
}

#[cfg(target_os = "linux")]
fn linux_nvidia_driver() -> LinuxNvidiaDriver {
    let devices = linux_drm_render_devices();
    let explicit_device_file = std::env::var_os("WEBKIT_WEB_RENDER_DEVICE_FILE")
        .filter(|path| !path.is_empty())
        .map(std::path::PathBuf::from)
        // Resolve stable /dev/dri/by-path links to the renderD* node used by sysfs.
        .map(|path| std::fs::canonicalize(&path).unwrap_or(path));
    let render_driver = linux_selected_drm_render_device(explicit_device_file.as_deref(), &devices)
        .and_then(|device| device.driver.as_deref());
    linux_nvidia_driver_from_state(
        std::path::Path::new("/dev/nvidiactl").exists(),
        std::path::Path::new("/proc/driver/nvidia/version").exists(),
        render_driver,
    )
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_webkit_rendering_workarounds(driver: LinuxNvidiaDriver) -> &'static [(&'static str, &'static str)] {
    match driver {
        LinuxNvidiaDriver::Proprietary => {
            // NVIDIA's proprietary driver needs both DMABuf and explicit-sync
            // workarounds to avoid blank windows and compositor failures.
            &[("WEBKIT_DISABLE_DMABUF_RENDERER", "1"), ("__NV_DISABLE_EXPLICIT_SYNC", "1")]
        }
        LinuxNvidiaDriver::Nouveau => {
            // WebKitGTK's DMABuf renderer can produce a fully black WebView on
            // Nouveau while the DOM remains interactive.
            &[("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        }
        LinuxNvidiaDriver::None => {
            // AMD / Intel and other Mesa drivers keep DMABuf enabled to avoid
            // unnecessary CPU usage and UI lag on Wayland.
            &[]
        }
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_system_gtk3_immodules_cache_path() -> Option<&'static str> {
    [
        "/usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules.cache",
        "/usr/lib/aarch64-linux-gnu/gtk-3.0/3.0.0/immodules.cache",
        "/usr/lib64/gtk-3.0/3.0.0/immodules.cache",
        "/usr/lib/gtk-3.0/3.0.0/immodules.cache",
    ]
    .iter()
    .copied()
    .find(|path| std::path::Path::new(path).is_file())
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_appimage_wayland_backend_override(
    appimage: Option<&std::ffi::OsStr>,
    wayland_display: Option<&std::ffi::OsStr>,
    gdk_backend: Option<&std::ffi::OsStr>,
) -> Option<&'static str> {
    if appimage.is_some() && wayland_display.is_some() && gdk_backend.is_none() {
        // AppImage uses the host GTK/WebKitGTK stack. Prefer XWayland for the
        // affected Wayland/EGL path, but keep Wayland and other compiled
        // backends as fallbacks for systems without XWayland.
        Some("x11,wayland,*")
    } else {
        None
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_appimage_system_gtk_immodules_cache(
    appimage: Option<&std::ffi::OsStr>,
    appdir: Option<&std::ffi::OsStr>,
    gtk_im_module: Option<&std::ffi::OsStr>,
    gtk_im_module_file: Option<&std::ffi::OsStr>,
    system_cache_path: Option<&'static str>,
) -> Option<&'static str> {
    let system_cache_path = system_cache_path?;
    if appimage.is_none() || gtk_im_module.is_none() {
        return None;
    }

    let Some(gtk_im_module_file) = gtk_im_module_file else {
        return Some(system_cache_path);
    };
    let appdir = appdir?;

    if std::path::Path::new(gtk_im_module_file).starts_with(std::path::Path::new(appdir)) {
        Some(system_cache_path)
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn apply_linux_webkit_rendering_workarounds() {
    for (key, value) in linux_webkit_rendering_workarounds(linux_nvidia_driver()) {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
    if let Some(gdk_backend) = linux_appimage_wayland_backend_override(
        std::env::var_os("APPIMAGE").as_deref(),
        std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        std::env::var_os("GDK_BACKEND").as_deref(),
    ) {
        std::env::set_var("GDK_BACKEND", gdk_backend);
    }
    if let Some(gtk_im_module_file) = linux_appimage_system_gtk_immodules_cache(
        std::env::var_os("APPIMAGE").as_deref(),
        std::env::var_os("APPDIR").as_deref(),
        std::env::var_os("GTK_IM_MODULE").as_deref(),
        std::env::var_os("GTK_IM_MODULE_FILE").as_deref(),
        linux_system_gtk3_immodules_cache_path(),
    ) {
        // linuxdeploy-plugin-gtk points GTK_IM_MODULE_FILE at the bundled
        // cache. That hides host IM modules such as fcitx5/ibus, so prefer the
        // host GTK cache when the user has configured a GTK input method.
        std::env::set_var("GTK_IM_MODULE_FILE", gtk_im_module_file);
    }
}

fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn clear_main_webview_focus<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(
            r#"
            (() => {
              const active = document.activeElement;
              if (active instanceof HTMLElement) active.blur();
              if (document.body) {
                if (!document.body.hasAttribute("tabindex")) {
                  document.body.setAttribute("tabindex", "-1");
                }
                document.body.focus({ preventScroll: true });
              }
            })();
            "#,
        );
    }
}

pub(crate) fn hide_main_window_for_close<R: tauri::Runtime>(app: &tauri::AppHandle<R>, window: &tauri::Window<R>) {
    clear_main_webview_focus(app);

    #[cfg(target_os = "macos")]
    {
        if window.is_fullscreen().unwrap_or(false) {
            let app = app.clone();
            let window = window.clone();
            let _ = window.set_fullscreen(false);
            tauri::async_runtime::spawn(async move {
                for _ in 0..40 {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    if !window.is_fullscreen().unwrap_or(false) {
                        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
                        let app_to_hide = app.clone();
                        let window_to_hide = window.clone();
                        let _ = app.run_on_main_thread(move || {
                            let _ = window_to_hide.hide();
                            let _ = app_to_hide.hide();
                        });
                        return;
                    }
                }
                let app_to_hide = app.clone();
                let window_to_hide = window.clone();
                let _ = app.run_on_main_thread(move || {
                    let _ = window_to_hide.hide();
                    let _ = app_to_hide.hide();
                });
            });
            return;
        }
    }

    let _ = window.hide();
}

pub(crate) fn request_app_close<R: tauri::Runtime>(app: &tauri::AppHandle<R>, target: &str) {
    let frontend_ready = app.try_state::<CloseBehaviorState>().is_some_and(|state| state.is_frontend_ready());
    if should_fallback_to_native_quit(target, frontend_ready) {
        // A missing WebView2 runtime can prevent the frontend listener from ever
        // loading. Only the explicit tray Quit fallback bypasses the prompt.
        if let Some(state) = app.try_state::<CloseBehaviorState>() {
            state.allow_next_exit();
        }
        app.exit(0);
        return;
    }
    show_main_window(app);
    let _ = app.emit(APP_CLOSE_REQUESTED_EVENT, target);
}

fn open_connection_deep_links(app: &tauri::AppHandle, links: Vec<String>) {
    if links.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<commands::deep_link::DeepLinkOpenState>() {
        state.push(links.clone());
    }
    let _ = app.emit("dbx-open-connection-links", links);
    show_main_window(app);
}

#[cfg_attr(not(any(target_os = "macos", target_os = "windows")), allow(dead_code))]
fn setup_desktop_tray<R: tauri::Runtime, M: Manager<R>>(
    manager: &M,
    _icon_theme: DesktopIconTheme,
) -> tauri::Result<()> {
    let menu = MenuBuilder::new(manager).text("show", "Show DBX").separator().text("quit", "Quit DBX").build()?;
    let mut tray =
        TrayIconBuilder::<R>::with_id(DESKTOP_TRAY_ID).tooltip("DBX").menu(&menu).show_menu_on_left_click(false);
    #[cfg(target_os = "macos")]
    {
        tray = tray.icon(MACOS_TRAY_ICON).icon_as_template(true);
    }
    #[cfg(target_os = "windows")]
    {
        let icon = match _icon_theme {
            DesktopIconTheme::Default => manager.app_handle().default_window_icon().cloned(),
            DesktopIconTheme::Black => Some(BLACK_APP_ICON),
        };
        if let Some(icon) = icon {
            tray = tray.icon(icon);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(icon) = manager.app_handle().default_window_icon().cloned() {
            tray = tray.icon(icon);
        }
    }

    tray.on_menu_event(|app, event| {
        if event.id() == "show" {
            show_main_window(app);
        } else if event.id() == "quit" {
            request_app_close(app, "quit");
        }
    })
    .on_tray_icon_event(|tray, event| match event {
        TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
        | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => show_main_window(tray.app_handle()),
        _ => {}
    })
    .build(manager)?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_macos_app_icon_theme(app: &tauri::AppHandle, icon_theme: DesktopIconTheme) -> tauri::Result<()> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let icon_bytes = match icon_theme {
        DesktopIconTheme::Default => MACOS_DEFAULT_APP_ICON,
        DesktopIconTheme::Black => MACOS_DARK_APP_ICON,
    };
    app.run_on_main_thread(move || {
        // macOS has no per-window icon. Update NSApplication so the Dock and
        // app switcher reflect the selected theme immediately.
        let marker = unsafe { MainThreadMarker::new_unchecked() };
        let application = NSApplication::sharedApplication(marker);
        let data = NSData::with_bytes(icon_bytes);
        if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
            unsafe { application.setApplicationIconImage(Some(&icon)) };
        } else {
            log::warn!("Failed to decode the selected macOS application icon");
        }
    })
}

fn apply_desktop_icon_theme(app: &tauri::AppHandle, icon_theme: DesktopIconTheme) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        apply_macos_app_icon_theme(app, icon_theme)
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        match icon_theme {
            DesktopIconTheme::Default => {
                if let Some(icon) = app.default_window_icon().cloned() {
                    window.set_icon(icon)?;
                }
            }
            DesktopIconTheme::Black => window.set_icon(BLACK_APP_ICON)?,
        }
    }
    #[cfg(not(target_os = "macos"))]
    Ok(())
}

fn apply_desktop_tray_icon_theme(app: &tauri::AppHandle, _icon_theme: DesktopIconTheme) -> tauri::Result<()> {
    if let Some(_tray) = app.tray_by_id(DESKTOP_TRAY_ID) {
        #[cfg(target_os = "windows")]
        {
            let icon = match _icon_theme {
                DesktopIconTheme::Default => app.default_window_icon().cloned(),
                DesktopIconTheme::Black => Some(BLACK_APP_ICON),
            };
            _tray.set_icon(icon)?;
        }
        #[cfg(target_os = "linux")]
        {
            let icon = match _icon_theme {
                DesktopIconTheme::Default => app.default_window_icon().cloned(),
                DesktopIconTheme::Black => Some(BLACK_APP_ICON),
            };
            _tray.set_icon(icon)?;
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = (_tray, _icon_theme);
        }
    }
    Ok(())
}

pub(crate) fn apply_desktop_settings(app: &tauri::AppHandle, desktop_settings: &DesktopSettings) -> tauri::Result<()> {
    apply_debug_log_level(desktop_settings.debug_logging_enabled);
    apply_desktop_icon_theme(app, desktop_settings.icon_theme)?;
    if should_setup_desktop_tray(std::env::consts::OS, desktop_settings.show_tray_icon, linux_appindicator_available())
    {
        if let Some(tray) = app.tray_by_id(DESKTOP_TRAY_ID) {
            tray.set_visible(desktop_settings.show_tray_icon)?;
            apply_desktop_tray_icon_theme(app, desktop_settings.icon_theme)?;
        } else if desktop_settings.show_tray_icon {
            setup_desktop_tray(app, desktop_settings.icon_theme)?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::{
        linux_appimage_system_gtk_immodules_cache, linux_appimage_wayland_backend_override,
        linux_nvidia_driver_from_state, linux_selected_drm_render_device, linux_webkit_rendering_workarounds,
        native_window_decorations_override, should_confirm_app_exit_request, should_fallback_to_native_quit,
        should_hide_window_on_close, should_setup_desktop_tray, should_show_main_window_after_setup,
        uses_application_level_icon, LinuxDrmRenderDevice, LinuxNvidiaDriver,
    };
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    const TEST_GTK3_IMMODULES_CACHE: &str = "/usr/lib/test/gtk-3.0/3.0.0/immodules.cache";

    #[test]
    fn hides_window_on_close_for_windows_and_macos() {
        assert!(should_hide_window_on_close("windows"));
        assert!(should_hide_window_on_close("macos"));
    }

    #[test]
    fn does_not_hide_window_on_close_for_other_platforms() {
        assert!(!should_hide_window_on_close("linux"));
    }

    #[test]
    fn sets_up_desktop_tray_for_windows_macos_and_linux() {
        assert!(should_setup_desktop_tray("windows", true, false));
        assert!(should_setup_desktop_tray("macos", true, false));
        assert!(should_setup_desktop_tray("linux", true, true));
        assert!(!should_setup_desktop_tray("linux", true, false));
        assert!(!should_setup_desktop_tray("windows", false, true));
        assert!(!should_setup_desktop_tray("macos", false, true));
        assert!(!should_setup_desktop_tray("linux", false, true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_tray_icon_remains_a_system_template() {
        // Menu bar template images are intentionally independent from the app
        // icon theme so macOS can recolor them for light and dark menu bars.
        assert_eq!(super::MACOS_TRAY_ICON.width(), 36);
        assert_eq!(super::MACOS_TRAY_ICON.height(), 36);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_icon_themes_use_packaged_dock_assets() {
        use objc2::AllocAnyThread;
        use objc2_app_kit::NSImage;
        use objc2_foundation::NSData;

        assert!(super::MACOS_DEFAULT_APP_ICON.starts_with(b"icns"));
        assert!(super::MACOS_DARK_APP_ICON.starts_with(b"icns"));
        for bytes in [super::MACOS_DEFAULT_APP_ICON, super::MACOS_DARK_APP_ICON] {
            let data = NSData::with_bytes(bytes);
            assert!(NSImage::initWithData(NSImage::alloc(), &data).is_some());
        }
    }

    #[test]
    fn macos_icon_theme_targets_the_application_instead_of_a_window() {
        assert!(uses_application_level_icon("macos"));
        assert!(!uses_application_level_icon("windows"));
        assert!(!uses_application_level_icon("linux"));
    }

    #[test]
    fn shows_main_window_after_regular_startup_setup() {
        assert!(should_show_main_window_after_setup());
    }

    #[test]
    fn only_user_requested_app_exit_needs_frontend_confirmation() {
        assert!(should_confirm_app_exit_request("windows", None, false));
        assert!(should_confirm_app_exit_request("macos", Some(0), false));
        assert!(!should_confirm_app_exit_request("windows", Some(0), true));
        assert!(!should_confirm_app_exit_request("windows", Some(tauri::RESTART_EXIT_CODE), false));
        assert!(!should_confirm_app_exit_request("linux", Some(0), false));
    }

    #[test]
    fn only_quit_uses_native_fallback_before_frontend_ready() {
        assert!(should_fallback_to_native_quit("quit", false));
        assert!(!should_fallback_to_native_quit("quit", true));
        assert!(!should_fallback_to_native_quit("settings", false));
    }

    #[test]
    fn overrides_native_window_decorations_for_desktop_platforms() {
        assert_eq!(native_window_decorations_override("windows"), Some(false));
        assert_eq!(native_window_decorations_override("linux"), Some(false));
        assert_eq!(native_window_decorations_override("macos"), None);
    }

    #[test]
    fn classifies_linux_nvidia_driver_from_selected_renderer() {
        assert_eq!(linux_nvidia_driver_from_state(true, false, None), LinuxNvidiaDriver::Proprietary);
        assert_eq!(linux_nvidia_driver_from_state(false, true, None), LinuxNvidiaDriver::Proprietary);
        assert_eq!(linux_nvidia_driver_from_state(true, false, Some("nouveau")), LinuxNvidiaDriver::Proprietary);
        assert_eq!(linux_nvidia_driver_from_state(false, false, Some("nouveau")), LinuxNvidiaDriver::Nouveau);
        assert_eq!(linux_nvidia_driver_from_state(false, false, Some("i915")), LinuxNvidiaDriver::None);
        assert_eq!(linux_nvidia_driver_from_state(false, false, Some("amdgpu")), LinuxNvidiaDriver::None);
        assert_eq!(linux_nvidia_driver_from_state(false, false, None), LinuxNvidiaDriver::None);
    }

    fn drm_render_device(path: &str, driver: &str, boot_vga: bool) -> LinuxDrmRenderDevice {
        LinuxDrmRenderDevice { device_file: PathBuf::from(path), driver: Some(driver.to_string()), boot_vga }
    }

    #[test]
    fn keeps_linux_dmabuf_when_nouveau_is_loaded_but_not_the_default_renderer() {
        let devices = [
            drm_render_device("/dev/dri/renderD128", "i915", true),
            drm_render_device("/dev/dri/renderD129", "nouveau", false),
        ];

        let selected = linux_selected_drm_render_device(None, &devices).unwrap();
        assert_eq!(selected.driver.as_deref(), Some("i915"));
        assert_eq!(linux_nvidia_driver_from_state(false, false, selected.driver.as_deref()), LinuxNvidiaDriver::None);
    }

    #[test]
    fn honors_explicit_webkit_linux_render_device_on_hybrid_gpus() {
        let devices = [
            drm_render_device("/dev/dri/renderD128", "i915", true),
            drm_render_device("/dev/dri/renderD129", "nouveau", false),
        ];

        let selected = linux_selected_drm_render_device(Some(Path::new("/dev/dri/renderD129")), &devices).unwrap();
        assert_eq!(selected.driver.as_deref(), Some("nouveau"));
        assert_eq!(
            linux_nvidia_driver_from_state(false, false, selected.driver.as_deref()),
            LinuxNvidiaDriver::Nouveau
        );

        let devices = [
            drm_render_device("/dev/dri/renderD128", "i915", false),
            drm_render_device("/dev/dri/renderD129", "nouveau", true),
        ];
        let selected = linux_selected_drm_render_device(Some(Path::new("/dev/dri/renderD128")), &devices).unwrap();
        assert_eq!(selected.driver.as_deref(), Some("i915"));
        assert_eq!(linux_nvidia_driver_from_state(false, false, selected.driver.as_deref()), LinuxNvidiaDriver::None);
    }

    #[test]
    fn uses_nouveau_workaround_for_the_default_linux_renderer() {
        let devices = [
            drm_render_device("/dev/dri/renderD128", "amdgpu", false),
            drm_render_device("/dev/dri/renderD129", "nouveau", true),
        ];

        let selected = linux_selected_drm_render_device(None, &devices).unwrap();
        assert_eq!(selected.driver.as_deref(), Some("nouveau"));
        assert_eq!(
            linux_nvidia_driver_from_state(false, false, selected.driver.as_deref()),
            LinuxNvidiaDriver::Nouveau
        );
    }

    #[test]
    fn applies_driver_specific_linux_webkit_rendering_workarounds() {
        assert_eq!(
            linux_webkit_rendering_workarounds(LinuxNvidiaDriver::Proprietary),
            &[("WEBKIT_DISABLE_DMABUF_RENDERER", "1"), ("__NV_DISABLE_EXPLICIT_SYNC", "1")]
        );
        assert_eq!(
            linux_webkit_rendering_workarounds(LinuxNvidiaDriver::Nouveau),
            &[("WEBKIT_DISABLE_DMABUF_RENDERER", "1")]
        );
        assert_eq!(linux_webkit_rendering_workarounds(LinuxNvidiaDriver::None), &[]);
    }

    #[test]
    fn prefers_x11_for_appimage_wayland_when_backend_is_not_user_configured() {
        assert_eq!(
            linux_appimage_wayland_backend_override(
                Some(OsStr::new("/tmp/DBX.AppImage")),
                Some(OsStr::new("wayland-0")),
                None
            ),
            Some("x11,wayland,*")
        );
        assert_eq!(
            linux_appimage_wayland_backend_override(
                Some(OsStr::new("/tmp/DBX.AppImage")),
                Some(OsStr::new("wayland-0")),
                Some(OsStr::new("wayland"))
            ),
            None
        );
        assert_eq!(linux_appimage_wayland_backend_override(Some(OsStr::new("/tmp/DBX.AppImage")), None, None), None);
        assert_eq!(linux_appimage_wayland_backend_override(None, Some(OsStr::new("wayland-0")), None), None);
    }

    #[test]
    fn prefers_system_gtk_immodules_cache_for_appimage_input_methods() {
        assert_eq!(
            linux_appimage_system_gtk_immodules_cache(
                Some(OsStr::new("/tmp/DBX.AppImage")),
                Some(OsStr::new("/tmp/.mount_DBX123")),
                Some(OsStr::new("fcitx5")),
                Some(OsStr::new("/tmp/.mount_DBX123/usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules.cache")),
                Some(TEST_GTK3_IMMODULES_CACHE),
            ),
            Some(TEST_GTK3_IMMODULES_CACHE)
        );
        assert_eq!(
            linux_appimage_system_gtk_immodules_cache(
                Some(OsStr::new("/tmp/DBX.AppImage")),
                Some(OsStr::new("/tmp/.mount_DBX123")),
                Some(OsStr::new("ibus")),
                None,
                Some(TEST_GTK3_IMMODULES_CACHE),
            ),
            Some(TEST_GTK3_IMMODULES_CACHE)
        );
    }

    #[test]
    fn preserves_external_gtk_immodules_cache_overrides() {
        assert_eq!(
            linux_appimage_system_gtk_immodules_cache(
                Some(OsStr::new("/tmp/DBX.AppImage")),
                Some(OsStr::new("/tmp/.mount_DBX123")),
                Some(OsStr::new("fcitx5")),
                Some(OsStr::new("/opt/custom/immodules.cache")),
                Some(TEST_GTK3_IMMODULES_CACHE),
            ),
            None
        );
    }

    #[test]
    fn skips_system_gtk_immodules_cache_without_required_context() {
        assert_eq!(
            linux_appimage_system_gtk_immodules_cache(
                None,
                Some(OsStr::new("/tmp/.mount_DBX123")),
                Some(OsStr::new("fcitx5")),
                Some(OsStr::new("/tmp/.mount_DBX123/usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules.cache")),
                Some(TEST_GTK3_IMMODULES_CACHE),
            ),
            None
        );
        assert_eq!(
            linux_appimage_system_gtk_immodules_cache(
                Some(OsStr::new("/tmp/DBX.AppImage")),
                Some(OsStr::new("/tmp/.mount_DBX123")),
                None,
                Some(OsStr::new("/tmp/.mount_DBX123/usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules.cache")),
                Some(TEST_GTK3_IMMODULES_CACHE),
            ),
            None
        );
        assert_eq!(
            linux_appimage_system_gtk_immodules_cache(
                Some(OsStr::new("/tmp/DBX.AppImage")),
                Some(OsStr::new("/tmp/.mount_DBX123")),
                Some(OsStr::new("fcitx5")),
                Some(OsStr::new("/tmp/.mount_DBX123/usr/lib/x86_64-linux-gnu/gtk-3.0/3.0.0/immodules.cache")),
                None,
            ),
            None
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    rustls::crypto::aws_lc_rs::default_provider().install_default().expect("Failed to install rustls crypto provider");
    #[cfg(target_os = "linux")]
    apply_linux_webkit_rendering_workarounds();

    let startup_begin = Instant::now();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let links = commands::deep_link::connection_deep_links_from_args(args.clone());
            open_connection_deep_links(app, links);

            let paths = commands::external_sql::sql_file_paths_from_args(args.clone(), std::path::Path::new(&cwd));
            if !paths.is_empty() {
                if let Some(state) = app.try_state::<commands::external_sql::ExternalSqlOpenState>() {
                    state.push(paths.clone());
                }
                let _ = app.emit("dbx-open-sql-files", paths);
            }

            let db_paths = commands::external_db::db_file_paths_from_args(args, std::path::Path::new(&cwd));
            if !db_paths.is_empty() {
                if let Some(state) = app.try_state::<commands::external_db::ExternalDbOpenState>() {
                    state.push(db_paths.clone());
                }
                let _ = app.emit("dbx-open-db-files", db_paths);
            }
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build());

    // macOS app menu (Cmd+Q / Dock Quit). Skip on Linux/Windows so an empty menu bar
    // is not installed where there was none before.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_app_menu).on_menu_event(|app, event| {
        if event.id() == APP_MENU_QUIT_ID {
            request_app_close(app, "quit");
        } else if event.id() == APP_MENU_COPY_SUPPORT_INFO_ID {
            if let Err(err) = app.clipboard().write_text(commands::support_info::format_support_info_for_clipboard()) {
                log::warn!("Failed to copy support info from app menu: {err}");
            }
        }
    });

    builder
        .manage(CloseBehaviorState::new())
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Started {
                if let Some(state) = webview.app_handle().try_state::<CloseBehaviorState>() {
                    state.set_frontend_ready(false);
                }
            }
        })
        .setup(move |app| {
            let setup_start = Instant::now();
            eprintln!("[STARTUP] plugins registered in {:?}", startup_begin.elapsed());

            let default_data_dir =
                app.path().app_data_dir().map_err(|e| e.to_string()).expect("Failed to resolve app data dir");
            let data_dir_resolution = data_dir::resolve_data_dir_with_mode(default_data_dir);
            let data_dir = data_dir_resolution.data_dir.clone();
            std::fs::create_dir_all(&data_dir).expect("Failed to create data dir");
            let alternative_data_dir = data_dir::alternative_data_dir(&data_dir_resolution);
            match maybe_import_user_data_db(&data_dir, alternative_data_dir.as_deref()) {
                Ok(result) => eprintln!("[STARTUP] data db fallback import: {result:?}"),
                Err(err) => eprintln!("[STARTUP] data db fallback import failed: {err}"),
            }
            let db_path = data_dir.join("dbx.db");

            let t = Instant::now();
            let storage = tauri::async_runtime::block_on(async {
                let s = Storage::open(&db_path).await.expect("Failed to open storage");
                eprintln!("[STARTUP]   Storage::open in {:?}", t.elapsed());
                let t2 = Instant::now();
                s.migrate_from_json(&data_dir).await.expect("Failed to migrate JSON data");
                eprintln!("[STARTUP]   migrate_from_json in {:?}", t2.elapsed());
                s
            });
            let desktop_settings = tauri::async_runtime::block_on(storage.load_desktop_settings()).unwrap_or_default();
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                    .format(|out, message, record| {
                        out.finish(format_args!(
                            "[{}][{}][{}] {}",
                            chrono::Local::now().format("%Y-%m-%d][%H:%M:%S%.3f"),
                            record.level(),
                            record.target(),
                            message
                        ));
                    })
                    .level(log::LevelFilter::Debug)
                    .build(),
            )?;
            apply_debug_log_level(desktop_settings.debug_logging_enabled);
            eprintln!("[STARTUP] storage ready in {:?}", t.elapsed());

            let default_agent_dir = data_dir_resolution.uses_custom_data_dir().then(|| data_dir.join("agents"));
            let (plugin_dir, agent_dir) = commands::app_settings::resolve_driver_store_dirs_from_settings(
                &desktop_settings,
                &data_dir,
                default_agent_dir,
            );

            let state = if let Some(agent_dir) = agent_dir {
                AppState::new_with_plugin_and_agent_dir_and_app_version(
                    storage,
                    plugin_dir,
                    agent_dir,
                    env!("CARGO_PKG_VERSION"),
                )
            } else {
                AppState::new_with_plugin_dir_and_app_version(storage, plugin_dir, env!("CARGO_PKG_VERSION"))
            };
            state.set_duckdb_worker_process_isolation_enabled(desktop_settings.duckdb_worker_process_isolation);
            state.set_duckdb_worker_max_processes(desktop_settings.duckdb_worker_max_processes);
            let state = Arc::new(state);
            app.manage(state.clone());
            commands::redis_pubsub_server::start_pubsub_server(state.clone());
            app.manage(commands::saved_sql::SavedSqlStorageState { data_dir: data_dir.clone() });
            app.manage(commands::external_sql::ExternalSqlOpenState::default());
            app.manage(commands::external_db::ExternalDbOpenState::default());
            app.manage(commands::deep_link::DeepLinkOpenState::default());
            app.manage(commands::update::PendingUpdateState::default());
            #[cfg(target_os = "macos")]
            macos_app_delegate::install_dock_quit_handler(app.handle());
            let startup_links = commands::deep_link::connection_deep_links_from_args(std::env::args().skip(1));
            open_connection_deep_links(app.handle(), startup_links);

            let app_handle = app.handle().clone();
            commands::mcp_bridge::start(app_handle, state, data_dir);
            eprintln!("[STARTUP] setup complete in {:?} (total {:?})", setup_start.elapsed(), startup_begin.elapsed());

            if let Some(decorations) = native_window_decorations_override(std::env::consts::OS) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_decorations(decorations);
                }
            }
            if should_setup_desktop_tray(
                std::env::consts::OS,
                desktop_settings.show_tray_icon,
                linux_appindicator_available(),
            ) {
                setup_desktop_tray(app, desktop_settings.icon_theme)?;
            }
            apply_desktop_icon_theme(app.handle(), desktop_settings.icon_theme)?;
            window_state_guard::enforce_main_window_bounds(app.handle());
            if should_show_main_window_after_setup() {
                show_main_window(app.handle());
            }
            #[cfg(any(windows, target_os = "linux"))]
            let _ = app.deep_link().register_all();

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !should_hide_window_on_close(std::env::consts::OS) {
                    return;
                }
                let app = window.app_handle();
                if app.try_state::<CloseBehaviorState>().is_none() {
                    api.prevent_close();
                    hide_main_window_for_close(app, window);
                    return;
                }
                api.prevent_close();
                request_app_close(app, "settings");
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::ai::ai_complete,
            commands::ai::ai_stream,
            commands::ai::ai_agent_stream,
            commands::ai::ai_cancel_stream,
            commands::ai::ai_test_connection,
            commands::ai::ai_list_models,
            commands::ai::save_ai_config,
            commands::ai::load_ai_config,
            commands::ai::save_ai_provider_config,
            commands::ai::load_ai_provider_configs,
            commands::ai::save_ai_conversation,
            commands::ai::load_ai_conversations,
            commands::ai::delete_ai_conversation,
            commands::ai_multi_config::save_ai_configs,
            commands::ai_multi_config::load_ai_configs,
            commands::ai_multi_config::set_default_ai_config,
            commands::ai_multi_config::save_ai_config_item,
            commands::ai_multi_config::delete_ai_config,
            commands::prompt_template::load_prompt_templates,
            commands::prompt_template::save_prompt_template,
            commands::prompt_template::delete_prompt_template,
            commands::prompt_template::get_ai_global_custom_instructions,
            commands::prompt_template::set_ai_global_custom_instructions,
            commands::app_settings::load_desktop_settings,
            commands::app_settings::save_desktop_settings,
            commands::app_settings::complete_app_close,
            commands::app_settings::mark_frontend_ready,
            commands::app_settings::request_app_close_from_window_controls,
            commands::window_controls::set_macos_traffic_light_position,
            commands::app_settings::set_driver_store_dir,
            commands::app_settings::set_plugin_store_dir,
            commands::app_settings::set_agent_store_dir,
            commands::app_settings::get_driver_store_path,
            commands::app_settings::load_pinned_tree_node_ids,
            commands::app_settings::save_pinned_tree_node_ids,
            commands::app_settings::load_mcp_global_policy,
            commands::app_settings::save_mcp_global_policy,
            commands::app_settings::load_editor_settings,
            commands::app_settings::save_editor_settings,
            commands::app_settings::load_open_tabs_state,
            commands::app_settings::save_open_tabs_state,
            commands::app_settings::load_saved_sql_editor_positions,
            commands::app_settings::save_saved_sql_editor_positions,
            commands::app_settings::load_native_debug_logs,
            commands::support_info::get_app_support_info,
            commands::cloud_sync::webdav_sync_test,
            commands::cloud_sync::webdav_password_status,
            commands::cloud_sync::save_webdav_saved_password,
            commands::cloud_sync::forget_webdav_saved_password,
            commands::cloud_sync::webdav_sync_secrets_status,
            commands::cloud_sync::save_webdav_sync_secrets_preference,
            commands::cloud_sync::forget_webdav_sync_secrets_passphrase,
            commands::cloud_sync::webdav_sync_upload,
            commands::cloud_sync::webdav_sync_download,
            commands::cloud_sync::snippet_sync_test,
            commands::cloud_sync::snippet_token_status,
            commands::cloud_sync::save_snippet_saved_token,
            commands::cloud_sync::forget_snippet_saved_token,
            commands::cloud_sync::snippet_sync_upload,
            commands::cloud_sync::snippet_sync_download,
            commands::connection::test_connection,
            commands::connection::test_connection_with_info,
            commands::connection::connect_db,
            commands::connection::connection_final_proxy_port,
            commands::connection::disconnect_db,
            commands::connection::close_database_connection,
            commands::connection::refresh_connections,
            commands::connection::check_connection_health,
            commands::connection::connection_identifier_quote,
            commands::connection::connection_database_info,
            commands::connection::save_connection_database_info,
            commands::connection::save_connections,
            commands::connection::load_connections,
            commands::connection::save_sidebar_layout,
            commands::connection::load_sidebar_layout,
            commands::plugins::list_plugins,
            commands::plugins::list_jdbc_drivers,
            commands::plugins::list_jdbc_maven_bundles,
            commands::plugins::list_jdbc_local_bundles,
            commands::plugins::import_jdbc_drivers,
            commands::plugins::install_jdbc_driver_from_maven,
            commands::plugins::install_prestosql_jdbc_driver,
            commands::plugins::delete_jdbc_driver,
            commands::plugins::delete_jdbc_maven_bundle,
            commands::plugins::delete_jdbc_local_bundle,
            commands::plugins::jdbc_plugin_status,
            commands::plugins::install_jdbc_plugin,
            commands::plugins::install_jdbc_plugin_local,
            commands::plugins::uninstall_jdbc_plugin,
            commands::schema::list_databases,
            commands::schema::list_database_storage,
            commands::schema::list_doris_catalogs,
            commands::schema::list_doris_catalog_databases,
            commands::schema::list_sqlserver_linked_servers,
            commands::schema::list_sqlserver_linked_server_catalogs,
            commands::schema::list_sqlserver_linked_server_schemas,
            commands::schema::list_sqlserver_linked_server_tables,
            commands::schema::list_tables,
            commands::schema::get_table_comment,
            commands::schema::list_objects,
            commands::schema::list_object_statistics,
            commands::schema::list_completion_objects,
            commands::schema::completion_assistant_search,
            commands::schema::get_object_source,
            commands::schema::list_schemas,
            commands::schema::list_schema_infos,
            commands::schema::list_data_types,
            commands::schema::get_columns,
            commands::schema::get_sqlserver_column_metadata,
            commands::schema::list_indexes,
            commands::schema::list_foreign_keys,
            commands::schema::list_triggers,
            commands::schema::get_table_ddl,
            commands::schema::list_functions,
            commands::schema::list_sequences,
            commands::schema::list_rules,
            commands::schema::list_owners,
            commands::schema::list_extensions,
            commands::schema::list_available_extensions,
            commands::schema_diff::prepare_schema_diff,
            commands::schema_diff::generate_schema_sync_sql,
            commands::schema_cache::save_schema_cache,
            commands::schema_cache::load_schema_cache,
            commands::schema_cache::delete_schema_cache_prefix,
            commands::tab_runtime_cache::save_tab_runtime_cache,
            commands::tab_runtime_cache::load_tab_runtime_cache,
            commands::tab_runtime_cache::list_tab_runtime_cache_metadata,
            commands::tab_runtime_cache::prune_tab_runtime_cache,
            commands::tab_runtime_cache::delete_tab_runtime_cache_owner,
            commands::tab_runtime_cache::delete_tab_runtime_cache,
            commands::query::execute_query,
            commands::query::execute_multi,
            commands::query::cancel_query,
            commands::query::close_query_session,
            commands::query::close_client_connection_session,
            commands::query::execute_batch,
            commands::query::execute_script,
            commands::query::execute_in_transaction,
            commands::query::begin_manual_transaction,
            commands::query::execute_in_manual_transaction,
            commands::query::commit_manual_transaction,
            commands::query::rollback_manual_transaction,
            commands::query::analyze_sql_references,
            commands::query::find_statement_at_cursor,
            commands::query::prepare_query_pagination_execution_plan,
            commands::query::build_sorted_query_sql,
            commands::query::build_explain_sql,
            commands::query::get_explain_info,
            commands::query::build_create_user_sql,
            commands::query::build_dropped_file_preview_sql,
            commands::query::build_table_select_sql,
            commands::query::build_database_search_sql,
            commands::query::build_search_result_where,
            commands::query::build_rename_object_sql,
            commands::query::build_create_database_sql,
            #[cfg(feature = "duckdb-bundled")]
            commands::query::build_duckdb_attach_database_sql,
            commands::query::build_sqlite_attach_database_sql,
            commands::query::build_drop_object_sql,
            commands::query::build_drop_table_sql,
            commands::query::build_drop_table_child_object_sql,
            commands::query::build_empty_table_sql,
            commands::query::build_truncate_table_sql,
            commands::query::build_drop_database_sql,
            commands::query::build_create_schema_sql,
            commands::query::build_update_database_properties_sql,
            commands::query::build_drop_schema_sql,
            commands::query::build_duplicate_table_structure_sql,
            commands::query::build_copy_table_data_sql,
            commands::query::build_executable_object_source_statements,
            commands::query::build_executable_object_source_sql,
            commands::query::build_editable_object_source,
            commands::query::build_routine_rename_object_source_statements,
            commands::query::build_view_ddl_sql,
            commands::query::build_table_structure_change_sql,
            commands::query::preview_sqlite_table_structure_change,
            commands::query::apply_sqlite_table_structure_change,
            commands::query::build_create_table_sql,
            commands::query::build_single_column_alter_sql,
            commands::query::analyze_editable_query_editability,
            commands::query::prepare_data_grid_save,
            commands::query::build_data_grid_copy_update_statements,
            commands::query::build_data_grid_copy_insert_statement,
            commands::query::build_data_grid_context_filter_condition,
            commands::query::build_data_grid_column_value_filter_condition,
            commands::query::build_data_grid_column_values_filter_condition,
            commands::query::build_data_grid_column_distinct_values_sql,
            commands::query::build_data_grid_count_sql,
            commands::query::build_hive_table_properties_sql,
            commands::query::build_export_insert_statements,
            commands::query::build_export_sql_insert,
            commands::query::build_database_sql_export,
            commands::data_compare::prepare_data_compare,
            commands::data_compare::prepare_data_compare_from_tables,
            commands::data_compare::prepare_data_compare_missing_target,
            commands::data_compare::build_data_compare_sync_plan,
            commands::sql_file::preview_sql_file,
            commands::sql_file::execute_sql_file,
            commands::sql_file::cancel_sql_file_execution,
            commands::external_sql::pending_open_sql_files,
            commands::external_sql::read_external_sql_file,
            commands::external_sql::write_external_sql_file,
            commands::external_sql::save_external_sql_file,
            commands::list_sql_files::list_sql_files_in_folder,
            commands::external_db::pending_open_db_files,
            commands::keychain::read_keychain_password,
            commands::keychain::read_keychain_passwords,
            commands::deep_link::pending_open_connection_links,
            commands::table_import::preview_table_import_file,
            commands::table_import::import_table_file,
            commands::table_import::cancel_table_import,
            commands::redis_cmd::redis_list_databases,
            commands::redis_cmd::redis_scan_keys,
            commands::redis_cmd::redis_scan_keys_batch,
            commands::redis_cmd::redis_scan_values,
            commands::redis_cmd::redis_get_value,
            commands::redis_cmd::redis_set_string,
            commands::redis_cmd::redis_delete_key,
            commands::redis_cmd::redis_hash_set,
            commands::redis_cmd::redis_hash_del,
            commands::redis_cmd::redis_list_push,
            commands::redis_cmd::redis_list_set,
            commands::redis_cmd::redis_list_remove,
            commands::redis_cmd::redis_set_add,
            commands::redis_cmd::redis_set_remove,
            commands::redis_cmd::redis_zadd,
            commands::redis_cmd::redis_zrem,
            commands::redis_cmd::redis_stream_add,
            commands::redis_cmd::redis_json_set,
            commands::redis_cmd::redis_check_json_module,
            commands::redis_cmd::redis_set_ttl,
            commands::redis_cmd::redis_delete_keys,
            commands::redis_cmd::redis_flush_db,
            commands::redis_cmd::redis_execute_command,
            commands::redis_cmd::redis_load_more,
            commands::redis_cmd::redis_pubsub_publish,
            commands::redis_pubsub_server::redis_pubsub_server_port,
            commands::redis_cmd::redis_slowlog_get,
            commands::redis_cmd::redis_cluster_master_nodes,
            commands::etcd_cmd::etcd_list_prefix,
            commands::etcd_cmd::etcd_get,
            commands::etcd_cmd::etcd_put,
            commands::etcd_cmd::etcd_delete,
            commands::zookeeper_cmd::zookeeper_list_prefix,
            commands::zookeeper_cmd::zookeeper_get,
            commands::zookeeper_cmd::zookeeper_put,
            commands::zookeeper_cmd::zookeeper_delete,
            commands::nacos_cmd::nacos_test_connection,
            commands::nacos_cmd::nacos_list_namespaces,
            commands::nacos_cmd::nacos_create_namespace,
            commands::nacos_cmd::nacos_update_namespace,
            commands::nacos_cmd::nacos_list_configs,
            commands::nacos_cmd::nacos_get_config,
            commands::nacos_cmd::nacos_publish_config,
            commands::nacos_cmd::nacos_delete_config,
            commands::nacos_cmd::nacos_list_config_history,
            commands::nacos_cmd::nacos_get_config_history,
            commands::nacos_cmd::nacos_rollback_config,
            commands::nacos_cmd::nacos_list_services,
            commands::nacos_cmd::nacos_list_instances,
            commands::nacos_cmd::nacos_update_instance,
            commands::nacos_cmd::nacos_raw_request,
            commands::saved_sql::load_saved_sql_library,
            commands::saved_sql::load_saved_sql_file,
            commands::saved_sql::save_saved_sql_folder,
            commands::saved_sql::delete_saved_sql_folder,
            commands::saved_sql::save_saved_sql_file,
            commands::saved_sql::delete_saved_sql_file,
            commands::saved_sql::saved_sql_storage_dir,
            commands::saved_sql::open_saved_sql_storage_dir,
            commands::saved_sql::sync_saved_sql_directory,
            commands::fs_open::reveal_path_in_file_manager,
            commands::fs_open::is_sqlite_database_file,
            commands::fs_open::delete_database_backup_files,
            commands::sqlite_backup::backup_sqlite_database,
            commands::mongo_cmd::mongo_list_databases,
            commands::mongo_cmd::mongo_list_collections,
            commands::mongo_cmd::vector_collection_detail,
            commands::mongo_cmd::mongo_create_database,
            commands::mongo_cmd::mongo_drop_database,
            commands::mongo_cmd::mongo_drop_collection,
            commands::mongo_cmd::mongo_rename_collection,
            commands::document_cmd::document_list_databases,
            commands::document_cmd::document_list_collections,
            commands::document_cmd::document_find_documents,
            commands::document_cmd::document_list_gridfs_buckets,
            commands::document_cmd::document_create_gridfs_bucket,
            commands::document_cmd::document_delete_gridfs_bucket,
            commands::document_cmd::document_list_gridfs_files,
            commands::document_cmd::document_download_gridfs_file,
            commands::document_cmd::document_upload_gridfs_file,
            commands::document_cmd::document_delete_gridfs_file,
            commands::mongo_cmd::mongo_find_documents,
            commands::mongo_cmd::mongo_parse_shell_command,
            commands::mongo_cmd::mongo_find_one,
            commands::mongo_cmd::mongo_count_documents,
            commands::mongo_cmd::mongo_server_version,
            commands::mongo_cmd::mongo_collection_stats,
            commands::mongo_cmd::mongo_aggregate_documents,
            commands::mongo_cmd::mongo_distinct,
            commands::mongo_cmd::mongo_create_index,
            commands::mongo_cmd::mongo_drop_indexes,
            commands::document_cmd::document_insert_document,
            commands::mongo_cmd::mongo_insert_document,
            commands::mongo_cmd::mongo_insert_documents,
            commands::document_cmd::document_update_document,
            commands::mongo_cmd::mongo_update_document,
            commands::mongo_cmd::mongo_update_documents,
            commands::document_cmd::document_delete_document,
            commands::mongo_cmd::mongo_delete_document,
            commands::mongo_cmd::mongo_delete_documents,
            commands::mongo_cmd::mongo_find_one_and_update,
            commands::mongo_cmd::mongo_find_one_and_replace,
            commands::mongo_cmd::mongo_find_one_and_delete,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_test_connection,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_tenants,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_tenant,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_tenant,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_update_tenant,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_tenant,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_namespaces,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_namespace,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_namespace,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_namespace_policies,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_topics,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_topic,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_topic,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_update_partitions,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_topic_stats,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_topic_internal_stats,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_exchanges,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_exchange,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_exchange,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_bindings,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_bind,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_unbind,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_subscriptions,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_subscription,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_subscription,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_skip_messages,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_reset_cursor,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_clear_backlog,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_consumer_group_config,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_alter_consumer_group_config,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_peek_messages,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_expire_messages,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_producers,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_consumers,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_unload_topic,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_client_connections,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_client_channels,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_close_client_connection,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_publish_rate,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_dispatch_rate,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_subscribe_rate,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_backlog_quota,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_retention,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_effective_policies,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_grant_permission,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_revoke_permission,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_permissions,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_users,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_create_user,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_user,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_user_permissions,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_grant_user_permission,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_revoke_user_permission,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_policies,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_set_policy,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_delete_policy,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_overview,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_nodes,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_issue_token,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_list_token_records,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_backlog,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_cluster_info,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_get_topic_route,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_alter_topic_config,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_skip_topic_accumulation,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_view_message,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_query_messages_by_key,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_query_messages_by_topic,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_query_message_trace,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_raw_request,
            #[cfg(feature = "mq-admin")]
            commands::mq_cmd::mq_send_message,
            commands::history::save_history,
            commands::history::load_history,
            commands::history::search_history,
            commands::history::load_history_connection_options,
            commands::history::clear_history,
            commands::history::delete_history_entry,
            commands::mcp::check_mcp_server_status,
            commands::mcp::install_mcp_server,
            commands::update::check_for_updates,
            commands::update::fetch_changelog,
            commands::update::get_system_proxy_url,
            commands::update::download_update,
            commands::update::install_downloaded_update,
            commands::transfer::start_transfer,
            commands::transfer::preview_transfer_ownership,
            commands::transfer::cancel_transfer,
            commands::database_export::begin_database_backup_snapshot,
            commands::database_export::export_database_sql,
            commands::database_export::cancel_database_export,
            commands::table_export::start_table_export,
            commands::table_export::cancel_table_export,
            commands::query_result_export::start_query_result_export,
            commands::query_result_export::cancel_query_result_export,
            commands::csv_export::export_query_result_csv,
            commands::csv_export::export_table_data_csv,
            commands::xlsx_export::export_query_result_xlsx,
            commands::xlsx_export::export_query_results_xlsx,
            commands::text_export::export_query_result_json,
            commands::text_export::export_query_result_markdown,
            commands::agents::list_installed_agents,
            commands::agents::list_installed_agents_local,
            commands::agents::is_agent_installed,
            commands::agents::get_driver_store_usage,
            commands::agents::clear_driver_download_cache,
            commands::agents::get_driver_runtime_summary,
            commands::agents::stop_driver_runtime,
            commands::agents::restart_driver_runtime,
            commands::agents::install_agent,
            commands::agents::upgrade_all_agents,
            commands::agents::check_agent_update_blockers,
            commands::agents::uninstall_agent,
            commands::agents::check_jre_installed,
            commands::agents::get_agent_java_runtime_config,
            commands::agents::set_agent_java_runtime_config,
            commands::agents::uninstall_jre,
            commands::agents::reinstall_jre,
            commands::agents::invalidate_agent_registry_cache,
            commands::agents::import_agents_from_zip,
            commands::agents::import_agent_driver_cmd,
            commands::agents::import_agent_jar_cmd,
            commands::system_fonts::list_system_fonts,
            commands::ssh_config::list_ssh_config_hosts,
            commands::tunnel_profiles::load_tunnel_profiles,
            commands::tunnel_profiles::save_tunnel_profiles,
            commands::tunnel_profiles::test_tunnel_profile,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = (&app_handle, &event);

            if let RunEvent::ExitRequested { code, api, .. } = &event {
                let confirmed_exit = app_handle
                    .try_state::<CloseBehaviorState>()
                    .map(|state| state.take_confirmed_exit())
                    .unwrap_or(false);
                if should_confirm_app_exit_request(std::env::consts::OS, *code, confirmed_exit) {
                    api.prevent_exit();
                    request_app_close(app_handle, "quit");
                } else if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                    tauri::async_runtime::block_on(state.shutdown_background_tasks(Duration::from_secs(3)));
                }
            }

            #[cfg(target_os = "macos")]
            if let RunEvent::Opened { urls } = &event {
                let links: Vec<String> = urls
                    .iter()
                    .map(|url| url.to_string())
                    .filter_map(|url| commands::deep_link::connection_deep_link_from_arg(&url))
                    .collect();
                open_connection_deep_links(app_handle, links);

                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| commands::external_sql::is_sql_file_path(path))
                    .map(|path| path.to_string_lossy().to_string())
                    .collect();
                if !paths.is_empty() {
                    if let Some(state) = app_handle.try_state::<commands::external_sql::ExternalSqlOpenState>() {
                        state.push(paths.clone());
                    }
                    let _ = app_handle.emit("dbx-open-sql-files", paths);
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }

                let db_paths: Vec<String> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| commands::external_db::is_db_file_path(path))
                    .map(|path| path.to_string_lossy().to_string())
                    .collect();
                if !db_paths.is_empty() {
                    if let Some(state) = app_handle.try_state::<commands::external_db::ExternalDbOpenState>() {
                        state.push(db_paths.clone());
                    }
                    let _ = app_handle.emit("dbx-open-db-files", db_paths);
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }

            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen { has_visible_windows, .. } = &event {
                if !has_visible_windows {
                    show_main_window(app_handle);
                }
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        state.refresh_connections().await;
                    }
                });
            }

            if let RunEvent::Resumed = &event {
                let app_handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = app_handle.try_state::<AppState>() {
                        state.refresh_connections().await;
                    }
                });
            }
        });
}
