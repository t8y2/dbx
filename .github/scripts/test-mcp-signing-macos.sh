#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo "This probe requires macOS and controlled Developer ID Application credentials." >&2
  exit 1
fi

: "${APPLE_CERTIFICATE:?Required base64 PKCS12 bundle}"
: "${APPLE_CERTIFICATE_PASSWORD:?Required PKCS12 password}"
: "${APPLE_SIGNING_IDENTITY:?Required Developer ID Application identity}"
: "${APPLE_TEAM_ID:?Required signing team}"
probe_root="${RUNNER_TEMP:-${TMPDIR:?Set TMPDIR to a private temporary directory}}"
work_dir="$(mktemp -d "$probe_root/dbx-mcp-identity.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
script_dir="$(cd "$(dirname "$0")" && pwd)"
security list-keychains -d user > "$work_dir/keychains-before"

for arch in arm64 x86_64; do
  for build in 1 2; do
    printf 'int main(void) { return %s; }\n' "$build" > "$work_dir/probe.c"
    xcrun clang -arch "$arch" "$work_dir/probe.c" -o "$work_dir/$arch-$build"
    node "$script_dir/sign-mcp-macos.mjs" sign "$work_dir/$arch-$build"
  done

  codesign -d -r- "$work_dir/$arch-1" > "$work_dir/requirement" 2> "$work_dir/codesign-display"
  requirement="$(sed -n 's/^designated => /=/p' "$work_dir/requirement")"
  test -n "$requirement"
  codesign --verify --strict --all-architectures -R "$requirement" "$work_dir/$arch-2"

  mkdir "$work_dir/$arch-package" "$work_dir/$arch-unpacked"
  cp "$work_dir/$arch-2" "$work_dir/$arch-package/dbx-mcp"
  tar -C "$work_dir/$arch-package" -czf "$work_dir/$arch.tar.gz" dbx-mcp
  tar -C "$work_dir/$arch-unpacked" -xzf "$work_dir/$arch.tar.gz"
  cmp "$work_dir/$arch-2" "$work_dir/$arch-unpacked/dbx-mcp"
  node "$script_dir/sign-mcp-macos.mjs" verify "$work_dir/$arch-unpacked/dbx-mcp"

  cp "$work_dir/$arch-2" "$work_dir/tampered"
  node - "$work_dir/tampered" <<'NODE'
const fs = require("node:fs");
const binary = fs.readFileSync(process.argv[2]);
binary[4096] ^= 1;
fs.writeFileSync(process.argv[2], binary);
NODE
  if node "$script_dir/sign-mcp-macos.mjs" verify "$work_dir/tampered"; then
    echo "Tampered binary unexpectedly passed verification." >&2
    exit 1
  fi

  cp "$work_dir/$arch-2" "$work_dir/adhoc"
  codesign --force --sign - --identifier com.dbx.app.mcp "$work_dir/adhoc"
  if node "$script_dir/sign-mcp-macos.mjs" verify "$work_dir/adhoc"; then
    echo "Ad-hoc binary unexpectedly passed verification." >&2
    exit 1
  fi
done

security list-keychains -d user > "$work_dir/keychains-after"
cmp "$work_dir/keychains-before" "$work_dir/keychains-after"
echo "Both architectures passed distinct-build identity, archive, rejection and keychain cleanup checks."
