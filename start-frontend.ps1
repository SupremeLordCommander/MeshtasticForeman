$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg     = Get-Content "$root\packages\web\package.json" | ConvertFrom-Json
$version = $pkg.version
$name    = $pkg.name

Write-Host ""
Write-Host "  Meshtastic Foreman — Frontend" -ForegroundColor Cyan
Write-Host "  $name v$version" -ForegroundColor Gray
Write-Host ""

Set-Location $root
pnpm --filter @foreman/web dev
