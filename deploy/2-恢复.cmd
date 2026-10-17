@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === pi-purge : restore original prompt ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0purge.ps1" restore %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" goto OK
echo ============================================================
echo FAILED - exit code %RC%. Read the output above.
echo ============================================================
goto END
:OK
echo ============================================================
echo Restored. Takes effect on the next turn.
echo ============================================================
:END
pause
