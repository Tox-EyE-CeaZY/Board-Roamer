#!/usr/bin/env bash
# Prints the release notes for a commit: the description of the pull request that was merged to make it.
# Usage: release_notes.sh <commit sha>     (needs GH_TOKEN and GITHUB_REPOSITORY; prints nothing when no PR is found)
set -euo pipefail
sha="$1"
pr=$(gh api "repos/$GITHUB_REPOSITORY/commits/$sha/pulls" --jq '[.[] | select(.merged_at != null)] | sort_by(.merged_at) | last | .number // empty' 2>/dev/null || true)
[ -n "$pr" ] || exit 0
gh api "repos/$GITHUB_REPOSITORY/pulls/$pr" --jq '.title + "\u0001" + (.body // "")' | python3 -c '
import re, sys
title, _, body = sys.stdin.read().partition("\x01")
body = body.replace("\r", "")
body = re.sub(r"<!--.*?-->", "", body, flags=re.S)                                   # hidden markers
body = "\n".join(l for l in body.split("\n") if not re.search(r"Generated with|^_Requested by|claude\.ai/code|Co-Authored-By", l))
body = re.sub(r"\n{3,}", "\n\n", body).strip()
body = re.sub(r"(\n\s*---\s*)+$", "", body).strip()
print("## " + title.strip() + "\n\n" + body if body else "## " + title.strip())
print("\n<!-- pr:" + sys.argv[1] + " -->")
' "$pr"
