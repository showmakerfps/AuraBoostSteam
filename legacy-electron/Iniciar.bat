@echo off
cd /d "%~dp0"
where npm >nul 2>nul || (echo Instalá Node.js LTS desde https://nodejs.org/ y volvé a intentar. & pause & exit /b 1)
if not exist node_modules\electron\dist\electron.exe (call npm install --no-audit --no-fund || (pause & exit /b 1))
call npm start
if errorlevel 1 pause
