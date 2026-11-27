#!/usr/bin/env bash
set -euo pipefail

output="${1:?Windows x64 output path is required}"
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ "$(go env GOVERSION)" != go1.20.14 ]; then
  echo 'Windows x64 Neo4j agents must be built with Go 1.20.14 for Windows 7 compatibility.' >&2
  exit 1
fi

export GOTOOLCHAIN=local
go test -mod=readonly -modfile=go.windows-legacy.mod -tags=neo4j_legacy_windows ./...
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build \
  -mod=readonly -modfile=go.windows-legacy.mod -tags=neo4j_legacy_windows \
  -trimpath -ldflags="-s -w" -o "$output" .
DBX_NEO4J_WINDOWS_COMPAT_BINARY="$output" go test \
  -mod=readonly -modfile=go.windows-legacy.mod -tags=neo4j_legacy_windows \
  -run '^TestWindowsAgentBinaryCompatibility$' -count=1 .
