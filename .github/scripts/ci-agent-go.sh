#!/usr/bin/env bash
set -euo pipefail

driver="${1:?driver is required}"
binary="${2:?binary name is required}"
race="${3:?race mode is required}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root/agents/drivers/$driver"
if [ "$driver" = xugu ]; then export GONOSUMDB=gitee.com/XuguDB/go-xugu-driver; fi

if [ "$race" = true ]; then go test -race ./...; else go test ./...; fi
if [ "$driver" = zookeeper ]; then
  for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64 windows/arm64 windows/amd64; do
    IFS=/ read -r goos goarch <<< "$target"
    output="/tmp/dbx-agent-zookeeper-${goos}-${goarch}"
    [ "$goos" = windows ] && output="${output}.exe"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags="-s -w" -o "$output" .
  done
else
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "/tmp/dbx-agent-${binary}-linux-x64" .
fi
