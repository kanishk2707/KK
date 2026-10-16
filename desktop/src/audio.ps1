# Windows Core Audio helper for Spidey.
#   audio.ps1 mic-state            -> "muted=False level=80"
#   audio.ps1 mic-fix              -> unmute the default mic and raise a too-low level
#   audio.ps1 volume-get           -> speaker "muted=False level=40"
#   audio.ps1 volume-set <0..100>
#   audio.ps1 mute | unmute
param([string]$Action = 'mic-state', [int]$Value = -1)

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float level, Guid ctx);
  int j(); int GetMasterVolumeLevelScalar(out float level);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public class SpideyAudio {
  static IAudioEndpointVolume Ep(int flow) {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice d; e.GetDefaultAudioEndpoint(flow, 0, out d);
    var iid = typeof(IAudioEndpointVolume).GUID; object o; d.Activate(ref iid, 23, IntPtr.Zero, out o);
    return (IAudioEndpointVolume)o;
  }
  public static string State(int flow) { var v = Ep(flow); float l; bool m; v.GetMasterVolumeLevelScalar(out l); v.GetMute(out m); return "muted=" + m + " level=" + Math.Round(l * 100); }
  public static void Mute(int flow, bool on) { Ep(flow).SetMute(on, Guid.Empty); }
  public static void Level(int flow, int pct) { Ep(flow).SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, pct)) / 100f, Guid.Empty); }
  public static string MicFix() {
    var v = Ep(1); bool m; float l; v.GetMute(out m); v.GetMasterVolumeLevelScalar(out l);
    string done = "";
    if (m) { v.SetMute(false, Guid.Empty); done += "unmuted "; }
    if (l < 0.5f) { v.SetMasterVolumeLevelScalar(0.8f, Guid.Empty); done += "raised "; }
    return (done == "" ? "ok " : done) + State(1);
  }
}
"@

try {
  switch ($Action) {
    'mic-state'  { [SpideyAudio]::State(1) }
    'mic-fix'    { [SpideyAudio]::MicFix() }
    'volume-get' { [SpideyAudio]::State(0) }
    'volume-set' { [SpideyAudio]::Mute(0, $false); [SpideyAudio]::Level(0, $Value); [SpideyAudio]::State(0) }
    'mute'       { [SpideyAudio]::Mute(0, $true); [SpideyAudio]::State(0) }
    'unmute'     { [SpideyAudio]::Mute(0, $false); [SpideyAudio]::State(0) }
  }
} catch { "error: $($_.Exception.Message)" }
