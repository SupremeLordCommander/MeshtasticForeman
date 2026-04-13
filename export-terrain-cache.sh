#!/usr/bin/env bash
# export-terrain-cache.sh
#
# Exports the Meshtastic Foreman elevation cache to a SQL file in TD_cache/.
#
# Dumps the elevation_cache table from the local PGlite database to a
# timestamped SQL file under TD_cache/ at the project root.  The file can
# then be copied to another machine and loaded with import-terrain-cache.sh.
#
# IMPORTANT: Stop the Meshtastic Foreman daemon before running this script.
# PGlite holds an exclusive lock on the data directory while the daemon runs.
#
# Usage:
#   ./export-terrain-cache.sh

set -euo pipefail

# Resolve the project root relative to this script, regardless of where the
# caller's working directory is.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

echo ""
echo "Meshtastic Foreman — Elevation Cache Export"
echo "--------------------------------------------"
echo ""
echo "Project root : $PROJECT_ROOT"
echo "Output dir   : $PROJECT_ROOT/TD_cache/"
echo ""
echo "NOTE: The daemon must not be running."
echo ""
read -r -p "Have you stopped the daemon? [y/N] " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted. Stop the daemon and re-run this script."
    exit 0
fi
echo ""

# Check for required tools
if ! command -v node &>/dev/null; then
    echo "Error: Node.js not found. Install it from https://nodejs.org" >&2
    exit 1
fi

if ! command -v pnpm &>/dev/null; then
    echo "Error: pnpm not found. Install it with: npm install -g pnpm" >&2
    echo "       or see https://pnpm.io/installation" >&2
    exit 1
fi

cd "$PROJECT_ROOT"
pnpm cache:export

echo ""
echo "Export complete. Copy the TD_cache/ directory to the target machine"
echo "and run ./import-terrain-cache.sh there."
echo ""
