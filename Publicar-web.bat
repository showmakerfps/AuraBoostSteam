@echo off
setlocal
cd /d "%~dp0"
where railway >nul 2>nul || goto :missing
call railway whoami >nul || goto :login
call railway link || goto :failed
call railway up . --path-as-root || goto :failed
pause
exit /b 0

:missing
echo Instala Railway CLI y vuelve a intentar.
goto :failed
:login
echo Ejecuta railway login antes de publicar.
:failed
pause
exit /b 1
