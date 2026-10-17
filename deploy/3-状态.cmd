@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === pi-purge : status ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0purge.ps1" status
echo.
pause
