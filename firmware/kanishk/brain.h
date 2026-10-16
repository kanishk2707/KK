// Kanishk's offline brain, on the ESP32. Used only when the PC has no internet (otherwise Groq answers).
// It understands what Varuna says and answers in his loving voice, and turns requests into the same
// tool calls the desktop app normally gets from Groq (set_reminder, todo, open, kanishk...), which the
// PC then runs. Plain C++ so it can be tested on a PC too.
#pragma once
#include <string>
#include <stdint.h>

namespace brain {

struct Clock { int64_t now = 0; int tzMinutes = 330; };   // unix seconds + local offset (IST default)

struct Reply {
  std::string mood = "happy";   // happy excited proud cool thinking love surprised sad oops sleepy
  std::string say;              // the short spoken line
  std::string show;             // longer content for the panel (markdown), may be empty
  std::string title;            // panel title
  std::string tool;             // a desktop tool to run (empty = none)
  std::string args = "{}";      // its arguments, as a JSON object
  bool showResult = false;      // show the tool's result in the panel (lists, notes, system info...)
  bool story = false;           // write a bedtime story with the on-chip model
  std::string storyAbout;
};

// Everything she says goes through here when offline.
Reply think(const std::string& text, const Clock& clk, const std::string& name = "Varuna");

std::string clockText(const Clock& clk);   // "6:42 PM"
std::string dateText(const Clock& clk);    // "Wednesday, 15 October"
void seed(uint32_t s);

}  // namespace brain
