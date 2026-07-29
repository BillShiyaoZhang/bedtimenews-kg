#!/usr/bin/env bash

set -euo pipefail

coverage_issue_title="Semantic coverage is below the reviewed threshold"
coverage_issue_url="$(gh issue list \
  --repo "$GITHUB_REPOSITORY" \
  --state open \
  --search "\"$coverage_issue_title\" in:title" \
  --json title,url \
  --jq "map(select(.title == \"$coverage_issue_title\"))[0].url // empty")"

if [[ -n "$coverage_issue_url" ]]; then
  echo "Coverage advisory issue is already open: $coverage_issue_url"
  exit 0
fi

gh label create coverage-advisory \
  --repo "$GITHUB_REPOSITORY" \
  --description "Non-blocking semantic coverage regression" \
  --color FBCA04 \
  --force
gh issue create \
  --repo "$GITHUB_REPOSITORY" \
  --title "$coverage_issue_title" \
  --body "The non-blocking semantic coverage check failed in [$GITHUB_WORKFLOW #$GITHUB_RUN_NUMBER]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID). Required validation still gates sync and merging." \
  --label coverage-advisory \
  --assignee "$GITHUB_REPOSITORY_OWNER"
