# Watches for USB-serial chips (ESP32 boards) being plugged in or out. Cheap: lists COM ports each
# second and only looks up which ones are USB-serial bridges when that list changes.
# Prints one line per change:  PORTS COM16,COM7   or   PORTS   (none)
$ErrorActionPreference = 'SilentlyContinue'
# USB-serial chips used on ESP32 boards: Silicon Labs CP210x, WCH CH340/CH9102, FTDI, Espressif native USB
$vids = @('VID_10C4', 'VID_1A86', 'VID_0403', 'VID_303A')
function UsbSerialPorts($present) {
  $found = @()
  foreach ($v in $vids) {
    $roots = Get-ChildItem "HKLM:\SYSTEM\CurrentControlSet\Enum\USB" -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -like "$v*" }
    foreach ($r in $roots) {
      foreach ($inst in (Get-ChildItem $r.PSPath -ErrorAction SilentlyContinue)) {
        $pn = (Get-ItemProperty "$($inst.PSPath)\Device Parameters" -Name PortName -ErrorAction SilentlyContinue).PortName
        if ($pn -and ($present -contains $pn)) { $found += $pn }
      }
    }
  }
  $found | Select-Object -Unique
}
# A board plugged in whose USB driver is missing has no port; it shows as a device with a problem.
# Prints:  NODRIVER VID_10C4&PID_EA60 CP2102 USB to UART Bridge Controller   (once per new case)
function DriverlessChip {
  $bad = Get-CimInstance Win32_PnPEntity -Filter 'ConfigManagerErrorCode <> 0' -ErrorAction SilentlyContinue |
    Where-Object { $id = $_.DeviceID; @($vids | Where-Object { $id -like "USB\$_*" }).Count -gt 0 } | Select-Object -First 1
  if ($bad) { return ($bad.DeviceID.Split([char]92)[1] + ' ' + $bad.Name) }
  return ''
}
$last = $null; $ports = @(); $lastBad = ''; $tick = 0
while ($true) {
  $names = [System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique
  $key = ($names -join ',')
  if ($key -ne $last) {
    $last = $key
    $ports = @(UsbSerialPorts $names)
    [Console]::Out.WriteLine("PORTS " + ($ports -join ','))
    [Console]::Out.Flush()
  }
  if ($ports.Count -eq 0 -and ($tick % 3) -eq 0) {
    $bad = DriverlessChip
    if ($bad -and $bad -ne $lastBad) { [Console]::Out.WriteLine("NODRIVER $bad"); [Console]::Out.Flush() }
    $lastBad = $bad
  }
  $tick++
  Start-Sleep -Milliseconds 1000
}
