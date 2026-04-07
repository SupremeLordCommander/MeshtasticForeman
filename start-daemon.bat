@echo off
start "Foreman Daemon" pwsh -NoExit -WorkingDirectory "%~dp0" -Command "pnpm --filter @foreman/daemon dev"
start "Foreman Web" pwsh -NoExit -WorkingDirectory "%~dp0" -Command "pnpm --filter @foreman/web dev"
