use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};

const MAX_PORTABLE_EXECUTABLE_BYTES: usize = 256 * 1024 * 1024;
const MAX_PORTABLE_MANIFEST_BYTES: usize = 16 * 1024;
const EMBEDDED_TAURI_CONFIG: &str = include_str!("../../tauri.conf.json");
const PORTABLE_EXECUTABLE_NAME: &str = "DBX.exe";
const PORTABLE_UPDATE_MANIFEST_NAME: &str = "portable-update.json";
const PORTABLE_UPDATE_MANIFEST_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
struct PortableUpdateManifest {
    schema_version: u32,
    version: String,
    arch: String,
    executable: String,
    executable_sha256: String,
}

pub(super) fn validate_requested_portable_version(
    requested_version: &str,
    current_version: &str,
) -> Result<Version, String> {
    let requested = parse_portable_version(requested_version, "requested")?;
    ensure_portable_version_is_newer(&requested, current_version)?;
    Ok(requested)
}

pub(super) fn ensure_portable_version_is_newer(
    requested_version: &Version,
    current_version: &str,
) -> Result<(), String> {
    let current = parse_portable_version(current_version, "current app")?;
    if requested_version <= &current {
        return Err(format!(
            "Portable update version {requested_version} must be newer than the current version {current}."
        ));
    }
    Ok(())
}

fn parse_portable_version(value: &str, label: &str) -> Result<Version, String> {
    let value = value.trim();
    let value = value.strip_prefix('v').unwrap_or(value);
    Version::parse(value).map_err(|error| format!("Invalid {label} portable update version: {error}"))
}

fn portable_arch_label(arch: &str) -> Result<&'static str, String> {
    match arch {
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("arm64"),
        other => Err(format!("Portable updates are not available for architecture {other}.")),
    }
}

pub(super) fn portable_asset_name(version: &str, arch: &str) -> Result<String, String> {
    let version = parse_portable_version(version, "requested")?;
    let arch = portable_arch_label(arch)?;
    Ok(format!("DBX_{version}_{arch}-portable.zip"))
}

pub(super) fn verify_portable_archive(
    archive: &[u8],
    encoded_signature: &str,
    expected_version: &Version,
    expected_arch: &str,
) -> Result<(), String> {
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
        .map_err(|error| format!("Portable update signature verification failed: {error}"))?;
    // The manifest lives inside the signed ZIP and hashes DBX.exe, binding the
    // requested version and architecture to the exact executable we install.
    validated_portable_executable(archive, expected_version, expected_arch).map(|_| ())
}

fn decode_tauri_text(value: &str, label: &str) -> Result<String, String> {
    let decoded =
        BASE64_STANDARD.decode(value).map_err(|error| format!("Invalid updater {label} encoding: {error}"))?;
    String::from_utf8(decoded).map_err(|error| format!("Updater {label} is not valid UTF-8: {error}"))
}

fn validated_portable_executable(
    archive: &[u8],
    expected_version: &Version,
    expected_arch: &str,
) -> Result<Vec<u8>, String> {
    let reader = Cursor::new(archive);
    let mut archive = zip::ZipArchive::new(reader).map_err(|error| format!("Invalid portable update ZIP: {error}"))?;
    let manifest = {
        let mut manifest_file = archive
            .by_name(PORTABLE_UPDATE_MANIFEST_NAME)
            .map_err(|_| format!("Portable update ZIP does not contain {PORTABLE_UPDATE_MANIFEST_NAME}."))?;
        if manifest_file.is_dir() || manifest_file.size() > MAX_PORTABLE_MANIFEST_BYTES as u64 {
            return Err("Portable update manifest is unexpectedly large or invalid.".to_string());
        }
        let mut manifest_bytes = Vec::with_capacity(manifest_file.size() as usize);
        manifest_file
            .by_ref()
            .take((MAX_PORTABLE_MANIFEST_BYTES + 1) as u64)
            .read_to_end(&mut manifest_bytes)
            .map_err(|error| format!("Failed to read portable update manifest: {error}"))?;
        if manifest_bytes.len() > MAX_PORTABLE_MANIFEST_BYTES {
            return Err("Portable update manifest is unexpectedly large.".to_string());
        }
        serde_json::from_slice::<PortableUpdateManifest>(&manifest_bytes)
            .map_err(|error| format!("Invalid portable update manifest: {error}"))?
    };

    if manifest.schema_version != PORTABLE_UPDATE_MANIFEST_SCHEMA_VERSION {
        return Err(format!("Unsupported portable update manifest schema version {}.", manifest.schema_version));
    }
    let manifest_version = parse_portable_version(&manifest.version, "manifest")?;
    if &manifest_version != expected_version {
        return Err(format!(
            "Portable update manifest version {manifest_version} does not match requested version {expected_version}."
        ));
    }
    let expected_arch = portable_arch_label(expected_arch)?;
    if manifest.arch != expected_arch {
        return Err(format!(
            "Portable update manifest architecture {} does not match the current architecture {expected_arch}.",
            manifest.arch
        ));
    }
    if manifest.executable != PORTABLE_EXECUTABLE_NAME {
        return Err(format!("Portable update manifest executable must be {PORTABLE_EXECUTABLE_NAME}."));
    }

    let mut file = archive
        .by_name(PORTABLE_EXECUTABLE_NAME)
        .map_err(|_| format!("Portable update ZIP does not contain {PORTABLE_EXECUTABLE_NAME}."))?;
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
    let executable_sha256 = sha256_hex(&executable);
    if !executable_sha256.eq_ignore_ascii_case(manifest.executable_sha256.trim()) {
        return Err("Portable update executable hash does not match the signed manifest.".to_string());
    }
    Ok(executable)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(target_os = "windows")]
pub(super) fn launch_portable_update_helper(archive: &[u8], version: &Version) -> Result<(), String> {
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
        let executable = validated_portable_executable(archive, version, std::env::consts::ARCH)?;
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
pub(super) fn launch_portable_update_helper(_archive: &[u8], _version: &Version) -> Result<(), String> {
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
    use super::{
        decode_tauri_text, portable_asset_name, sha256_hex, validate_requested_portable_version,
        validated_portable_executable, PORTABLE_EXECUTABLE_NAME, PORTABLE_UPDATE_MANIFEST_NAME,
        PORTABLE_UPDATE_MANIFEST_SCHEMA_VERSION,
    };
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use semver::Version;
    use std::io::{Cursor, Write};

    fn portable_zip(version: &str, arch: &str, executable: &[u8], executable_sha256: Option<&str>) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut zip = zip::ZipWriter::new(cursor);
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        let manifest = serde_json::json!({
            "schema_version": PORTABLE_UPDATE_MANIFEST_SCHEMA_VERSION,
            "version": version,
            "arch": arch,
            "executable": PORTABLE_EXECUTABLE_NAME,
            "executable_sha256": executable_sha256.map(ToOwned::to_owned).unwrap_or_else(|| sha256_hex(executable)),
        });
        zip.start_file(PORTABLE_UPDATE_MANIFEST_NAME, options).unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap()).unwrap();
        zip.start_file(PORTABLE_EXECUTABLE_NAME, options).unwrap();
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
    fn accepts_newer_portable_update_requests() {
        assert_eq!(validate_requested_portable_version("0.5.64", "0.5.63").unwrap(), Version::parse("0.5.64").unwrap());
    }

    #[test]
    fn rejects_equal_version_requests() {
        let error = validate_requested_portable_version("0.5.63", "0.5.63").unwrap_err();
        assert!(error.contains("must be newer"));
    }

    #[test]
    fn rejects_downgrade_requests() {
        let error = validate_requested_portable_version("0.5.62", "0.5.63").unwrap_err();
        assert!(error.contains("must be newer"));
    }

    #[test]
    fn decodes_tauri_base64_text() {
        let encoded = BASE64_STANDARD.encode("untrusted comment: test\nAAAA");
        assert_eq!(decode_tauri_text(&encoded, "test").unwrap(), "untrusted comment: test\nAAAA");
    }

    #[test]
    fn extracts_the_executable_bound_to_the_signed_manifest() {
        let archive = portable_zip("0.5.64", "x64", b"MZportable executable", None);
        assert_eq!(
            validated_portable_executable(&archive, &Version::parse("0.5.64").unwrap(), "x86_64").unwrap(),
            b"MZportable executable"
        );
    }

    #[test]
    fn rejects_archives_without_a_windows_executable() {
        let archive = portable_zip("0.5.64", "x64", b"not a PE file", None);
        assert!(validated_portable_executable(&archive, &Version::parse("0.5.64").unwrap(), "x86_64").is_err());
    }

    #[test]
    fn rejects_an_archive_whose_manifest_version_differs_from_the_request() {
        let archive = portable_zip("0.5.62", "x64", b"MZolder executable", None);
        let error = validated_portable_executable(&archive, &Version::parse("0.5.64").unwrap(), "x86_64").unwrap_err();
        assert!(error.contains("does not match requested version"));
    }

    #[test]
    fn rejects_an_executable_not_matching_the_signed_manifest_hash() {
        let archive = portable_zip("0.5.64", "x64", b"MZportable executable", Some(&"0".repeat(64)));
        let error = validated_portable_executable(&archive, &Version::parse("0.5.64").unwrap(), "x86_64").unwrap_err();
        assert!(error.contains("hash does not match"));
    }
}
