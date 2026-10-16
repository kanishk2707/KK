# Press PLAY on a song inside the Spotify or Apple Music desktop app, through Windows UI Automation
# (the same accessibility buttons a screen reader uses), then check that it is really playing.
# Prints one line: "PLAYING <what>" or "FAIL <why>".
# Spotify:     -App spotify -Uri spotify:search:radhimaa -Query "radhimaa"
# Apple Music: -App apple -Uri music://music.apple.com/... -Track "Radhimaa" -Collection "Radhimaa - Single"
param([string]$App, [string]$Uri, [string]$Query = '', [string]$Track = '', [string]$Collection = '')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$TS = [Windows.Automation.TreeScope]::Descendants
$ButtonCond = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Button)

function Words($s) { if (-not $s) { return @() }; @(([regex]::Matches(([string]$s).ToLower(), '[\p{L}\p{N}]+') | ForEach-Object { $_.Value })) }
function Score($name, $want) {
  $w = Words $want; if (-not $w.Count) { return 0 }
  $n = ' ' + ((Words $name) -join ' ') + ' '
  ($w | Where-Object { $n.Contains(" $_ ") }).Count / $w.Count
}
# bring the app up (front first if it's already running), then open the search / song link in it
function Launch($proc) {
  $p = Get-Process $proc -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
  if ($p) { Front $p; Start-Sleep -Milliseconds 300 }
  Start-Process $Uri
  $p = Win $proc
  if ($p) { Front $p }
  $p
}
function Win($proc) {
  for ($i = 0; $i -lt 40; $i++) {
    $p = Get-Process $proc -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
    if ($p) { return $p }
    Start-Sleep -Milliseconds 500
  }
}
function Press($el) { $el.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke() }
# a real double-click in the middle of an element (Apple Music only starts an album track that way); the pointer goes back after
function DoubleClick($el) {
  try { $el.GetCurrentPattern([Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView(); Start-Sleep -Milliseconds 300 } catch {}
  $r = $el.Current.BoundingRectangle
  Add-Type -AssemblyName System.Windows.Forms
  $old = [System.Windows.Forms.Cursor]::Position
  [void][MusicWin]::SetCursorPos([int]($r.X + $r.Width * 0.4), [int]($r.Y + $r.Height / 2))
  foreach ($k in 1, 2) { [MusicWin]::mouse_event(2, 0, 0, 0, [IntPtr]::Zero); [MusicWin]::mouse_event(4, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60 }
  [void][MusicWin]::SetCursorPos($old.X, $old.Y)
}
# the user asked for this app, so show it: Spotify (Chromium) doesn't even update its page while hidden behind other windows
Add-Type @"
using System; using System.Runtime.InteropServices;
public class MusicWin { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e); }
"@
function Front($p) { if ([MusicWin]::IsIconic($p.MainWindowHandle)) { [void][MusicWin]::ShowWindow($p.MainWindowHandle, 9) }; [void][MusicWin]::SetForegroundWindow($p.MainWindowHandle) }

if ($App -eq 'spotify') {
  # Already open: a second spotify:search link is often ignored, so use its own search box instead.
  # UI Automation sets the text; the suggestion list then has "Play <song>" buttons we can press directly.
  $p = Get-Process Spotify -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
  $best = $null; $searched = $false
  if ($p) {
    Front $p
    $root = $A::FromHandle($p.MainWindowHandle)
    $box = $root.FindFirst($TS, (New-Object Windows.Automation.PropertyCondition($A::NameProperty, 'What do you want to play?')))
    if ($box) {
      try {
        $box.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($Query)
        $r = $box.Current.BoundingRectangle
        $LinkCond = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Hyperlink)
        for ($i = 0; $i -lt 15 -and -not $best -and -not $searched; $i++) {
          Start-Sleep -Milliseconds 400
          try {
            # only things inside the drop-down under the search box (the page behind it has its own buttons)
            $drop = { param($e) $b = $e.Current.BoundingRectangle; $b.Y -gt $r.Bottom -and $b.Y -lt ($r.Bottom + 800) -and $b.X -ge ($r.X - 20) -and $b.X -lt $r.Right }
            $cand = @($root.FindAll($TS, $ButtonCond) | Where-Object { $_.Current.Name -like 'Play *' -and (& $drop $_) } |
              ForEach-Object { [pscustomobject]@{ el = $_; s = (Score $_.Current.Name.Substring(5) $Query); y = $_.Current.BoundingRectangle.Y } } |
              Where-Object { $_.s -ge 0.6 } | Sort-Object @{ e = 's'; Descending = $true }, y)
            if ($cand.Count) { $best = $cand[0].el; break }
            # no song row yet: a plain text suggestion equal to the query opens the full results page
            if ($i -gt 5) {
              $sug = $root.FindAll($TS, $LinkCond) | Where-Object { $_.Current.Name -and (& $drop $_) -and $_.Current.Name.ToLower().Trim() -eq $Query.ToLower().Trim() } | Select-Object -First 1
              if ($sug) { Press $sug; $searched = $true }
            }
          } catch {}
        }
      } catch {}
    }
  }
  if (-not $best) {
    if (-not $searched) { $p = Launch 'Spotify' }
    if (-not $p) { 'FAIL Spotify did not open'; exit }
    $root = $A::FromHandle($p.MainWindowHandle)
    $bottom = $root.Current.BoundingRectangle.Bottom
    # wait for results that match the search (the page may still show older results for a moment)
    for ($i = 0; $i -lt 25 -and -not $best; $i++) {
      Start-Sleep -Milliseconds 600
      try {
        $btns = @($root.FindAll($TS, $ButtonCond) | Where-Object { $_.Current.BoundingRectangle.Bottom -lt $bottom - 120 })
        # songs: "Play <title>" buttons, best word match first, ties go to the higher (earlier) one
        $songs = @($btns | Where-Object { $_.Current.Name -like 'Play *' } |
          ForEach-Object { [pscustomobject]@{ el = $_; s = (Score $_.Current.Name.Substring(5) $Query); y = $_.Current.BoundingRectangle.Y } } |
          Where-Object { $_.s -ge 0.5 } | Sort-Object @{ e = 's'; Descending = $true }, y)
        if ($songs.Count) { $best = $songs[0].el; break }
        # otherwise the big "Top result" card's own Play button, once a matching title is on screen
        $links = $root.FindAll($TS, (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Hyperlink)))
        if (@($links | Where-Object { (Score $_.Current.Name $Query) -ge 0.5 }).Count -and $i -gt 4) {
          $best = $btns | Where-Object { $_.Current.Name -eq 'Play' } | Sort-Object { $_.Current.BoundingRectangle.Y } | Select-Object -First 1
        }
      } catch {}
    }
  }
  if (-not $best) { 'FAIL no matching result appeared in Spotify search'; exit }
  $label = $best.Current.Name -replace '^Play\s*', ''
  if (-not $label) { $label = $Query }
  Press $best
  # Spotify's window title becomes "Artist - Song" while playing; it must be THIS song, not whatever played before
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $p.Refresh()
    $t = $p.MainWindowTitle
    if ($t -and $t -notmatch '^Spotify( Free| Premium)?$' -and ((Score $t $label) -ge 0.5 -or (Score $t $Query) -ge 0.5)) { "PLAYING $t"; exit }
  }
  "FAIL pressed play on '$label' but Spotify does not show it playing"; exit
}

if ($App -eq 'apple') {
  $p = Launch 'AppleMusic'
  if (-not $p) { 'FAIL Apple Music did not open'; exit }
  $root = $A::FromHandle($p.MainWindowHandle)
  $idCond = { param($id) New-Object Windows.Automation.PropertyCondition($A::AutomationIdProperty, $id) }
  # wait until the page for this song's album/single is showing (not the page that was open before)
  $play = $null
  for ($i = 0; $i -lt 40 -and -not $play; $i++) {
    Start-Sleep -Milliseconds 500
    $groups = $root.FindAll($TS, (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Group)))
    if (@($groups | Where-Object { (Score $_.Current.Name $Collection) -ge 0.7 }).Count) { $play = $root.FindFirst($TS, (& $idCond 'PlayButtonElement')) }
  }
  if (-not $play) { 'FAIL the song page did not load in Apple Music'; exit }
  $transport = $root.FindFirst($TS, (& $idCond 'TransportControl_PlayPauseStop'))
  # a single: its Play button plays the song. An album: start from the song's own row.
  $rows = @($root.FindAll($TS, (New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem))) |
    Where-Object { $_.Current.Name -like 'Track *' })
  $row = $rows | Where-Object { (Score $_.Current.Name $Track) -ge 0.8 } | Select-Object -First 1
  if ($rows.Count -gt 1 -and $row) {
    DoubleClick $row
  } else {
    Press $play
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if ($transport.Current.Name -eq 'Pause') {
      $now = @($root.FindAll($TS, [Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.BoundingRectangle.Y -lt 80 -and $_.Current.Name -and (Score $_.Current.Name $Track) -ge 0.6 })
      if ($now.Count) { "PLAYING $Track"; exit }
    }
  }
  "FAIL pressed play but Apple Music is not playing (maybe not signed in / no subscription)"; exit
}
"FAIL unknown app $App"
