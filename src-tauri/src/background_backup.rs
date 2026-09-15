use dbx_core::{
    connection::AppState,
    scheduled_backup::{BackupCommand, BackupService},
    storage::Storage,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct BackgroundBackup {
    pub service: BackupService,
    data_dir: PathBuf,
    stop: CancellationToken,
    worker: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    lease: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundStatus {
    enabled: bool,
    platform: &'static str,
}

impl BackgroundBackup {
    pub fn new(state: Arc<AppState>, data_dir: PathBuf) -> Result<Self, String> {
        let service = BackupService::new(state, &data_dir, None);
        let stop = CancellationToken::new();
        let directory = data_dir.join("database-backups");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let lease = directory.join(format!("ui-{}.lease", uuid::Uuid::new_v4().simple()));
        std::fs::write(&lease, b"1").map_err(|e| e.to_string())?;
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command
            .arg("--ui-backup-worker")
            .arg("--data-dir")
            .arg(&data_dir)
            .arg("--ui-lease")
            .arg(&lease)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000200);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let heartbeat_lease = lease.clone();
        let heartbeat_stop = stop.clone();
        let worker = tokio::spawn(async move {
            loop {
                tokio::select! { _ = heartbeat_stop.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(2)) => {} }
                if let Err(error) = tokio::fs::write(&heartbeat_lease, b"1").await {
                    log::error!("[database-backup] UI lease failed: {error}");
                }
                if child.try_wait().is_ok_and(|exit| exit.is_some()) {
                    match command.spawn() {
                        Ok(restarted) => child = restarted,
                        Err(error) => log::error!("[database-backup] worker restart failed: {error}"),
                    }
                }
            }
        });
        Ok(Self { service, data_dir, stop, worker: tokio::sync::Mutex::new(Some(worker)), lease })
    }

    pub async fn shutdown(&self) {
        self.stop.cancel();
        if let Some(worker) = self.worker.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(60), worker).await;
        }
        let _ = tokio::fs::remove_file(&self.lease).await;
    }

    pub fn resume(&self) -> Result<(), String> {
        if marker(&self.data_dir).exists() {
            register(&self.data_dir)?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn database_backup_command(
    state: tauri::State<'_, BackgroundBackup>,
    command: BackupCommand,
) -> Result<serde_json::Value, String> {
    state.service.command(command).await
}

#[tauri::command]
pub async fn database_backup_background(
    state: tauri::State<'_, BackgroundBackup>,
    enabled: Option<bool>,
) -> Result<BackgroundStatus, String> {
    let data_dir = state.data_dir.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(enabled) = enabled {
            if enabled {
                std::fs::create_dir_all(data_dir.join("database-backups")).map_err(|e| e.to_string())?;
                std::fs::write(marker(&data_dir), b"1").map_err(|e| e.to_string())?;
                if let Err(error) = register(&data_dir) {
                    let _ = std::fs::remove_file(marker(&data_dir));
                    return Err(error);
                }
            } else {
                match std::fs::remove_file(marker(&data_dir)) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
                unregister(&data_dir)?;
            }
        }
        Ok(BackgroundStatus { enabled: marker(&data_dir).exists(), platform: std::env::consts::OS })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn marker(data_dir: &Path) -> PathBuf {
    data_dir.join("database-backups").join("background-enabled")
}
fn name(data_dir: &Path) -> String {
    let hash = format!("{:x}", Sha256::digest(data_dir.to_string_lossy().as_bytes()));
    format!("dbx-backup-{}", &hash[..16])
}

fn run(command: &mut Command) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Background service command failed: {} {}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        ))
    }
}

#[cfg(any(windows, target_os = "macos"))]
fn xml(value: &str) -> String {
    value.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

struct WorkerLogger(std::sync::Mutex<std::fs::File>);

impl log::Log for WorkerLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Warn
    }
    fn log(&self, record: &log::Record<'_>) {
        use std::io::Write;
        if self.enabled(record.metadata()) {
            if let Ok(mut file) = self.0.lock() {
                let _ = writeln!(file, "{} {} {}", chrono::Utc::now().to_rfc3339(), record.level(), record.args());
            }
        }
    }
    fn flush(&self) {
        use std::io::Write;
        if let Ok(mut file) = self.0.lock() {
            let _ = file.flush();
        }
    }
}

fn worker_logging(data_dir: &Path) -> Result<(), String> {
    let directory = data_dir.join("database-backups");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join("worker.log");
    let truncate = std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 5 * 1024 * 1024);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate)
        .open(path)
        .map_err(|e| e.to_string())?;
    if log::set_logger(Box::leak(Box::new(WorkerLogger(std::sync::Mutex::new(file))))).is_ok() {
        log::set_max_level(log::LevelFilter::Warn);
    }
    Ok(())
}

#[cfg(windows)]
fn current_user_sid() -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let output = Command::new("whoami.exe")
        .args(["/user", "/fo", "csv", "/nh"])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("Cannot resolve the Windows backup account".into());
    }
    let mut reader = csv::ReaderBuilder::new().has_headers(false).from_reader(output.stdout.as_slice());
    // The account name uses the console code page; only the SID is guaranteed ASCII.
    let row = reader.byte_records().next().ok_or("Windows account is unavailable")?.map_err(|e| e.to_string())?;
    let sid =
        std::str::from_utf8(row.get(1).ok_or("Windows account SID is unavailable")?).map_err(|e| e.to_string())?;
    if !sid.starts_with("S-1-") || !sid.split('-').skip(1).all(|part| part.parse::<u64>().is_ok()) {
        return Err("Invalid Windows account SID".into());
    }
    Ok(sid.to_string())
}

#[cfg(windows)]
fn register(data_dir: &Path) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let user_id = current_user_sid()?;
    let task = name(data_dir);
    let path = data_dir.join("database-backups").join("task.xml");
    let path_text = data_dir.to_string_lossy();
    let trailing_slashes = path_text.chars().rev().take_while(|c| *c == '\\').count();
    let arguments = format!("--managed-backup-worker --data-dir \"{}{}\"", path_text, "\\".repeat(trailing_slashes));
    let content = format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user_id}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>{user_id}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>{}</Command><Arguments>{}</Arguments></Exec></Actions></Task>"#,
        xml(&exe.to_string_lossy()),
        xml(&arguments)
    );
    // schtasks reads XML reliably as BOM-prefixed UTF-16, including non-ASCII paths.
    let encoded: Vec<u8> =
        std::iter::once(0xfeff_u16).chain(content.encode_utf16()).flat_map(u16::to_le_bytes).collect();
    std::fs::write(&path, encoded).map_err(|e| e.to_string())?;
    run(Command::new("schtasks.exe").args(["/Create", "/F", "/TN", &task, "/XML"]).arg(&path))?;
    run(Command::new("schtasks.exe").args(["/Run", "/TN", &task]))
}

#[cfg(windows)]
fn unregister(data_dir: &Path) -> Result<(), String> {
    run(Command::new("schtasks.exe").args(["/Delete", "/F", "/TN", &name(data_dir)]))
}

#[cfg(target_os = "macos")]
fn launch_agent(data_dir: &Path) -> Result<(String, PathBuf, String), String> {
    let label = format!("app.dbx.{}", name(data_dir));
    let home = std::env::var_os("HOME").ok_or("HOME is unavailable")?;
    let path = PathBuf::from(home).join("Library/LaunchAgents").join(format!("{label}.plist"));
    let output = Command::new("id").arg("-u").output().map_err(|e| e.to_string())?;
    let uid = String::from_utf8(output.stdout).map_err(|e| e.to_string())?.trim().to_string();
    if !output.status.success() || !uid.chars().all(|c| c.is_ascii_digit()) || uid.is_empty() {
        return Err("Cannot resolve login user".into());
    }
    Ok((label, path, format!("gui/{uid}")))
}

#[cfg(target_os = "macos")]
fn register(data_dir: &Path) -> Result<(), String> {
    let (label, path, domain) = launch_agent(data_dir)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>{}</string><key>ProgramArguments</key><array><string>{}</string><string>--managed-backup-worker</string><string>--data-dir</string><string>{}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer></dict></plist>"#,
        xml(&label),
        xml(&exe.to_string_lossy()),
        xml(&data_dir.to_string_lossy())
    );
    std::fs::create_dir_all(path.parent().ok_or("Invalid LaunchAgent path")?).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    if Command::new("launchctl")
        .args(["print", &format!("{domain}/{label}")])
        .output()
        .is_ok_and(|o| o.status.success())
    {
        return Ok(());
    }
    run(Command::new("launchctl").args(["bootstrap", &domain]).arg(&path))
}

#[cfg(target_os = "macos")]
fn unregister(data_dir: &Path) -> Result<(), String> {
    let (_, path, domain) = launch_agent(data_dir)?;
    run(Command::new("launchctl").args(["bootout", &domain]).arg(&path))?;
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn unit_path(data_dir: &Path) -> Result<PathBuf, String> {
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .ok_or("User configuration directory is unavailable")?;
    Ok(config.join("systemd/user").join(format!("{}.service", name(data_dir))))
}

#[cfg(target_os = "linux")]
fn systemd_arg(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('%', "%%").replace('$', "$$"))
}

#[cfg(target_os = "linux")]
fn register(data_dir: &Path) -> Result<(), String> {
    let path = unit_path(data_dir)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if data_dir.to_string_lossy().chars().chain(exe.to_string_lossy().chars()).any(char::is_control) {
        return Err("Service paths contain control characters".into());
    }
    let content = format!("[Unit]\nDescription=DBX database backups\nAfter=network-online.target\n[Service]\nExecStart={} --managed-backup-worker --data-dir {}\nRestart=on-failure\nRestartSec=30\nTimeoutStopSec=90\n[Install]\nWantedBy=default.target\n", systemd_arg(&exe.to_string_lossy()), systemd_arg(&data_dir.to_string_lossy()));
    std::fs::create_dir_all(path.parent().ok_or("Invalid systemd path")?).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    run(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
    run(Command::new("systemctl").args(["--user", "enable", "--now", &format!("{}.service", name(data_dir))]))
}

#[cfg(target_os = "linux")]
fn unregister(data_dir: &Path) -> Result<(), String> {
    run(Command::new("systemctl").args(["--user", "disable", "--now", &format!("{}.service", name(data_dir))]))?;
    std::fs::remove_file(unit_path(data_dir)?).map_err(|e| e.to_string())?;
    run(Command::new("systemctl").args(["--user", "daemon-reload"]))
}

/// This entrypoint runs before Tauri's single-instance plugin or any WebView initialization.
pub fn run_if_requested() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    let managed = args.iter().any(|a| a == "--managed-backup-worker");
    let ui = args.iter().any(|a| a == "--ui-backup-worker");
    if !managed && !ui && !args.iter().any(|a| a == "--backup-worker") {
        return false;
    }
    let result = (|| {
        let index = args.iter().position(|a| a == "--data-dir").ok_or("--data-dir is required for backup workers")?;
        let dir = PathBuf::from(args.get(index + 1).ok_or("--data-dir requires a path")?);
        if !dir.is_absolute() || !dir.join("dbx.db").is_file() {
            return Err("Worker requires an existing absolute DBX data directory".to_string());
        }
        let lease = args.iter().position(|a| a == "--ui-lease").and_then(|i| args.get(i + 1)).map(PathBuf::from);
        if ui && lease.is_none() {
            return Err("UI worker requires a lease".into());
        }
        if managed && !marker(&dir).exists() {
            return Ok(());
        }
        worker_logging(&dir)?;
        let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().map_err(|e| e.to_string())?;
        let result = runtime.block_on(async {
            let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
            dbx_core::sql_dialect::dialect_loader::register_core_dialects();
            let storage = Storage::open(&dir.join("dbx.db")).await?;
            let state = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
            let stop = CancellationToken::new();
            let drain = CancellationToken::new();
            let service = BackupService::new(state.clone(), &dir, None);
            let worker = service.start_with_drain(stop.clone(), drain.clone());
            #[cfg(unix)]
            let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|e| e.to_string())?;
            loop {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => break,
                    _ = async { #[cfg(unix)] { terminate.recv().await; } #[cfg(not(unix))] { std::future::pending::<()>().await; } } => break,
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {
                        if worker.is_finished() { break; }
                        let ui_alive = lease.as_ref().and_then(|p| std::fs::metadata(p).ok()).and_then(|m| m.modified().ok())
                            .and_then(|time| time.elapsed().ok()).is_some_and(|age| age < Duration::from_secs(10));
                        if ui && !ui_alive && marker(&dir).exists() { drain.cancel(); }
                        if (managed || ui) && !marker(&dir).exists() && !(ui && ui_alive) { break; }
                    }
                }
            }
            stop.cancel();
            let _ = tokio::time::timeout(Duration::from_secs(60), worker).await;
            state.shutdown(Duration::from_secs(3)).await;
            Ok::<_, String>(())
        });
        // Runtime drop otherwise waits indefinitely for a stalled blocking export.
        runtime.shutdown_timeout(Duration::from_secs(3));
        result
    })();
    if let Err(error) = result {
        log::error!("DBX backup worker: {error}");
        eprintln!("DBX backup worker: {error}");
        std::process::exit(1);
    }
    true
}
