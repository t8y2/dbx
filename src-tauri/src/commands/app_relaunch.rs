/// Relaunches DBX after installing an update or after a setting change that needs a fresh process.
///
/// macOS must go through LaunchServices instead of spawning the executable directly: a directly
/// spawned process is attributed to the exiting app and never gets its own LaunchServices record,
/// which makes macOS 27 drop its LAN connections (`No route to host`, os error 65). See
/// `dbx_platform::relaunch` for the details.
#[tauri::command]
pub fn relaunch_app(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(executable) = std::env::current_exe() {
            if let Some(bundle) = dbx_platform::relaunch::app_bundle_path(&executable) {
                match dbx_platform::relaunch::spawn_launch_services_relaunch(std::process::id(), &bundle) {
                    Ok(helper_pid) => {
                        log::info!("relaunching {} through LaunchServices (helper pid {helper_pid})", bundle.display());
                        // exit(0) bypasses tauri's ExitRequested shutdown, so stop the runtime
                        // resources here exactly like the updater's forced exit does.
                        crate::cleanup_before_updater_forced_exit(&app);
                        std::process::exit(0);
                    }
                    Err(error) => {
                        log::warn!("failed to start the LaunchServices relaunch helper: {error}");
                    }
                }
            }
        }
    }
    app.request_restart();
}
