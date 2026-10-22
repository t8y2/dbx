//! Relaunching the desktop app on macOS.
//!
//! Tauri's `process::restart` (used by `@tauri-apps/plugin-process`'s `relaunch`) spawns the
//! executable inside `Contents/MacOS` directly. During an in-app update that new process is
//! parented by the old instance, which exits right after spawning it: LaunchServices keeps the
//! old app record alive as `exited-with-subordinates` and the new process never gets its own app
//! record.
//!
//! macOS 27 resolves the local-network privacy grant through that app record. A relaunched process
//! without one cannot be matched to the app's grant, so every connection to a LAN address is
//! dropped by the kernel as `EHOSTUNREACH` ("No route to host", os error 65) while internet
//! connections keep working. Opening the bundle through LaunchServices (`open`) instead gives the
//! new process a normal app record, so the local-network permission keeps working after an update.

use std::path::{Path, PathBuf};

/// Returns the `.app` bundle that contains `executable`.
///
/// Only the `.../Foo.app/Contents/MacOS/foo` layout is accepted. A bare `target/debug/dbx`, a
/// portable executable or a test binary returns `None` and callers should fall back to the
/// platform's default restart behavior.
pub fn app_bundle_path(executable: &Path) -> Option<PathBuf> {
    let macos_dir = executable.parent()?;
    if macos_dir.file_name()? != "MacOS" {
        return None;
    }
    let contents_dir = macos_dir.parent()?;
    if contents_dir.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents_dir.parent()?;
    if bundle.extension()? != "app" {
        return None;
    }
    Some(bundle.to_path_buf())
}

/// Builds the detached helper script run by [`spawn_launch_services_relaunch`].
///
/// `data_dir` is forwarded as `DBX_DATA_DIR` when set, because LaunchServices does not pass this
/// process's environment to the new instance. `open --env` needs macOS 13+, so the helper falls
/// back to a plain launch when that option is unavailable.
#[cfg(any(target_os = "macos", test))]
fn relaunch_script(waiter_pid: u32, data_dir: Option<&str>) -> String {
    let open = match data_dir {
        Some(data_dir) => format!(
            "/usr/bin/open -n --env 'DBX_DATA_DIR={}' \"$1\" || exec /usr/bin/open -n \"$1\"",
            data_dir.replace('\'', "'\\''")
        ),
        None => "/usr/bin/open -n \"$1\"".to_string(),
    };
    format!("while /bin/kill -0 {waiter_pid} 2>/dev/null; do /bin/sleep 0.1; done; exec {open}")
}

/// Spawns a detached helper that waits for `waiter_pid` to exit, then opens `bundle` through
/// LaunchServices.
///
/// The helper must not open the bundle while this process is still alive: the single-instance
/// guard would hand the second launch back to the exiting process and quit, leaving the app
/// closed. Returns the helper's pid.
#[cfg(target_os = "macos")]
pub fn spawn_launch_services_relaunch(waiter_pid: u32, bundle: &Path) -> std::io::Result<u32> {
    use std::process::{Command, Stdio};

    let data_dir = std::env::var_os("DBX_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string_lossy().into_owned());
    let script = relaunch_script(waiter_pid, data_dir.as_deref());
    Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .arg("dbx-relaunch")
        .arg(bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|child| child.id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn detects_app_bundle_from_bundled_executable() {
        let bundle = app_bundle_path(Path::new("/Applications/DBX.app/Contents/MacOS/dbx"));
        assert_eq!(bundle.as_deref(), Some(Path::new("/Applications/DBX.app")));
    }

    #[test]
    fn detects_app_bundle_in_build_directory() {
        let bundle =
            app_bundle_path(Path::new("/Users/staff/dbx/target/debug/bundle/macos/DBX.app/Contents/MacOS/dbx"));
        assert_eq!(bundle.as_deref(), Some(Path::new("/Users/staff/dbx/target/debug/bundle/macos/DBX.app")));
    }

    #[test]
    fn ignores_executables_outside_an_app_bundle() {
        assert_eq!(app_bundle_path(Path::new("/Users/staff/dbx/target/debug/dbx")), None);
        assert_eq!(app_bundle_path(Path::new("/Applications/DBX.app/dbx")), None);
        assert_eq!(app_bundle_path(Path::new("/Applications/DBX.app/Contents/MacOS/dbx/extra")), None);
        assert_eq!(app_bundle_path(Path::new("/Applications/DBX.app/Contents/Resources/dbx")), None);
        assert_eq!(app_bundle_path(Path::new("/Applications/DBX/Contents/MacOS/dbx")), None);
        assert_eq!(app_bundle_path(Path::new("dbx")), None);
    }

    #[test]
    fn requires_the_lowercase_dot_app_extension() {
        assert_eq!(app_bundle_path(Path::new("/Applications/DBX.app.bak/Contents/MacOS/dbx")), None);
        assert_eq!(app_bundle_path(Path::new("/Applications/DBX.App/Contents/MacOS/dbx")), None);
    }

    #[test]
    fn helper_waits_for_the_current_process_and_opens_the_bundle() {
        let script = relaunch_script(4242, None);
        assert!(script.starts_with("while /bin/kill -0 4242 2>/dev/null; do /bin/sleep 0.1; done; "));
        assert!(script.ends_with("exec /usr/bin/open -n \"$1\""));
        assert!(!script.contains("--env"));
    }

    #[test]
    fn helper_forwards_the_custom_data_dir_to_the_new_instance() {
        let script = relaunch_script(7, Some("/tmp/dbx dev/data"));
        assert!(script.contains("--env 'DBX_DATA_DIR=/tmp/dbx dev/data'"));
        assert!(script.contains("|| exec /usr/bin/open -n \"$1\""));
    }

    #[test]
    fn helper_escapes_single_quotes_in_the_data_dir() {
        let script = relaunch_script(7, Some("/tmp/it's here"));
        assert!(script.contains("--env 'DBX_DATA_DIR=/tmp/it'\\''s here'"));
    }

    /// Exercises the real helper against a throwaway bundle. Needs a macOS GUI session, so it is
    /// opt-in: `cargo test -p dbx-platform -- --ignored launches_bundle_through_launch_services`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "launches a temporary .app through LaunchServices"]
    fn launches_bundle_through_launch_services() {
        use std::fs;
        use std::time::{Duration, Instant};

        let root = std::env::temp_dir().join(format!(
            "dbx-relaunch-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let app = root.join("DBX Relaunch Test.app");
        let macos_dir = app.join("Contents/MacOS");
        fs::create_dir_all(&macos_dir).unwrap();
        let marker = root.join("launched.txt");
        fs::write(
            app.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>relaunch-test</string>
<key>CFBundleIdentifier</key><string>dev.dbx.relaunch-test</string>
<key>CFBundleName</key><string>DBX Relaunch Test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
"#,
        )
        .unwrap();
        let executable = macos_dir.join("relaunch-test");
        fs::write(&executable, format!("#!/bin/sh\n/usr/bin/touch \"{}\"\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        }

        // u32::MAX is never a live pid, so the helper opens the bundle immediately.
        spawn_launch_services_relaunch(u32::MAX, &app).unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if marker.exists() {
                let _ = fs::remove_dir_all(&root);
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = fs::remove_dir_all(&root);
        panic!("LaunchServices did not start the test bundle");
    }
}
