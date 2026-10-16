# Installs Kanishk on this computer. No admin rights, nothing to download, works offline.
# After this, he starts with Windows (hidden) and pops up by himself whenever his chip is plugged in.
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'Kanishk'
$exe = Join-Path $dest 'node_modules\electron\dist\electron.exe'
# her own files: never overwritten if she already has them
$keep = @('config.json', 'memory.json', 'todo.json', 'notes.md', 'reminders.json', 'routines.json')

function Say($text, $colour = 'Gray') { Write-Host $text -ForegroundColor $colour }
Say ''
Say '  Kanishk' Red
Say '  Setting him up on this computer...' DarkGray
Say ''

if ($src -eq $dest) { Say '  Already running from the installed folder.' Yellow }

# 1. close a running copy (only this app: matched by its own folder, so other apps are untouched)
Get-CimInstance Win32_Process -Filter "name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$dest*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "name='whisper-server.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$dest*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800

# 2. copy the app (robocopy: built into Windows, handles big folders and long paths)
if ($src -ne $dest) {
  Say '  Copying files (about 600 MB, give it a minute)...' DarkGray
  # /E adds and updates but never deletes, so anything of hers already there survives.
  # Her settings, lists and notes are never copied over; nor are logs, saved outfits, clips or undo data.
  $a = @($src, $dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1',
         '/XF') + $keep + @('*.log', '*.jsonl') + @('/XD', 'outfits', 'clips', 'undo')
  $null = robocopy @a
  if ($LASTEXITCODE -ge 8) { Say "  Could not copy the files (robocopy said $LASTEXITCODE)." Red; Read-Host '  Press Enter to close'; exit 1 }
}
if (-not (Test-Path $exe)) { Say '  Something is missing from this folder (electron.exe).' Red; Read-Host '  Press Enter to close'; exit 1 }

# 3. start with Windows, hidden, so he is ready the moment the chip goes in
Say '  Teaching him to start with Windows...' DarkGray
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Kanishk' `
  -Value "`"$exe`" `"$dest`" --hidden" -PropertyType String -Force | Out-Null

# 4. wake him up now
Say '  Waking him up...' DarkGray
Start-Process -FilePath $exe -ArgumentList "`"$dest`"", '--hidden' -WorkingDirectory $dest
Start-Sleep -Seconds 3

Say ''
Say '  All done.' Green
Say ''
Say '  Plug in Kanishk''s chip and he will pop up in the corner by himself.' White
Say '  He is always ready in the background, even after you restart the computer.' DarkGray
Say ''
Say '  (To remove him: run Uninstall.bat in this folder.)' DarkGray
Say ''
Start-Sleep -Seconds 4
