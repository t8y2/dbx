@echo off
setlocal EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
if not exist "%SCRIPT_DIR%dev-full.ps1" (
  if exist "%CD%\scripts\dev-full.ps1" set "SCRIPT_DIR=%CD%\scripts\"
)
cd /d "%SCRIPT_DIR%.."
if "%~1"=="--" shift
set "ARGS="
:collect_args
if "%~1"=="" goto run_script
set "ARGS=!ARGS! "%~1""
shift
goto collect_args
:run_script
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%dev-full.ps1" !ARGS!
