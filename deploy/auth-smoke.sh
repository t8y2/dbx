#!/usr/bin/env bash
# End-to-end API smoke test for the DBX multi-user auth layer.
#
# Starts a fresh dbx-web instance plus the demo HTTP-callback adapter, then
# exercises: first-run setup → admin/user roles → role-gated admin APIs →
# password rotation → proxy-header auto-login → callback login → logout →
# legacy password-only login.
#
# Usage:  bash deploy/auth-smoke.sh [path-to-dbx-web-binary]
# Requirements: curl + python3 on PATH. The binary is built if missing.
set -u

EXE="${1:-./target/debug/dbx-web.exe}"
[ -x "$EXE" ] || EXE="${1:-./target/debug/dbx-web}"
if [ ! -x "$EXE" ]; then
  echo "dbx-web binary not found; building (debug, no duckdb)..."
  RUST_MIN_STACK=536870912 cargo build -p dbx-web --no-default-features --features sqlite-sqlcipher \
    -j 1 --config 'profile.dev.incremental=false' --config 'profile.dev.debug=0' --config 'profile.dev.codegen-units=256' \
    || exit 1
fi

PORT=4321
ADAPTER_PORT=4322
DATA_DIR="$(mktemp -d)"
LOG="$DATA_DIR/server.log"
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0

AUTH_CONFIG='[
  {"id":"proxy","kind":"proxy_header","label":"Proxy","enabled":true,"config":{}},
  {"id":"corp","kind":"http_callback","label":"Corp Adapter","enabled":true,"config":{
    "url":"http://127.0.0.1:4322/auth",
    "shared_secret":"demo-shared-secret",
    "role_map":{"ops-admin":"admin"},
    "default_role":"member"
  }}
]'

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "${ADAPTER_PID:-}" ] && kill "$ADAPTER_PID" 2>/dev/null
}
trap cleanup EXIT

echo "== starting demo callback adapter (port $ADAPTER_PORT) =="
ADAPTER_PORT=$ADAPTER_PORT python "$(dirname "$0")/auth-callback-adapter.py" >"$DATA_DIR/adapter.log" 2>&1 &
ADAPTER_PID=$!

echo "== starting dbx-web (port $PORT, data dir $DATA_DIR) =="
DBX_PORT=$PORT DBX_DATA_DIR="$DATA_DIR" DBX_PUBLIC_URL="$BASE" \
  DBX_AUTH_CONFIG="$AUTH_CONFIG" DBX_WEB_CAPTCHA=off \
  "$EXE" >"$LOG" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 150); do
  if curl -sf "$BASE/api/auth/check" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server died during startup:"; tail -20 "$LOG"; exit 1
  fi
  sleep 0.1
done

# helper: report an expectation
check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  PASS  $1"; PASS=$((PASS + 1))
  else
    echo "  FAIL  $1 (expected $2, got $3)"; FAIL=$((FAIL + 1))
  fi
}

code() { # code <method> <url> <cookie-header> <json-body> -> http status
  local method="$1" url="$2" cookie="$3" body="$4"
  if [ -n "$cookie" ]; then
    curl -s -o /dev/null -w "%{http_code}" -X "$method" -H "cookie: $cookie" ${body:+-H "content-type: application/json" -d "$body"} "$url"
  else
    curl -s -o /dev/null -w "%{http_code}" -X "$method" ${body:+-H "content-type: application/json" -d "$body"} "$url"
  fi
}

body_of() { # body_of <method> <url> <cookie-header> <json-body>
  local method="$1" url="$2" cookie="$3" body="$4"
  if [ -n "$cookie" ]; then
    curl -s -X "$method" -H "cookie: $cookie" ${body:+-H "content-type: application/json" -d "$body"} "$url"
  else
    curl -s -X "$method" ${body:+-H "content-type: application/json" -d "$body"} "$url"
  fi
}

echo
echo "== 1. first-run state =="
provider_ids=$(body_of GET "$BASE/api/auth/providers" "" "" | python -c "import json,sys;print(','.join(p['id'] for p in json.load(sys.stdin)['providers']))")
check "login page lists local + proxy + callback providers" "local,proxy,corp" "$provider_ids"
setup_required=$(body_of GET "$BASE/api/auth/check" "" "" | python -c "import json,sys;print(json.load(sys.stdin)['setup_required'])")
check "external providers suppress the setup wizard (pure-SSO semantics)" "False" "$setup_required"

echo "== 2. first-run setup creates the admin =="
setup_code=$(code POST "$BASE/api/auth/setup" "" '{"password":"admin123"}')
check "setup accepts the initial password" "200" "$setup_code"
# log in explicitly to obtain a clean admin cookie jar (two form providers are
# enabled, so the request routes explicitly to the local provider)
admin_login=$(curl -s -i -X POST -H 'content-type: application/json' -d '{"password":"admin123","provider":"local"}' "$BASE/api/auth/login")
ADMIN_COOKIE=$(printf '%s' "$admin_login" | grep -i '^set-cookie: dbx_session=' | head -1 | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
check "admin login succeeds (username-less local account)" "200" "$(printf '%s' "$admin_login" | head -1 | grep -o '200')"
who=$(body_of GET "$BASE/api/auth/check" "$ADMIN_COOKIE" "" | python -c "import json,sys;d=json.load(sys.stdin);print(d['user']['username'],d['user']['role'],d['authenticated'])")
check "admin session carries identity admin/admin" "admin admin True" "$who"

echo "== 3. admin creates a member =="
created=$(code POST "$BASE/api/auth/admin/users" "$ADMIN_COOKIE" '{"username":"bob","password":"bob123","role":"member"}')
check "admin creates local user bob" "200" "$created"

echo "== 4. member login + role gating =="
bob_login=$(curl -s -i -X POST -H 'content-type: application/json' -d '{"username":"bob","password":"bob123","provider":"local"}' "$BASE/api/auth/login")
BOB_COOKIE=$(printf '%s' "$bob_login" | grep -i '^set-cookie: dbx_session=' | head -1 | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
check "bob logs in with username+password" "200" "$(printf '%s' "$bob_login" | head -1 | grep -o '200')"
bob_role=$(body_of GET "$BASE/api/auth/check" "$BOB_COOKIE" "" | python -c "import json,sys;print(json.load(sys.stdin)['user']['role'])")
check "bob's role is member" "member" "$bob_role"
check "member is rejected by admin API (403)" "403" "$(code GET "$BASE/api/auth/admin/users" "$BOB_COOKIE" "")"

echo "== 5. password rotation =="
rotated=$(code POST "$BASE/api/auth/change-password" "$BOB_COOKIE" '{"old_password":"bob123","new_password":"bob456"}')
check "bob rotates his own password" "200" "$rotated"
check "new password accepted" "200" "$(code POST "$BASE/api/auth/login" "" '{"username":"bob","password":"bob456","provider":"local"}')"
check "old password rejected after rotation" "401" "$(code POST "$BASE/api/auth/login" "" '{"username":"bob","password":"bob123","provider":"local"}')"

echo "== 6. proxy-header auto-login (trusted loopback) =="
proxy_response=$(curl -s -i -H 'x-forwarded-user: carol' "$BASE/api/connection/list")
PROXY_COOKIE=$(printf '%s' "$proxy_response" | grep -i '^set-cookie: dbx_session=' | head -1 | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
if [ -n "$PROXY_COOKIE" ]; then
  echo "  PASS  trusted proxy header auto-creates a session"; PASS=$((PASS + 1))
else
  echo "  FAIL  trusted proxy header did not create a session"; FAIL=$((FAIL + 1))
fi
carol=$(body_of GET "$BASE/api/auth/check" "$PROXY_COOKIE" "" | python -c "import json,sys;d=json.load(sys.stdin);print(d['user']['username'],d['user']['role'],d['user']['provider_id'])" 2>/dev/null || echo "none")
check "proxy identity JIT-provisioned as carol/member/proxy" "carol member proxy" "$carol"
check "proxy user (member) rejected by admin API (403)" "403" "$(code GET "$BASE/api/auth/admin/users" "$PROXY_COOKIE" "")"

echo "== 7. HTTP-callback provider (demo adapter) =="
callback_code=$(code POST "$BASE/api/auth/login" "" '{"username":"demo","password":"demo123","provider":"corp"}')
check "callback login accepts demo/demo123" "200" "$callback_code"
DEMO_COOKIE=$(curl -s -i -X POST -H 'content-type: application/json' -d '{"username":"demo","password":"demo123","provider":"corp"}' "$BASE/api/auth/login" | grep -i '^set-cookie: dbx_session=' | head -1 | sed 's/^[Ss]et-[Cc]ookie: //' | cut -d';' -f1)
demo_role=$(body_of GET "$BASE/api/auth/check" "$DEMO_COOKIE" "" | python -c "import json,sys;print(json.load(sys.stdin)['user']['role'])" 2>/dev/null || echo "none")
check "callback group ops-admin maps to admin" "admin" "$demo_role"
check "wrong callback password rejected" "401" "$(code POST "$BASE/api/auth/login" "" '{"username":"demo","password":"nope","provider":"corp"}')"

echo "== 8. logout burns the session =="
check "admin logout succeeds" "200" "$(code POST "$BASE/api/auth/logout" "$ADMIN_COOKIE" "")"
check "logged-out cookie is no longer authenticated" "401" "$(code GET "$BASE/api/connection/list" "$ADMIN_COOKIE" "")"
check "logged-out admin API access denied" "401" "$(code GET "$BASE/api/auth/admin/users" "$ADMIN_COOKIE" "")"

echo "== 9. regression: wrong password / username requirement =="
check "wrong admin password rejected (401, no captcha on first failure)" "401" "$(code POST "$BASE/api/auth/login" "" '{"username":"admin","password":"wrong","provider":"local"}')"
check "password-only login with several local users asks for a username (400)" "400" "$(code POST "$BASE/api/auth/login" "" '{"password":"admin123"}')"

echo
echo "== summary: $PASS passed, $FAIL failed =="
echo "server log: $LOG"
[ "$FAIL" = "0" ]
