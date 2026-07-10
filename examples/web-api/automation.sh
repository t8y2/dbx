#!/usr/bin/env bash
set -euo pipefail

# Minimal DBX Web API automation example.
# Requires a running DBX Web/Docker instance.

BASE_URL="${DBX_WEB_URL:-http://localhost:4224}"
PASSWORD="${DBX_WEB_PASSWORD:-changeme}"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

echo "==> Checking auth state"
curl -fsS "$BASE_URL/api/auth/check"

echo
echo "==> Logging in"
curl -fsS -c "$COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"$PASSWORD\"}" \
  "$BASE_URL/api/auth/login" >/dev/null

echo "==> Listing saved connections"
curl -fsS -b "$COOKIE_JAR" "$BASE_URL/api/connection/list" | jq .

echo
echo "Done. Reuse the session cookie for schema and query routes."
