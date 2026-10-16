@echo off
rem Double-click this on any Windows computer to put Kanishk on it.
rem It asks permission first; after that it does everything on its own.
title Kanishk
set ELECTRON_RUN_AS_NODE=
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;" ^
  "$u='https://raw.githubusercontent.com/kanishk2707/KK/main/install.ps1';" ^
  "$f=Join-Path $env:TEMP 'kanishk-install.ps1';" ^
  "try{ Invoke-WebRequest $u -OutFile $f -UseBasicParsing -TimeoutSec 60 }catch{ Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.MessageBox]::Show('Could not reach the internet to fetch Kanishk.' + [Environment]::NewLine + $_.Exception.Message,'Kanishk','OK','Error')|Out-Null; exit 1 };" ^
  "& $f %*"
