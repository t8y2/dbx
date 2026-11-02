# dbx-plugin-packager

Builds an unsigned `.dbxp` candidate from a staged plugin directory and signs an already-reviewed candidate as a separate repository operation.

## Usage

```bash
cargo run --release \
  --manifest-path plugins/sdk/packager/Cargo.toml \
  -- path/to/stage path/to/vendor.example-1.0.0-darwin-arm64.dbxp \
  --artifact-metadata path/to/vendor.example-1.0.0-darwin-arm64.artifact.json \
  --target darwin-arm64 \
  --artifact-url vendor.example-1.0.0-darwin-arm64.dbxp
```

The stage directory must contain `manifest.json` and the current-platform files referenced by the manifest. The packager:

- walks regular files without following symlinks;
- rejects symlinks, oversized files, oversized stages, excessive entries, and output paths inside the stage;
- writes archive entries in deterministic path order;
- hashes and writes files as streams instead of loading the whole package into memory;
- preserves executable permissions;
- creates exact SHA-256 coverage in `checksums.json`;
- optionally writes candidate artifact metadata containing the target, URL, package SHA-256, and size;
- writes through a temporary file so a failed build does not truncate the previous package.

Use `--target universal` only when the same `.dbxp` is valid on every DBX target. This is normally appropriate for frontend-only plugins. When a catalog contains both an exact platform artifact and `universal`, DBX selects the exact artifact first.

The generated metadata has the shape expected by marketplace catalog v1:

```json
{
  "target": "darwin-arm64",
  "url": "vendor.example-1.0.0-darwin-arm64.dbxp",
  "sha256": "...",
  "size": 123456
}
```

## Repository signing

Only a repository operator should sign packages. Plugin authors submit unsigned candidates. `DBX_PLUGIN_SIGNING_KEY` is a base64-encoded 32-byte Ed25519 repository private-key seed, and `--key-id` identifies the corresponding repository public key in DBX's trust store.

```bash
DBX_PLUGIN_SIGNING_KEY="..." \
cargo run --release \
  --manifest-path plugins/sdk/packager/Cargo.toml \
  -- sign path/to/vendor.example-1.0.0-darwin-arm64.unsigned.dbxp path/to/vendor.example-1.0.0-darwin-arm64.dbxp \
  --key-id vendor-release \
  --artifact-metadata path/to/vendor.example-1.0.0-darwin-arm64.artifact.json \
  --target darwin-arm64 \
  --artifact-url https://plugins.example.com/vendor.example-1.0.0-darwin-arm64.dbxp
```

The signing command validates the existing archive, rejects symlinks, duplicate entries, invalid checksums, path traversal, oversized content, and pre-existing `signature.json`, then appends the repository signature and computes metadata for the final signed bytes.

Keep the private seed in protected repository-signing CI. Set `DBX_PLUGIN_SIGNING_PUBLIC_KEY` there as well to make the packager reject a private key that does not derive the configured repository public key. Publish the Base64 32-byte public key through an independent trusted channel. Do not give the official repository key to plugin authors.

## GitHub Releases

`../../templates/github/plugin-release.yml` is a caller template for DBX's reusable multi-platform author workflow. It uploads unsigned `.dbxp` candidates and publishes merged `release-candidates.json` metadata for review. Repository signing happens later in protected repository infrastructure.
