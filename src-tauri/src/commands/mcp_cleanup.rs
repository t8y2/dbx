use std::fs::{self, Metadata};
use std::io;
use std::path::Path;

fn is_replacement_temp_file(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.strip_prefix("dbx-mcp.exe~rf")
        .and_then(|suffix| suffix.strip_suffix(".tmp"))
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
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
        if !entry.file_name().to_str().is_some_and(is_replacement_temp_file) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else { continue };
        // Never recurse or follow links; locked/read-only leftovers can be retried next launch.
        if metadata.is_file() && !is_link(&metadata) && fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("dbx-mcp-cleanup-{}-{nonce}", std::process::id()));
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
        for name in ["dbx-mcp.exe~RF8c73e4f.TMP", "DBX-MCP.EXE~rfAb123.tmp", "dbx-mcp.exe~RF1.TMP"] {
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
        ] {
            assert!(!is_replacement_temp_file(name), "{name}");
        }
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

        assert_eq!(cleanup_directory(&directory.0).unwrap(), 0);
        assert_eq!(cleanup_directory(&dir_link).unwrap(), 0);
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
