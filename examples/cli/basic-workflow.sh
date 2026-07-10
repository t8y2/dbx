#!/usr/bin/env bash
set -euo pipefail

# Basic DBX CLI workflow.
# Replace "local" with one of your saved connection names.

CONNECTION="${DBX_CONNECTION:-local}"

echo "==> Checking local DBX setup"
dbx doctor

echo "==> Listing connections"
dbx connections list --json

echo "==> Listing tables"
dbx schema list "$CONNECTION" --json

echo "==> Running a read-only query"
dbx query "$CONNECTION" "select 1 as ok" --json

echo "==> Building schema context for prompts"
dbx context "$CONNECTION" --tables users,orders
