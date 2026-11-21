//! Redirect HKCU only inside this proof process, using a disposable volatile key.
use std::{io, ptr};
use windows_sys::Win32::System::Registry::*;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn checked(status: u32) -> io::Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(status as i32))
    }
}

pub struct RegistrySandbox {
    key: HKEY,
    path: Vec<u16>,
    redirected: bool,
}

impl RegistrySandbox {
    pub fn from_env() -> io::Result<Option<Self>> {
        let Ok(proxy) = std::env::var("DBX_PROOF_SYSTEM_PROXY") else {
            return Ok(None);
        };
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = wide(&format!("Software\\DBXIssue12277-{}-{stamp}", std::process::id()));
        let mut sandbox = Self { key: ptr::null_mut(), path, redirected: false };
        unsafe {
            checked(RegCreateKeyExW(
                HKEY_CURRENT_USER,
                sandbox.path.as_ptr(),
                0,
                ptr::null(),
                REG_OPTION_VOLATILE,
                KEY_ALL_ACCESS,
                ptr::null(),
                &mut sandbox.key,
                ptr::null_mut(),
            ))?;
        }
        let settings_path = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings");
        let mut settings = ptr::null_mut();
        unsafe {
            checked(RegCreateKeyExW(
                sandbox.key,
                settings_path.as_ptr(),
                0,
                ptr::null(),
                REG_OPTION_VOLATILE,
                KEY_ALL_ACCESS,
                ptr::null(),
                &mut settings,
                ptr::null_mut(),
            ))?;
            let setup = (|| -> io::Result<()> {
                let enabled =
                    if std::env::var("DBX_PROOF_SYSTEM_ENABLED").as_deref() == Ok("0") { 0_u32 } else { 1_u32 };
                checked(RegSetValueExW(
                    settings,
                    wide("ProxyEnable").as_ptr(),
                    0,
                    REG_DWORD,
                    enabled.to_le_bytes().as_ptr(),
                    4,
                ))?;
                for (name, value) in [
                    ("ProxyServer", proxy),
                    ("ProxyOverride", std::env::var("DBX_PROOF_PROXY_OVERRIDE").unwrap_or_default()),
                ] {
                    let data = wide(&value);
                    checked(RegSetValueExW(
                        settings,
                        wide(name).as_ptr(),
                        0,
                        REG_SZ,
                        data.as_ptr().cast(),
                        (data.len() * 2) as u32,
                    ))?;
                }
                Ok(())
            })();
            RegCloseKey(settings);
            setup?;
            checked(RegOverridePredefKey(HKEY_CURRENT_USER, sandbox.key))?;
        }
        sandbox.redirected = true;
        Ok(Some(sandbox))
    }
}

impl Drop for RegistrySandbox {
    fn drop(&mut self) {
        unsafe {
            if self.redirected {
                if let Err(error) = checked(RegOverridePredefKey(HKEY_CURRENT_USER, ptr::null_mut())) {
                    eprintln!("registry mapping restore failed: {error}");
                    return;
                }
            }
            if !self.key.is_null() {
                RegCloseKey(self.key);
                // Exact unique proof key only; never the user's Internet Settings key.
                if let Err(error) = checked(RegDeleteTreeW(HKEY_CURRENT_USER, self.path.as_ptr())) {
                    eprintln!("temporary registry key cleanup failed: {error}");
                }
            }
        }
    }
}
