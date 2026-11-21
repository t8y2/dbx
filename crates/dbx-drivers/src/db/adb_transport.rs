//! adb (Android Debug Bridge) transport for DBX "Android (ADB)" connections.
//!
//! The desktop client discovers devices, verifies the target app is
//! debuggable, pushes the on-device worker binary to `/data/local/tmp`, and
//! then drives it through an `adb exec-out run-as <pkg> ...` child process
//! using the same JSON line protocol as the SSH SQLite worker.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::{Child, Command};

use percent_encoding::percent_decode_str;

use crate::models::connection::ConnectionConfig;

pub const ADB_WORKER_ENV: &str = "DBX_ANDROID_WORKER_PATH";
/// Staging location on the device. `/data/local/tmp` is writable by the shell
/// user, but on SELinux-enforcing devices the app uid (untrusted_app domain)
/// cannot execute `shell_data_file`, so the binary only transits through here.
pub const ADB_WORKER_REMOTE_PATH: &str = "/data/local/tmp/dbx-android-worker";
/// Final install location: inside the app's own data dir, where `run-as`
/// executes it as the app uid. Relative to the app data dir (run-as sets the
/// cwd there). Executing app-owned files is allowed on Android <= 9; on
/// Android 10+ it is restricted for apps targeting API 29+ (W^X), which we
/// surface as an explicit error.
pub const ADB_WORKER_APP_PATH: &str = "./dbx-android-worker";
pub const ADB_CONNECT_TIMEOUT_SECS: u64 = 10;

/// Prevent adb child processes from flashing/holding a Windows console
/// window. Long-lived worker sessions would otherwise keep an empty console
/// visible for as long as the connection is open.
fn suppress_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

/// Reject package names that could break out of the `run-as <package> ...`
/// command line. Android package names are `[A-Za-z0-9_.]` segments.
fn validate_package_name(package: &str) -> Result<(), String> {
    let valid = !package.is_empty()
        && package.len() <= 255
        && package
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_');
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid Android package name: {package}"))
    }
}

/// Registered by the desktop host at startup: directory that contains the
/// packaged per-ABI worker binaries (`arm64-v8a/`, `armeabi-v7a/`, `x86_64/`).
static ANDROID_WORKER_RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn set_android_worker_resource_dir(dir: PathBuf) {
    let _ = ANDROID_WORKER_RESOURCE_DIR.set(dir);
}

pub fn android_worker_resource_dir() -> Option<&'static PathBuf> {
    ANDROID_WORKER_RESOURCE_DIR.get()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct AdbDevice {
    pub serial: String,
    pub state: String,
    pub model: Option<String>,
}

/// ADB parameters carried in `ConnectionConfig::url_params`
/// (`adb_serial`, `adb_package`, `adb_path`) with the device database file
/// path in `ConnectionConfig::host`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdbConnectionParams {
    pub adb_path: Option<PathBuf>,
    pub serial: String,
    pub package: String,
    pub database_path: String,
}

pub fn adb_connection_params(config: &ConnectionConfig) -> Result<AdbConnectionParams, String> {
    let params = url_params(config.url_params.as_deref());
    let serial = params.get("adb_serial").cloned().unwrap_or_default();
    let package = params.get("adb_package").cloned().unwrap_or_default();
    let adb_path = params.get("adb_path").filter(|value| !value.trim().is_empty()).map(PathBuf::from);
    let database_path = percent_decode_str(&config.host.trim()).decode_utf8_lossy().into_owned();
    if serial.trim().is_empty() {
        return Err("An Android device serial is required".to_string());
    }
    if package.trim().is_empty() {
        return Err("An Android package name is required".to_string());
    }
    if database_path.is_empty() {
        return Err("A device database file path is required".to_string());
    }
    Ok(AdbConnectionParams { adb_path, serial: serial.trim().to_string(), package: package.trim().to_string(), database_path })
}

fn url_params(params: Option<&str>) -> HashMap<String, String> {
    let Some(params) = params else { return HashMap::new() };
    params
        .trim()
        .trim_start_matches('?')
        .split('&')
        .filter_map(|part| {
            let (raw_key, raw_value) = part.split_once('=')?;
            Some((
                raw_key.to_string(),
                percent_encoding::percent_decode_str(&raw_value.replace('+', " ")).decode_utf8_lossy().into_owned(),
            ))
        })
        .collect()
}

/// Locate the adb executable: explicit connection setting, dev/test override
/// env var, `PATH`, then the platform-specific Android SDK default location.
pub fn resolve_adb_binary(configured: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = configured {
        if !path.is_file() {
            return Err(format!("adb executable not found: {}", path.display()));
        }
        return Ok(path.to_path_buf());
    }
    if let Ok(path) = std::env::var(ADB_WORKER_ENV) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    if which_adb().is_some() {
        return Ok(PathBuf::from("adb"));
    }
    for candidate in adb_sdk_default_candidates() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(
        "adb was not found. Install the Android SDK platform-tools, add adb to PATH, \
         or set the adb path on the connection."
            .to_string(),
    )
}

fn which_adb() -> Option<PathBuf> {
    #[cfg(windows)]
    const PATH_SEP: char = ';';
    #[cfg(not(windows))]
    const PATH_SEP: char = ':';
    let path = std::env::var_os("PATH")?;
    let exe = if cfg!(windows) { "adb.exe" } else { "adb" };
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(exe);
        candidate.is_file().then_some(candidate)
    })
}

fn adb_sdk_default_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(android_home) = std::env::var("ANDROID_HOME") {
        let exe = if cfg!(windows) { "adb.exe" } else { "adb" };
        candidates.push(PathBuf::from(&android_home).join("platform-tools").join(exe));
    }
    if let Some(home) = dirs_home() {
        let sdk = if cfg!(windows) {
            home.join("AppData").join("Local").join("Android").join("Sdk").join("platform-tools").join("adb.exe")
        } else if cfg!(target_os = "macos") {
            home.join("Library").join("Android").join("sdk").join("platform-tools").join("adb")
        } else {
            home.join("Android").join("Sdk").join("platform-tools").join("adb")
        };
        candidates.push(sdk);
    }
    candidates
}

fn dirs_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

async fn adb_capture(adb: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new(adb);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    suppress_console_window(&mut command);
    let mut child = command
        .spawn()
        .map_err(|e| format!("failed to start adb: {e}"))?;
    let Some(mut stdout) = child.stdout.take() else {
        return Err("adb produced no stdout".to_string());
    };
    let Some(mut stderr) = child.stderr.take() else {
        return Err("adb produced no stderr pipe".to_string());
    };
    let read_out = tokio::spawn(async move {
        let mut out = Vec::new();
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut out).await;
        out
    });
    let read_err = tokio::spawn(async move {
        let mut err = Vec::new();
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut stderr, &mut err).await;
        err
    });
    let status = tokio::time::timeout(timeout, child.wait())
        .await
        .map_err(|_| format!("adb timed out after {}s: {}", timeout.as_secs(), args.join(" ")))?
        .map_err(|e| format!("adb failed: {e}"))?;
    let out = read_out.await.map_err(|e| e.to_string())?;
    let err = read_err.await.map_err(|e| e.to_string())?;
    let out = String::from_utf8_lossy(&out).into_owned();
    let err = String::from_utf8_lossy(&err).into_owned();
    if !status.success() {
        return Err(format!("adb {} failed (exit {}): {}", args.join(" "), status.code().unwrap_or(-1), err.trim()));
    }
    Ok(out)
}

pub async fn list_adb_devices(adb: &Path) -> Result<Vec<AdbDevice>, String> {
    let output = adb_capture(adb, &["devices", "-l"], Duration::from_secs(ADB_CONNECT_TIMEOUT_SECS)).await?;
    Ok(parse_adb_devices(&output))
}

pub fn parse_adb_devices(output: &str) -> Vec<AdbDevice> {
    output
        .lines()
        .skip_while(|line| !line.trim().starts_with("List of devices"))
        .skip(1)
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next().unwrap_or("unknown").to_string();
            let model = line
                .split_whitespace()
                .find_map(|token| token.strip_prefix("model:"))
                .map(str::to_string);
            Some(AdbDevice { serial, state, model })
        })
        .collect()
}

pub async fn ensure_device_online(adb: &Path, serial: &str) -> Result<(), String> {
    let devices = list_adb_devices(adb).await?;
    match devices.iter().find(|device| device.serial == serial) {
        Some(device) if device.state == "device" => Ok(()),
        Some(device) => Err(format!("Android device {serial} is in state \"{}\"; authorize USB debugging and retry", device.state)),
        None => Err(format!("Android device {serial} is not connected. Check the cable and run \"adb devices\".")),
    }
}

pub async fn list_adb_packages(adb: &Path, serial: &str) -> Result<Vec<String>, String> {
    let output =
        adb_capture(adb, &["-s", serial, "shell", "pm", "list", "packages", "-3"], Duration::from_secs(20)).await?;
    Ok(parse_package_list(&output))
}

pub fn parse_package_list(output: &str) -> Vec<String> {
    let mut packages: Vec<String> = output
        .lines()
        .filter_map(|line| line.trim().strip_prefix("package:"))
        .map(str::to_string)
        .filter(|package| !package.is_empty())
        .collect();
    packages.sort();
    packages.dedup();
    packages
}

/// `run-as` succeeds only for debuggable packages; this is the authoritative
/// check that the app's data dir is reachable without root.
pub async fn check_debuggable(adb: &Path, serial: &str, package: &str) -> Result<(), String> {
    let output =
        adb_capture(adb, &["-s", serial, "shell", &format!("run-as {package} id")], Duration::from_secs(15)).await?;
    classify_run_as_check(package, &output)
}

pub fn classify_run_as_check(package: &str, output: &str) -> Result<(), String> {
    let output = output.trim();
    if output.starts_with("uid=") {
        return Ok(());
    }
    let lowered = output.to_lowercase();
    if lowered.contains("not debuggable") {
        return Err(format!("Package {package} is not debuggable. Install a debug build or enable \"android:debuggable\"."));
    }
    if lowered.contains("unknown package") || lowered.contains("not found") {
        return Err(format!("Package {package} is not installed on this device."));
    }
    Err(format!("run-as failed for {package}: {output}"))
}

/// Enumerate SQLite-ish files inside the app data dir (run-as sets the cwd to
/// the app data dir, so relative paths resolve against it) plus the app's
/// external storage dir on emulated storage (e.g. uni-app keeps databases in
/// `/storage/emulated/0/Android/data/<pkg>/apps/<id>/doc`). The external scan
/// is best-effort: on devices where it is inaccessible we still return the
/// internal results.
pub async fn list_app_database_files(adb: &Path, serial: &str, package: &str) -> Result<Vec<String>, String> {
    let internal_command = format!(
        "run-as {package} find . -maxdepth 3 -type f \\( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' -o -path './databases/*' \\)"
    );
    let output = adb_capture(adb, &["-s", serial, "shell", &internal_command], Duration::from_secs(20)).await?;
    let mut files = parse_database_file_list(&output);

    let external_dir = format!("/storage/emulated/0/Android/data/{package}");
    let external_command = format!(
        "run-as {package} find {external_dir} -maxdepth 6 -type f \\( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \\)"
    );
    if let Ok(external_output) =
        adb_capture(adb, &["-s", serial, "shell", &external_command], Duration::from_secs(20)).await
    {
        files.extend(parse_external_database_file_list(&external_output));
    }

    files.sort();
    files.dedup();
    Ok(files)
}

pub fn parse_database_file_list(output: &str) -> Vec<String> {
    let mut files: Vec<String> = output
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| line.starts_with("./"))
        .filter(|line| {
            let lowered = line.to_lowercase();
            // -wal/-shm/-journal sidecars are never standalone databases.
            if lowered.ends_with("-wal") || lowered.ends_with("-shm") || lowered.ends_with("-journal") {
                return false;
            }
            // Everything inside ./databases/ is a candidate: SQLite apps often
            // name their files without an extension (e.g. uni-app's DCStorage).
            if lowered.starts_with("./databases/") {
                return true;
            }
            lowered.ends_with(".db") || lowered.ends_with(".sqlite") || lowered.ends_with(".sqlite3")
        })
        .map(|line| line[2..].to_string())
        .collect();
    files.sort();
    files.dedup();
    files
}

/// External-storage results keep their absolute path (the worker runs as the
/// app's uid, which may open its own external dir).
pub fn parse_external_database_file_list(output: &str) -> Vec<String> {
    output
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| line.starts_with('/'))
        .filter(|line| {
            let lowered = line.to_lowercase();
            !(lowered.ends_with("-wal") || lowered.ends_with("-shm") || lowered.ends_with("-journal"))
                && (lowered.ends_with(".db") || lowered.ends_with(".sqlite") || lowered.ends_with(".sqlite3"))
        })
        .collect()
}

pub async fn device_abi(adb: &Path, serial: &str) -> Result<String, String> {
    let output =
        adb_capture(adb, &["-s", serial, "shell", "getprop", "ro.product.cpu.abi"], Duration::from_secs(10)).await?;
    let abi = output.trim().to_string();
    if abi.is_empty() {
        return Err("Could not read the device CPU ABI".to_string());
    }
    Ok(abi)
}

/// Map a device ABI to the packaged worker directory name.
pub fn abi_resource_dir(abi: &str) -> Result<&'static str, String> {
    if abi.starts_with("arm64") {
        Ok("arm64-v8a")
    } else if abi.starts_with("armeabi") {
        Ok("armeabi-v7a")
    } else if abi.starts_with("x86_64") {
        Ok("x86_64")
    } else if abi.starts_with("x86") {
        Err("32-bit x86 Android devices are not supported; use an arm64 or x86_64 device/emulator".to_string())
    } else {
        Err(format!("Unsupported device ABI: {abi}"))
    }
}

/// Resolve the packaged worker binary for this device ABI.
pub fn resolve_local_worker_binary(abi: &str) -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var(ADB_WORKER_ENV) {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }
    let resource_dir = android_worker_resource_dir()
        .ok_or_else(|| "The Android worker binary is not bundled in this build".to_string())?;
    let abi_dir = abi_resource_dir(abi)?;
    let path = resource_dir.join(abi_dir).join("dbx-android-worker");
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!("Android worker binary for ABI {abi} is missing: {}", path.display()))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Read worker version on the device through run-as; confirms the binary is
/// executable by the app uid and matches the expected protocol version.
async fn verify_worker_version(adb: &Path, serial: &str, package: &str) -> Result<String, String> {
    let command = format!("run-as {package} {ADB_WORKER_APP_PATH} --version");
    let output = adb_capture(adb, &["-s", serial, "shell", &command], Duration::from_secs(15)).await?;
    let line = output.lines().next().unwrap_or("").trim().to_string();
    if line.starts_with("dbx-android-worker ") {
        Ok(line)
    } else {
        let trimmed = output.trim();
        let lowered = trimmed.to_lowercase();
        if lowered.contains("permission denied") {
            // SELinux W^X on Android 10+ (app targets API 29+) or a locked-down
            // OEM policy: the app uid is not allowed to exec the binary.
            return Err(
                "The app uid is not allowed to execute the worker binary on this device (SELinux/W^X restriction). \
                 This is expected on Android 10+ for apps targeting API 29+; use a device running Android 9 or lower, \
                 or an app targeting an older API."
                    .to_string(),
            );
        }
        Err(format!("The on-device worker did not report its version: {trimmed}"))
    }
}

/// Make sure the packaged worker is installed inside the target app's data dir
/// (digest + version verified) and executable by the app uid.
///
/// Two-stage deploy, required by SELinux: the app uid cannot execute binaries
/// staged in `/data/local/tmp` (`shell_data_file`), so we push there as the
/// shell user and then pipe the bytes into the app data dir via `run-as`.
/// Executing app-owned files works on Android <= 9; on Android 10+ with apps
/// targeting API 29+ the kernel blocks it and the `--version` probe reports
/// the failure.
pub async fn ensure_android_worker(adb: &Path, serial: &str, package: &str, local_worker: &Path) -> Result<(), String> {
    validate_package_name(package)?;
    let bytes = std::fs::read(local_worker).map_err(|e| format!("failed to read worker binary {}: {e}", local_worker.display()))?;
    let digest = sha256_hex(&bytes);

    // Fast path: an identical copy is already installed in the app data dir.
    let remote_digest = adb_capture(
        adb,
        &["-s", serial, "shell", &format!("run-as {package} sha256sum {ADB_WORKER_APP_PATH} 2>/dev/null")],
        Duration::from_secs(15),
    )
    .await
    .ok()
    .and_then(|output| output.split_whitespace().next().map(str::to_string));
    if remote_digest.as_deref() == Some(digest.as_str()) {
        verify_worker_version(adb, serial, package).await?;
        return Ok(());
    }

    // Stage the binary where the shell user can write it...
    adb_capture(adb, &["-s", serial, "push", &local_worker.to_string_lossy(), ADB_WORKER_REMOTE_PATH], Duration::from_secs(60))
        .await
        .map_err(|e| format!("failed to push the Android worker: {e}"))?;
    adb_capture(adb, &["-s", serial, "shell", &format!("chmod 755 {ADB_WORKER_REMOTE_PATH}")], Duration::from_secs(10)).await?;
    // ...then pipe it into the app data dir and make it executable there.
    let install_command = format!(
        "cat {ADB_WORKER_REMOTE_PATH} | run-as {package} sh -c 'cat > {ADB_WORKER_APP_PATH} && chmod 755 {ADB_WORKER_APP_PATH}'"
    );
    adb_capture(adb, &["-s", serial, "shell", &install_command], Duration::from_secs(60)).await?;
    verify_worker_version(adb, serial, package).await?;
    Ok(())
}

/// Spawn the on-device worker as the target app's uid and return the child
/// process whose stdio carries the JSON line protocol.
pub async fn spawn_android_worker(
    adb: &Path,
    serial: &str,
    package: &str,
    database_path: &str,
) -> Result<Child, String> {
    validate_package_name(package)?;
    let command = format!("run-as {package} {ADB_WORKER_APP_PATH} --stdio");
    // `shell -T` (raw, no PTY) instead of `exec-out`: some transports — the
    // Android emulator in particular — do not forward stdin on `exec-out`,
    // leaving the worker waiting forever for its first request.
    let mut cmd = Command::new(adb);
    cmd.args(["-s", serial, "shell", "-T", &command])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    suppress_console_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start adb worker session: {e}"))?;
    // Drain stderr: adb writes connection warnings there and a full pipe can
    // deadlock the worker session.
    if let Some(mut stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut sink = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut stderr, &mut sink).await;
        });
    }
    // Give adb a moment to fail fast on an obviously broken transport.
    tokio::time::sleep(Duration::from_millis(300)).await;
    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!("adb worker session exited immediately (exit {})", status.code().unwrap_or(-1)));
    }
    let _ = database_path;
    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_device_list() {
        let output = "List of devices attached\n\
                      emulator-5554\tdevice product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64xa transport_id:1\n\
                      ABC123XYZ\tunauthorized usb:1-1 transport_id:2\n\
                      \n";
        let devices = parse_adb_devices(output);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].serial, "emulator-5554");
        assert_eq!(devices[0].state, "device");
        assert_eq!(devices[0].model.as_deref(), Some("sdk_gphone64_arm64"));
        assert_eq!(devices[1].state, "unauthorized");
    }

    #[test]
    fn parses_package_list_sorted_and_deduped() {
        let output = "package:com.example.b\npackage:com.example.a\npackage:com.example.b\n\n";
        assert_eq!(parse_package_list(output), vec!["com.example.a", "com.example.b"]);
    }

    #[test]
    fn run_as_check_classifies_debuggable_and_failures() {
        assert!(classify_run_as_check("com.example", "uid=10123(com.example) gid=10123(com.example)\n").is_ok());
        let error = classify_run_as_check("com.example", "run-as: Package 'com.example' is not debuggable\n").unwrap_err();
        assert!(error.contains("not debuggable"), "{error}");
        let error = classify_run_as_check("com.example", "run-as: unknown package: com.example\n").unwrap_err();
        assert!(error.contains("not installed"), "{error}");
    }

    #[test]
    fn database_file_list_filters_wal_shm_journal_and_strips_prefix() {
        let output = "./databases/app.db\n./databases/app.db-wal\n./databases/app.db-shm\n./files/x.sqlite\n./junk.txt\n";
        assert_eq!(parse_database_file_list(output), vec!["databases/app.db", "files/x.sqlite"]);
    }

    #[test]
    fn database_file_list_keeps_extensionless_files_in_databases_dir() {
        // uni-app/DCloud stores its SQLite database as an extensionless file
        // (e.g. ./databases/DCStorage); keep every ./databases/ entry that is
        // not a sidecar, but still require an extension elsewhere.
        let output = "./databases/DCStorage\n./databases/DCStorage-wal\n./databases/DCStorage-shm\n./databases/DCStorage-journal\n./files/DCStorage\n";
        assert_eq!(parse_database_file_list(output), vec!["databases/DCStorage"]);
    }

    #[test]
    fn external_database_file_list_keeps_absolute_sqlite_paths_only() {
        let output = "/storage/emulated/0/Android/data/com.example/apps/UNI/doc/waste.db\n/storage/emulated/0/Android/data/com.example/files/waste.db-wal\n/storage/emulated/0/Android/data/com.example/cache/noise.txt\nfind: /missing: No such file or directory\n";
        assert_eq!(
            parse_external_database_file_list(output),
            vec!["/storage/emulated/0/Android/data/com.example/apps/UNI/doc/waste.db"]
        );
    }

    #[test]
    fn adb_params_require_serial_package_and_path() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id", "name": "n", "db_type": "android-adb",
            "host": "databases/app.db", "port": 0, "username": "", "password": "",
            "url_params": "adb_serial=emu-1&adb_package=com.example"
        }))
        .unwrap();
        let params = adb_connection_params(&config).unwrap();
        assert_eq!(params.serial, "emu-1");
        assert_eq!(params.package, "com.example");
        assert_eq!(params.database_path, "databases/app.db");

        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id", "name": "n", "db_type": "android-adb",
            "host": "databases/app.db", "port": 0, "username": "", "password": ""
        }))
        .unwrap();
        assert!(adb_connection_params(&config).is_err());
    }

    #[test]
    fn package_names_are_sanitized_for_run_as() {
        assert!(validate_package_name("cn.iocoder.yudao.app.callcenter").is_ok());
        assert!(validate_package_name("com.example.app_2").is_ok());
        assert!(validate_package_name("").is_err());
        assert!(validate_package_name("pkg; rm -rf /").is_err());
        assert!(validate_package_name("pkg --flag").is_err());
        assert!(validate_package_name("p'kg").is_err());
    }

    #[test]
    fn abi_maps_to_resource_dirs() {
        assert_eq!(abi_resource_dir("arm64-v8a").unwrap(), "arm64-v8a");
        assert_eq!(abi_resource_dir("armeabi-v7a").unwrap(), "armeabi-v7a");
        assert_eq!(abi_resource_dir("x86_64").unwrap(), "x86_64");
        assert!(abi_resource_dir("armeabi").unwrap().starts_with("armeabi"));
        assert!(abi_resource_dir("mips").is_err());
    }

    #[test]
    fn adb_connection_params_decode_percent_escapes() {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "id", "name": "n", "db_type": "android-adb",
            "host": "databases/my%20app.db", "port": 0, "username": "", "password": "",
            "url_params": "adb_serial=emu%2D1&adb_package=com.example"
        }))
        .unwrap();
        let params = adb_connection_params(&config).unwrap();
        assert_eq!(params.serial, "emu-1");
        assert_eq!(params.database_path, "databases/my app.db");
    }
}
