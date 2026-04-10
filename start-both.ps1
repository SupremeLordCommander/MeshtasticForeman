$root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$apiPkg     = Get-Content "$root\packages\daemon\package.json" | ConvertFrom-Json
$webPkg     = Get-Content "$root\packages\web\package.json"    | ConvertFrom-Json

Write-Host ""
Write-Host "  Meshtastic Foreman" -ForegroundColor Cyan
Write-Host "  API      $($apiPkg.name) v$($apiPkg.version)" -ForegroundColor Gray
Write-Host "  Frontend $($webPkg.name) v$($webPkg.version)" -ForegroundColor Gray
Write-Host ""
Write-Host "  Starting API daemon..." -ForegroundColor Yellow

Start-Process pwsh -ArgumentList @(
    "-NoExit",
    "-WorkingDirectory", $root,
    "-Command", "& '$root\start-api.ps1'"
)

Write-Host "  Waiting 3s for daemon to initialise..." -ForegroundColor DarkGray
Start-Sleep -Seconds 3

Write-Host "  Starting frontend..." -ForegroundColor Yellow

Start-Process pwsh -ArgumentList @(
    "-NoExit",
    "-WorkingDirectory", $root,
    "-Command", "& '$root\start-frontend.ps1'"
)

Write-Host ""
Write-Host "  Both services launched in separate windows." -ForegroundColor Green
Write-Host ""
