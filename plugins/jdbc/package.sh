#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
VERSION="$(grep -m1 '<version>' "$ROOT/pom.xml" | sed -E 's/.*<version>([^<]+)<.*/\1/')"
PACKAGE_DIR="$ROOT/dist/dbx-jdbc-plugin-$VERSION"
ZIP_PATH="$ROOT/dist/dbx-jdbc-plugin-$VERSION.zip"
LATEST_ZIP_PATH="$ROOT/dist/dbx-jdbc-plugin-latest.zip"

cd "$ROOT"
mvn -q -DskipTests package

rm -rf "$PACKAGE_DIR" "$ZIP_PATH" "$LATEST_ZIP_PATH"
mkdir -p "$PACKAGE_DIR/bin" "$PACKAGE_DIR/lib"
cp "$ROOT/manifest.json" "$PACKAGE_DIR/manifest.json"
cp "$ROOT/bin/dbx-jdbc-plugin" "$PACKAGE_DIR/bin/dbx-jdbc-plugin"
cp "$ROOT/bin/dbx-jdbc-plugin.bat" "$PACKAGE_DIR/bin/dbx-jdbc-plugin.bat"
cp "$ROOT/bin/dbx-maven-resolver" "$PACKAGE_DIR/bin/dbx-maven-resolver"
cp "$ROOT/bin/dbx-maven-resolver.bat" "$PACKAGE_DIR/bin/dbx-maven-resolver.bat"
cp "$ROOT/target/dbx-jdbc-plugin-$VERSION-all.jar" "$PACKAGE_DIR/lib/dbx-jdbc-plugin.jar"
chmod +x "$PACKAGE_DIR/bin/dbx-jdbc-plugin"
chmod +x "$PACKAGE_DIR/bin/dbx-maven-resolver"

(cd "$ROOT/dist" && zip -qr "dbx-jdbc-plugin-$VERSION.zip" "dbx-jdbc-plugin-$VERSION")
cp "$ZIP_PATH" "$LATEST_ZIP_PATH"
echo "$ZIP_PATH"
echo "$LATEST_ZIP_PATH"
