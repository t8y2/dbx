use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[cfg(target_os = "windows")]
const PORTABLE_MARKER: &str = "portable.dbx";
#[cfg(target_os = "windows")]
const INSTALLER_MARKER: &str = "uninstall.exe";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataDirMode {
    Default,
    EnvOverride,
    Portable { exe_dir: PathBuf },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirResolution {
    pub data_dir: PathBuf,
    pub default_data_dir: PathBuf,
    pub mode: DataDirMode,
    portable_data_dir: Option<PathBuf>,
}

impl DataDirResolution {
    /// Resolve aliases before deriving the lock so two paths to one database
    /// cannot accidentally start separate writers.
    pub fn prepare(&mut self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        self.data_dir = std::fs::canonicalize(&self.data_dir)?;
        Ok(())
    }

    pub fn single_instance_secret(&self) -> String {
        let path = self.data_dir.as_os_str();
        #[cfg(target_os = "windows")]
        let path_bytes = {
            use std::os::windows::ffi::OsStrExt;
            path.encode_wide()
                .map(|unit| if (65..=90).contains(&unit) { unit + 32 } else { unit })
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>()
        };
        #[cfg(not(target_os = "windows"))]
        let path_bytes = path.as_encoded_bytes().to_vec();
        // 128 bits keeps the macOS Unix socket below its path-length limit.
        let digest = Sha256::digest(path_bytes);
        digest[..16].iter().map(|byte| format!("{byte:02x}")).collect()
    }

    pub fn uses_custom_data_dir(&self) -> bool {
        matches!(self.mode, DataDirMode::EnvOverride | DataDirMode::Portable { .. })
    }

    pub fn custom_data_dir(&self) -> Option<&Path> {
        self.uses_custom_data_dir().then_some(self.data_dir.as_path())
    }

    pub fn is_portable_mode(&self) -> bool {
        matches!(self.mode, DataDirMode::Portable { .. })
    }
}

pub fn resolve_data_dir_with_mode(default_app_data_dir: PathBuf) -> DataDirResolution {
    let env_data_dir = std::env::var_os("DBX_DATA_DIR").filter(|value| !value.is_empty()).map(PathBuf::from);

    #[cfg(target_os = "windows")]
    let exe_dir = current_exe_dir();
    #[cfg(not(target_os = "windows"))]
    let exe_dir = None;

    let portable_marker_exists = exe_dir.as_deref().is_some_and(portable_marker_exists);
    let installer_marker_exists = exe_dir.as_deref().is_some_and(installer_marker_exists);

    resolve_data_dir_from_inputs(
        default_app_data_dir,
        exe_dir,
        portable_marker_exists,
        installer_marker_exists,
        env_data_dir,
    )
}

pub fn alternative_data_dir(resolution: &DataDirResolution) -> Option<PathBuf> {
    match &resolution.mode {
        DataDirMode::Portable { .. } => Some(resolution.default_data_dir.clone()),
        DataDirMode::Default => resolution.portable_data_dir.clone(),
        DataDirMode::EnvOverride => None,
    }
}

pub fn is_portable_mode() -> bool {
    resolve_data_dir_with_mode(PathBuf::new()).is_portable_mode()
}

#[cfg(target_os = "windows")]
fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf))
}

#[cfg(target_os = "windows")]
fn portable_marker_exists(exe_dir: &Path) -> bool {
    exe_dir.join(PORTABLE_MARKER).is_file()
}

#[cfg(not(target_os = "windows"))]
fn portable_marker_exists(_exe_dir: &Path) -> bool {
    false
}

#[cfg(target_os = "windows")]
fn installer_marker_exists(exe_dir: &Path) -> bool {
    exe_dir.join(INSTALLER_MARKER).is_file()
}

#[cfg(not(target_os = "windows"))]
fn installer_marker_exists(_exe_dir: &Path) -> bool {
    false
}

fn resolve_data_dir_from_inputs(
    default_app_data_dir: PathBuf,
    exe_dir: Option<PathBuf>,
    portable_marker_exists: bool,
    installer_marker_exists: bool,
    env_data_dir: Option<PathBuf>,
) -> DataDirResolution {
    let portable_data_dir = exe_dir.as_ref().filter(|_| portable_marker_exists).map(|dir| dir.join("data"));

    if let Some(env_dir) = env_data_dir {
        return DataDirResolution {
            data_dir: env_dir,
            default_data_dir: default_app_data_dir,
            mode: DataDirMode::EnvOverride,
            portable_data_dir,
        };
    }

    if portable_marker_exists && !installer_marker_exists {
        if let Some(exe_dir) = exe_dir {
            return DataDirResolution {
                data_dir: exe_dir.join("data"),
                default_data_dir: default_app_data_dir,
                mode: DataDirMode::Portable { exe_dir },
                portable_data_dir,
            };
        }
    }

    DataDirResolution {
        data_dir: default_app_data_dir.clone(),
        default_data_dir: default_app_data_dir,
        mode: DataDirMode::Default,
        portable_data_dir,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{alternative_data_dir, resolve_data_dir_from_inputs, DataDirMode};

    #[test]
    fn profiles_have_stable_distinct_private_instance_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let mut first = resolve_data_dir_from_inputs(
            temp.path().join("default"),
            None,
            false,
            false,
            Some(temp.path().join("first")),
        );
        let mut second = resolve_data_dir_from_inputs(
            temp.path().join("default"),
            None,
            false,
            false,
            Some(temp.path().join("second")),
        );
        first.prepare().unwrap();
        second.prepare().unwrap();
        assert_ne!(first.single_instance_secret(), second.single_instance_secret());
        assert_eq!(first.single_instance_secret(), first.clone().single_instance_secret());
        assert_eq!(first.single_instance_secret().len(), 32);
        assert!(first.single_instance_secret().bytes().all(|value| value.is_ascii_hexdigit()));
    }

    #[test]
    fn canonical_directory_aliases_share_one_instance_secret() {
        let temp = tempfile::tempdir().unwrap();
        let mut first = resolve_data_dir_from_inputs(temp.path().join("profile"), None, false, false, None);
        first.prepare().unwrap();
        let mut alias = resolve_data_dir_from_inputs(temp.path().join("profile").join("."), None, false, false, None);
        alias.prepare().unwrap();
        assert_eq!(first.data_dir, alias.data_dir);
        assert_eq!(first.single_instance_secret(), alias.single_instance_secret());
    }

    #[test]
    fn prepare_fails_closed_when_the_profile_is_a_file() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("profile");
        std::fs::write(&file, b"not a directory").unwrap();
        let mut resolution = resolve_data_dir_from_inputs(file, None, false, false, None);
        assert!(resolution.prepare().is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_ascii_case_aliases_have_one_instance_secret() {
        let temp = tempfile::tempdir().unwrap();
        let mut first = resolve_data_dir_from_inputs(temp.path().join("Profile"), None, false, false, None);
        let mut alias = resolve_data_dir_from_inputs(temp.path().join("PROFILE"), None, false, false, None);
        first.prepare().unwrap();
        alias.prepare().unwrap();
        assert_eq!(first.single_instance_secret(), alias.single_instance_secret());
    }

    #[test]
    fn uses_portable_data_dir_when_marker_exists_without_installer_marker() {
        let default_dir = PathBuf::from(r"C:\Users\Administrator\AppData\Roaming\com.dbx.app");
        let exe_dir = PathBuf::from(r"D:\Apps\DBX");

        let resolution = resolve_data_dir_from_inputs(default_dir, Some(exe_dir.clone()), true, false, None);

        assert_eq!(resolution.data_dir, exe_dir.join("data"));
        assert_eq!(resolution.custom_data_dir(), Some(resolution.data_dir.as_path()));
        assert_eq!(resolution.mode, DataDirMode::Portable { exe_dir });
        assert!(resolution.uses_custom_data_dir());
        assert!(resolution.is_portable_mode());
    }

    #[test]
    fn installer_marker_keeps_installed_mode_even_when_portable_marker_exists() {
        let default_dir = PathBuf::from(r"C:\Users\Administrator\AppData\Roaming\com.dbx.app");
        let exe_dir = PathBuf::from(r"C:\Program Files\DBX");

        let resolution = resolve_data_dir_from_inputs(default_dir.clone(), Some(exe_dir), true, true, None);

        assert_eq!(resolution.data_dir, default_dir);
        assert_eq!(resolution.custom_data_dir(), None);
        assert_eq!(resolution.mode, DataDirMode::Default);
        assert!(!resolution.uses_custom_data_dir());
        assert!(!resolution.is_portable_mode());
    }

    #[test]
    fn env_override_wins_over_installer_and_portable_markers() {
        let default_dir = PathBuf::from(r"C:\Users\Administrator\AppData\Roaming\com.dbx.app");
        let exe_dir = PathBuf::from(r"C:\Program Files\DBX");
        let env_dir = PathBuf::from(r"E:\DBXData");

        let resolution = resolve_data_dir_from_inputs(default_dir, Some(exe_dir), true, true, Some(env_dir.clone()));

        assert_eq!(resolution.data_dir, env_dir);
        assert_eq!(resolution.custom_data_dir(), Some(resolution.data_dir.as_path()));
        assert_eq!(resolution.mode, DataDirMode::EnvOverride);
        assert!(resolution.uses_custom_data_dir());
        assert!(!resolution.is_portable_mode());
    }

    #[test]
    fn portable_mode_can_import_from_default_data_dir() {
        let default_dir = PathBuf::from(r"C:\Users\Administrator\AppData\Roaming\com.dbx.app");
        let exe_dir = PathBuf::from(r"D:\Apps\DBX");

        let resolution = resolve_data_dir_from_inputs(default_dir.clone(), Some(exe_dir), true, false, None);

        assert_eq!(alternative_data_dir(&resolution), Some(default_dir));
    }

    #[test]
    fn installed_mode_can_import_from_leftover_portable_data_dir() {
        let default_dir = PathBuf::from(r"C:\Users\Administrator\AppData\Roaming\com.dbx.app");
        let exe_dir = PathBuf::from(r"C:\Program Files\DBX");

        let resolution = resolve_data_dir_from_inputs(default_dir, Some(exe_dir.clone()), true, true, None);

        assert_eq!(alternative_data_dir(&resolution), Some(exe_dir.join("data")));
    }

    #[test]
    fn env_override_does_not_import_from_implicit_alternative_dir() {
        let default_dir = PathBuf::from(r"C:\Users\Administrator\AppData\Roaming\com.dbx.app");
        let exe_dir = PathBuf::from(r"D:\Apps\DBX");

        let resolution =
            resolve_data_dir_from_inputs(default_dir, Some(exe_dir), true, false, Some(PathBuf::from(r"E:\DBXData")));

        assert_eq!(alternative_data_dir(&resolution), None);
    }
}
