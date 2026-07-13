@echo off
title Claude Bridge
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Please install Node.js first.
  pause
  exit /b 1
)
echo Starting Claude Bridge... Keep this window open. (Minimize is OK)
node scripts\claude-bridge.js
echo.
echo Bridge stopped. If there is an error above, please report it.
pause
