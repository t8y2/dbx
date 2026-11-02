//! Incremental (delta) driver artifact updates.
//!
//! A delta artifact is a zstd frame produced by compressing the new package
//! with the previous package as a raw-content prefix (`zstd --patch-from`).
//! Reconstructing the new package only needs the previously downloaded
//! artifact — retained in the download cache as a "delta base" after every
//! successful install — plus a small delta file. The reconstructed output is
//! always verified against the full artifact's SHA-256 before it is used, and
//! every failure path falls back to a full download, so a missing or corrupt
//! base can never break an install.

use std::path::{Path, PathBuf};

use zstd::zstd_safe::{DCtx, DParameter, InBuffer, OutBuffer};

/// `ZSTD_d_windowLogMax` cap for decoding patch-from frames. The window must
/// cover the whole base artifact; 31 (2 GiB) is above any driver package we
/// ship, and zstd only allocates what the frame actually needs.
const DECODE_WINDOW_LOG_MAX: u32 = 31;

/// Reconstructs the full artifact at `dest_path` by applying the delta frame
/// `delta_path` onto the base artifact `base_path`.
///
/// Returns an error on any I/O or zstd failure; callers treat errors as a
/// signal to fall back to a full download. If the base does not match the one
/// the delta was produced from, decoding may still "succeed" with garbage
/// output — the caller's SHA-256 check on the result is what catches that.
pub fn apply_zstd_delta(base_path: &Path, delta_path: &Path, dest_path: &Path) -> Result<(), String> {
    let base =
        std::fs::read(base_path).map_err(|err| format!("Failed to read delta base {}: {err}", base_path.display()))?;
    let delta = std::fs::read(delta_path)
        .map_err(|err| format!("Failed to read delta artifact {}: {err}", delta_path.display()))?;

    let mut output = Vec::new();
    decode_with_prefix(&base, &delta, &mut output)?;

    if let Some(parent) = dest_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("Failed to create delta output directory: {err}"))?;
    }
    std::fs::write(dest_path, &output)
        .map_err(|err| format!("Failed to write reconstructed artifact {}: {err}", dest_path.display()))?;
    Ok(())
}

fn decode_with_prefix(prefix: &[u8], frame: &[u8], output: &mut Vec<u8>) -> Result<(), String> {
    let mut ctx = DCtx::create();
    ctx.set_parameter(DParameter::WindowLogMax(DECODE_WINDOW_LOG_MAX))
        .map_err(|code| format!("zstd decode window configuration failed: {code:?}"))?;
    ctx.ref_prefix(prefix).map_err(|code| format!("zstd delta base registration failed: {code:?}"))?;

    let mut input_pos = 0usize;
    let mut out_scratch = vec![0_u8; DCtx::out_size().max(64 * 1024)];

    loop {
        let mut src = InBuffer::around(&frame[input_pos..]);
        let mut dst = OutBuffer::around(&mut out_scratch);
        let code =
            ctx.decompress_stream(&mut dst, &mut src).map_err(|code| format!("zstd delta decode failed: {code:?}"))?;
        output.extend_from_slice(dst.as_slice());
        input_pos += src.pos();
        if code == 0 && input_pos >= frame.len() {
            return Ok(());
        }
        if code > 0 && src.pos() == 0 && input_pos >= frame.len() {
            return Err("zstd delta frame is truncated".to_string());
        }
    }
}

/// File name of the retained delta base for `db_type` at `version` inside the
/// download cache. The `driver-<db_type>-` prefix keeps bases aligned with the
/// existing per-driver cache pruning (uninstall, manual cache clear), and the
/// `base-<version>-` segment lets [find_delta_base] locate a base by version
/// without knowing the full-artifact URL metadata of that release.
pub fn delta_base_file_name(db_type: &str, version: &str, artifact_file_name: &str) -> String {
    format!("driver-{}-base-{}-{}", cache_file_token(db_type), cache_file_token(version), artifact_file_name)
}

/// Retains `downloaded_artifact` as the delta base for future incremental
/// updates of `db_type`, replacing any base retained for an older version.
///
/// The base is copied (not moved) so a caller that still needs the downloaded
/// artifact for unpacking keeps working; the transient cache entries for the
/// driver are pruned right after by the regular install cleanup, which is
/// taught to preserve the base returned here.
pub fn retain_delta_base(
    cache_dir: &Path,
    db_type: &str,
    version: &str,
    downloaded_artifact: &Path,
) -> Result<PathBuf, String> {
    let artifact_file_name = downloaded_artifact
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Delta base artifact has no file name".to_string())?;
    let base_name = delta_base_file_name(db_type, version, artifact_file_name);
    let base_path = cache_dir.join(&base_name);

    // Drop bases from other versions of this driver first so at most one base
    // per driver is retained at any time (bounded disk usage).
    let prefix = format!("driver-{}-base-", cache_file_token(db_type));
    if let Ok(entries) = std::fs::read_dir(cache_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with(&prefix) && name != base_name {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    if let Some(parent) = base_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("Failed to create delta base directory: {err}"))?;
    }
    // Windows cannot rename onto an existing file; the version-scoped name
    // makes collisions unlikely, but remove first to stay atomic-safe.
    let _ = std::fs::remove_file(&base_path);
    std::fs::copy(downloaded_artifact, &base_path)
        .map_err(|err| format!("Failed to retain delta base {}: {err}", base_path.display()))?;
    Ok(base_path)
}

/// Locates the retained delta base for `db_type` whose version matches
/// `base_version`, if one survives in the download cache.
pub fn find_delta_base(cache_dir: &Path, db_type: &str, base_version: &str) -> Option<PathBuf> {
    let prefix = format!("driver-{}-base-{}-", cache_file_token(db_type), cache_file_token(base_version));
    let entries = std::fs::read_dir(cache_dir).ok()?;
    let mut candidates: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_name().to_str().is_some_and(|name| name.starts_with(&prefix)))
        .map(|entry| entry.path())
        .collect();
    candidates.sort();
    candidates.into_iter().find(|path| path.is_file())
}

/// Reuses the same sanitizing rules as the driver download cache naming in
/// `agent_service` so bases and transient entries share one namespace.
fn cache_file_token(value: &str) -> String {
    let token = value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' { ch } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if token.is_empty() {
        "unknown".to_string()
    } else {
        token
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zstd::zstd_safe::{CCtx, CParameter};

    fn compress_with_prefix(prefix: &[u8], content: &[u8]) -> Vec<u8> {
        let mut ctx = CCtx::create();
        // Mirror `zstd --patch-from`: a window that covers the whole prefix so
        // matches may reference any earlier offset of the base artifact.
        let window_log = (usize::BITS - prefix.len().leading_zeros()).saturating_sub(1);
        ctx.set_parameter(CParameter::WindowLog(window_log.max(10))).unwrap();
        ctx.set_parameter(CParameter::CompressionLevel(3)).unwrap();
        ctx.ref_prefix(prefix).unwrap();

        let mut src = InBuffer::around(content);
        let mut compressed = Vec::new();
        let mut out_scratch = vec![0_u8; CCtx::out_size()];
        while src.pos() < content.len() {
            let mut dst = OutBuffer::around(&mut out_scratch);
            ctx.compress_stream(&mut dst, &mut src).unwrap();
            compressed.extend_from_slice(dst.as_slice());
        }
        loop {
            let mut dst = OutBuffer::around(&mut out_scratch);
            let remaining = ctx.end_stream(&mut dst).unwrap();
            compressed.extend_from_slice(dst.as_slice());
            if remaining == 0 {
                break;
            }
        }
        compressed
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dbx-driver-delta-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn synthetic_artifact(seed: &str, size: usize, mutate_from: usize) -> Vec<u8> {
        // Deterministic pseudo-content with large shared regions, so prefix
        // matching has real work to do instead of compressing from scratch.
        let mut data = Vec::with_capacity(size);
        let mut state: u64 = seed.bytes().map(|b| b as u64).sum();
        for _ in 0..size {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            data.push((state >> 33) as u8);
        }
        if mutate_from < size {
            for (i, byte) in b"DELTA-MUTATED-PAYLOAD".iter().enumerate() {
                let at = mutate_from + i;
                if at < size {
                    data[at] = *byte;
                }
            }
        }
        data
    }

    #[test]
    fn delta_round_trip_reconstructs_new_artifact_bit_for_bit() {
        let old = synthetic_artifact("old", 512 * 1024, usize::MAX);
        let new = synthetic_artifact("old", 512 * 1024, 300 * 1024);
        let frame = compress_with_prefix(&old, &new);
        assert!(frame.len() < new.len(), "delta should be smaller than the full artifact");

        let dir = temp_dir("roundtrip");
        let base = dir.join("base.tar.zst");
        let delta = dir.join("update.delta");
        let out = dir.join("reconstructed.tar.zst");
        std::fs::write(&base, &old).unwrap();
        std::fs::write(&delta, &frame).unwrap();

        apply_zstd_delta(&base, &delta, &out).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), new);
    }

    #[test]
    fn wrong_base_reconstructs_garbage_instead_of_succeeding_cleanly() {
        // A base that does not match the delta's production base may decode
        // without a zstd error; the output must then differ from the expected
        // artifact, which is exactly what the caller's SHA-256 check detects.
        let old = synthetic_artifact("old", 256 * 1024, usize::MAX);
        let new = synthetic_artifact("old", 256 * 1024, 128 * 1024);
        let frame = compress_with_prefix(&old, &new);
        let other_base = synthetic_artifact("other", 256 * 1024, usize::MAX);

        let dir = temp_dir("wrong-base");
        let base = dir.join("base.tar.zst");
        let delta = dir.join("update.delta");
        let out = dir.join("reconstructed.tar.zst");
        std::fs::write(&base, &other_base).unwrap();
        std::fs::write(&delta, &frame).unwrap();

        if apply_zstd_delta(&base, &delta, &out).is_ok() {
            let reconstructed = std::fs::read(&out).unwrap();
            assert_ne!(reconstructed, new, "mismatched base must not reproduce the target");
        }
    }

    #[test]
    fn truncated_delta_is_rejected() {
        let old = synthetic_artifact("old", 128 * 1024, usize::MAX);
        let new = synthetic_artifact("old", 128 * 1024, 64 * 1024);
        let frame = compress_with_prefix(&old, &new);

        let dir = temp_dir("truncated");
        let base = dir.join("base.tar.zst");
        let delta = dir.join("update.delta");
        let out = dir.join("reconstructed.tar.zst");
        std::fs::write(&base, &old).unwrap();
        std::fs::write(&delta, &frame[..frame.len() / 2]).unwrap();

        assert!(apply_zstd_delta(&base, &delta, &out).is_err());
    }

    #[test]
    fn retained_base_is_found_by_version_and_replaced_by_newer_base() {
        let dir = temp_dir("retain");
        let artifact_v1 = dir.join("dbx-agent-demo-0.1.1.tar.zst");
        let artifact_v2 = dir.join("dbx-agent-demo-0.1.2.tar.zst");
        std::fs::write(&artifact_v1, b"v1-bytes").unwrap();
        std::fs::write(&artifact_v2, b"v2-bytes").unwrap();

        let cache = dir.join("cache");
        std::fs::create_dir_all(&cache).unwrap();

        retain_delta_base(&cache, "demo", "0.1.1", &artifact_v1).unwrap();
        let found = find_delta_base(&cache, "demo", "0.1.1").expect("base for 0.1.1 retained");
        assert_eq!(std::fs::read(&found).unwrap(), b"v1-bytes");
        assert!(find_delta_base(&cache, "demo", "0.1.2").is_none());

        // Retaining the next version drops the previous base: one base per driver.
        retain_delta_base(&cache, "demo", "0.1.2", &artifact_v2).unwrap();
        assert!(find_delta_base(&cache, "demo", "0.1.1").is_none());
        let found = find_delta_base(&cache, "demo", "0.1.2").expect("base for 0.1.2 retained");
        assert_eq!(std::fs::read(&found).unwrap(), b"v2-bytes");
    }

    /// Real-world end-to-end check against published release artifacts.
    ///
    /// Ignored by default (CI has no network guarantees and the artifacts are
    /// ~68 MB); run manually after downloading two consecutive versions of a
    /// driver package, e.g. the snowflake pair from `agents-v0.2.129` and
    /// `agents-v0.2.130`:
    ///
    /// ```text
    /// DRIVER_DELTA_E2E_BASE=<old.tar.zst> DRIVER_DELTA_E2E_DELTA=<old-to-new.tar.zst.delta> \
    ///   DRIVER_DELTA_E2E_EXPECTED_SHA256=<sha256 of new.tar.zst> \
    ///   cargo nextest run -p dbx-driver-agent e2e_real --run-ignored=only
    /// ```
    #[test]
    #[ignore = "requires manually downloaded release artifacts via DRIVER_DELTA_E2E_* env vars"]
    fn e2e_real_artifact_delta_reconstruction() {
        let Ok(base) = std::env::var("DRIVER_DELTA_E2E_BASE") else {
            panic!("DRIVER_DELTA_E2E_BASE (previous full artifact) is required");
        };
        let Ok(delta) = std::env::var("DRIVER_DELTA_E2E_DELTA") else {
            panic!("DRIVER_DELTA_E2E_DELTA (delta frame) is required");
        };
        let expected_sha = std::env::var("DRIVER_DELTA_E2E_EXPECTED_SHA256")
            .expect("DRIVER_DELTA_E2E_EXPECTED_SHA256 (sha256 of the new full artifact) is required");

        let dir = temp_dir("e2e-real");
        let out = dir.join("reconstructed.tar.zst");
        apply_zstd_delta(std::path::Path::new(&base), std::path::Path::new(&delta), &out)
            .expect("real delta must apply");

        let actual_sha = {
            use sha2::Digest;
            let bytes = std::fs::read(&out).unwrap();
            format!("{:x}", sha2::Sha256::digest(&bytes))
        };
        assert_eq!(
            actual_sha, expected_sha,
            "reconstructed artifact must match the published full artifact bit-for-bit"
        );
    }
}
