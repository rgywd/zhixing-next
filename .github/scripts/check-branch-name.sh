#!/usr/bin/env bash
set -euo pipefail

branch="${1:-}"

if [[ -z "${branch}" ]]; then
  echo "Usage: $0 <branch-name>" >&2
  exit 2
fi

case "${branch}" in
  release/*)
    pattern='^release/[0-9]+\.[0-9]+\.[0-9]+$'
    ;;
  feat/*)
    pattern='^feat/[^/[:space:]]+-[^/[:space:]]+$'
    ;;
  fix/*)
    pattern='^fix/[^/[:space:]]+-[^/[:space:]]+$'
    ;;
  chore/*)
    pattern='^chore/[^/[:space:]]+$'
    ;;
  exp/*)
    pattern='^exp/[^/[:space:]]+$'
    ;;
  *)
    pattern='a^'
    ;;
esac

if [[ ! "${branch}" =~ ${pattern} ]]; then
  cat >&2 <<EOF
Invalid branch name: ${branch}

Allowed forms:
  release/x.y.z
  feat/requirement-id-description
  fix/issue-id-description
  chore/description
  exp/description
EOF
  exit 1
fi

echo "Branch name accepted: ${branch}"
