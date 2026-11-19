#!/usr/bin/env bash
set -euo pipefail

archive=$(mktemp)
trap 'rm -f -- "$archive"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

curl --fail --location --silent --show-error \
  --retry 2 --retry-connrefused --retry-delay 2 \
  --connect-timeout 15 --max-time 120 --retry-max-time 360 \
  https://github.com/rui314/mold/releases/download/v2.42.1/mold-2.42.1-x86_64-linux.tar.gz \
  --output "$archive"
sudo tar -C /usr/local --strip-components=1 -xzf "$archive"
mold --version
