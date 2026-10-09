#!/usr/bin/env bash
# Runs the PR's frontend against a dbx-web backend in a home of its own, with
# made-up data beside it (seed.mjs: two SQLite databases, connections, a
# saved-SQL library, query history), and records it (record.mjs).
#
#   run.sh <out dir>
#
# env: DBX_WEB_BIN    the dbx-web binary (or the static package's launcher)
#                     — required
#      DIST_DIR       the PR's frontend build; when set it replaces the
#                     binary's embedded frontend (DBX_STATIC_DIR)
#      DBX_PORT       listen port (default 4280)
#      DEEPSEEK_API_KEY, DIFF_FILE, PR_TITLE, PR_BODY_FILE, SRC_DIR (the
#      PR's source, for code context) — read by record.mjs;
#      PLAYWRIGHT_BROWSERS_PATH must already point at the installed
#      Chromium, since HOME moves.
#
# For local testing against a dbx-web that already runs somewhere: set
# DBX_URL and nothing here is started or seeded.
set -euo pipefail
[ "$(uname -s)" = Linux ] || { echo "run.sh: Linux only" >&2; exit 1; }
out_arg=$1
mkdir -p "$out_arg"
out=$(cd "$out_arg" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
web=""
trap 'kill "${web:-}" 2>/dev/null || true' EXIT

url=${DBX_URL:-}
if [ -z "$url" ]; then
  : "${DBX_WEB_BIN:?DBX_WEB_BIN or DBX_URL is required}"
  port=${DBX_PORT:-4280}
  # nothing of the runner's own: the app sees only this home
  export HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config" XDG_CACHE_HOME="$work/home/.cache" \
         XDG_DATA_HOME="$work/home/.local/share" XDG_STATE_HOME="$work/home/.local/state"
  mkdir -p "$HOME" "$work/data" "$work/dbs"

  static=()
  [ -n "${DIST_DIR:-}" ] && static=(DBX_STATIC_DIR="$(cd "$DIST_DIR" && pwd)")
  env DBX_PORT="$port" DBX_BIND_ADDR=127.0.0.1 DBX_DISABLE_PASSWORD=1 \
      DBX_DATA_DIR="$work/data" "${static[@]}" \
      "$DBX_WEB_BIN" >"$work/web.log" 2>&1 &
  web=$!
  url="http://127.0.0.1:$port"
  for _ in $(seq 60); do
    curl -fsS -o /dev/null "$url/api/auth/check" 2>/dev/null && break
    kill -0 "$web" 2>/dev/null || { cat "$work/web.log"; exit 1; }
    sleep 1
  done
  curl -fsS -o /dev/null "$url/api/auth/check" || { echo "run.sh: dbx-web never became ready" >&2; cat "$work/web.log"; exit 1; }

  node "$here/seed.mjs" dbs "$work/dbs"
  node "$here/seed.mjs" api "$url" "$work/dbs"
  export SEED_DIR="$work/dbs"
fi

status=0
DBX_URL="$url" OUT_DIR="$out" node "$here/record.mjs" || status=$?
exit $status
