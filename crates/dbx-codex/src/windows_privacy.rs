use std::{fs::File, os::windows::io::AsRawHandle, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree, HANDLE},
    Security::{
        Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT,
        },
        EqualSid, GetSecurityDescriptorDacl, GetTokenInformation, TokenOwner, TokenUser, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_OWNER, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT},
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct LocalMemory(*mut std::ffi::c_void);
impl Drop for LocalMemory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}
struct Token(HANDLE);
impl Drop for Token {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn os_error() -> String {
    format!("Cannot protect Codex runtime files: {}", std::io::Error::last_os_error())
}

pub(super) fn restrict(file: &File, directory: bool) -> Result<(), String> {
    // Validate ownership and reparse/link identity on the opened handle, before reading or writing credentials.
    unsafe {
        let handle = file.as_raw_handle();
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        if GetFileInformationByHandle(handle, &mut info) == 0 {
            return Err(os_error());
        }
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 || (!directory && info.nNumberOfLinks != 1) {
            return Err("Codex runtime files cannot be reparse points or hard links".into());
        }
        let mut owner = ptr::null_mut();
        let mut original = LocalMemory(ptr::null_mut());
        let error = GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut original.0,
        );
        if error != 0 {
            return Err(format!("Cannot inspect Codex file ownership: Windows error {error}"));
        }
        let mut token = Token(ptr::null_mut());
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token.0) == 0 {
            return Err(os_error());
        }
        let mut buffer = [0u64; 128];
        let mut needed = 0;
        if GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            std::mem::size_of_val(&buffer) as u32,
            &mut needed,
        ) == 0
        {
            return Err(os_error());
        }
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let owned_by_user = !owner.is_null() && EqualSid(owner, user.User.Sid) != 0;
        if !owned_by_user {
            // Elevated Windows tokens may create objects owned by their default Administrators group.
            if GetTokenInformation(
                token.0,
                TokenOwner,
                buffer.as_mut_ptr().cast(),
                std::mem::size_of_val(&buffer) as u32,
                &mut needed,
            ) == 0
            {
                return Err(os_error());
            }
            let default_owner = &*buffer.as_ptr().cast::<TOKEN_OWNER>();
            if owner.is_null() || EqualSid(owner, default_owner.Owner) == 0 {
                return Err(
                    "Codex runtime files must belong to the current Windows account or its default owner".into()
                );
            }
        }
        // Owner Rights grants the actual object owner; SYSTEM/Administrators retain normal OS access.
        let sddl: Vec<u16> =
            "D:P(A;OICI;FA;;;OW)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)".encode_utf16().chain(Some(0)).collect();
        let mut descriptor = LocalMemory(ptr::null_mut());
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor.0, ptr::null_mut())
            == 0
        {
            return Err(os_error());
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = ptr::null_mut();
        if GetSecurityDescriptorDacl(descriptor.0, &mut present, &mut acl, &mut defaulted) == 0
            || present == 0
            || acl.is_null()
        {
            return Err("Cannot create private Codex access rules".into());
        }
        let error = SetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            acl,
            ptr::null_mut(),
        );
        if error != 0 {
            return Err(format!("Cannot apply private Codex access rules: Windows error {error}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs::OpenOptions,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{ConvertSecurityDescriptorToStringSecurityDescriptorW, GetSecurityInfo, SE_FILE_OBJECT},
            DACL_SECURITY_INFORMATION,
        },
    };

    #[tokio::test]
    async fn private_dacl_has_only_owner_system_and_administrators() {
        let directory = tempfile::tempdir().unwrap();
        let data = directory.path().join("data");
        let _lease = crate::runtime::ServiceLease::acquire(&data).await.unwrap();
        for path in [&data, &data.join("mcp-token")] {
            let file = OpenOptions::new().read(true).custom_flags(0x02000000).open(path).unwrap();
            unsafe {
                let mut descriptor = ptr::null_mut();
                assert_eq!(
                    GetSecurityInfo(
                        file.as_raw_handle(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        &mut descriptor
                    ),
                    0
                );
                let mut text = ptr::null_mut();
                assert_ne!(
                    ConvertSecurityDescriptorToStringSecurityDescriptorW(
                        descriptor,
                        1,
                        DACL_SECURITY_INFORMATION,
                        &mut text,
                        ptr::null_mut()
                    ),
                    0
                );
                let mut length = 0;
                while *text.add(length) != 0 {
                    length += 1;
                }
                let sddl = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
                LocalFree(text.cast());
                LocalFree(descriptor);
                assert!(sddl.starts_with("D:P"), "{sddl}");
                assert_eq!(sddl.matches("(A;").count(), 3, "{sddl}");
                for sid in ["OW", "SY", "BA"] {
                    assert!(sddl.contains(&format!(";FA;;;{sid})")), "{sddl}");
                }
            }
        }
    }

    #[test]
    fn refuses_hard_linked_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credential");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .access_mode(0xC0000000 | 0x00040000)
            .open(&path)
            .unwrap();
        std::fs::hard_link(&path, directory.path().join("other")).unwrap();
        assert!(super::restrict(&file, false).unwrap_err().contains("hard links"));
    }
}
