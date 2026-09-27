use super::{
    secret_codec::{SecretCodec, SecretKeyPolicy},
    storage::Storage,
};
use std::path::Path;

pub async fn open(path: &Path) -> Result<Storage, String> {
    let directory = path.parent().ok_or("Test storage requires a data directory")?;
    SecretCodec::resolve(SecretKeyPolicy::TestDataDir, directory, true)?;
    Storage::open_with_secret_key_policy(path, SecretKeyPolicy::TestDataDir).await
}

pub async fn open_unmigrated(path: &Path) -> Result<Storage, String> {
    Ok(Storage::open_unmigrated(path).await?.with_secret_key_policy(SecretKeyPolicy::TestDataDir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::secret_codec::{managed_key_path, SecretCodec};

    #[tokio::test]
    async fn test_storage_keys_are_isolated_and_persist_across_reopens() {
        let first_dir = tempfile::tempdir().unwrap();
        let second_dir = tempfile::tempdir().unwrap();
        let first_path = first_dir.path().join("dbx.db");
        let first = open(&first_path).await.unwrap();
        let first_key = SecretCodec::resolve(SecretKeyPolicy::TestDataDir, first_dir.path(), true).unwrap();
        let second_key = SecretCodec::resolve(SecretKeyPolicy::TestDataDir, second_dir.path(), true).unwrap();
        let encrypted = first_key.codec.encrypt("test", "credential", "fixture-value").unwrap();
        assert!(second_key.codec.decrypt("test", "credential", &encrypted).is_err());
        let first_bytes = std::fs::read(managed_key_path(first_dir.path())).unwrap();
        let second_bytes = std::fs::read(managed_key_path(second_dir.path())).unwrap();
        assert_ne!(first_bytes, second_bytes);
        assert_eq!(first_key.source, second_key.source);
        drop(first);
        let _reopened = open(&first_path).await.unwrap();
        let reopened_key = SecretCodec::resolve(SecretKeyPolicy::TestDataDir, first_dir.path(), false).unwrap();
        assert_eq!(reopened_key.codec.decrypt("test", "credential", &encrypted).unwrap(), "fixture-value");
        assert_eq!(first_bytes, std::fs::read(managed_key_path(first_dir.path())).unwrap());
    }
}
