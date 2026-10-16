# Talk to Kanishk over USB serial: reset, show the boot log, then run test commands from his serial console.
# usage: powershell -File serial_test.ps1 [-Port COM16] [-Commands "status","chat hi"]
param([string]$Port = 'COM16', [string[]]$Commands = @('status'), [int]$BootSeconds = 6, [int]$WaitSeconds = 8)
$sp = New-Object System.IO.Ports.SerialPort $Port, 115200, 'None', 8, 'One'
$sp.Encoding = [System.Text.Encoding]::UTF8
$sp.ReadTimeout = 200
$sp.Open()
# pulse reset (EN) through RTS, keep IO0 high (DTR off) so it boots normally
$sp.DtrEnable = $false; $sp.RtsEnable = $true; Start-Sleep -Milliseconds 150; $sp.RtsEnable = $false
function Drain([int]$secs) {
  $end = (Get-Date).AddSeconds($secs)
  while ((Get-Date) -lt $end) { try { $l = $sp.ReadLine(); if ($l.Trim()) { Write-Output $l.TrimEnd() } } catch {} }
}
Drain $BootSeconds
foreach ($c in $Commands) {
  Write-Output ">>> $c"
  $sp.Write("$c`n")
  $w = if ($c -like 'story*') { 90 } else { $WaitSeconds }
  Drain $w
}
$sp.Close()
