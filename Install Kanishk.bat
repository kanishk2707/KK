@echo off
rem Double-click this on any Windows computer to put Kanishk on it.
rem It asks permission first; after "Allow" it does everything on its own: downloads him, shows how
rem far along it is, sets him up, makes him start with Windows, and starts him.
rem It runs without a console window, so only Kanishk's own windows appear.
start "" /D "%TEMP%" conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12;" ^
  "$f = Join-Path $env:TEMP 'kanishk-install.ps1';" ^
  "try { Invoke-WebRequest 'https://raw.githubusercontent.com/kanishk2707/KK/main/install.ps1' -OutFile $f -UseBasicParsing -TimeoutSec 60 }" ^
  "catch { Add-Type -AssemblyName System.Windows.Forms; [void][Windows.Forms.MessageBox]::Show('Kanishk could not reach the internet to download himself. Connect to the internet and open this file again.', 'Kanishk', 'OK', 'Warning'); exit 1 };" ^
  "& $f %*"
