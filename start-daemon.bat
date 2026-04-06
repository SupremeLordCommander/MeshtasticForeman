@echo off
cd /d "%~dp0"
pnpm --filter @foreman/daemon dev
