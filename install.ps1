# Installs Kanishk on this computer.
#
# It asks permission first. After "Allow" there is nothing left to do by hand: it downloads
# everything it needs, shows the progress, sets him up and starts him. From then on he starts
# with Windows and pops up in the corner whenever his chip is plugged in.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   ... -GroqKey "gsk_..."   gives him his cloud brain straight away (optional)
#   ... -Silent              no windows, just install (for reinstalling)
param(
  [string]$GroqKey = '',
  [switch]$Silent,
  [string]$InstallDir = "$env:LOCALAPPDATA\Kanishk"
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, System.Net.Http

$APP      = 'https://codeload.github.com/kanishk2707/KK/zip/refs/heads/main'
$ELECTRON = 'https://github.com/electron/electron/releases/download/v37.10.3/electron-v37.10.3-win32-x64.zip'
$WHISPER  = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-blas-bin-x64.zip'
$MODEL    = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'

$INK = [Drawing.Color]::FromArgb(22, 15, 29)
$RED = [Drawing.Color]::FromArgb(227, 38, 59)
$PAPER = [Drawing.Color]::FromArgb(255, 253, 246)

# ---------------------------------------------------------------- his pixel face, drawn from code
function Get-FaceIcon([int]$px = 6) {
  $rows = @(
    '...WWWWWWW...', '..WWWWWWWWW..', '.WWWWWWWWWWW.', 'WWKKKWWWKKKWW', 'WKKKKKWKKKKKW',
    'WKKKKKWKKKKKW', 'WWKKKWWWKKKWW', 'WWWWWWWWWWWWW', '.WWWWWWWWWWW.', '..WWWWWWWWW..', '...WWWWWWW...')
  $bmp = New-Object Drawing.Bitmap(13 * $px), (11 * $px)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.Clear([Drawing.Color]::Transparent)
  $red = New-Object Drawing.SolidBrush $RED
  $white = New-Object Drawing.SolidBrush $PAPER
  for ($y = 0; $y -lt $rows.Count; $y++) {
    for ($x = 0; $x -lt $rows[$y].Length; $x++) {
      $c = $rows[$y][$x]
      if ($c -eq '.') { continue }
      $b = $red; if ($c -eq 'K') { $b = $white }
      $g.FillRectangle($b, $x * $px, $y * $px, $px, $px)
    }
  }
  $g.Dispose()
  return $bmp
}

# ---------------------------------------------------------------- "may I?"
function Ask-Permission {
  $f = New-Object Windows.Forms.Form
  $f.Text = 'Kanishk'
  $f.Size = New-Object Drawing.Size 470, 320
  $f.StartPosition = 'CenterScreen'
  $f.FormBorderStyle = 'FixedDialog'
  $f.MaximizeBox = $false; $f.MinimizeBox = $false
  $f.BackColor = $INK
  $f.TopMost = $true

  $pic = New-Object Windows.Forms.PictureBox
  $pic.Image = Get-FaceIcon 5
  $pic.SizeMode = 'AutoSize'
  $pic.Location = New-Object Drawing.Point 200, 24
  $pic.BackColor = [Drawing.Color]::Transparent
  $f.Controls.Add($pic)

  $t = New-Object Windows.Forms.Label
  $t.Text = 'Install Kanishk on this computer?'
  $t.ForeColor = $PAPER
  $t.Font = New-Object Drawing.Font 'Segoe UI', 13, ([Drawing.FontStyle]::Bold)
  $t.TextAlign = 'MiddleCenter'
  $t.Location = New-Object Drawing.Point 20, 108
  $t.Size = New-Object Drawing.Size 420, 30
  $f.Controls.Add($t)

  $d = New-Object Windows.Forms.Label
  $d.Text = "He will download himself (about 310 MB) and set everything up on his own." + [Environment]::NewLine +
            "Nothing else to do, no password needed." + [Environment]::NewLine + [Environment]::NewLine +
            "After that, plug in his chip and he appears in the corner."
  $d.ForeColor = [Drawing.Color]::FromArgb(176, 170, 196)
  $d.Font = New-Object Drawing.Font 'Segoe UI', 9.5
  $d.TextAlign = 'MiddleCenter'
  $d.Location = New-Object Drawing.Point 30, 140
  $d.Size = New-Object Drawing.Size 400, 72
  $f.Controls.Add($d)

  $ok = New-Object Windows.Forms.Button
  $ok.Text = 'Allow'
  $ok.Size = New-Object Drawing.Size 150, 42
  $ok.Location = New-Object Drawing.Point 90, 222
  $ok.BackColor = $RED; $ok.ForeColor = [Drawing.Color]::White
  $ok.FlatStyle = 'Flat'; $ok.FlatAppearance.BorderSize = 0
  $ok.Font = New-Object Drawing.Font 'Segoe UI', 11, ([Drawing.FontStyle]::Bold)
  $ok.DialogResult = [Windows.Forms.DialogResult]::OK
  $f.Controls.Add($ok)

  $no = New-Object Windows.Forms.Button
  $no.Text = 'Not now'
  $no.Size = New-Object Drawing.Size 110, 42
  $no.Location = New-Object Drawing.Point 252, 222
  $no.BackColor = [Drawing.Color]::FromArgb(45, 38, 64); $no.ForeColor = $PAPER
  $no.FlatStyle = 'Flat'; $no.FlatAppearance.BorderSize = 0
  $no.Font = New-Object Drawing.Font 'Segoe UI', 10
  $no.DialogResult = [Windows.Forms.DialogResult]::Cancel
  $f.Controls.Add($no)

  $f.AcceptButton = $ok; $f.CancelButton = $no
  return ($f.ShowDialog() -eq [Windows.Forms.DialogResult]::OK)
}

# ---------------------------------------------------------------- the progress window
$script:form = $null; $script:bar = $null; $script:step = $null; $script:detail = $null
function Show-Progress {
  $f = New-Object Windows.Forms.Form
  $f.Text = 'Setting up Kanishk'
  $f.Size = New-Object Drawing.Size 470, 250
  $f.StartPosition = 'CenterScreen'
  $f.FormBorderStyle = 'FixedDialog'
  $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.ControlBox = $false
  $f.BackColor = $INK
  $f.TopMost = $true

  $pic = New-Object Windows.Forms.PictureBox
  $pic.Image = Get-FaceIcon 3
  $pic.SizeMode = 'AutoSize'
  $pic.Location = New-Object Drawing.Point 28, 30
  $pic.BackColor = [Drawing.Color]::Transparent
  $f.Controls.Add($pic)

  $s = New-Object Windows.Forms.Label
  $s.Text = 'Getting ready...'
  $s.ForeColor = $PAPER
  $s.Font = New-Object Drawing.Font 'Segoe UI', 11, ([Drawing.FontStyle]::Bold)
  $s.Location = New-Object Drawing.Point 95, 36
  $s.Size = New-Object Drawing.Size 340, 26
  $f.Controls.Add($s)

  $d = New-Object Windows.Forms.Label
  $d.Text = ''
  $d.ForeColor = [Drawing.Color]::FromArgb(176, 170, 196)
  $d.Font = New-Object Drawing.Font 'Segoe UI', 9
  $d.Location = New-Object Drawing.Point 95, 62
  $d.Size = New-Object Drawing.Size 340, 22
  $f.Controls.Add($d)

  $b = New-Object Windows.Forms.ProgressBar
  $b.Location = New-Object Drawing.Point 30, 120
  $b.Size = New-Object Drawing.Size 400, 26
  $b.Style = 'Continuous'
  $b.Maximum = 1000
  $f.Controls.Add($b)

  $n = New-Object Windows.Forms.Label
  $n.Text = 'This usually takes a few minutes. You can keep using your computer.'
  $n.ForeColor = [Drawing.Color]::FromArgb(130, 124, 150)
  $n.Font = New-Object Drawing.Font 'Segoe UI', 8.5
  $n.TextAlign = 'MiddleCenter'
  $n.Location = New-Object Drawing.Point 30, 160
  $n.Size = New-Object Drawing.Size 400, 24
  $f.Controls.Add($n)

  $script:form = $f; $script:bar = $b; $script:step = $s; $script:detail = $d
  $f.Show(); $f.Refresh()
  [Windows.Forms.Application]::DoEvents()
}
function Set-Step($text, $pct) {
  if ($Silent) { Write-Host "  $text"; return }
  $script:step.Text = $text
  $script:bar.Value = [Math]::Max(0, [Math]::Min(1000, [int]($pct * 10)))
  [Windows.Forms.Application]::DoEvents()
}
function Set-Detail($text) {
  if ($Silent) { return }
  $script:detail.Text = $text
  [Windows.Forms.Application]::DoEvents()
}

# ---------------------------------------------------------------- downloading, with live progress
function Get-Download($url, $dest, $label, $from, $to) {
  Set-Step $label $from
  $h = New-Object System.Net.Http.HttpClient
  $h.Timeout = [TimeSpan]::FromMinutes(30)
  $h.DefaultRequestHeaders.UserAgent.ParseAdd('KanishkInstaller/1.0')
  $resp = $h.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  if (-not $resp.IsSuccessStatusCode) { throw "Could not download $label ($([int]$resp.StatusCode))" }
  $total = 0
  if ($resp.Content.Headers.ContentLength) { $total = [int64]$resp.Content.Headers.ContentLength }
  $in = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
  $out = [IO.File]::Create($dest)
  try {
    $buf = New-Object byte[] 1048576
    $done = 0L; $tick = [Diagnostics.Stopwatch]::StartNew(); $last = 0
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
      $out.Write($buf, 0, $n)
      $done += $n
      if ($tick.ElapsedMilliseconds - $last -gt 120) {
        $last = $tick.ElapsedMilliseconds
        $mb = [Math]::Round($done / 1MB, 1)
        if ($total -gt 0) {
          $frac = $done / $total
          Set-Step $label ($from + ($to - $from) * $frac)
          Set-Detail ("{0} MB of {1} MB" -f $mb, [Math]::Round($total / 1MB, 1))
        } else {
          Set-Detail ("{0} MB" -f $mb)
        }
      }
    }
  } finally { $out.Close(); $in.Close(); $h.Dispose() }
  Set-Step $label $to
  Set-Detail ''
}

function Expand-Zip($zip, $dir) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (Test-Path $tar) {
    Push-Location $dir
    & $tar -x -f $zip
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -eq 0) { return }
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $dir)
}

# ---------------------------------------------------------------- go
if (-not $Silent) { if (-not (Ask-Permission)) { exit 0 } }
if ($Silent) { Write-Host ''; Write-Host '  Setting up Kanishk...' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("kanishk-setup-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Show-Progress
  if ($Silent) { $script:form = $null }

  # stop a copy that is already running, so its files can be replaced
  Set-Step 'Getting ready...' 1
  foreach ($n in 'electron', 'whisper-server') {
    Get-CimInstance Win32_Process -Filter "name='$n.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like "*$InstallDir*" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Milliseconds 600

  Get-Download $APP      (Join-Path $tmp 'app.zip')      'Getting Kanishk...'          2  12
  Get-Download $ELECTRON (Join-Path $tmp 'electron.zip') 'Getting his body...'        12  48
  Get-Download $MODEL    (Join-Path $tmp 'model.bin')    'Getting his ears...'        48  86
  Get-Download $WHISPER  (Join-Path $tmp 'whisper.zip')  'Getting his hearing...'     86  93

  Set-Step 'Putting him together...' 94
  Expand-Zip (Join-Path $tmp 'app.zip') (Join-Path $tmp 'app')
  $srcRoot = Get-ChildItem (Join-Path $tmp 'app') -Directory | Select-Object -First 1
  $appSrc = Join-Path $srcRoot.FullName 'desktop'
  if (-not (Test-Path (Join-Path $appSrc 'src\main.js'))) { throw 'The download looks incomplete.' }

  # his own files are never overwritten
  $keep = @('config.json', 'memory.json', 'todo.json', 'notes.md', 'reminders.json', 'routines.json', 'secrets.json')
  $rc = @($appSrc, $InstallDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1', '/XF') + $keep
  $null = robocopy @rc
  if ($LASTEXITCODE -ge 8) { throw "Could not copy his files (robocopy $LASTEXITCODE)" }

  Set-Step 'Putting him together...' 96
  Expand-Zip (Join-Path $tmp 'electron.zip') (Join-Path $InstallDir 'electron')
  $exe = Join-Path $InstallDir 'electron\electron.exe'
  if (-not (Test-Path $exe)) { throw 'His body did not unpack properly.' }

  Set-Step 'Putting him together...' 98
  $whisperDir = Join-Path $InstallDir 'runtime\whisper'
  Expand-Zip (Join-Path $tmp 'whisper.zip') $whisperDir
  $rel = Get-ChildItem $whisperDir -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
  if ($rel) {
    foreach ($dll in Get-ChildItem (Join-Path $InstallDir 'vcruntime') -Filter '*.dll' -ErrorAction SilentlyContinue) {
      Copy-Item $dll.FullName $rel.DirectoryName -Force -ErrorAction SilentlyContinue
    }
  }
  $models = Join-Path $InstallDir 'runtime\models'
  New-Item -ItemType Directory -Force -Path $models | Out-Null
  Move-Item (Join-Path $tmp 'model.bin') (Join-Path $models 'ggml-base.en.bin') -Force

  # his cloud brain, if a key was handed to the installer
  if ($GroqKey) {
    $keys = @($GroqKey -split '[,; ]+' | Where-Object { $_ })
    @{ groqKeys = $keys } | ConvertTo-Json | Set-Content (Join-Path $InstallDir 'secrets.json') -Encoding UTF8
  }

  Set-Step 'Teaching him to start with Windows...' 99
  New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Kanishk' `
    -Value "`"$exe`" `"$InstallDir`" --hidden" -PropertyType String -Force | Out-Null

  Set-Step 'Waking him up...' 100
  Start-Process -FilePath $exe -ArgumentList "`"$InstallDir`"", '--hidden' -WorkingDirectory $InstallDir
  Start-Sleep -Seconds 3

  if ($script:form) {
    $script:form.Close()
    $m = New-Object Windows.Forms.Form
    $m.Text = 'Kanishk'; $m.Size = New-Object Drawing.Size 430, 250; $m.StartPosition = 'CenterScreen'
    $m.FormBorderStyle = 'FixedDialog'; $m.MaximizeBox = $false; $m.MinimizeBox = $false
    $m.BackColor = $INK; $m.TopMost = $true
    $p = New-Object Windows.Forms.PictureBox
    $p.Image = Get-FaceIcon 4; $p.SizeMode = 'AutoSize'; $p.BackColor = [Drawing.Color]::Transparent
    $p.Location = New-Object Drawing.Point 165, 22
    $m.Controls.Add($p)
    $l = New-Object Windows.Forms.Label
    $l.Text = "He's here." + [Environment]::NewLine + [Environment]::NewLine +
              "Plug in his chip and he'll pop up in the corner." + [Environment]::NewLine +
              "He starts with Windows from now on."
    $l.ForeColor = $PAPER; $l.Font = New-Object Drawing.Font 'Segoe UI', 10
    $l.TextAlign = 'MiddleCenter'
    $l.Location = New-Object Drawing.Point 20, 95; $l.Size = New-Object Drawing.Size 380, 90
    $m.Controls.Add($l)
    $b = New-Object Windows.Forms.Button
    $b.Text = 'Lovely'; $b.Size = New-Object Drawing.Size 120, 36
    $b.Location = New-Object Drawing.Point 150, 170
    $b.BackColor = $RED; $b.ForeColor = [Drawing.Color]::White
    $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0
    $b.Font = New-Object Drawing.Font 'Segoe UI', 10, ([Drawing.FontStyle]::Bold)
    $b.DialogResult = [Windows.Forms.DialogResult]::OK
    $m.Controls.Add($b); $m.AcceptButton = $b
    $m.ShowDialog() | Out-Null
  } else {
    Write-Host ''; Write-Host '  Done. Plug in his chip and he will pop up.' -ForegroundColor Green; Write-Host ''
  }
} catch {
  $msg = "Something went wrong while setting Kanishk up:" + [Environment]::NewLine + [Environment]::NewLine + $_.Exception.Message
  if ($script:form) { $script:form.Close() }
  if ($Silent) { Write-Host "  $msg" -ForegroundColor Red }
  else { [Windows.Forms.MessageBox]::Show($msg, 'Kanishk', 'OK', 'Error') | Out-Null }
  exit 1
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
