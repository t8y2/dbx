use std::fs::{self, Metadata};
use std::io;
use std::path::Path;
use std::time::{Duration, SystemTime};

/// A killed install leaves its working directory behind; only sweep it once it is
/// clearly abandoned, so a concurrent install never loses the directory it is using.
const INSTALL_DIRECTORY_MINIMUM_AGE: Duration = Duration::from_secs(60 * 60);

fn is_replacement_temp_file(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.strip_prefix("dbx-mcp.exe")
        .and_then(|suffix| suffix.strip_prefix('~').or_else(|| suffix.strip_prefix('.')))
        .and_then(|suffix| suffix.strip_prefix("rf"))
        .and_then(|suffix| suffix.strip_suffix(".tmp"))
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// `.dbx-mcp-install.<guid N>`: the working directory one installer run creates.
/// Its `finally` cleanup never runs when the install is hard-killed (#13009).
fn is_install_work_directory(name: &str) -> bool {
    name.to_ascii_lowercase()
        .strip_prefix(".dbx-mcp-install.")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn is_older_than(metadata: &Metadata, age: Duration) -> bool {
    metadata
        .modified()
        .is_ok_and(|modified| SystemTime::now().duration_since(modified).is_ok_and(|elapsed| elapsed >= age))
}

fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

pub(super) fn cleanup_directory(directory: &Path) -> io::Result<usize> {
    sweep(directory, INSTALL_DIRECTORY_MINIMUM_AGE)
}

fn sweep(directory: &Path, minimum_install_age: Duration) -> io::Result<usize> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    if !metadata.is_dir() || is_link(&metadata) {
        return Ok(0);
    }

    let mut removed = 0;
    for entry in fs::read_dir(directory)? {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else { continue };
        // Never follow links; a matching name does not make the target ours. Locked
        // leftovers can be retried next launch.
        if is_link(&metadata) {
            continue;
        }
        if metadata.is_dir() {
            if is_install_work_directory(&name)
                && is_older_than(&metadata, minimum_install_age)
                && fs::remove_dir_all(&path).is_ok()
            {
                removed += 1;
            }
            continue;
        }
        if !metadata.is_file() || !is_replacement_temp_file(&name) {
            continue;
        }
        // A READONLY attribute makes fs::remove_file fail with Access Denied on
        // Windows, so one read-only leftover would otherwise survive every
        // startup pass. Clear the attribute (the name pattern is strict enough)
        // before deleting. This is Windows-only: on Unix unlinking only needs a
        // writable directory, and clearing the write bits would widen the mode
        // to 0666 if the delete failed. The clear is best-effort so a failed
        // attribute write never skips the delete attempt.
        #[cfg(windows)]
        if metadata.permissions().readonly() {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(false);
            let _ = fs::set_permissions(&path, permissions);
        }
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_DIRECTORY_ID: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let sequence = NEXT_DIRECTORY_ID.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("dbx-mcp-cleanup-{}-{nonce}-{sequence}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn recognizes_only_mcp_replacement_temp_names() {
        for name in [
            "dbx-mcp.exe~RF8c73e4f.TMP",
            "DBX-MCP.EXE~rfAb123.tmp",
            "dbx-mcp.exe~RF1.TMP",
            "dbx-mcp.exe.RF1A2B3C4D.TMP",
            "DBX-MCP.EXE.rfabc.tmp",
        ] {
            assert!(is_replacement_temp_file(name), "{name}");
        }
        for name in [
            "dbx-mcp.exe",
            ".dbx-mcp-version",
            "dbx-mcp.exe~RF.TMP",
            "dbx-mcp.exe~RFxyz.TMP",
            "dbx-mcp.exe~RF123.TMP.bak",
            "dbx-mcp.exe~RF123.TMP\n",
            "other.exe~RF123.TMP",
            "dbx-mcp.exe.tmp",
            "dbx-mcp.exe.RF.TMP",
            "dbx-mcp.exe.RFxyz.TMP",
            "dbx-mcp.exe.1234.TMP",
        ] {
            assert!(!is_replacement_temp_file(name), "{name}");
        }
    }

    #[test]
    fn removes_only_abandoned_install_work_directories() {
        let directory = TestDirectory::new();
        let abandoned = directory.0.join(".dbx-mcp-install.0123456789abcdef0123456789abcdef");
        fs::create_dir(&abandoned).unwrap();
        fs::write(abandoned.join("npm.tgz"), b"partial download").unwrap();
        let unrelated = directory.0.join(".dbx-mcp-install.not-a-guid");
        fs::create_dir(&unrelated).unwrap();

        assert_eq!(sweep(&directory.0, Duration::ZERO).unwrap(), 1);
        assert!(!abandoned.exists());
        assert!(unrelated.exists());

        let live = directory.0.join(".dbx-mcp-install.fedcba9876543210fedcba9876543210");
        fs::create_dir(&live).unwrap();
        assert_eq!(sweep(&directory.0, INSTALL_DIRECTORY_MINIMUM_AGE).unwrap(), 0);
        assert!(live.exists());
    }

    #[test]
    fn removes_only_matching_files_without_recursing() {
        let directory = TestDirectory::new();
        let stale = ["dbx-mcp.exe~RF8c73e4f.TMP", "DBX-MCP.EXE~rfABC123.tmp"];
        let preserved = ["dbx-mcp.exe", ".dbx-mcp-version", "other.tmp", "dbx-mcp.exe~RFxyz.TMP"];
        for name in stale.iter().chain(preserved.iter()) {
            fs::write(directory.0.join(name), b"original contents").unwrap();
        }
        let nested = directory.0.join("dbx-mcp.exe~RF123.TMP");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join(stale[0]), b"nested contents").unwrap();

        assert_eq!(cleanup_directory(&directory.0).unwrap(), stale.len());
        for name in stale {
            assert!(!directory.0.join(name).exists());
        }
        for name in preserved {
            assert_eq!(fs::read(directory.0.join(name)).unwrap(), b"original contents");
        }
        assert_eq!(fs::read(nested.join(stale[0])).unwrap(), b"nested contents");
        assert_eq!(cleanup_directory(&directory.0).unwrap(), 0);
    }

    #[test]
    fn missing_directory_is_a_noop() {
        let directory = TestDirectory::new();
        let missing = directory.0.join("missing");
        assert_eq!(cleanup_directory(&missing).unwrap(), 0);
        assert!(!missing.exists());
    }

    #[test]
    fn removes_read_only_leftovers() {
        let directory = TestDirectory::new();
        let readonly_path = directory.0.join("dbx-mcp.exe~RF8c73e4f.TMP");
        fs::write(&readonly_path, b"readonly leftover").unwrap();
        let mut permissions = fs::metadata(&readonly_path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&readonly_path, permissions).unwrap();
        assert!(fs::metadata(&readonly_path).unwrap().permissions().readonly());

        assert_eq!(cleanup_directory(&directory.0).unwrap(), 1);
        assert!(!readonly_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn skips_symlinked_files_and_directories() {
        use std::os::unix::fs::symlink;

        let directory = TestDirectory::new();
        let target = TestDirectory::new();
        let target_file = target.0.join("dbx-mcp.exe~RF123.TMP");
        fs::write(&target_file, b"keep").unwrap();
        let file_link = directory.0.join("dbx-mcp.exe~RFabc.TMP");
        symlink(&target_file, &file_link).unwrap();
        let dir_link = directory.0.join("linked-bin");
        symlink(&target.0, &dir_link).unwrap();
        let work_link = directory.0.join(".dbx-mcp-install.0123456789abcdef0123456789abcdef");
        symlink(&target.0, &work_link).unwrap();

        assert_eq!(cleanup_directory(&directory.0).unwrap(), 0);
        assert_eq!(cleanup_directory(&dir_link).unwrap(), 0);
        assert!(work_link.symlink_metadata().unwrap().file_type().is_symlink());
        assert!(file_link.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read(&target_file).unwrap(), b"keep");
    }

    #[cfg(windows)]
    #[test]
    fn skips_locked_files_and_retries_after_release() {
        use std::os::windows::fs::OpenOptionsExt;

        let directory = TestDirectory::new();
        let locked_path = directory.0.join("dbx-mcp.exe~RF123.TMP");
        fs::write(&locked_path, b"locked").unwrap();
        let locked = fs::OpenOptions::new().read(true).share_mode(0).open(&locked_path).unwrap();
        let unlocked_path = directory.0.join("dbx-mcp.exe~RF456.TMP");
        fs::write(&unlocked_path, b"unlocked").unwrap();

        assert_eq!(cleanup_directory(&directory.0).unwrap(), 1);
        assert!(locked_path.exists());
        assert!(!unlocked_path.exists());
        drop(locked);
        assert_eq!(cleanup_directory(&directory.0).unwrap(), 1);
        assert!(!locked_path.exists());
    }
}
