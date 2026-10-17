# Putting Kanishk on a computer

## On a computer that already has him

Nothing to do. He starts with Windows, waits quietly in the background, and pops up the moment his
chip is plugged into USB. Unplug it and he leaves.

## On a new computer

1. Get **`Install Kanishk.bat`** onto it: download it from <https://github.com/kanishk2707/KK>
   (open the file, then "Download raw file"), or carry it on a USB stick.
2. Double-click it and click **Allow**.

That is the only thing anyone does. After "Allow" the installer works on its own:

- downloads him (about 314 MB: his app from this repo, Electron, and his voice model), with a progress
  bar showing how far along it is
- rides out short internet dropouts, and carries on from where it stopped instead of starting over
- sets him up in `%LOCALAPPDATA%\Kanishk` (no admin password needed)
- makes him start with Windows
- starts him

Then plug in his chip and he pops up in the corner.

Running the installer again later updates him and keeps her settings, list, notes and outfits.
`Uninstall.bat` (in `%LOCALAPPDATA%\Kanishk`) removes him; it asks first.

Needs Windows 10 (version 1809 or later) or Windows 11, internet during the install, and about 1 GB free.

## Why the chip can't start the install by itself

The chip is an ESP32 with a USB-to-serial bridge, so when it is plugged in Windows sees only a serial
port. Windows never runs programs from a plugged-in device (it stopped allowing that in 2011, because
that is how USB viruses spread), and a serial port cannot show a prompt. So on a computer that has
never met Kanishk, someone opens the installer once. After that, plugging in the chip is all it takes.

## His Groq key on a new computer

This repo is public, so his Groq keys are not in it. On a computer installed from GitHub he works
straight away, but answers with his chip brain (the offline mode) until that computer has a key.
To give it one, either:

- copy `secrets.json` from a computer that has it into `%LOCALAPPDATA%\Kanishk\`, or
- run the installer with the key: `powershell -ExecutionPolicy Bypass -File install.ps1 -GroqKey gsk_...`

Never commit `secrets.json` or paste keys into the repo: anyone can read it.
