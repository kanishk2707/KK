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
$last = $null
while ($true) {
  $names = [System.IO.Ports.SerialPort]::GetPortNames() | Sort-Object -Unique
  $key = ($names -join ',')
  if ($key -ne $last) {
    $last = $key
    $ports = @(UsbSerialPorts $names)
    [Console]::Out.WriteLine("PORTS " + ($ports -join ','))
    [Console]::Out.Flush()
  }
  Start-Sleep -Milliseconds 1000
}
