#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

VERSION=$(grep '^VERSION=' "$ROOT/VERSION.txt" | cut -d= -f2)

echo ""
echo "  Meshtastic Foreman — Frontend"
echo "  v$VERSION"
echo ""

cd "$ROOT"
pnpm --filter @foreman/web dev
