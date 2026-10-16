# Putting Kanishk on a computer

## On a computer that already has him

Nothing to do. He starts with Windows, waits quietly in the background, and the moment his chip is
plugged into USB he pops up in the corner. Unplug it and he leaves. That is the whole experience.

## On a computer that has never met him

Copy **`Kanishk-Setup.zip`** (306 MB) onto it — USB stick, email, OneDrive, anything — then:

1. Right-click the zip → **Extract All**
2. Open the `Kanishk` folder → double-click **`Setup.bat`**

About 30 seconds later he is installed and running, and from then on that computer behaves like the
one above: plug in the chip, he appears. Nothing else is ever needed.

The package carries **everything**: he needs no internet to install, no admin password, no Node, no
Electron, no Visual C++ redistributable (his voice engine's runtime DLLs are bundled too). It installs
to `%LOCALAPPDATA%\Kanishk`, which needs no permissions.

Running `Setup.bat` again later just updates him and keeps her settings, list, notes and saved outfits.
`Uninstall.bat` removes him completely.

## Why there is one double-click, and not zero

The chip is an **ESP32-D0WDQ6 with a CP210x USB-to-serial bridge**. Over USB it can only ever appear as
a *serial port* — it has no native USB hardware, so it cannot pretend to be a USB drive or a keyboard.
On top of that, Windows has refused to auto-run programs from anything plugged into USB since 2011
(that is how USB-stick viruses used to spread).

So on a computer that has never seen Kanishk, there is nothing the chip itself can do to install him:
Windows simply will not run code from a device. Someone has to start the installer once. After that one
double-click, the computer remembers him forever and everything is automatic.

The only way to get closer to zero on a brand-new machine would be a different board with native USB
(ESP32-S2/S3) pretending to be a keyboard that types the setup commands by itself. That is exactly the
technique "BadUSB" attacks use, antivirus blocks it, and it would make Kanishk look like malware — so
it is not worth doing to save one click.

## Keeping the keys private

`secrets.json` inside the package holds the Groq API keys, so he works the moment he is installed.
That means **anyone who gets the zip gets the keys**. Keep it to yourself and to her computers. If you
want to publish it (GitHub, a website), delete `secrets.json` from the package first — he will still
run, and will use his chip brain until keys are added back.
