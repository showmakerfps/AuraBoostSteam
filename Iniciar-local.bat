@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || goto :missing
where npm >nul 2>nul || goto :missing
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a<22||a===22&&b<14?1:0)" || goto :missing
if not exist ".env" (
  copy /y ".env.example" ".env" >nul || goto :failed
  echo Se creo .env para la demostracion local.
)
if not exist "node_modules\.package-lock.json" (
  call npm ci --no-audit --no-fund --cache .npm-cache || goto :failed
)
call npm start || goto :failed
exit /b 0

:missing
echo Instala Node.js 24 LTS y vuelve a intentar.
:failed
pause
exit /b 1
