#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NAME=$(node -p "require('$ROOT/packages/daemon/package.json').name" 2>/dev/null || echo "@foreman/daemon")
VERSION=$(node -p "require('$ROOT/packages/daemon/package.json').version" 2>/dev/null || echo "unknown")

echo ""
echo "  Meshtastic Foreman — API Daemon"
echo "  $NAME v$VERSION"
echo ""

# Warn if MESHTASTIC_PORT looks like a Windows COM port
if [ -f "$ROOT/.env" ]; then
    port=$(grep -E '^MESHTASTIC_PORT=' "$ROOT/.env" | cut -d= -f2 | tr -d '[:space:]"' || true)
    if [[ "$port" =~ ^COM[0-9]+ ]]; then
        echo "  WARNING: MESHTASTIC_PORT is set to '$port' (Windows COM port)."
        echo "           On Linux use a device path, e.g. /dev/ttyUSB0 or /dev/ttyACM0"
        echo ""
    fi
fi

cd "$ROOT"
pnpm --filter @foreman/daemon dev
