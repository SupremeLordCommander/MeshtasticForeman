#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAME=$(node -p "require('$ROOT/packages/web/package.json').name" 2>/dev/null || echo "@foreman/web")
VERSION=$(node -p "require('$ROOT/packages/web/package.json').version" 2>/dev/null || echo "unknown")

echo ""
echo "  Meshtastic Foreman — Frontend"
echo "  $NAME v$VERSION"
echo ""

cd "$ROOT"
pnpm --filter @foreman/web dev
