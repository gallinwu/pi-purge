@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === pi-purge : install prompt ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0purge.ps1" install %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" goto OK
echo ============================================================
echo FAILED - exit code %RC%. Read the output above.
echo ============================================================
goto END
:OK
echo ============================================================
echo Done. Takes effect on the next turn - no restart needed.
echo ============================================================
:END
pause
