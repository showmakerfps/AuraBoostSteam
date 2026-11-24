@echo off
cd /d "%~dp0"
call npm install --no-audit --no-fund || (pause & exit /b 1)
call npm run dist
pause
