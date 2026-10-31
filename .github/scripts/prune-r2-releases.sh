#!/usr/bin/env bash
# Keep only the newest five versioned release directories of one R2 channel.
#
# Usage: prune-r2-releases.sh <stable|beta> <current_tag>
#
# stable: published non-prerelease releases (a promoted beta tag lives under
#         releases/stable/ too) and also removes legacy releases/<tag>/ dirs.
# beta:   published releases whose tag is a beta tag, whatever their prerelease
#         flag, because a promoted beta keeps its releases/beta/<tag>/ directory.
#
# Nothing is deleted unless five releases are listed and <current_tag> is one
# of them, so incomplete release metadata can never remove the wrong versions.
# Needs GH_TOKEN, GITHUB_REPOSITORY, R2_ACCOUNT_ID, R2_BUCKET_NAME and AWS credentials.

set -euo pipefail

family="${1:?family (stable|beta) required}"
current_tag="${2:?current tag required}"
keep_count=5
beta_pattern='^v[0-9]+[.][0-9]+[.][0-9]+-beta[.][0-9]{8}[.][0-9]+$'
version_pattern='^v[0-9]+[.][0-9]+[.][0-9]+([.-][0-9A-Za-z.-]+)?$'

case "$family" in
  stable)
    filter='.isDraft == false and .isPrerelease == false and (.tagName | test($version))'
    ;;
  beta)
    filter='.isDraft == false and (.tagName | test($beta))'
    ;;
  *)
    echo "::error::Unknown R2 channel: $family" >&2
    exit 2
    ;;
esac

mapfile -t keep_tags < <(
  gh release list --repo "${GITHUB_REPOSITORY}" --limit 100 --json tagName,isDraft,isPrerelease,publishedAt \
    | jq -r --arg version "$version_pattern" --arg beta "$beta_pattern" --argjson keep "$keep_count" \
      "[.[] | select($filter)] | sort_by(.publishedAt) | reverse | .[:\$keep] | .[].tagName"
)

if [ "${#keep_tags[@]}" -lt "$keep_count" ]; then
  echo "::warning::Fewer than ${keep_count} published ${family} releases; skipping ${family} R2 cleanup."
  exit 0
fi

is_kept() {
  printf '%s\n' "${keep_tags[@]}" | grep -Fxq -- "$1"
}

if ! is_kept "$current_tag"; then
  echo "::warning::Current release ${current_tag} is not among the latest ${keep_count} ${family} releases; skipping ${family} R2 cleanup."
  exit 0
fi

echo "Keeping R2 ${family} releases: ${keep_tags[*]}"
endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

list_tags() {
  local prefix="$1"
  aws s3api list-objects-v2 --bucket "${R2_BUCKET_NAME}" --prefix "${prefix}" --delimiter "/" \
    --endpoint-url "${endpoint}" --query 'CommonPrefixes[].Prefix' --output text \
    | tr '\t' '\n' \
    | sed -nE "s#^${prefix}(v[0-9]+\\.[0-9]+\\.[0-9]+([.-][0-9A-Za-z.-]+)?)/\$#\\1#p"
}

mapfile -t stored_tags < <(list_tags "releases/${family}/")
for tag in "${stored_tags[@]}"; do
  if is_kept "$tag"; then continue; fi
  echo "Removing old R2 release: ${family}/${tag}"
  aws s3 rm "s3://${R2_BUCKET_NAME}/releases/${family}/${tag}/" --recursive --endpoint-url "${endpoint}"
done

if [ "$family" = stable ]; then
  mapfile -t legacy_tags < <(list_tags "releases/")
  for tag in "${legacy_tags[@]}"; do
    echo "Removing legacy R2 release directory: ${tag}"
    aws s3 rm "s3://${R2_BUCKET_NAME}/releases/${tag}/" --recursive --endpoint-url "${endpoint}"
  done
fi
