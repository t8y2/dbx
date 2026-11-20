// SPDX-License-Identifier: Apache-2.0 OR MIT

pub(crate) fn scoped_identifier(identifier: &str, secret: Option<&str>) -> String {
    match secret {
        Some(secret) => format!("{identifier}.profile{secret}"),
        None => identifier.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::scoped_identifier;

    #[test]
    fn preserves_unscoped_identifiers() {
        assert_eq!(scoped_identifier("com.dbx.app", None), "com.dbx.app");
    }

    #[test]
    fn namespaces_every_endpoint_by_the_profile_secret() {
        let first = scoped_identifier("com.dbx.app", Some("0123456789abcdef0123456789abcdef"));
        assert_eq!(first, scoped_identifier("com.dbx.app", Some("0123456789abcdef0123456789abcdef")));
        assert_ne!(first, scoped_identifier("com.dbx.app", Some("fedcba9876543210fedcba9876543210")));
        assert!(first.len() + "/tmp/_si.sock".len() < 100);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_kernel_locks_are_exclusive_per_profile_and_released_on_close() {
        use std::{ffi::c_void, os::windows::ffi::OsStrExt};
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS},
            System::Threading::CreateMutexW,
        };
        struct Handle(*mut c_void);
        impl Drop for Handle {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        let base = format!(
            "com.dbx.test.{}.{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        );
        let name = |secret| {
            std::ffi::OsStr::new(&format!("{}-sim", scoped_identifier(&base, Some(secret))))
                .encode_wide()
                .chain(Some(0))
                .collect::<Vec<_>>()
        };
        let open = |name: &[u16]| unsafe {
            SetLastError(0);
            let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            let error = GetLastError();
            assert!(!handle.is_null());
            (Handle(handle), error == ERROR_ALREADY_EXISTS)
        };
        let a = name("aaa");
        let b = name("bbb");
        let (first, existed) = open(&a);
        assert!(!existed);
        let (second, existed) = open(&a);
        assert!(existed);
        let (other_profile, existed) = open(&b);
        assert!(!existed);
        drop(second);
        drop(first);
        let (_reopened, existed) = open(&a);
        assert!(!existed);
        drop(other_profile);
    }
}
