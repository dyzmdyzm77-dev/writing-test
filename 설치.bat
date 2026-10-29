@echo off
rem Claude connector setup - runs scripts\register-protocol.js in this folder.
rem No hidden payload, no download. Kept deliberately simple to avoid antivirus false positives.
rem Notes: ASCII only, and no parenthesized if-blocks (cmd mis-parses them with UTF-8 text).
rem Node.js: the distribution zip ships runtime\node.exe, so nothing needs to be installed.
rem          If that folder is missing (developer checkout), the PC's own node is used.
cd /d "%~dp0"

set "NODE=%~dp0runtime\node.exe"
if exist "%NODE%" goto HAVENODE
set "NODE=node"
where node >nul 2>&1 || goto NONODE
:HAVENODE

"%NODE%" scripts\register-protocol.js
if errorlevel 1 goto FAILED

echo.
echo   Setup done. Open the plugin in Figma and sign in to Claude.
echo.
pause
exit /b 0

:NONODE
echo.
echo   Node.js was not found, and this folder has no runtime\node.exe.
echo   Please download the latest S1-UX-Writing-Agent zip again (it includes Node.js),
echo   or install the LTS build from https://nodejs.org and run this file again.
echo.
pause
exit /b 1

:FAILED
echo.
echo   Setup failed. Please share the message above with the developer.
echo.
pause
exit /b 1
