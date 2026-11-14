#!/usr/bin/env bash
# openFilter.js を公開Gistへ公開する。
# 使い方: scripts/publish-openfilter-gist.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

gist_id="$(tr -d '[:space:]' < scripts/openfilter-gist-id.txt)"
if [[ -z "$gist_id" ]]; then
    echo "scripts/openfilter-gist-id.txt が空です" >&2
    exit 1
fi

node --check openFilter.js
node tests/check-userscript.mjs

gh gist edit "$gist_id" --filename openFilter.user.js openFilter.js

owner="$(gh api user --jq .login)"
echo "Published: https://gist.githubusercontent.com/${owner}/${gist_id}/raw/openFilter.user.js"
