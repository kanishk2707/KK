# Spidey's senses, one long-running process (cheap: compiles once, then just loops).
# Prints one line every 400 ms:   level <0..1>          (loudness of whatever the PC is playing)
# and every 2 s:                  fg <window title>     (only used during focus sessions)
# It never records or reads audio content - just the output peak meter.
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation { int GetPeakValue(out float peak); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
public class SpideySense {
  static IAudioMeterInformation meter;
  static DateTime got = DateTime.MinValue;
  public static float Level() {
    try {
      // re-acquire now and then, so switching speakers/headphones keeps working
      if (meter == null || (DateTime.Now - got).TotalSeconds > 30) {
        var e = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice d; e.GetDefaultAudioEndpoint(0, 0, out d);
        var iid = typeof(IAudioMeterInformation).GUID; object o; d.Activate(ref iid, 23, IntPtr.Zero, out o);
        meter = (IAudioMeterInformation)o; got = DateTime.Now;
      }
      float p; meter.GetPeakValue(out p); return p;
    } catch { meter = null; return 0; }
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Foreground() { var sb = new StringBuilder(300); GetWindowText(GetForegroundWindow(), sb, 300); return sb.ToString(); }
}
"@
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$i = 0
while ($true) {
  [Console]::Out.WriteLine(('level {0:0.000}' -f [SpideySense]::Level()))
  if (($i % 5) -eq 0) { [Console]::Out.WriteLine('fg ' + [SpideySense]::Foreground()) }
  [Console]::Out.Flush()
  $i++
  Start-Sleep -Milliseconds 400
}
