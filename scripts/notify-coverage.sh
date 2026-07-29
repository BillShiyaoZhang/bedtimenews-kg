#!/usr/bin/env bash

set -euo pipefail

coverage_issue_title="Semantic coverage is below the reviewed threshold"
coverage_issue_number="$(gh issue list \
  --repo "$GITHUB_REPOSITORY" \
  --state open \
  --search "\"$coverage_issue_title\" in:title" \
  --json number,title \
  --jq "map(select(.title == \"$coverage_issue_title\"))[0].number // empty")"

if [[ -z "$coverage_issue_number" ]]; then
  gh label create coverage-advisory \
    --repo "$GITHUB_REPOSITORY" \
    --description "Non-blocking semantic coverage regression" \
    --color FBCA04 \
    --force
  coverage_issue_url="$(gh issue create \
    --repo "$GITHUB_REPOSITORY" \
    --title "$coverage_issue_title" \
    --body "The non-blocking semantic coverage check failed in [$GITHUB_WORKFLOW #$GITHUB_RUN_NUMBER]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID). Required validation still gates sync and merging. The daily Codex scheduled task will inspect this advisory and will push to main only after the complete validation suite passes." \
    --label coverage-advisory \
    --assignee "$GITHUB_REPOSITORY_OWNER")"
  echo "Opened coverage advisory issue: $coverage_issue_url"
else
  echo "Coverage advisory issue #$coverage_issue_number is already open."
fi
