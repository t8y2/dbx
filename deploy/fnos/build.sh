#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
package_source="$repo_root/deploy/fnos/package"
output_dir="${DBX_FNOS_OUTPUT_DIR:-$repo_root/dist/fnos}"
fnpack_version="1.2.3"
scratch_root="$(mktemp -d "${TMPDIR:-/tmp}/dbx-fnos-build.XXXXXX")"

cleanup() {
  if [[ -d "$scratch_root" ]]; then
    find "$scratch_root" -depth -delete
  fi
}
trap cleanup EXIT

read_package_version() {
  sed -nE 's/^version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' \
    "$repo_root/crates/dbx-web/Cargo.toml" | head -n 1
}

version="${DBX_FNOS_VERSION:-$(read_package_version)}"
image="${DBX_FNOS_IMAGE:-docker.cnb.cool/dbxio.com/dbx:$version}"
changelog="${DBX_FNOS_CHANGELOG:-升级至 DBX ${version}。}"

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid fnOS package version: $version" >&2
  exit 1
fi

if [[ "$image" == *:latest ]]; then
  echo "fnOS release packages must use an immutable image tag, not latest" >&2
  exit 1
fi

if [[ "$image" != *:"$version" ]]; then
  echo "fnOS image tag must match package version $version: $image" >&2
  exit 1
fi

if [[ "$changelog" == *$'\n'* || "$changelog" == *$'\r'* ]]; then
  echo "DBX_FNOS_CHANGELOG must be a single line" >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

resolve_fnpack() {
  if [[ -n "${FNPACK_BIN:-}" ]]; then
    printf '%s\n' "$FNPACK_BIN"
    return
  fi

  if command -v fnpack >/dev/null 2>&1; then
    command -v fnpack
    return
  fi

  local os arch asset expected_sha256
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/arm64)
      asset="fnpack-${fnpack_version}-darwin-arm64"
      expected_sha256="d40cb00896cb2a5d211357d255750ed0cbe7f2d141df671c2b717afb4e74bf77"
      ;;
    Darwin/x86_64)
      asset="fnpack-${fnpack_version}-darwin-amd64"
      expected_sha256="30a9f50a35e8d8d425b687881761478c3c778e9c0da3a1b59f298b666dd7a268"
      ;;
    Linux/x86_64)
      asset="fnpack-${fnpack_version}-linux-amd64"
      expected_sha256="54b97fa7b70968c4d05c79840f5daeff508957d0bb2062fdb0376d00d9615c93"
      ;;
    *)
      echo "no verified fnpack download for $os/$arch; set FNPACK_BIN" >&2
      exit 1
      ;;
  esac

  local tool_dir tool_path actual_sha256
  tool_dir="$scratch_root/tool"
  mkdir -p "$tool_dir"
  tool_path="$tool_dir/fnpack"
  curl --fail --location --retry 3 --connect-timeout 10 \
    "https://static2.fnnas.com/fnpack/$asset" \
    --output "$tool_path"
  actual_sha256="$(sha256_file "$tool_path")"
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    echo "fnpack checksum mismatch: expected $expected_sha256, got $actual_sha256" >&2
    exit 1
  fi
  chmod +x "$tool_path"
  printf '%s\n' "$tool_path"
}

render_template() {
  local source="$1" destination="$2"
  local escaped_version escaped_image escaped_changelog
  escaped_version="$(printf '%s' "$version" | sed 's/[\\&|]/\\&/g')"
  escaped_image="$(printf '%s' "$image" | sed 's/[\\&|]/\\&/g')"
  escaped_changelog="$(printf '%s' "$changelog" | sed 's/[\\&|]/\\&/g')"
  sed \
    -e "s|__DBX_VERSION__|$escaped_version|g" \
    -e "s|__DBX_IMAGE__|$escaped_image|g" \
    -e "s|__DBX_CHANGELOG__|$escaped_changelog|g" \
    "$source" > "$destination"
}

fnpack_bin="$(resolve_fnpack)"
if [[ ! -x "$fnpack_bin" ]]; then
  echo "fnpack is not executable: $fnpack_bin" >&2
  exit 1
fi

work_root="$scratch_root/package"
package_dir="$work_root/dbx"
mkdir -p "$package_dir" "$output_dir"
cp -R "$package_source/." "$package_dir/"
mkdir -p "$package_dir/app/ui/images" "$package_dir/wizard"

render_template "$package_dir/manifest.template" "$package_dir/manifest"
render_template "$package_dir/app/docker/docker-compose.yaml.template" \
  "$package_dir/app/docker/docker-compose.yaml"
rm "$package_dir/manifest.template" "$package_dir/app/docker/docker-compose.yaml.template"

cp "$repo_root/docs/public/logo-64.png" "$package_dir/ICON.PNG"
cp "$repo_root/docs/logo.png" "$package_dir/ICON_256.PNG"
cp "$repo_root/docs/public/logo-64.png" "$package_dir/app/ui/images/icon_64.png"
cp "$repo_root/docs/logo.png" "$package_dir/app/ui/images/icon_256.png"
chmod +x "$package_dir"/cmd/*

(cd "$package_dir" && "$fnpack_bin" build)

fpk_path="$(find "$package_dir" -maxdepth 1 -type f -name '*.fpk' -print -quit)"
if [[ -z "$fpk_path" ]]; then
  echo "fnpack completed without producing an FPK" >&2
  exit 1
fi

artifact="$output_dir/DBX_${version}_fnos.fpk"
cp "$fpk_path" "$artifact"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$output_dir" && sha256sum "$(basename "$artifact")" > "$(basename "$artifact").sha256")
else
  (cd "$output_dir" && shasum -a 256 "$(basename "$artifact")" > "$(basename "$artifact").sha256")
fi

printf 'Created %s\n' "$artifact"
printf 'Image: %s\n' "$image"
