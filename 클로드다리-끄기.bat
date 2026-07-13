@echo off
title Stop Claude Bridge
cd /d "%~dp0"
node -e "fetch('http://localhost:11888/shutdown',{method:'POST'}).then(function(){console.log('Bridge stopped.')}).catch(function(){console.log('Bridge is not running.')})"
timeout /t 2 >nul
