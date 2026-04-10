$root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$pkg     = Get-Content "$root\packages\daemon\package.json" | ConvertFrom-Json
$version = $pkg.version
$name    = $pkg.name

Write-Host ""
Write-Host "  Meshtastic Foreman — API Daemon" -ForegroundColor Cyan
Write-Host "  $name v$version" -ForegroundColor Gray
Write-Host ""

Set-Location $root

while ($true) {
    pnpm --filter @foreman/daemon dev
    $code = $LASTEXITCODE
    Write-Host ""
    Write-Host "  Daemon exited (code $code) — restarting..." -ForegroundColor Yellow
    Write-Host ""
    Start-Sleep -Seconds 1
}
