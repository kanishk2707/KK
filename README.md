# Kanishk: Spidey for Varuna, with his own brain chip

Kanishk is Spidey, the pixel-art desktop companion, in the name of **Kanishk** and in love with **Varuna**:
the same body, animations, moves, voice, panel, outfits, game and every one of Spidey's abilities on
the computer (open apps, play music, files, reminders, lists, notes, study packs, smart screenshot,
look at the screen, routines, phone notifications...).

## Installing him

On a computer that already has him: **nothing to do, ever.** He starts with Windows, waits in the
background, and pops up when his chip is plugged in.

On a new computer: double-click **`Install Kanishk.bat`** (from this repo) and click **Allow**. The rest
is automatic: it downloads him with a progress bar, sets him up, makes him start with Windows and starts
him. No admin password, nothing to pre-install. See [INSTALL.md](INSTALL.md), which also explains why
the chip itself can't start the install, and how a new computer gets his Groq key.

## How it works

- **Plug the ESP32 into the computer: Kanishk drops into the corner of the screen.** Unplug it: he waves
  and leaves. Nothing to click or start. (He starts hidden with Windows and waits for his chip.)
- **His brain:** when the computer has internet, every reply comes from **Groq** (`qwen/qwen3.8-27b`,
  falling back to `openai/gpt-oss-20b`, with two API keys). Only when there is **no internet** does the
  **chip** answer: it understands her requests and turns them into the same actions (reminders, list,
  notes, opening/closing apps, volume, moves, outfits...), chats in his loving voice, and writes bedtime
  stories with a tiny AI model running on the ESP32 itself.
- Speech recognition runs locally (whisper), so "Hey Kanishk" works with or without internet.

| | Online | Offline |
|---|---|---|
| Chat, answers, writing, code, explanations | Groq | the chip's loving lines |
| Reminders, timers, list, notes, memory | Groq decides, PC does it | chip decides, PC does it |
| Open / close apps, volume, brightness, lock, battery, find files | yes | yes |
| Moves, outfits, catch-the-bug, modes | yes | yes |
| Web search, music, weather, seeing the screen/pictures, study packs | yes | needs internet (he says so) |
| Bedtime stories | Groq | written on the chip by its tiny model |

## Using him (same as Spidey)

- Click him to type, or say **"Hey Kanishk, ..."**. Hotkeys (different from Spidey's, so both can run):
  **Ctrl+Alt+Space** talk, **Ctrl+Alt+K** type, **Ctrl+Alt+B** help with what I copied,
  **Ctrl+Alt+L** look at my screen, **Ctrl+Alt+N** smart screenshot.
- Right-click him (or his tray icon) for modes, voice, tricks, wardrobe, phone notifications, size, nap, quit.
- Drag him anywhere; he remembers where. If Spidey is on screen too, Kanishk sits beside him.

## Folders

```
Install Kanishk.bat  double-click on any Windows PC: asks once, then installs and starts him
install.ps1          the installer it runs (downloads, progress window, set up, start with Windows)
desktop/             the Kanishk app (Spidey's code, renamed, with a Groq brain and the chip link)
  src/main.js          window, tray, auto-start, pops up / leaves with the chip
  src/agent.js         his brain loop: Groq (only the tools a request needs, to fit Groq's free limits),
                       the chip when offline
  src/groq.js          Groq client: rotates 2 models x 2 keys, waits instead of failing on rate limits,
                       tells "no internet" apart from other errors
  src/chip.js          USB link to the chip (chip-watch.ps1 notices plug-in; serial-bridge.ps1 talks to it)
  src/tools.js         everything he can do on the computer (Spidey's tools)
  secrets.json         the Groq keys (private: never in git, see INSTALL.md)
  vcruntime/           Visual C++ runtime DLLs for his voice engine (for PCs that lack them)
  Uninstall.bat        removes him again (asks first)
  config.json          settings (created on first run)
firmware/kanishk/    the chip: offline brain (brain.cpp), tiny story model (llm.cpp + model_data.h)
model/               stories260K.bin + tok512.bin (karpathy/tinyllamas, MIT)
tools/               build_assets.py (packs the model for the firmware), serial_test.ps1 (talk to the chip)
test/                native tests of the chip brain and the story model
backup/              original_firmware_4MB.bin: what was on the ESP32 before Kanishk (local only)
```

## Re-flashing the chip

Quit Kanishk first (tray > Quit Kanishk), since he holds the USB port while running.

```powershell
$cli = "$env:LOCALAPPDATA\Programs\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe"
python tools\build_assets.py
& $cli compile --fqbn esp32:esp32:esp32:PartitionScheme=huge_app --build-path build firmware\kanishk
& $cli upload  --fqbn esp32:esp32:esp32:PartitionScheme=huge_app,UploadSpeed=115200 --port COM16 --input-dir build firmware\kanishk
```

This board's USB link is reliable only at 115200 baud (about 2 minutes; retry if it says "No more data").
Restore the original firmware:
`esptool --port COM16 --baud 115200 write-flash 0 backup\original_firmware_4MB.bin`

## Good to know

- Groq's free tier allows a few thousand tokens per minute per model per key. Kanishk keeps each request
  small and rotates between both keys and both models; in a very fast burst he may pause a few seconds
  ("One sec, Varuna...") instead of failing.
- On a computer without this app installed, plugging in the chip does nothing: Windows never runs
  programs from a USB device by itself (and this board can only appear as a serial port). Run
  `Install Kanishk.bat` once on that machine; after that he pops up by himself forever.
- The Groq keys were shared in a chat while this was built; consider making new ones at console.groq.com
  and putting them in `desktop/secrets.json`.

## Tests

```bash
cd test
g++ -O1 -std=c++17 -I../firmware/kanishk brain_test.cpp ../firmware/kanishk/brain.cpp -o brain_test.exe && ./brain_test.exe
g++ -O2 -I../firmware/kanishk llm_test.cpp ../firmware/kanishk/llm.cpp -o llm_test.exe   # matches llama2.c's run.c exactly
```
