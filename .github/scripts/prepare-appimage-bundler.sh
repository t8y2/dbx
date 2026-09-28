#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "AppImage bundler setup failed: $*" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  die "usage: $0 <Linux target triple>"
fi

: "${XDG_CACHE_HOME:?XDG_CACHE_HOME must point to the isolated release cache}"

target=$1
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
case "$target" in
  x86_64-unknown-linux-gnu)
    tools_arch=x86_64
    linuxdeploy_sha256=36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62
    ;;
  aarch64-unknown-linux-gnu)
    tools_arch=aarch64
    linuxdeploy_sha256=556ab80baa98e600aa80f0dcedfb70bca0e1ce7e9f147fb345be3fcc3e91b2b1
    ;;
  *)
    die "unsupported Linux target: $target"
    ;;
esac

# Tauri CLI 2.11.4 only downloads these tools when their cache entries are
# absent, so an older runner cache can keep generating an AppRun hook that
# unconditionally forces X11. Pin the tools from the accepted upstream fix
# until a stable Tauri CLI release includes tauri-apps/tauri#16062.
tauri_fix_commit=8e7028331ad37ac2db74d4ec20e66be5cacf2c40
linuxdeploy_revision=07333c6
gtk_plugin_sha256=ef6b9a980417243bc62e0241b51dc49876032afd1bab9b4762389f961b406d9b
tools_dir="$XDG_CACHE_HOME/tauri"
mkdir -p "$tools_dir"

download_path=''
cleanup() {
  if [[ -n "$download_path" ]]; then
    rm -f -- "$download_path"
  fi
}
trap cleanup EXIT

install_verified_tool() {
  local name=$1
  local url=$2
  local expected_sha256=$3
  local destination="$tools_dir/$name"
  local actual_sha256

  if [[ -f "$destination" ]]; then
    actual_sha256=$(sha256sum "$destination")
    actual_sha256=${actual_sha256%% *}
    if [[ "$actual_sha256" == "$expected_sha256" ]]; then
      chmod 0755 "$destination"
      echo "Using verified cached AppImage tool: $name"
      return
    fi
  fi

  download_path=$(mktemp "$tools_dir/.${name}.XXXXXX")
  curl --fail --location --retry 3 --retry-all-errors --silent --show-error \
    "$url" --output "$download_path"
  actual_sha256=$(sha256sum "$download_path")
  actual_sha256=${actual_sha256%% *}
  [[ "$actual_sha256" == "$expected_sha256" ]] \
    || die "$name SHA-256 mismatch: expected $expected_sha256, got $actual_sha256"
  chmod 0755 "$download_path"
  mv -f -- "$download_path" "$destination"
  download_path=''
  echo "Installed verified AppImage tool: $name"
}

linuxdeploy_name="linuxdeploy-${tools_arch}.AppImage"
install_verified_tool \
  "$linuxdeploy_name" \
  "https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-${linuxdeploy_revision}/${linuxdeploy_name}" \
  "$linuxdeploy_sha256"

gtk_plugin_name=linuxdeploy-plugin-gtk-upstream.sh
install_verified_tool \
  "$gtk_plugin_name" \
  "https://raw.githubusercontent.com/tauri-apps/tauri/${tauri_fix_commit}/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy-plugin-gtk.sh" \
  "$gtk_plugin_sha256"

upstream_gtk_plugin="$tools_dir/$gtk_plugin_name"
gtk_plugin="$tools_dir/linuxdeploy-plugin-gtk.sh"
install -m 0755 "$script_dir/linuxdeploy-plugin-gtk-wrapper.sh" "$gtk_plugin"
bash -n "$upstream_gtk_plugin" "$gtk_plugin"
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?GDK_BACKEND[[:space:]]*=' "$upstream_gtk_plugin"; then
  die "pinned GTK plugin still contains an active GDK_BACKEND assignment"
fi

echo "Prepared Wayland-capable AppImage tools for $target in $tools_dir"
