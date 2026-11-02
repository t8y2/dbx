#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "AppImage runtime verification failed: $*" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  die "usage: $0 <AppImage file or bundle directory>"
fi

input_path=$1
if [[ -f "$input_path" ]]; then
  appimage=$input_path
elif [[ -d "$input_path" ]]; then
  appimages=()
  while IFS= read -r -d '' candidate; do
    appimages+=("$candidate")
  done < <(find "$input_path" -maxdepth 1 -type f -name '*.AppImage' -print0)
  [[ ${#appimages[@]} -eq 1 ]] \
    || die "expected exactly one AppImage in $input_path, found ${#appimages[@]}"
  appimage=${appimages[0]}
else
  die "path does not exist: $input_path"
fi
appimage=$(realpath "$appimage")

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/dbx-appimage-input-methods.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT

(
  cd "$work_dir"
  "$appimage" --appimage-extract >/dev/null
)
appdir="$work_dir/squashfs-root"
[[ -d "$appdir" ]] || die "AppImage extraction did not create squashfs-root"
appdir=$(realpath "$appdir")

gtk_hook="$appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh"
[[ -f "$gtk_hook" ]] || die "missing GTK AppRun hook"
if grep -Eq '^[[:space:]]*(export[[:space:]]+)?GDK_BACKEND[[:space:]]*=' "$gtk_hook"; then
  die "GTK AppRun hook overrides GDK_BACKEND"
fi

for requested_backend in wayland x11; do
  preserved_backend=$(
    APPDIR="$appdir" GDK_BACKEND="$requested_backend" XDG_DATA_DIRS='' \
      bash --noprofile --norc -c 'source "$APPDIR/apprun-hooks/linuxdeploy-plugin-gtk.sh"; printf "%s" "$GDK_BACKEND"'
  )
  [[ "$preserved_backend" == "$requested_backend" ]] \
    || die "GTK AppRun hook changed explicit GDK_BACKEND=$requested_backend to '$preserved_backend'"
done
echo "Verified GTK AppRun hook preserves explicit Wayland and X11 backends"

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
  bundled_library=$(find "$appdir/usr" \( -type f -o -type l \) -name "$pattern" -print -quit)
  [[ -z "$bundled_library" ]] \
    || die "bundled display-stack library must come from the host: ${bundled_library#"$appdir"/}"
done
echo "Verified AppImage relies on the host Wayland/XKB/XCB display stack"

require_artifact() {
  local basename=$1
  local match
  local resolved
  match=$(find "$appdir" \( -type f -o -type l \) -name "$basename" -print -quit)
  [[ -n "$match" ]] || die "missing bundled artifact: $basename"
  [[ -e "$match" ]] || die "bundled artifact is a broken symbolic link: ${match#"$appdir"/}"
  resolved=$(realpath "$match")
  [[ "$resolved" == "$appdir"/* ]] \
    || die "bundled artifact resolves outside the AppImage: ${match#"$appdir"/}"
  echo "Found $basename at ${match#"$appdir"/}"
}

require_artifact im-fcitx5.so
require_artifact im-ibus.so
require_artifact libFcitx5GClient.so.2
require_artifact libibus-1.0.so.5

cache=''
while IFS= read -r -d '' candidate; do
  if grep -Fq 'im-fcitx5.so' "$candidate" && grep -Fq 'im-ibus.so' "$candidate"; then
    cache=$candidate
    break
  fi
done < <(find "$appdir" -type f -path '*/gtk-3.0/*/immodules.cache' -print0)

[[ -n "$cache" ]] || die "no private GTK 3 immodules.cache registers both Fcitx 5 and IBus"
echo "Verified GTK input-method cache at ${cache#"$appdir"/}"
