#!/usr/bin/env bash
set -euo pipefail

# Verify the static web package inside an old-glibc container (e.g.
# ubuntu:14.04). The container arch matches the package arch, so the binary
# runs natively. Confirms the ELF is fully static and the HTTP server serves
# the bundled frontend.

package_tarball="${1:-${DBX_STATIC_TARBALL:-}}"
if [ -z "$package_tarball" ]; then
  echo "usage: $0 <package-tarball>" >&2
  exit 2
fi

verify_seconds="${DBX_STATIC_VERIFY_SECONDS:-30}"
runtime_dir="${DBX_STATIC_VERIFY_DIR:-/tmp/dbx-web-static-verify}"

if [ ! -f "$package_tarball" ]; then
  echo "missing package tarball: $package_tarball" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1 || ! command -v readelf >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  # Archived releases (14.04, etc.) have moved to old-releases.ubuntu.com
  if [ -f /etc/apt/sources.list ] && ! apt-get update 2>/dev/null; then
    sed -i 's|archive\.ubuntu\.com|old-releases.ubuntu.com|g' /etc/apt/sources.list
    sed -i 's|security\.ubuntu\.com|old-releases.ubuntu.com|g' /etc/apt/sources.list
    apt-get -o Acquire::Check-Valid-Until=false update
  fi
  apt-get install -y --no-install-recommends ca-certificates bash binutils curl procps
  rm -rf /var/lib/apt/lists/*
fi

rm -rf "$runtime_dir"
mkdir -p "$runtime_dir"
tar -xzf "$package_tarball" -C "$runtime_dir" --strip-components=1

for required_runtime_path in \
  dbx \
  bin/dbx-web-bin \
  dist/index.html; do
  if [ ! -e "$runtime_dir/$required_runtime_path" ]; then
    echo "missing packaged static web runtime path: $required_runtime_path" >&2
    exit 1
  fi
done

if readelf -l "$runtime_dir/bin/dbx-web-bin" | grep -q 'Requesting program interpreter'; then
  readelf -l "$runtime_dir/bin/dbx-web-bin" | grep 'Requesting program interpreter' >&2 || true
  echo "packaged dbx-web is not static: ELF has a program interpreter" >&2
  exit 1
fi

if readelf -d "$runtime_dir/bin/dbx-web-bin" 2>/dev/null | grep -q 'Shared library:'; then
  readelf -d "$runtime_dir/bin/dbx-web-bin" | grep 'Shared library:' >&2 || true
  echo "packaged dbx-web is not static: ELF has dynamic shared library dependencies" >&2
  exit 1
fi

cd "$runtime_dir"
export RUST_BACKTRACE="${RUST_BACKTRACE:-full}"
export DBX_DISABLE_PASSWORD="${DBX_DISABLE_PASSWORD:-1}"
export DBX_PORT="${DBX_PORT:-4224}"

echo "static web verification page size: $(getconf PAGE_SIZE 2>/dev/null || echo unknown)"
./dbx >/tmp/dbx-web-static.log 2>&1 &
pid=$!
cleanup() {
  kill "$pid" >/dev/null 2>&1 || true
  wait "$pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in $(seq 1 "$verify_seconds"); do
  if ! kill -0 "$pid" 2>/dev/null; then
    cat /tmp/dbx-web-static.log || true
    wait "$pid"
    exit 1
  fi

  if curl -fsS "http://127.0.0.1:${DBX_PORT}/" >/tmp/dbx-web-static-index.html 2>/dev/null; then
    curl -fsS "http://127.0.0.1:${DBX_PORT}/api/auth/check" >/tmp/dbx-web-static-auth.json
    grep -q '"authenticated":true' /tmp/dbx-web-static-auth.json
    echo "static web verification HTTP check passed"
    tail -40 /tmp/dbx-web-static.log || true
    exit 0
  fi

  sleep 1
done

cat /tmp/dbx-web-static.log || true
echo "static dbx-web did not become ready within ${verify_seconds}s" >&2
exit 1
