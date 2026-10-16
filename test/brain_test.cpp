// Native test of Kanishk's offline brain (the one on the chip): every request must turn into the right
// desktop tool call with valid JSON arguments, and chat must stay loving.
// build: g++ -O1 -std=c++17 -I../firmware/kanishk brain_test.cpp ../firmware/kanishk/brain.cpp -o brain_test
// usage: brain_test            -> runs the checks
//        brain_test "text"     -> one reply as JSON
#include "brain.h"
#include <cstdio>
#include <cstring>
#include <string>

using namespace brain;

static std::string esc(const std::string& s) {
  std::string o;
  for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if (c == '\n') o += "\\n"; else if ((unsigned char)c < 32) o += ' '; else o += c; }
  return o;
}
// minimal JSON object validator for the args (balanced braces/quotes, starts with { ends with })
static bool validObject(const std::string& j) {
  if (j.size() < 2 || j.front() != '{' || j.back() != '}') return false;
  int depth = 0; bool inStr = false;
  for (size_t i = 0; i < j.size(); i++) {
    char c = j[i];
    if (inStr) { if (c == '\\') i++; else if (c == '"') inStr = false; continue; }
    if (c == '"') inStr = true; else if (c == '{') depth++; else if (c == '}') depth--;
  }
  return depth == 0 && !inStr;
}

int main(int argc, char** argv) {
  Clock c; c.now = 1792040400; c.tzMinutes = 330;   // Thu 15 Oct 2026, 10:30 IST
  seed(7);
  if (argc > 1) {
    Reply r = think(argv[1], c);
    printf("{\"mood\":\"%s\",\"say\":\"%s\",\"tool\":\"%s\",\"args\":%s,\"story\":%s}\n", esc(r.mood).c_str(), esc(r.say).c_str(), esc(r.tool).c_str(), r.args.c_str(), r.story ? "true" : "false");
    return 0;
  }
  int fails = 0;
  auto check = [&](const char* text, const char* tool, const char* argHas) {
    Reply r = think(text, c);
    bool ok = r.tool == tool && validObject(r.args) && (!argHas || r.args.find(argHas) != std::string::npos);
    if (!ok) fails++;
    printf("%s %-46s -> [%s] tool=%s args=%s | %s\n", ok ? "PASS" : "FAIL", text, r.mood.c_str(), r.tool.c_str(), r.args.c_str(), r.say.c_str());
  };
  check("remind me to drink water in 20 minutes", "set_reminder", "\"minutes\":20");
  check("remind me to call mom at 6:30 pm", "set_reminder", "\"at\":\"6:30 pm\"");
  check("remind me at 9 to sleep", "set_reminder", "\"message\":\"sleep\"");
  check("set a timer for 5 minutes", "timer", "\"minutes\":5");
  check("start a pomodoro", "timer", "\"focus\":true");
  check("add milk, eggs and bread to my list", "todo", "milk, eggs and bread");
  check("what's on my list", "todo", "\"list\"");
  check("done with eggs", "todo", "\"item\":\"eggs\"");
  check("clear my list", "todo", "\"clear\"");
  check("note that the wifi password is on the router", "notes", "router");
  check("show my notes", "notes", "\"list\"");
  check("remember that my exam is on friday", "remember", "my exam is on friday");
  check("what do you remember", "_memory", nullptr);
  check("do a backflip", "kanishk", "backflip");
  check("can you dance", "kanishk", "dance");
  check("wear a cricket kit", "outfit", "cricket kit");
  check("dress up as a pirate captain", "outfit", "pirate captain");
  check("take it off", "outfit", "remove");
  check("let's play a game", "kanishk", "game");
  check("quiet mode", "kanishk", "quiet");
  check("hide for 20 minutes", "kanishk", "\"20\"");
  check("open notepad", "open", "notepad");
  check("close chrome", "close_app", "chrome");
  check("turn the volume up", "system_control", "volume_up");
  check("set volume to 40", "system_control", "\"value\":40");
  check("lock my computer", "system_control", "lock");
  check("how's my battery", "system_info", nullptr);
  check("pause the music", "media_control", "play_pause");
  check("show desktop", "window", "minimize_all");
  check("find my resume", "find_files", "resume");
  check("tell me the rest of the story", "", nullptr);   // must NOT be a nap
  // chat answers (no tool)
  for (const char* t : { "hi kanishk", "i love you", "i'm sad today", "what time is it", "what is 12 * 7", "write me a poem", "what's the weather", "why is the sky blue?" }) {
    Reply r = think(t, c);
    bool ok = r.tool.empty() && !r.say.empty();
    if (!ok) fails++;
    printf("%s %-46s -> [%s] %s%s\n", ok ? "PASS" : "FAIL", t, r.mood.c_str(), r.say.c_str(), r.show.empty() ? "" : "  (+panel)");
  }
  Reply s = think("tell me a bedtime story about a dragon", c);
  printf("%s story -> story=%d about=%s\n", s.story && s.storyAbout == "a dragon" ? "PASS" : (fails++, "FAIL"), s.story, s.storyAbout.c_str());
  printf("\n%d failures\n", fails);
  return fails ? 1 : 0;
}
