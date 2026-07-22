use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
#[cfg(any(target_os = "windows", test))]
use std::io::{Cursor, Read};

#[cfg(any(target_os = "windows", test))]
const MAX_PORTABLE_EXECUTABLE_BYTES: usize = 256 * 1024 * 1024;
const EMBEDDED_TAURI_CONFIG: &str = include_str!("../../tauri.conf.json");

pub(super) fn portable_asset_name(version: &str, arch: &str) -> Result<String, String> {
    let version = version.trim().trim_start_matches('v');
    let version = Version::parse(version).map_err(|error| format!("Invalid portable update version: {error}"))?;
    let arch = match arch {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => return Err(format!("Portable updates are not available for architecture {other}.")),
    };
    Ok(format!("DBX_{version}_{arch}-portable.zip"))
}

pub(super) fn verify_portable_archive(archive: &[u8], encoded_signature: &str) -> Result<(), String> {
    let config: serde_json::Value = serde_json::from_str(EMBEDDED_TAURI_CONFIG)
        .map_err(|error| format!("Failed to read embedded updater configuration: {error}"))?;
    let encoded_public_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Embedded updater public key is missing.".to_string())?;
    let public_key_text = decode_tauri_text(encoded_public_key, "public key")?;
    let signature_text = decode_tauri_text(encoded_signature.trim(), "signature")?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|error| format!("Failed to decode portable update public key: {error}"))?;
    let signature = Signature::decode(&signature_text)
        .map_err(|error| format!("Failed to decode portable update signature: {error}"))?;
    public_key
        .verify(archive, &signature, true)
        .map_err(|error| format!("Portable update signature verification failed: {error}"))
}

fn decode_tauri_text(value: &str, label: &str) -> Result<String, String> {
    let decoded =
        BASE64_STANDARD.decode(value).map_err(|error| format!("Invalid updater {label} encoding: {error}"))?;
    String::from_utf8(decoded).map_err(|error| format!("Updater {label} is not valid UTF-8: {error}"))
}

#[cfg(any(target_os = "windows", test))]
fn portable_executable_from_archive(archive: &[u8]) -> Result<Vec<u8>, String> {
    let reader = Cursor::new(archive);
    let mut archive = zip::ZipArchive::new(reader).map_err(|error| format!("Invalid portable update ZIP: {error}"))?;
    let mut candidate: Option<(usize, usize)> = None;

    for index in 0..archive.len() {
        let file =
            archive.by_index(index).map_err(|error| format!("Failed to inspect portable update ZIP: {error}"))?;
        if file.is_dir() {
            continue;
        }
        let Some(path) = file.enclosed_name() else { continue };
        let Some(file_name) = path.file_name().and_then(std::ffi::OsStr::to_str) else { continue };
        if !file_name.eq_ignore_ascii_case("DBX.exe") {
            continue;
        }
        let depth = path.components().count();
        if candidate.map_or(true, |(_, current_depth)| depth < current_depth) {
            candidate = Some((index, depth));
        }
    }

    let (index, _) = candidate.ok_or_else(|| "Portable update ZIP does not contain DBX.exe.".to_string())?;
    let mut file = archive.by_index(index).map_err(|error| format!("Failed to open DBX.exe in update ZIP: {error}"))?;
    if file.size() > MAX_PORTABLE_EXECUTABLE_BYTES as u64 {
        return Err("Portable update executable is unexpectedly large.".to_string());
    }
    let mut executable = Vec::with_capacity(file.size() as usize);
    file.by_ref()
        .take((MAX_PORTABLE_EXECUTABLE_BYTES + 1) as u64)
        .read_to_end(&mut executable)
        .map_err(|error| format!("Failed to extract DBX.exe from update ZIP: {error}"))?;
    if executable.len() > MAX_PORTABLE_EXECUTABLE_BYTES {
        return Err("Portable update executable is unexpectedly large.".to_string());
    }
    if !executable.starts_with(b"MZ") {
        return Err("Portable update executable is not a valid Windows executable.".to_string());
    }
    Ok(executable)
}

#[cfg(target_os = "windows")]
pub(super) fn launch_portable_update_helper(archive: &[u8], _version: &str) -> Result<(), String> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    let current_exe =
        std::env::current_exe().map_err(|error| format!("Failed to locate the portable executable: {error}"))?;
    let exe_dir = current_exe.parent().ok_or_else(|| "Portable executable directory is unavailable.".to_string())?;
    if !exe_dir.join("portable.dbx").is_file() {
        return Err("Portable update marker is missing beside DBX.exe.".to_string());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is unavailable: {error}"))?
        .as_nanos();
    let update_id = format!("{}-{timestamp}", std::process::id());
    let write_probe = exe_dir.join(format!(".dbx-update-{update_id}.probe"));
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&write_probe)
        .map_err(|error| format!("The portable DBX directory is not writable: {error}"))?;
    fs::remove_file(&write_probe)
        .map_err(|error| format!("Failed to finish portable directory write check: {error}"))?;

    let staging_dir = std::env::temp_dir().join(format!("dbx-portable-update-{update_id}"));
    fs::create_dir(&staging_dir)
        .map_err(|error| format!("Failed to create portable update staging directory: {error}"))?;
    let staged_exe = staging_dir.join("DBX.exe.new");
    let script_path = staging_dir.join("apply-update.ps1");
    let backup_exe = exe_dir.join(format!(".DBX-{update_id}.old.exe"));

    let prepare_result = (|| -> Result<(), String> {
        let executable = portable_executable_from_archive(archive)?;
        let mut staged_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged_exe)
            .map_err(|error| format!("Failed to stage portable DBX executable: {error}"))?;
        staged_file
            .write_all(&executable)
            .and_then(|_| staged_file.sync_all())
            .map_err(|error| format!("Failed to write portable DBX executable: {error}"))?;
        fs::write(&script_path, PORTABLE_UPDATE_SCRIPT)
            .map_err(|error| format!("Failed to create portable update helper: {error}"))?;

        Command::new("powershell.exe")
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&script_path)
            .arg("-ParentProcessId")
            .arg(std::process::id().to_string())
            .arg("-SourceExe")
            .arg(&staged_exe)
            .arg("-TargetExe")
            .arg(&current_exe)
            .arg("-BackupExe")
            .arg(&backup_exe)
            .arg("-StagingDir")
            .arg(&staging_dir)
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
            .spawn()
            .map_err(|error| format!("Failed to start portable update helper: {error}"))?;
        Ok(())
    })();

    if prepare_result.is_err() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    prepare_result
}

#[cfg(not(target_os = "windows"))]
pub(super) fn launch_portable_update_helper(_archive: &[u8], _version: &str) -> Result<(), String> {
    Err("Portable updates are only supported on Windows.".to_string())
}

#[cfg(target_os = "windows")]
const PORTABLE_UPDATE_SCRIPT: &str = r#"param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [Parameter(Mandatory = $true)][string]$SourceExe,
    [Parameter(Mandatory = $true)][string]$TargetExe,
    [Parameter(Mandatory = $true)][string]$BackupExe,
    [Parameter(Mandatory = $true)][string]$StagingDir
)

$ErrorActionPreference = 'Stop'
Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
try { Wait-Process -Id $ParentProcessId -Timeout 120 -ErrorAction SilentlyContinue } catch {}

$installed = $false
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
        if (Test-Path -LiteralPath $TargetExe) {
            if (Test-Path -LiteralPath $BackupExe) {
                Remove-Item -LiteralPath $BackupExe -Force
            }
            Move-Item -LiteralPath $TargetExe -Destination $BackupExe -Force
        }

        if (-not (Test-Path -LiteralPath $BackupExe)) {
            throw 'The existing DBX executable could not be backed up.'
        }

        Move-Item -LiteralPath $SourceExe -Destination $TargetExe -Force
        $installed = $true
        break
    } catch {
        if (-not (Test-Path -LiteralPath $TargetExe) -and (Test-Path -LiteralPath $BackupExe)) {
            try { Copy-Item -LiteralPath $BackupExe -Destination $TargetExe -Force } catch {}
        }
        Start-Sleep -Seconds 1
    }
}

if (-not $installed) {
    if (-not (Test-Path -LiteralPath $TargetExe) -and (Test-Path -LiteralPath $BackupExe)) {
        try { Copy-Item -LiteralPath $BackupExe -Destination $TargetExe -Force } catch {}
    }
    exit 1
}

try {
    Start-Process -FilePath $TargetExe -WorkingDirectory (Split-Path -Parent $TargetExe)
} catch {
    try {
        if (Test-Path -LiteralPath $TargetExe) { Remove-Item -LiteralPath $TargetExe -Force }
        if (Test-Path -LiteralPath $BackupExe) { Move-Item -LiteralPath $BackupExe -Destination $TargetExe -Force }
        Start-Process -FilePath $TargetExe -WorkingDirectory (Split-Path -Parent $TargetExe)
    } catch {}
    exit 1
}

Remove-Item -LiteralPath $BackupExe -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
exit 0
"#;

#[cfg(test)]
mod tests {
    use super::{decode_tauri_text, portable_asset_name, portable_executable_from_archive};
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use std::io::{Cursor, Write};

    fn portable_zip(path: &str, executable: &[u8]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        zip.start_file(path, options).unwrap();
        zip.write_all(executable).unwrap();
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn builds_portable_asset_names_for_windows_architectures() {
        assert_eq!(portable_asset_name("0.5.64", "x86_64").unwrap(), "DBX_0.5.64_x64-portable.zip");
        assert_eq!(portable_asset_name("v0.5.64-beta.1", "aarch64").unwrap(), "DBX_0.5.64-beta.1_arm64-portable.zip");
        assert!(portable_asset_name("0.5.64", "x86").is_err());
        assert!(portable_asset_name("../../0.5.64", "x86_64").is_err());
    }

    #[test]
    fn decodes_tauri_base64_text() {
        let encoded = BASE64_STANDARD.encode("untrusted comment: test\nAAAA");
        assert_eq!(decode_tauri_text(&encoded, "test").unwrap(), "untrusted comment: test\nAAAA");
    }

    #[test]
    fn extracts_the_portable_executable_without_using_archive_paths() {
        let archive = portable_zip("nested/DBX.exe", b"MZportable executable");
        assert_eq!(portable_executable_from_archive(&archive).unwrap(), b"MZportable executable");
    }

    #[test]
    fn rejects_archives_without_a_windows_executable() {
        let archive = portable_zip("DBX.exe", b"not a PE file");
        assert!(portable_executable_from_archive(&archive).is_err());
    }
}
