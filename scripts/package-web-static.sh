#!/usr/bin/env bash
set -euo pipefail

# Package a fully static musl-linked dbx-web binary together with the built
# frontend into a portable tarball that runs on any Linux (no glibc needed).

target="${DBX_STATIC_TARGET:-aarch64-unknown-linux-musl}"
dist_dir="${DBX_FRONTEND_DIST:-dist}"
output_dir="${DBX_STATIC_OUTPUT_DIR:-dist-web-static}"

case "$target" in
  x86_64-unknown-linux-musl*)
    arch_label="x64"
    ;;
  aarch64-unknown-linux-musl*)
    arch_label="arm64"
    ;;
  *)
    echo "unsupported static web target: $target" >&2
    exit 2
    ;;
esac

binary="${DBX_WEB_BINARY:-target/${target}/release/dbx-web}"
package_name="${DBX_STATIC_PACKAGE_NAME:-dbx-linux-${arch_label}-browser-static}"
package_dir="${output_dir}/${package_name}"
tarball="${output_dir}/${package_name}.tar.gz"

if [ ! -x "$binary" ]; then
  echo "missing static dbx-web binary: $binary" >&2
  exit 1
fi

if [ ! -f "${dist_dir}/index.html" ]; then
  echo "missing frontend build output: ${dist_dir}/index.html" >&2
  exit 1
fi

if readelf -l "$binary" | grep -q 'Requesting program interpreter'; then
  readelf -l "$binary" | grep 'Requesting program interpreter' >&2 || true
  echo "dbx-web is not fully static: ELF has a program interpreter" >&2
  exit 1
fi

if readelf -d "$binary" 2>/dev/null | grep -q 'Shared library:'; then
  readelf -d "$binary" | grep 'Shared library:' >&2 || true
  echo "dbx-web is not fully static: ELF has dynamic shared library dependencies" >&2
  exit 1
fi

rm -rf "$output_dir"
mkdir -p \
  "$package_dir/bin" \
  "$package_dir/dist" \
  "$package_dir/data"

cp "$binary" "$package_dir/bin/dbx-web-bin"
chmod +x "$package_dir/bin/dbx-web-bin"
cp -a "${dist_dir}/." "$package_dir/dist/"

cat > "$package_dir/dbx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P "$(dirname "$SOURCE")" && pwd)"
export DBX_PACKAGE_ROOT="$ROOT"
export DBX_STATIC_DIR="${DBX_STATIC_DIR:-$ROOT/dist}"
export DBX_DATA_DIR="${DBX_DATA_DIR:-$ROOT/data}"
port="${DBX_PORT:-4224}"
base_path="${DBX_PUBLIC_BASE_PATH:-/}"
case "$base_path" in
  "") base_path="/" ;;
  /*) ;;
  *) base_path="/$base_path" ;;
esac
printf 'DBX browser UI: http://127.0.0.1:%s%s\n' "$port" "$base_path"
cd "$ROOT"
exec "$ROOT/bin/dbx-web-bin" "$@"
EOF
chmod +x "$package_dir/dbx"
ln -sfn dbx "$package_dir/dbx-web"

cat > "$package_dir/README.txt" <<EOF
DBX ${arch_label} static browser package

Run:
  ./dbx

Then open:
  http://127.0.0.1:4224

This package runs a musl-linked static dbx-web binary and serves the bundled
frontend from ./dist. The backend binary has no ELF interpreter and no DT_NEEDED
shared library entries, so it runs on any Linux distribution regardless of the
system glibc version (verified down to Ubuntu 14.04).

Useful environment variables:
  DBX_PORT=4224
  DBX_DATA_DIR=./data
  DBX_PASSWORD=your-password
  DBX_DISABLE_PASSWORD=1
EOF

tar -C "$output_dir" -czf "$tarball" "$package_name"
sha256sum "$tarball" | tee "${tarball}.sha256"
file "$package_dir/bin/dbx-web-bin"
du -sh "$package_dir" "$tarball"
