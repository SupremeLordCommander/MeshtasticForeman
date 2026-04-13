#Requires -Version 5.1
<#
.SYNOPSIS
    Exports the Meshtastic Foreman elevation cache to a SQL file in TD_cache/.

.DESCRIPTION
    Dumps the elevation_cache table from the local PGlite database to a
    timestamped SQL file under TD_cache/ at the project root.  The file can
    then be copied to another machine and loaded with import-terrain-cache.ps1.

    IMPORTANT: Stop the Meshtastic Foreman daemon before running this script.
    PGlite holds an exclusive lock on the data directory while the daemon runs.

.EXAMPLE
    .\export-terrain-cache.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot

Write-Host ""
Write-Host "Meshtastic Foreman — Elevation Cache Export" -ForegroundColor Cyan
Write-Host "--------------------------------------------" -ForegroundColor Cyan
Write-Host ""
Write-Host "Project root : $ProjectRoot"
Write-Host "Output dir   : $ProjectRoot\TD_cache\"
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
    pnpm cache:export
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Export failed (exit code $LASTEXITCODE)."
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Export complete. Copy the TD_cache\ folder to the target machine" -ForegroundColor Green
Write-Host "and run import-terrain-cache.ps1 there." -ForegroundColor Green
Write-Host ""
