#!/bin/bash
# Publish a Fold Rage release.
#
# The release itself is built by CI (.github/workflows/release.yml), not here:
# pushing a version-shaped tag triggers a workflow that checks out that exact
# commit, installs from the committed lockfile, builds, attests provenance for
# main.js, and uploads main.js and manifest.json. That is what makes the
# published artifact reproducible from the tagged source.
#
# This script only does the local safety checks and pushes the tag.
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="obsidian-fold-rage"
VERSION="$(node -p "require('./manifest.json').version")"

echo "==> Checking GitHub CLI authentication"
gh auth status
OWNER="$(gh api user --jq .login)"
SLUG="$OWNER/$REPO_NAME"

echo "==> Refusing to touch an unrelated remote"
if git remote get-url origin >/dev/null 2>&1; then
  EXISTING="$(git remote get-url origin)"
  case "$EXISTING" in
    *"$REPO_NAME"*) echo "    origin points at $EXISTING — continuing" ;;
    *) echo "    ERROR: origin points at $EXISTING, which is not $REPO_NAME."; exit 1 ;;
  esac
else
  gh repo create "$REPO_NAME" --public --source=. --remote=origin \
    --description "Fold Rage — Stay in your range. An unofficial workaround for corrupt fold ranges in Obsidian Live Preview."
fi

echo "==> Local checks before tagging"
npm ci
npm run build
npm run verify:brat

if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "ERROR: tag $VERSION already exists. Bump the version rather than moving a published tag."
  exit 1
fi

echo "==> Pushing main and tag $VERSION"
git push origin main
git tag -a "$VERSION" -m "Fold Rage $VERSION"
git push origin "$VERSION"

echo
echo "CI is now building and publishing the release from the tagged commit."
echo "  Actions:  https://github.com/$SLUG/actions"
echo "  Release:  https://github.com/$SLUG/releases/tag/$VERSION"
echo
echo "Once the workflow finishes, verify the live release:"
echo "  node test/verify-brat.mjs --repo=$SLUG"
