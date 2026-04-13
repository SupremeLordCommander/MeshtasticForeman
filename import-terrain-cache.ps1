#Requires -Version 5.1
<#
.SYNOPSIS
    Imports an elevation cache SQL file into the local Meshtastic Foreman database.

.DESCRIPTION
    Loads a previously exported elevation cache file into the local PGlite
    database.  With no argument it picks the most recently dated file in
    TD_cache/ automatically.  Pass a file path to load a specific file.

    Existing cache rows are merged (upserted), not deleted.

    IMPORTANT: Stop the Meshtastic Foreman daemon before running this script.
    PGlite holds an exclusive lock on the data directory while the daemon runs.

.PARAMETER File
    Optional path to a specific .sql export file.  If omitted the newest file
    in TD_cache\ is used.

.EXAMPLE
    .\import-terrain-cache.ps1

.EXAMPLE
    .\import-terrain-cache.ps1 "TD_cache\elevation_cache_2025-06-01_12-00-00.sql"
#>

param(
    [Parameter(Position = 0)]
    [string]$File = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot

Write-Host ""
Write-Host "Meshtastic Foreman — Elevation Cache Import" -ForegroundColor Cyan
Write-Host "--------------------------------------------" -ForegroundColor Cyan
Write-Host ""
Write-Host "Project root : $ProjectRoot"

if ($File -ne "") {
    # Resolve relative paths against the project root
    if (-not [System.IO.Path]::IsPathRooted($File)) {
        $File = Join-Path $ProjectRoot $File
    }
    Write-Host "Import file  : $File"
} else {
    Write-Host "Import file  : (auto — latest in TD_cache\)"
}

Write-Host ""
Write-Host "NOTE: The daemon must not be running." -ForegroundColor Yellow
Write-Host ""
$confirm = Read-Host "Have you stopped the daemon? [y/N]"
if ($confirm -notmatch '^[Yy]$') {
    Write-Host "Aborted. Stop the daemon and re-run this script." -ForegroundColor Red
    exit 0
}
Write-Host ""

# Verify pnpm is available
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Error "pnpm not found. Install it from https://pnpm.io or run: npm install -g pnpm"
    exit 1
}

# Verify Node.js is available
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js not found. Install it from https://nodejs.org"
    exit 1
}

Push-Location $ProjectRoot
try {
    if ($File -ne "") {
        pnpm cache:import $File
    } else {
        pnpm cache:import
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Import failed (exit code $LASTEXITCODE)."
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Import complete. Start the daemon to use the updated cache." -ForegroundColor Green
Write-Host ""
