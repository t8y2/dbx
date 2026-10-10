//! Run artifacts (ADR §5.1): only metadata + URI live in SQLite; the artifact
//! body itself never enters the database or events.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::TaskError;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifact {
    pub name: String,
    pub uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
}

/// SHA-256 checksum (hex) of an artifact file, used by providers that declare
/// the `artifacts` capability.
pub fn file_checksum(path: &Path) -> Result<String, TaskError> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path)
        .map_err(|error| TaskError::execution_failed(format!("Cannot read artifact {}: {error}", path.display())))?;
    let digest = Sha256::digest(&bytes);
    Ok(bytes_to_hex(&digest))
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_matches_known_sha256_vector() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("artifact.txt");
        std::fs::write(&path, b"hello").unwrap();
        assert_eq!(file_checksum(&path).unwrap(), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert!(file_checksum(&dir.path().join("missing")).is_err());
    }
}
