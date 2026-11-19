use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use russh::keys::{decode_secret_key, Error as KeysError, HashAlg};
use serde::Serialize;

/// A local SSH private key offered as a connection-form suggestion
/// (`private_key_path` plugin field convenience picker).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSshKey {
    /// Absolute path to the private key file.
    pub path: String,
    /// SSH algorithm name (for example `ssh-ed25519`); empty when undetectable.
    pub algorithm: String,
    /// SHA-256 fingerprint (`SHA256:...`); empty when the key could not be decoded.
    pub fingerprint: String,
    /// Heuristic: the key looks passphrase-protected.
    pub has_passphrase: bool,
}

const FIXED_KEY_NAMES: [&str; 5] = ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "identity"];

/// Lists private keys from `$HOME/.ssh` (well-known names, `id_*`, `*.pem`,
/// `*.key`) plus `IdentityFile` entries declared in `~/.ssh/config`.
#[tauri::command]
pub async fn list_local_ssh_keys() -> Result<Vec<LocalSshKey>, String> {
    tauri::async_runtime::spawn_blocking(list_local_ssh_keys_blocking).await.map_err(|err| err.to_string())?
}

fn list_local_ssh_keys_blocking() -> Result<Vec<LocalSshKey>, String> {
    let home = home_dir().ok_or_else(|| "Could not resolve the home directory".to_string())?;
    Ok(list_local_ssh_keys_in(&home))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok().map(PathBuf::from)
}

fn list_local_ssh_keys_in(home: &Path) -> Vec<LocalSshKey> {
    let mut candidates: BTreeSet<PathBuf> = scan_ssh_directory(&home.join(".ssh")).into_iter().collect();
    for identity in ssh_config_identity_files() {
        if let Some(path) = resolve_identity_file(&identity, home) {
            candidates.insert(path);
        }
    }
    candidates.into_iter().filter(|path| path.is_file()).map(|path| inspect_local_ssh_key(&path)).collect()
}

/// Fixed well-known names plus `id_*` / `*.pem` / `*.key` globs, skipping `.pub`.
fn is_candidate_key_file(name: &str) -> bool {
    if name.starts_with('.') || name.ends_with(".pub") {
        return false;
    }
    FIXED_KEY_NAMES.contains(&name) || name.starts_with("id_") || name.ends_with(".pem") || name.ends_with(".key")
}

fn scan_ssh_directory(ssh_dir: &Path) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(ssh_dir) else {
        return entries;
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else { continue };
        if path.is_file() && is_candidate_key_file(name) {
            entries.push(path);
        }
    }
    entries
}

fn ssh_config_identity_files() -> Vec<String> {
    dbx_core::ssh_config::list_hosts().unwrap_or_default().into_iter().filter_map(|entry| entry.identity_file).collect()
}

/// Expands `~`-prefixed and absolute paths as-is; relative `IdentityFile`
/// values are interpreted relative to `~/.ssh` (OpenSSH behavior).
fn resolve_identity_file(raw: &str, home: &Path) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let path = if let Some(rest) = raw.strip_prefix('~') {
        let rest = rest.strip_prefix('/').or_else(|| rest.strip_prefix('\\')).unwrap_or(rest);
        if rest.is_empty() {
            home.to_path_buf()
        } else {
            home.join(rest)
        }
    } else if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        home.join(".ssh").join(raw)
    };
    Some(path)
}

/// Reads the key and derives algorithm/fingerprint via `russh::keys`.
/// Undecodable and encrypted keys are still listed.
fn inspect_local_ssh_key(path: &Path) -> LocalSshKey {
    let bytes = std::fs::read(path).unwrap_or_default();
    let content = String::from_utf8_lossy(&bytes);
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");

    let (algorithm, fingerprint, has_passphrase) = match decode_secret_key(&content, None) {
        Ok(key) => (key.algorithm().to_string(), key.public_key().fingerprint(HashAlg::Sha256).to_string(), false),
        Err(KeysError::KeyIsEncrypted) => (String::new(), String::new(), true),
        Err(_) => (String::new(), String::new(), false),
    };

    let algorithm = if algorithm.is_empty() { guess_algorithm_from_name(file_name) } else { algorithm };
    let has_passphrase = has_passphrase || content.contains("ENCRYPTED");

    LocalSshKey { path: path.display().to_string(), algorithm, fingerprint, has_passphrase }
}

/// Fallback for keys that cannot be decoded: infer the algorithm from the name.
fn guess_algorithm_from_name(file_name: &str) -> String {
    let lower = file_name.to_ascii_lowercase();
    if lower.contains("ed25519") {
        "ssh-ed25519".to_string()
    } else if lower.contains("ecdsa") {
        "ecdsa".to_string()
    } else if lower.contains("dsa") {
        "ssh-dss".to_string()
    } else if lower.contains("rsa") {
        "ssh-rsa".to_string()
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_ED25519_KEY: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAVDlhwKBk+QMZN+WNAUKL6qLr3hf3S5p1TdSK4hMhLxwAAAJD9wI28/cCN
vAAAAAtzc2gtZWQyNTUxOQAAACAVDlhwKBk+QMZN+WNAUKL6qLr3hf3S5p1TdSK4hMhLxw
AAAEDxqdMQX37UdhziSi5Br3kyRM/Xrpo9ZcXoguYkeogq0hUOWHAoGT5Axk35Y0BQovqo
uveF/dLmnVN1IriEyEvHAAAACGRieC10ZXN0AQIDBAU=
-----END OPENSSH PRIVATE KEY-----"#;

    #[test]
    fn filters_candidate_key_files() {
        assert!(is_candidate_key_file("id_rsa"));
        assert!(is_candidate_key_file("id_ed25519"));
        assert!(is_candidate_key_file("identity"));
        assert!(is_candidate_key_file("id_deploy_company"));
        assert!(is_candidate_key_file("server.pem"));
        assert!(is_candidate_key_file("client.key"));
        assert!(!is_candidate_key_file("id_rsa.pub"));
        assert!(!is_candidate_key_file("known_hosts"));
        assert!(!is_candidate_key_file("authorized_keys"));
        assert!(!is_candidate_key_file("config"));
    }

    #[test]
    fn resolves_identity_file_paths() {
        let home = Path::new("/home/dev");
        assert_eq!(resolve_identity_file("~/.ssh/id_ed25519", home), Some(PathBuf::from("/home/dev/.ssh/id_ed25519")));
        assert_eq!(resolve_identity_file("id_ed25519", home), Some(PathBuf::from("/home/dev/.ssh/id_ed25519")));
        assert_eq!(resolve_identity_file("/opt/keys/prod", home), Some(PathBuf::from("/opt/keys/prod")));
        assert_eq!(resolve_identity_file("  ", home), None);
    }

    #[test]
    fn decodes_key_algorithm_and_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id_ed25519");
        std::fs::write(&path, TEST_ED25519_KEY).unwrap();

        let key = inspect_local_ssh_key(&path);

        assert_eq!(key.algorithm, "ssh-ed25519");
        assert!(key.fingerprint.starts_with("SHA256:"));
        assert!(!key.has_passphrase);
    }

    #[test]
    fn lists_undecodable_and_encrypted_keys_without_failing() {
        let dir = tempfile::tempdir().unwrap();
        let ssh_dir = dir.path().join(".ssh");
        std::fs::create_dir_all(&ssh_dir).unwrap();
        std::fs::write(ssh_dir.join("id_ed25519"), b"not a key").unwrap();
        std::fs::write(ssh_dir.join("legacy_rsa.pem"), "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n")
            .unwrap();
        std::fs::write(ssh_dir.join("id_rsa.pub"), b"public part").unwrap();
        std::fs::write(ssh_dir.join("known_hosts"), b"# hosts").unwrap();

        let keys = list_local_ssh_keys_in(dir.path());
        let by_name = |name: &str| keys.iter().find(|key| key.path.ends_with(name)).cloned().unwrap();

        let undecodable = by_name("id_ed25519");
        assert_eq!(undecodable.algorithm, "ssh-ed25519");
        assert!(undecodable.fingerprint.is_empty());
        assert!(!undecodable.has_passphrase);

        let encrypted = by_name("legacy_rsa.pem");
        assert_eq!(encrypted.algorithm, "ssh-rsa");
        assert!(encrypted.has_passphrase);
        assert!(!keys.iter().any(|key| key.path.ends_with(".pub")));
        assert!(!keys.iter().any(|key| key.path.ends_with("known_hosts")));
    }
}
