set -euo pipefail

issue_text="$(
  jq -r '
    [
      .issue.title // "",
      .issue.body // ""
    ] | join("\n")
  ' "$GITHUB_EVENT_PATH"
)"

issue_number="$(jq -r '.issue.number' "$GITHUB_EVENT_PATH")"

prefix="$(printf '\345\210\267')"
cn_target="$(printf '\346\230\237')"
ascii_target="$(printf '\163\164\141\162')"
pattern="${prefix}[[:space:]]*(${cn_target}|${ascii_target})"

if grep -Eiq "$pattern" <<<"$issue_text"; then
  matched=true
else
  matched=false
fi

{
  printf 'matched=%s\n' "$matched"
  printf 'issue_number=%s\n' "$issue_number"
} >>"$GITHUB_OUTPUT"
