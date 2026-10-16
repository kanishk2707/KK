# Two-way bridge between the desktop app and Kanishk's chip:
#   our stdin  (one JSON command per line) -> serial
#   serial     (one reply/log per line)    -> our stdout
# One bridge per connected chip; it exits when the chip is unplugged.
param([string]$Port = 'COM16', [int]$Baud = 115200)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
try {
  $sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, 'None', 8, 'One'
  $sp.Encoding = New-Object System.Text.UTF8Encoding $false   # the chip speaks UTF-8; ASCII would turn text into '?'
  $sp.NewLine = "`n"
  $sp.ReadTimeout = -1          # block until a whole line arrives
  $sp.WriteTimeout = 3000
  $sp.DtrEnable = $true         # normal run mode (DTR high, RTS low); opening may reset the chip once
  $sp.RtsEnable = $false
  $sp.Open()
} catch {
  [Console]::Error.WriteLine("BRIDGE_OPEN_FAILED $($_.Exception.Message)")
  exit 2
}
[Console]::Out.WriteLine("@bridge open $Port")
[Console]::Out.Flush()

# background thread: PC -> chip
$rs = [runspacefactory]::CreateRunspace(); $rs.Open()
$rs.SessionStateProxy.SetVariable('sp', $sp)
$writer = [powershell]::Create(); $writer.Runspace = $rs
[void]$writer.AddScript({
  $in = [Console]::In
  while ($true) {
    $line = $in.ReadLine()
    if ($null -eq $line) { try { $sp.Close() } catch {}; break }   # the app went away
    if ($line.Length -eq 0) { continue }
    try { $sp.WriteLine($line) } catch { break }
  }
})
[void]$writer.BeginInvoke()

# main thread: chip -> PC
try {
  while ($sp.IsOpen) {
    $line = $sp.ReadLine()
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  }
} catch { }
try { $sp.Close() } catch {}
[Console]::Error.WriteLine("BRIDGE_CLOSED")
exit 0
