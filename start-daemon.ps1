$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Start-Process pwsh -ArgumentList @("-NoExit", "-WorkingDirectory", $root, "-Command", "pnpm --filter @foreman/daemon dev")
Start-Sleep -Seconds 3
Start-Process pwsh -ArgumentList @("-NoExit", "-WorkingDirectory", $root, "-Command", "pnpm --filter @foreman/web dev")
