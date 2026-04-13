#!/usr/bin/env bash
# import-terrain-cache.sh
#
# Imports an elevation cache SQL file into the local Meshtastic Foreman database.
#
# Loads a previously exported elevation cache file into the local PGlite
# database.  With no argument it picks the most recently dated file in
# TD_cache/ automatically.  Pass a file path to load a specific file.
#
# Existing cache rows are merged (upserted), not deleted.
#
# IMPORTANT: Stop the Meshtastic Foreman daemon before running this script.
# PGlite holds an exclusive lock on the data directory while the daemon runs.
#
# Usage:
#   ./import-terrain-cache.sh
#   ./import-terrain-cache.sh TD_cache/elevation_cache_2025-06-01_12-00-00.sql

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# Optional file argument — resolve relative paths against the project root
FILE_ARG=""
if [[ $# -gt 0 ]]; then
    if [[ "$1" = /* ]]; then
        FILE_ARG="$1"           # absolute path — use as-is
    else
        FILE_ARG="$PROJECT_ROOT/$1"  # relative path — anchor to project root
    fi
fi

echo ""
echo "Meshtastic Foreman — Elevation Cache Import"
echo "--------------------------------------------"
echo ""
echo "Project root : $PROJECT_ROOT"
if [[ -n "$FILE_ARG" ]]; then
    echo "Import file  : $FILE_ARG"
else
    echo "Import file  : (auto — latest in TD_cache/)"
fi
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

if [[ -n "$FILE_ARG" ]]; then
    pnpm cache:import "$FILE_ARG"
else
    pnpm cache:import
fi

echo ""
echo "Import complete. Start the daemon to use the updated cache."
echo ""
