$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content "$root\VERSION.txt" | Where-Object { $_ -match '^VERSION=' }) -replace '^VERSION=', ''

Write-Host ""
Write-Host "  Meshtastic Foreman — Frontend" -ForegroundColor Cyan
Write-Host "  v$version" -ForegroundColor Gray
Write-Host ""

Set-Location $root
pnpm --filter @foreman/web dev
