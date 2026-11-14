//! Retries for filesystem operations that security software can briefly block.
//!
//! Real-time antivirus/EDR scanners open a file right after it is written. On Windows a
//! directory rename is rejected with `ERROR_ACCESS_DENIED` (5) while any file below it is
//! still open, even when the opening handle allows delete sharing, and file operations can
//! fail with `ERROR_SHARING_VIOLATION` (32). The scan normally finishes well inside this
//! retry window, so callers can keep a single atomic rename as their commit point instead
//! of falling back to a non-atomic write protocol.

use std::path::Path;
use std::time::Duration;

/// Field reports put the scan window at roughly 1-2 seconds for a large installer, so this
/// budget gives the scanner several times that window. The plugin installer and the desktop
/// updater share it deliberately: both commit by renaming a freshly written package.
pub const TRANSIENT_LOCK_RETRY_DELAYS: [Duration; 5] = [
    Duration::from_millis(200),
    Duration::from_millis(400),
    Duration::from_millis(800),
    Duration::from_millis(1500),
    Duration::from_millis(2000),
];

/// Rename `src` to `dst`, retrying the transient Windows locks described above.
pub fn rename_with_transient_lock_retry(src: &Path, dst: &Path) -> std::io::Result<()> {
    retry_transient_lock(&TRANSIENT_LOCK_RETRY_DELAYS, || std::fs::rename(src, dst))
}

/// Run `operation`, sleeping for each entry in `delays` after a transient Windows lock error.
///
/// Every other error is returned immediately. After the last delay the operation is tried
/// once more, so at most `delays.len() + 1` attempts are made and the final error is the
/// original one.
pub fn retry_transient_lock<T>(
    delays: &[Duration],
    mut operation: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    for delay in delays {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if cfg!(windows) && is_windows_lock_error(&error) => std::thread::sleep(*delay),
            Err(error) => return Err(error),
        }
    }
    operation()
}

fn is_windows_lock_error(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32))
}

#[cfg(test)]
mod tests {
    use super::retry_transient_lock;
    use std::time::Duration;

    #[test]
    #[cfg(windows)]
    fn transient_lock_retry_recovers_from_windows_lock_errors() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        for code in [5, 32] {
            let attempts = AtomicUsize::new(0);
            let result = retry_transient_lock(&[Duration::ZERO, Duration::ZERO, Duration::ZERO], || {
                if attempts.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err(std::io::Error::from_raw_os_error(code))
                } else {
                    Ok(())
                }
            });
            assert!(result.is_ok());
            assert_eq!(attempts.load(Ordering::SeqCst), 3);
        }
    }

    #[test]
    #[cfg(windows)]
    fn transient_lock_retry_returns_last_error_after_exhausting_delays() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let attempts = AtomicUsize::new(0);
        let result: std::io::Result<()> = retry_transient_lock(&[Duration::ZERO], || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::from_raw_os_error(5))
        });
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(result.unwrap_err().raw_os_error(), Some(5));
    }

    #[test]
    fn transient_lock_retry_does_not_retry_other_errors() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let attempts = AtomicUsize::new(0);
        let result: std::io::Result<()> = retry_transient_lock(&[Duration::ZERO; 3], || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::from_raw_os_error(2))
        });
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(result.unwrap_err().raw_os_error(), Some(2));
    }

    #[test]
    #[cfg(unix)]
    fn transient_lock_retry_treats_windows_lock_codes_as_final_on_unix() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        // Raw code 5 on Unix is EIO, not a Windows lock error, so the retry gate must leave it final.
        let attempts = AtomicUsize::new(0);
        let result: std::io::Result<()> = retry_transient_lock(&[Duration::ZERO; 3], || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::from_raw_os_error(5))
        });
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(result.unwrap_err().raw_os_error(), Some(5));
    }
}
