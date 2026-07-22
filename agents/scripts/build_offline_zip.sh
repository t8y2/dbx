#!/usr/bin/env bash
set -euo pipefail

# Build offline ZIP bundles for each platform.
# Usage: ./scripts/build_offline_zip.sh <release-dir>
# The release-dir must contain agent-registry.json, dbx-agent-*.jar, and dbx-jre-*.tar.gz

RELEASE_DIR="$(cd "${1:?Usage: build_offline_zip.sh <release-dir>}" && pwd)"

if [ ! -f "$RELEASE_DIR/agent-registry.json" ]; then
  echo "ERROR: agent-registry.json not found in $RELEASE_DIR"
  exit 1
fi

PLATFORMS=(
  "macos-aarch64"
  "macos-x64"
  "linux-x64"
  "linux-aarch64"
  "windows-x64"
  "windows-aarch64"
)

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

for platform in "${PLATFORMS[@]}"; do
  WORK="$STAGING/$platform"
  mkdir -p "$WORK/jre" "$WORK/drivers"

  cp "$RELEASE_DIR/agent-registry.json" "$WORK/"

  # Copy all JRE archives for this platform
  JRE_COUNT=0
  for jre_file in "$RELEASE_DIR"/dbx-jre-*-"$platform".tar.gz; do
    [ -f "$jre_file" ] || continue
    cp "$jre_file" "$WORK/jre/"
    JRE_COUNT=$((JRE_COUNT + 1))
  done

  if [ "$JRE_COUNT" -eq 0 ]; then
    echo "SKIP $platform (no JRE found)"
    rm -rf "$WORK"
    continue
  fi

  # Copy all driver JARs (platform-independent)
  for jar_file in "$RELEASE_DIR"/dbx-agent-*.jar; do
    [ -f "$jar_file" ] || continue
    # Kingbase is distributed only as a native agent; keep legacy JDBC builds out of offline bundles.
    case "$(basename "$jar_file")" in
      dbx-agent-kingbase.jar|dbx-agent-kingbase-*.jar) continue ;;
    esac
    cp "$jar_file" "$WORK/drivers/"
  done

  for native_file in "$RELEASE_DIR"/dbx-agent-*-"$platform" "$RELEASE_DIR"/dbx-agent-*-"$platform".exe; do
    [ -f "$native_file" ] || continue
    cp "$native_file" "$WORK/drivers/"
  done

  ZIP_NAME="dbx-agents-offline-${platform}.zip"
  (cd "$WORK" && zip -r "$RELEASE_DIR/$ZIP_NAME" agent-registry.json jre/ drivers/)
  SIZE=$(du -h "$RELEASE_DIR/$ZIP_NAME" | cut -f1)
  echo "Created $ZIP_NAME ($SIZE)"
done

echo "Done."
