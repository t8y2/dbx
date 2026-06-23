#!/usr/bin/env bash
set -euo pipefail

# 自动打 tag 并推送触发发布
# 用法:
#   ./scripts/release.sh              # 自动递增 patch 版本
#   ./scripts/release.sh minor        # 递增 minor 版本
#   ./scripts/release.sh major        # 递增 major 版本
#   ./scripts/release.sh agents-v0.3.0 # 手动指定版本号
#   ./scripts/release.sh v0.3.0        # 手动指定旧 dbx-agents 版本号，会转换为 agents-v0.3.0

BUMP="${1:-patch}"

to_agents_tag() {
  case "$1" in
    agents-v*) echo "$1" ;;
    v*) echo "agents-$1" ;;
    *) echo "$1" ;;
  esac
}

bump_tag() {
  local tag="$1"
  local bump="$2"
  local version major minor patch

  version="${tag#agents-v}"
  IFS='.' read -r major minor patch <<< "$version"

  case "$bump" in
    major)
      echo "agents-v$((major + 1)).0.0"
      ;;
    minor)
      echo "agents-v${major}.$((minor + 1)).0"
      ;;
    patch)
      echo "agents-v${major}.${minor}.$((patch + 1))"
      ;;
    agents-v*|v*)
      to_agents_tag "$bump"
      ;;
    *)
      echo "错误: 未知的版本递增方式 '$bump'，请使用 patch/minor/major 或 agents-vX.Y.Z" >&2
      return 1
      ;;
  esac
}

# 获取当前仓库最新的 agents-v 开头的 tag
latest_tag=$(git tag --sort=-v:refname | grep '^agents-v' | head -1 || true)

if [ -z "$latest_tag" ]; then
  # 迁移后首次发布时，沿用旁边旧 dbx-agents 仓库的 vX.Y.Z tag。
  legacy_tag=""
  if git -C ../dbx-agents rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    legacy_tag=$(git -C ../dbx-agents tag --sort=-v:refname | grep '^v' | head -1 || true)
  fi

  if [ -n "$legacy_tag" ]; then
    latest_tag=$(to_agents_tag "$legacy_tag")
    echo "当前仓库未找到 Agent 版本 tag，沿用旧 dbx-agents 最新 tag: $legacy_tag"
  else
    latest_tag="agents-v0.0.0"
    echo "未找到任何 Agent 版本 tag，从 agents-v0.1.0 开始"
  fi
else
  echo "当前最新 tag: $latest_tag"
fi

new_tag=$(bump_tag "$latest_tag" "$BUMP")

echo "新版本: $new_tag"

# 确认
read -r -p "确认创建并推送 tag ${new_tag}? [y/N] " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
  echo "已取消"
  exit 0
fi

# 创建并推送 tag
git tag "$new_tag"
git push origin "$new_tag"

echo "完成! tag $new_tag 已推送，CI 将自动触发发布流程。"
