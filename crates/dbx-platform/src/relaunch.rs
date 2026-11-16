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
/// `forwarded_env` (the caller's `DBX_*` variables) is passed to the new instance with
/// `open --env`, because LaunchServices does not inherit this process's environment.
/// `open --env` needs macOS 13+, so the helper falls back to a plain launch when that
/// option is unavailable.
#[cfg(any(target_os = "macos", test))]
fn relaunch_script(waiter_pid: u32, forwarded_env: &[(String, String)]) -> String {
    let open = if forwarded_env.is_empty() {
        "exec /usr/bin/open -n \"$1\"".to_string()
    } else {
        let env_args = forwarded_env
            .iter()
            .map(|(key, value)| format!(" --env '{}={}'", key, value.replace('\'', "'\\''")))
            .collect::<String>();
        format!("/usr/bin/open -n{env_args} \"$1\" || exec /usr/bin/open -n \"$1\"")
    };
    // Keep the shell alive for the first open so an unsupported --env option
    // can return to it and run the fallback. exec would bypass that fallback.
    format!("while /bin/kill -0 {waiter_pid} 2>/dev/null; do /bin/sleep 0.1; done; {open}")
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

    // The previous spawn-based restart inherited the whole environment; LaunchServices
    // starts a fresh one, so forward every DBX_* override (data dir, secret key file, ...).
    let mut forwarded_env: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(key, value)| {
            let key = key.to_string_lossy().into_owned();
            let value = value.to_string_lossy().into_owned();
            (key.starts_with("DBX_") && !value.is_empty()).then_some((key, value))
        })
        .collect();
    forwarded_env.sort();
    let script = relaunch_script(waiter_pid, &forwarded_env);
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
        let script = relaunch_script(4242, &[]);
        assert!(script.starts_with("while /bin/kill -0 4242 2>/dev/null; do /bin/sleep 0.1; done; "));
        assert!(script.ends_with("exec /usr/bin/open -n \"$1\""));
        assert!(!script.contains("--env"));
    }

    #[test]
    fn helper_forwards_the_custom_data_dir_to_the_new_instance() {
        let script = relaunch_script(7, &[("DBX_DATA_DIR".to_string(), "/tmp/dbx dev/data".to_string())]);
        assert!(script.contains("--env 'DBX_DATA_DIR=/tmp/dbx dev/data'"));
        assert!(script.contains("|| exec /usr/bin/open -n \"$1\""));
    }

    #[test]
    fn helper_escapes_single_quotes_in_the_data_dir() {
        let script = relaunch_script(7, &[("DBX_DATA_DIR".to_string(), "/tmp/it's here".to_string())]);
        assert!(script.contains("--env 'DBX_DATA_DIR=/tmp/it'\\''s here'"));
    }

    #[test]
    fn helper_forwards_every_dbx_override_as_its_own_env_argument() {
        let script = relaunch_script(
            9,
            &[
                ("DBX_DATA_DIR".to_string(), "/tmp/dbx".to_string()),
                ("DBX_SECRET_KEY_FILE".to_string(), "/tmp/key file".to_string()),
            ],
        );
        assert!(script.contains("--env 'DBX_DATA_DIR=/tmp/dbx' --env 'DBX_SECRET_KEY_FILE=/tmp/key file'"));
    }

    #[cfg(unix)]
    #[test]
    fn helper_runs_the_fallback_when_open_rejects_env() {
        // Simulate an older open rejecting --env, then observe the fallback
        // without launching an app. Execute the actual generated shell script.
        // The wait loop has its own test. Run only the launch section here:
        // Linux kill narrows u32::MAX to pid -1, which can wait indefinitely.
        let helper = relaunch_script(4242, &[("DBX_DATA_DIR".to_string(), "/tmp/dbx".to_string())]);
        let script = helper
            .split_once("; done; ")
            .unwrap()
            .1
            .replacen("/usr/bin/open", "/usr/bin/false", 1)
            .replace("/usr/bin/open", "/bin/echo");
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", &script, "dbx-relaunch", "/Applications/Test App.app"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8(output.stdout).unwrap(), "/Applications/Test App.app");
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
