@echo off
rem Removes Kanishk from this computer: his installed copy, and starting with Windows. It asks first.
start "" /D "%TEMP%" conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Add-Type -AssemblyName System.Windows.Forms;" ^
  "if ([Windows.Forms.MessageBox]::Show('Remove Kanishk from this computer?', 'Kanishk', 'YesNo', 'Question') -ne 'Yes') { exit };" ^
  "$d = Join-Path $env:LOCALAPPDATA 'Kanishk';" ^
  "foreach ($n in 'electron', 'whisper-server', 'powershell') { Get-CimInstance Win32_Process -Filter ('name=''' + $n + '.exe''') -EA SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + $d + '\*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue } };" ^
  "Start-Sleep -Milliseconds 800;" ^
  "Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Kanishk' -EA SilentlyContinue;" ^
  "Remove-Item $d -Recurse -Force -EA SilentlyContinue;" ^
  "[void][Windows.Forms.MessageBox]::Show('Kanishk has been removed from this computer.', 'Kanishk', 'OK', 'Information')"
