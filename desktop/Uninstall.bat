@echo off
rem Removes Kanishk from this computer (his installed copy, and starting with Windows).
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$d = Join-Path $env:LOCALAPPDATA 'Kanishk';" ^
  "Get-CimInstance Win32_Process -Filter \"name='electron.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -like \"*$d*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue };" ^
  "Get-CimInstance Win32_Process -Filter \"name='whisper-server.exe'\" -EA SilentlyContinue | Where-Object { $_.CommandLine -like \"*$d*\" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue };" ^
  "Start-Sleep -Milliseconds 700;" ^
  "Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Kanishk' -EA SilentlyContinue;" ^
  "if (Test-Path $d) { Remove-Item $d -Recurse -Force -EA SilentlyContinue };" ^
  "Write-Host ''; Write-Host '  Kanishk has been removed from this computer.' -ForegroundColor Yellow; Write-Host ''; Start-Sleep -Seconds 3"
