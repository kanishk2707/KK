# Installs Kanishk on this computer.
#
# It asks permission first. After "Allow" there is nothing left to do by hand: it downloads
# everything he needs, shows how far along it is, sets him up and starts him. From then on he
# starts with Windows and pops up in the corner whenever his chip is plugged in.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   ... -GroqKey "gsk_..."   gives him his cloud brain straight away (optional; his chip carries it too)
#   ... -Silent              no windows, just install (prints progress instead)
param(
  [string]$GroqKey = '',
  [switch]$Silent,
  [string]$InstallDir = "$env:LOCALAPPDATA\Kanishk"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# Everything he is made of. "size" is only used when a server does not say how big a file is,
# so the progress bar still moves smoothly.
$PARTS = @(
  @{ file = 'app.zip';      label = 'Getting Kanishk...';     size = 11000000;  url = 'https://codeload.github.com/kanishk2707/KK/zip/refs/heads/main' },
  @{ file = 'electron.zip'; label = 'Getting his body...';    size = 133848303; url = 'https://github.com/electron/electron/releases/download/v37.10.3/electron-v37.10.3-win32-x64.zip' },
  @{ file = 'model.bin';    label = 'Getting his ears...';    size = 147964211; url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' },
  @{ file = 'whisper.zip';  label = 'Getting his hearing...'; size = 21715607;  url = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip' }
)

# The window and the work only talk through this. The work runs on its own thread, so the
# window never freezes, even while 250 MB of files are being unpacked.
$state = [hashtable]::Synchronized(@{ pct = 0.0; upTo = 0.0; step = 'Getting ready...'; detail = ''; done = $false; error = $null })

# ================================================================ the work (background thread)
$WORK = {
  param($state, $InstallDir, $GroqKey, $PARTS)
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Add-Type -AssemblyName System.Net.Http
  $DOWNLOADS = 88.0   # downloading fills the bar up to here; putting him together does the rest

  # $upTo: for a long step with nothing to count, the bar creeps toward it so it never looks stuck
  function Step($text, $pct, $upTo = -1) {
    $state.step = $text
    $state.detail = ''
    $state.pct = [double]$pct
    if ($upTo -lt 0) { $upTo = $pct }
    $state.upTo = [double]$upTo
  }

  function Invoke-Quiet([scriptblock]$cmd) {
    # native tools (tar, robocopy) print to stderr; that is not an error, their exit code says
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $cmd 2>&1 | Out-Null } finally { $ErrorActionPreference = $old }
    return $LASTEXITCODE
  }

  function Expand-Zip($zip, $dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) {
      $code = Invoke-Quiet { & $tar -x -f $zip -C $dir }
      if ($code -eq 0) { return }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $dir)
  }

  # Downloads one file. If the connection drops, it waits for it to come back and carries on from
  # where it stopped (for servers that allow it), instead of starting the big files again.
  function Get-Part($p, $dest, $before, $total) {
    $waits = @(2, 4, 8, 15, 30)
    for ($try = 0; ; $try++) {
      $h = $null; $in = $null; $out = $null
      try {
        $have = 0L
        if (Test-Path $dest) { $have = (Get-Item $dest).Length }
        $h = New-Object System.Net.Http.HttpClient
        $h.Timeout = [TimeSpan]::FromMinutes(30)
        $h.DefaultRequestHeaders.UserAgent.ParseAdd('KanishkInstaller/1.0')
        $req = New-Object System.Net.Http.HttpRequestMessage ([System.Net.Http.HttpMethod]::Get), $p.url
        if ($have -gt 0) { $req.Headers.Range = [System.Net.Http.Headers.RangeHeaderValue]::new($have, $null) }
        $resp = $h.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if ([int]$resp.StatusCode -eq 416) { return }   # it was already all here
        if (-not $resp.IsSuccessStatusCode) { throw "the server answered $([int]$resp.StatusCode)." }
        if ([int]$resp.StatusCode -ne 206) { $have = 0L }   # this server starts over from the beginning
        $size = [int64]$p.size
        if ($resp.Content.Headers.ContentLength) { $size = $have + [int64]$resp.Content.Headers.ContentLength }
        $in = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        if ($have -gt 0) { $out = [IO.FileStream]::new($dest, [IO.FileMode]::Append, [IO.FileAccess]::Write) }
        else { $out = [IO.File]::Create($dest) }
        $buf = New-Object byte[] 262144
        $got = $have
        while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
          $out.Write($buf, 0, $n)
          $got += $n
          $part = [Math]::Min($got, $size) / $size * [int64]$p.size
          $state.pct = $DOWNLOADS * ($before + $part) / $total
          $state.upTo = $state.pct
          $state.detail = ('{0:N1} of {1:N1} MB' -f ($got / 1MB), ([Math]::Max($got, $size) / 1MB))
        }
        return
      } catch {
        $e = $_.Exception
        while ($e.InnerException) { $e = $e.InnerException }
        if ($try -ge $waits.Count) {
          throw ("Could not download his files: " + $e.Message + " Check the internet connection and run the installer again.")
        }
        $state.detail = 'Waiting for the internet connection...'
        Start-Sleep -Seconds $waits[$try]
      } finally {
        if ($out) { $out.Close() }
        if ($in) { $in.Close() }
        if ($h) { $h.Dispose() }
      }
    }
  }

  $tmp = $null
  try {
    Step 'Getting ready...' 0
    # close a copy already running from this folder (and its helpers, which hold the chip's port)
    foreach ($n in 'electron', 'whisper-server', 'powershell') {
      Get-CimInstance Win32_Process -Filter "name='$n.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -like "*$InstallDir\*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Milliseconds 700

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('kanishk-setup-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null

    $total = 0L
    foreach ($p in $PARTS) { $total += [int64]$p.size }
    $before = 0L
    foreach ($p in $PARTS) {
      Step $p.label ($DOWNLOADS * $before / $total)
      Get-Part $p (Join-Path $tmp $p.file) $before $total
      $before += [int64]$p.size
    }

    # --- his app
    Step 'Putting him together...' $DOWNLOADS 91
    $x = Join-Path $tmp 'app'
    Expand-Zip (Join-Path $tmp 'app.zip') $x
    $root = Get-ChildItem $x -Directory | Select-Object -First 1
    $appSrc = Join-Path $root.FullName 'desktop'
    if (-not (Test-Path (Join-Path $appSrc 'src\main.js'))) { throw 'The download looks incomplete. Please run the installer again.' }
    # her own things are never overwritten
    $keep = @('config.json', 'memory.json', 'todo.json', 'notes.md', 'reminders.json', 'routines.json', 'secrets.json')
    $code = Invoke-Quiet { robocopy $appSrc $InstallDir /E /NFL /NDL /NJH /NJS /NP /R:2 /W:1 /XF @keep }
    if ($code -ge 8) { throw "Could not copy his files (robocopy $code)." }
    # leftovers of the older, all-in-one package
    foreach ($old in 'node_modules\electron', 'Setup.bat', 'setup.ps1', 'START HERE.txt') {
      Remove-Item (Join-Path $InstallDir $old) -Recurse -Force -ErrorAction SilentlyContinue
    }

    # --- his body
    Step 'Putting him together...' 91 97
    Expand-Zip (Join-Path $tmp 'electron.zip') (Join-Path $InstallDir 'electron')
    Remove-Item (Join-Path $tmp 'electron.zip') -Force -ErrorAction SilentlyContinue
    $exe = Join-Path $InstallDir 'electron\electron.exe'
    if (-not (Test-Path $exe)) { throw 'His body did not unpack properly. Please run the installer again.' }

    # --- his ears
    Step 'Putting him together...' 97 98.5
    $whisperDir = Join-Path $InstallDir 'runtime\whisper'
    Expand-Zip (Join-Path $tmp 'whisper.zip') $whisperDir
    $server = Get-ChildItem $whisperDir -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
    if ($server) {
      foreach ($dll in Get-ChildItem (Join-Path $InstallDir 'vcruntime') -Filter '*.dll' -ErrorAction SilentlyContinue) {
        Copy-Item $dll.FullName $server.DirectoryName -Force -ErrorAction SilentlyContinue
      }
    }
    $models = Join-Path $InstallDir 'runtime\models'
    New-Item -ItemType Directory -Force -Path $models | Out-Null
    Move-Item (Join-Path $tmp 'model.bin') (Join-Path $models 'ggml-base.en.bin') -Force

    # --- his cloud brain, if a key was handed to the installer (otherwise his chip brings it)
    if ($GroqKey) {
      $keys = @($GroqKey -split '[,; ]+' | Where-Object { $_ })
      @{ groqKeys = $keys } | ConvertTo-Json | Set-Content (Join-Path $InstallDir 'secrets.json') -Encoding ASCII
    }

    Step 'Teaching him to start with Windows...' 99
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Kanishk' `
      -Value "`"$exe`" `"$InstallDir`" --hidden" -PropertyType String -Force | Out-Null

    Step 'Waking him up...' 100
    # if this was started from an editor's terminal, Electron could inherit "run as plain Node" and quit
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $exe -ArgumentList "`"$InstallDir`"", '--hidden' -WorkingDirectory $InstallDir
    Start-Sleep -Seconds 2
  } catch {
    $state.error = $_.Exception.Message
  } finally {
    if ($tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
    $state.done = $true
  }
}

# ================================================================ the windows (this thread)
$INK = [Drawing.Color]::FromArgb(22, 15, 29)
$SLATE = [Drawing.Color]::FromArgb(45, 38, 64)
$RED = [Drawing.Color]::FromArgb(227, 38, 59)
$PAPER = [Drawing.Color]::FromArgb(255, 253, 246)
$MUTED = [Drawing.Color]::FromArgb(176, 170, 196)
$DIM = [Drawing.Color]::FromArgb(130, 124, 150)

function New-Form($title, $w, $h) {
  $f = New-Object Windows.Forms.Form
  $f.AutoScaleDimensions = New-Object Drawing.SizeF 96, 96
  $f.AutoScaleMode = 'Dpi'
  $f.Text = $title
  $f.ClientSize = New-Object Drawing.Size $w, $h
  $f.StartPosition = 'CenterScreen'
  $f.FormBorderStyle = 'FixedDialog'
  $f.MaximizeBox = $false; $f.MinimizeBox = $false
  $f.BackColor = $INK
  return $f
}
function Add-Label($f, $text, $x, $y, $w, $h, $size, $color, $bold = $false, $align = 'MiddleCenter') {
  $l = New-Object Windows.Forms.Label
  $l.Text = $text
  $l.ForeColor = $color
  $style = [Drawing.FontStyle]::Regular
  if ($bold) { $style = [Drawing.FontStyle]::Bold }
  $l.Font = New-Object Drawing.Font 'Segoe UI', $size, $style
  $l.TextAlign = $align
  $l.Location = New-Object Drawing.Point $x, $y
  $l.Size = New-Object Drawing.Size $w, $h
  $l.BackColor = [Drawing.Color]::Transparent
  $f.Controls.Add($l)
  return $l
}
function Add-Button($f, $text, $x, $y, $w, $h, $back, $result, $bold = $false) {
  $b = New-Object Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object Drawing.Point $x, $y
  $b.Size = New-Object Drawing.Size $w, $h
  $b.BackColor = $back; $b.ForeColor = [Drawing.Color]::White
  $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0
  $style = [Drawing.FontStyle]::Regular
  if ($bold) { $style = [Drawing.FontStyle]::Bold }
  $b.Font = New-Object Drawing.Font 'Segoe UI', 10.5, $style
  $b.DialogResult = $result
  $f.Controls.Add($b)
  return $b
}

# his pixel face, drawn from code (no image files needed); drawn big and shown scaled, so it stays sharp
function Add-Face($f, $px, $centerX, $y) {
  $rows = @(
    '...WWWWWWW...', '..WWWWWWWWW..', '.WWWWWWWWWWW.', 'WWKKKWWWKKKWW', 'WKKKKKWKKKKKW',
    'WKKKKKWKKKKKW', 'WWKKKWWWKKKWW', 'WWWWWWWWWWWWW', '.WWWWWWWWWWW.', '..WWWWWWWWW..', '...WWWWWWW...')
  $p = 12
  $bmp = New-Object Drawing.Bitmap (13 * $p), (11 * $p)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.Clear([Drawing.Color]::Transparent)
  $redBrush = New-Object Drawing.SolidBrush $RED
  $whiteBrush = New-Object Drawing.SolidBrush $PAPER
  for ($r = 0; $r -lt $rows.Count; $r++) {
    for ($c = 0; $c -lt $rows[$r].Length; $c++) {
      $ch = $rows[$r][$c]
      if ($ch -eq '.') { continue }
      $brush = $redBrush
      if ($ch -eq 'K') { $brush = $whiteBrush }
      $g.FillRectangle($brush, $c * $p, $r * $p, $p, $p)
    }
  }
  $g.Dispose()
  $pic = New-Object Windows.Forms.PictureBox
  $pic.Image = $bmp
  $pic.SizeMode = 'Zoom'
  $pic.Size = New-Object Drawing.Size (13 * $px), (11 * $px)
  $pic.BackColor = [Drawing.Color]::Transparent
  $pic.Location = New-Object Drawing.Point ([int]($centerX - 13 * $px / 2)), $y
  $f.Controls.Add($pic)
}

function Ask-Permission {
  $f = New-Form 'Kanishk' 480 330
  $f.TopMost = $true
  Add-Face $f 5 240 24
  [void](Add-Label $f 'Install Kanishk on this computer?' 20 92 440 34 13 $PAPER $true)
  $nl = [Environment]::NewLine
  [void](Add-Label $f ("He will download himself (about 314 MB) and set everything up on his own." + $nl +
                       "Nothing else to do, and no password needed." + $nl + $nl +
                       "After that, plug in his chip and he pops up in the corner.") 30 130 420 100 9.5 $MUTED)
  $ok = Add-Button $f 'Allow' 100 250 150 44 $RED ([Windows.Forms.DialogResult]::OK) $true
  $no = Add-Button $f 'Not now' 262 250 118 44 $SLATE ([Windows.Forms.DialogResult]::Cancel)
  $f.AcceptButton = $ok; $f.CancelButton = $no
  $answer = $f.ShowDialog()
  $f.Dispose()
  return ($answer -eq [Windows.Forms.DialogResult]::OK)
}

function Show-Progress {
  $f = New-Form 'Setting up Kanishk' 480 200
  $f.ControlBox = $false
  Add-Face $f 3 52 26
  $script:stepLabel = Add-Label $f 'Getting ready...' 100 24 360 28 11.5 $PAPER $true 'MiddleLeft'
  $script:detailLabel = Add-Label $f '' 100 52 360 22 9 $MUTED $false 'MiddleLeft'
  $script:track = New-Object Windows.Forms.Panel
  $script:track.BackColor = $SLATE
  $script:track.Location = New-Object Drawing.Point 30, 100
  $script:track.Size = New-Object Drawing.Size 360, 18
  $f.Controls.Add($script:track)
  $script:fill = New-Object Windows.Forms.Panel
  $script:fill.BackColor = $RED
  $script:fill.Location = New-Object Drawing.Point 0, 0
  $script:fill.Size = New-Object Drawing.Size 0, 18
  $script:track.Controls.Add($script:fill)
  $script:pctLabel = Add-Label $f '0%' 396 94 60 30 11 $PAPER $true 'MiddleRight'
  [void](Add-Label $f 'This takes a few minutes. You can keep using your computer.' 20 144 440 26 8.5 $DIM)

  $script:shown = 0.0
  $script:finishTicks = 0
  $script:timer = New-Object Windows.Forms.Timer
  $script:timer.Interval = 50
  $script:timer.Add_Tick({
    $s = $script:state
    $target = [double]$s.pct
    $upTo = [double]$s.upTo
    if ($s.done -and -not $s.error) { $target = 100.0 }
    if ($target -gt $script:shown) {
      # glide toward the real number
      $script:shown = [Math]::Min($target, $script:shown + [Math]::Max(0.08, ($target - $script:shown) * 0.25))
    } elseif ($upTo -gt $script:shown + 0.2) {
      # a long step with nothing to count (unpacking): creep so it never looks frozen
      $script:shown += ($upTo - $script:shown) * 0.006
    }
    $w = [int]($script:track.ClientSize.Width * $script:shown / 100.0)
    if ($script:fill.Width -ne $w) { $script:fill.Width = $w }
    $t = ('{0}%' -f [int][Math]::Floor($script:shown))
    if ($script:pctLabel.Text -ne $t) { $script:pctLabel.Text = $t }
    if ($script:stepLabel.Text -ne $s.step) { $script:stepLabel.Text = $s.step }
    if ($script:detailLabel.Text -ne $s.detail) { $script:detailLabel.Text = $s.detail }
    if ($s.done) {
      if ($s.error -or $script:shown -ge 99.9) { $script:finishTicks++ }
      if ($script:finishTicks -gt 12) { $script:timer.Stop(); $script:progressForm.Close() }
    }
  })
  $f.Add_Shown({ $script:timer.Start() })
  # no closing it halfway through; it closes itself when he is ready
  $f.Add_FormClosing({ param($sender, $e) if (-not $script:state.done) { $e.Cancel = $true } })
  $script:progressForm = $f
  [void]$f.ShowDialog()
  $script:timer.Dispose()
  $f.Dispose()
}

function Show-Done {
  $f = New-Form 'Kanishk' 440 250
  $f.TopMost = $true
  Add-Face $f 4 220 22
  $nl = [Environment]::NewLine
  [void](Add-Label $f "He's here." 20 74 400 34 13 $PAPER $true)
  [void](Add-Label $f ("Plug in his chip and he pops up in the corner." + $nl + "He starts with Windows from now on.") 20 110 400 54 10 $MUTED)
  $ok = Add-Button $f 'Lovely' 160 186 120 40 $RED ([Windows.Forms.DialogResult]::OK) $true
  $f.AcceptButton = $ok
  [void]$f.ShowDialog()
  $f.Dispose()
}

function Show-Problem($text) {
  if ($Silent) { Write-Host "  $text" -ForegroundColor Red; return }
  [void][Windows.Forms.MessageBox]::Show($text, 'Kanishk', 'OK', 'Warning')
}

# ================================================================ go
$drive = (Get-Item $env:LOCALAPPDATA).PSDrive
if ($drive.Free -lt 1GB) {
  Show-Problem ("Kanishk needs about 1 GB of free space to settle in, but this computer only has {0:N2} GB left on {1}:. Free up some space and run the installer again." -f ($drive.Free / 1GB), $drive.Name)
  exit 1
}
if (-not $Silent) {
  [Windows.Forms.Application]::EnableVisualStyles()
  if (-not (Ask-Permission)) { exit 0 }
} else {
  Write-Host ''
  Write-Host '  Setting up Kanishk...'
}

$rs = [runspacefactory]::CreateRunspace()
$rs.Open()
$ps = [PowerShell]::Create()
$ps.Runspace = $rs
[void]$ps.AddScript($WORK.ToString()).AddArgument($state).AddArgument($InstallDir).AddArgument($GroqKey).AddArgument($PARTS)
$job = $ps.BeginInvoke()

if ($Silent) {
  $last = ''
  while (-not $state.done) {
    if ($state.step -ne $last) { Write-Host "  $($state.step)"; $last = $state.step }
    Start-Sleep -Milliseconds 250
  }
} else {
  Show-Progress
}
try { [void]$ps.EndInvoke($job) } catch { if (-not $state.error) { $state.error = $_.Exception.Message } }
$ps.Dispose(); $rs.Dispose()

if ($state.error) {
  Show-Problem ("Something went wrong while setting Kanishk up:" + [Environment]::NewLine + [Environment]::NewLine + $state.error)
  exit 1
}
if ($Silent) {
  Write-Host ''
  Write-Host '  Done. Plug in his chip and he will pop up.' -ForegroundColor Green
  Write-Host ''
} else {
  Show-Done
}
