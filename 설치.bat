@echo off
rem Claude connector setup - runs scripts\register-protocol.js in this folder.
rem No hidden payload, no download. Kept deliberately simple to avoid antivirus false positives.
rem Notes: ASCII only, and no parenthesized if-blocks (cmd mis-parses them with UTF-8 text).
cd /d "%~dp0"

where node >nul 2>&1 || goto NONODE

node scripts\register-protocol.js
if errorlevel 1 goto FAILED

where claude >nul 2>&1 || goto NOCLAUDE

echo.
echo   Setup done. Open the plugin in Figma and press [Recommend].
echo.
pause
exit /b 0

:NONODE
echo.
echo   Node.js is required. Install the LTS build from https://nodejs.org
echo   then run this file again.
echo.
pause
exit /b 1

:NOCLAUDE
echo.
echo   Setup done, but Claude Code is not installed on this PC.
echo   Run these two commands in a terminal, then reopen the plugin:
echo.
echo       npm install -g @anthropic-ai/claude-code
echo       claude login
echo.
pause
exit /b 0

:FAILED
echo.
echo   Setup failed. Please share the message above with the developer.
echo.
pause
exit /b 1
