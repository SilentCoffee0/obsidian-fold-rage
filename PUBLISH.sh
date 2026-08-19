#!/bin/bash
# Publish Fold Rage. Run from the repository root: bash PUBLISH.sh
set -euo pipefail

cd "$(dirname "$0")"

REPO_NAME="obsidian-fold-rage"
TAG="v0.1.0"
ZIP="dist/fold-rage-0.1.0.zip"

echo "==> Checking GitHub CLI authentication"
gh auth status

OWNER="$(gh api user --jq .login)"
SLUG="$OWNER/$REPO_NAME"

echo "==> Refusing to touch an unrelated remote"
if git remote get-url origin >/dev/null 2>&1; then
  EXISTING="$(git remote get-url origin)"
  case "$EXISTING" in
    *"$REPO_NAME"*) echo "    origin already points at $EXISTING — continuing" ;;
    *) echo "    ERROR: origin points at $EXISTING, which is not $REPO_NAME."
       echo "    Remove or repoint it first; this script will not overwrite it."
       exit 1 ;;
  esac
fi

echo "==> Building and checking the release layout"
npm run build
npm run verify:brat

echo "==> Creating or reusing $SLUG"
if gh repo view "$SLUG" >/dev/null 2>&1; then
  echo "    $SLUG already exists — pushing to it"
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$SLUG.git"
  git push -u origin HEAD
else
  gh repo create "$REPO_NAME" \
    --public \
    --source=. \
    --remote=origin \
    --push \
    --description "Fold Rage — Stay in your range. An unofficial workaround for corrupt fold ranges in Obsidian Live Preview."
fi

echo "==> Creating release $TAG"
# main.js and manifest.json must be individual assets: BRAT matches release
# assets by exact filename and ignores the .zip, which is for manual installs.
gh release create "$TAG" \
  main.js \
  manifest.json \
  "$ZIP" \
  --title "Fold Rage v0.1.0 — Stay in your range" \
  --notes-file RELEASE_NOTES.md

echo
echo "Published: https://github.com/$SLUG"
echo "Release:   https://github.com/$SLUG/releases/tag/$TAG"
echo
echo "==> Verifying the live release against BRAT's requirements"
node test/verify-brat.mjs --repo="$SLUG"
