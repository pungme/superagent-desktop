#!/bin/sh
# Total downloads across EVERY release, as a shields.io endpoint badge.
#
# shields.io's own "downloads/total" badge reads one page of the releases API,
# which is the newest 100 releases. This repo has more than that, so each new
# beta pushed an old, well-downloaded release out of the count and the number
# on the README went DOWN as the app was downloaded more.
set -eu
repo="${GITHUB_REPOSITORY:-pungme/superagent-desktop}"
total=$(gh api "repos/$repo/releases?per_page=100" --paginate \
  --jq '[.[].assets[].download_count] | add // 0' | awk '{s+=$1} END{print s+0}')
if [ "$total" -ge 1000000 ]; then msg=$(awk -v n="$total" 'BEGIN{printf "%.1fM", n/1000000}')
elif [ "$total" -ge 1000 ]; then msg=$(awk -v n="$total" 'BEGIN{printf "%.1fk", n/1000}')
else msg="$total"; fi
printf '{"schemaVersion":1,"label":"downloads","message":"%s","color":"1c1d1a"}\n' "$msg"
