# Convert any audio/video file Windows can play (mp3, m4a, aac, wma, wav, mp4, mov, mkv...) into
# a 16 kHz mono 16-bit WAV for whisper, using the built-in Windows media transcoder (no ffmpeg needed).
# Usage: powershell -File towav.ps1 <input> <output.wav>
param([string]$Src, [string]$Dst)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Transcoding.MediaTranscoder, Windows.Media.Transcoding, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaProperties.MediaEncodingProfile, Windows.Media.MediaProperties, ContentType = WindowsRuntime]

$ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
$opAsTask = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
$progAsTask = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncActionWithProgress`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $opAsTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }

$in = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Src)) ([Windows.Storage.StorageFile])
$dir = Await ([Windows.Storage.StorageFolder]::GetFolderFromPathAsync([IO.Path]::GetDirectoryName($Dst))) ([Windows.Storage.StorageFolder])
$out = Await ($dir.CreateFileAsync([IO.Path]::GetFileName($Dst), [Windows.Storage.CreationCollisionOption]::ReplaceExisting)) ([Windows.Storage.StorageFile])

$profile = [Windows.Media.MediaProperties.MediaEncodingProfile]::CreateWav([Windows.Media.MediaProperties.AudioEncodingQuality]::Low)
$profile.Audio.SampleRate = 16000
$profile.Audio.ChannelCount = 1
$profile.Audio.BitsPerSample = 16
$profile.Video = $null

$tc = New-Object Windows.Media.Transcoding.MediaTranscoder
$prep = Await ($tc.PrepareFileTranscodeAsync($in, $out, $profile)) ([Windows.Media.Transcoding.PrepareTranscodeResult])
if (-not $prep.CanTranscode) { Write-Output "FAIL $($prep.FailureReason)"; exit 2 }
$t = $progAsTask.MakeGenericMethod([double]).Invoke($null, @($prep.TranscodeAsync()))
$t.Wait(-1) | Out-Null
Write-Output 'OK'
