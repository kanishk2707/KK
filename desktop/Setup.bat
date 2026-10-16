@echo off
rem Double-click this once on a new computer. Nothing else is needed: no Node, no internet, no admin.
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
if errorlevel 1 pause
