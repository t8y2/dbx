#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
upstream_plugin="$script_dir/linuxdeploy-plugin-gtk-upstream.sh"
[[ -x "$upstream_plugin" ]] || {
  echo "Missing executable upstream GTK plugin: $upstream_plugin" >&2
  exit 1
}

# linuxdeploy queries this before invoking the plugin. Preserve the upstream
# protocol response without requiring an AppDir.
for argument in "$@"; do
  case "$argument" in
    --plugin-api-version | --help)
      exec "$upstream_plugin" "$@"
      ;;
  esac
done

appdir=''
arguments=("$@")
for ((index = 0; index < ${#arguments[@]}; index += 1)); do
  case "${arguments[index]}" in
    --appdir)
      index=$((index + 1))
      appdir=${arguments[index]:-}
      ;;
    --appdir=*)
      appdir=${arguments[index]#--appdir=}
      ;;
  esac
done
[[ -n "$appdir" ]] || {
  echo "GTK plugin wrapper did not receive --appdir" >&2
  exit 1
}

"$upstream_plugin" "$@"

# AppImages must use the target system's display stack. Bundling Ubuntu's
# Wayland/XKB/XCB libraries ahead of a newer host Mesa stack can abort before
# GTK creates a window (tauri-apps/tauri#15976).
display_library_patterns=(
  'libwayland-*.so*'
  'libxkbcommon.so*'
  'libxcb-randr.so*'
  'libxcb-render.so*'
  'libxcb-shm.so*'
  'libXau.so*'
  'libXdmcp.so*'
)

for pattern in "${display_library_patterns[@]}"; do
  find "$appdir/usr" \( -type f -o -type l \) -name "$pattern" -print -delete
done
