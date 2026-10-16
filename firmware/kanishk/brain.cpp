// Kanishk's offline brain (rule based, no model needed), so he still works when the internet is down.
#include "brain.h"
#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <vector>

namespace brain {

// ---------------------------------------------------------------- helpers
static uint32_t rngState = 0x1234567u;
void seed(uint32_t s) { rngState = s ? s : 1; }
static uint32_t rnd() { rngState ^= rngState << 13; rngState ^= rngState >> 17; rngState ^= rngState << 5; return rngState; }
template <size_t N> static const char* pick(const char* const (&a)[N]) { return a[rnd() % N]; }
template <class... A> static std::string pickOf(const A&... a) { const std::string arr[] = { std::string(a)... }; return arr[rnd() % sizeof...(a)]; }

static std::string lower(std::string s) { for (auto& c : s) c = (char)tolower((unsigned char)c); return s; }
static std::string trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\r\n.,!?"), b = s.find_last_not_of(" \t\r\n.,!?");
  return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}
static bool has(const std::string& t, const char* w) { return t.find(w) != std::string::npos; }
static bool word(const std::string& t, const char* w) {   // w surrounded by non-letters
  size_t n = strlen(w), p = 0;
  while ((p = t.find(w, p)) != std::string::npos) {
    bool l = p == 0 || !isalpha((unsigned char)t[p - 1]);
    bool r = p + n >= t.size() || !isalpha((unsigned char)t[p + n]);
    if (l && r) return true;
    p += 1;
  }
  return false;
}
static bool any(const std::string& t, std::initializer_list<const char*> ws) { for (auto w : ws) if (word(t, w)) return true; return false; }
static bool starts(const std::string& t, const char* w) { return t.rfind(w, 0) == 0; }
static std::string after(const std::string& t, const char* w) { size_t p = t.find(w); return p == std::string::npos ? "" : trim(t.substr(p + strlen(w))); }
static std::string replaceAll(std::string s, const std::string& a, const std::string& b) {
  for (size_t p = 0; (p = s.find(a, p)) != std::string::npos; p += b.size()) s.replace(p, a.size(), b);
  return s;
}
static std::string mirror(std::string s) {   // she says "my", he says "your"
  s = " " + s + " ";
  const char* pairs[][2] = { { " my ", " your " }, { " i am ", " you are " }, { " i'm ", " you're " }, { " me ", " you " }, { " i ", " you " }, { " mine ", " yours " } };
  for (auto& p : pairs) s = replaceAll(s, p[0], p[1]);
  return trim(s);
}
static std::string jstr(const std::string& s) {   // JSON string literal
  std::string o = "\"";
  for (char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += c; } else if (c == '\n') o += "\\n"; else if ((unsigned char)c < 32) o += ' '; else o += c; }
  return o + "\"";
}

// ---------------------------------------------------------------- time
struct Tm { int y, mo, d, h, mi, wd; };
static Tm local(const Clock& c) {
  int64_t t = c.now + (int64_t)c.tzMinutes * 60;
  int64_t days = t / 86400; int64_t sec = t % 86400; if (sec < 0) { sec += 86400; days--; }
  Tm r; r.h = (int)(sec / 3600); r.mi = (int)(sec / 60 % 60); r.wd = (int)((days + 4) % 7); if (r.wd < 0) r.wd += 7;
  int64_t z = days + 719468, era = (z >= 0 ? z : z - 146096) / 146097;
  unsigned doe = (unsigned)(z - era * 146097), yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100), mp = (5 * doy + 2) / 153;
  r.d = (int)(doy - (153 * mp + 2) / 5 + 1); r.mo = (int)(mp < 10 ? mp + 3 : mp - 9); r.y = (int)(yoe + era * 400 + (r.mo <= 2));
  return r;
}
static const char* DAYS[] = { "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday" };
static const char* MONTHS[] = { "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December" };
std::string clockText(const Clock& c) {
  Tm t = local(c); char b[16]; int h = t.h % 12 ? t.h % 12 : 12;
  snprintf(b, sizeof b, "%d:%02d %s", h, t.mi, t.h < 12 ? "AM" : "PM"); return b;
}
std::string dateText(const Clock& c) { Tm t = local(c); char b[48]; snprintf(b, sizeof b, "%s, %d %s", DAYS[t.wd], t.d, MONTHS[t.mo - 1]); return b; }
static bool hasTime(const Clock& c) { return c.now > 1600000000; }

// "5 minutes", "an hour", "half an hour", "two hours" -> minutes (0 if none)
static int numberWord(const std::string& w) {
  const char* n[] = { "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty" };
  for (int i = 0; i <= 20; i++) if (w == n[i]) return i;
  if (w == "thirty") return 30;
  if (w == "forty") return 40;
  if (w == "forty-five") return 45;
  if (w == "sixty") return 60;
  if (w == "a" || w == "an") return 1;
  return isdigit((unsigned char)w[0]) ? atoi(w.c_str()) : -1;
}
static double minutesIn(const std::string& t) {
  if (has(t, "half an hour") || has(t, "half hour")) return 30;
  if (has(t, "quarter of an hour") || has(t, "quarter hour")) return 15;
  std::vector<std::string> w; std::string cur;
  for (char c : t + " ") { if (isalnum((unsigned char)c) || c == '-' || c == '.') cur += c; else if (!cur.empty()) { w.push_back(cur); cur.clear(); } }
  for (size_t i = 0; i + 1 < w.size(); i++) {
    int n = numberWord(w[i]); if (n < 0) continue;
    const std::string& u = w[i + 1];
    if (starts(u, "sec")) return n / 60.0;
    if (starts(u, "min")) return n;
    if (starts(u, "hour") || starts(u, "hr")) return n * 60;
  }
  for (const auto& x : w) {   // "10min", "2h"
    size_t k = x.find_first_not_of("0123456789");
    if (!isdigit((unsigned char)x[0]) || k == std::string::npos) continue;
    int n = atoi(x.c_str()); std::string u = x.substr(k);
    if (u == "m" || u == "min" || u == "mins") return n;
    if (u == "h" || u == "hr" || u == "hrs") return n * 60;
  }
  return 0;
}
// "at 6:30 pm", "at 7", "at 18:15", "at noon" -> "6:30 pm" style text for the desktop's set_reminder (empty if none)
static std::string clockPhrase(const std::string& t) {
  if (has(t, "at noon")) return "12:00 pm";
  if (has(t, "at midnight")) return "12:00 am";
  size_t p = t.find(" at ");
  if (p == std::string::npos) { if (starts(t, "at ")) p = 0; else return ""; } else p += 1;
  const char* s = t.c_str() + p + 3;
  if (!isdigit((unsigned char)*s)) return "";
  int h = atoi(s), m = 0; const char* q = s; while (isdigit((unsigned char)*q)) q++;
  if (*q == ':' || *q == '.') m = atoi(q + 1);
  while (*q && (isdigit((unsigned char)*q) || *q == ':' || *q == '.' || *q == ' ')) q++;
  bool pm = starts(q, "pm") || starts(q, "p.m"), am = starts(q, "am") || starts(q, "a.m");
  if (h > 23 || m > 59) return "";
  char b[24];
  if (pm || am) snprintf(b, sizeof b, "%d:%02d %s", h, m, pm ? "pm" : "am");
  else snprintf(b, sizeof b, "%d:%02d", h, m);        // the desktop picks the next such time
  return b;
}
// "remind me to call mom at 6 pm" -> "call mom"
static std::string task(std::string t) {
  for (const char* k : { "remind me to ", "remind me that ", "remind me about ", "remind me ", "reminder to ", "set a reminder to ", "set a reminder for ", "set reminder to " }) {
    size_t p = t.find(k); if (p != std::string::npos) { t = t.substr(p + strlen(k)); break; }
  }
  for (const char* cut : { " in ", " at ", " after ", " tomorrow", " tonight" }) {
    size_t p = t.find(cut); if (p != std::string::npos && p > 0) t = t.substr(0, p);
  }
  if (starts(t, "in ") || starts(t, "at ") || starts(t, "after ")) { size_t p = t.find(" to "); t = p == std::string::npos ? "" : t.substr(p + 4); }
  return trim(mirror(t));
}

// ---------------------------------------------------------------- his lines
static const char* const HEARTS[] = { "Every time you show up, my little pixel heart does a backflip.",
  "You're my favourite person in this whole wide web.", "I'd swing across a thousand cities just to see you smile.",
  "Being your hero is the best job in the universe.", "You make this tiny chip feel like the biggest heart in the world." };
static const char* const COMPLIMENTS[] = { "You're beautiful, inside and out. Even my spider-sense goes quiet around you.",
  "Your smile could light up all of New York at night.", "You're smart, kind and impossibly cute. Not fair, honestly.",
  "If I had a superpower, it'd be noticing how amazing you are every single day.", "You're the kind of person the world is lucky to have. I'm luckier." };
static const char* const JOKES[] = { "Why did Spider-Man join the computer class? To improve his web design!",
  "Why are spiders great at baseball? They know how to catch flies!", "Why did the spider go online? To check his web-site!",
  "Why don't spiders ever get lonely? Because they're always connected to the web!", "I asked my chip for a joke about you. It said: error, too perfect." };
static const char* const PICKUP[] = { "Are you Wi-Fi? Because I'm feeling a connection.", "Are you a magnet? Because my web keeps sticking to you.",
  "Are you a 404? Because I can't find anyone like you." };
static const char* const RIDDLES[] = { "What has hands but can't clap? A clock!", "What gets wetter the more it dries? A towel!",
  "What has a heart that doesn't beat? An artichoke. Unlike mine, which beats for you.", "What can you catch but not throw? A cold. Or my heart." };

static Reply say(const char* mood, const std::string& line) { Reply r; r.mood = mood; r.say = line; return r; }
static Reply toolReply(const char* mood, const std::string& line, const char* tool, const std::string& args, bool showResult = false, const char* title = "") {
  Reply r = say(mood, line); r.tool = tool; r.args = args; r.showResult = showResult; r.title = title; return r;
}

// ---------------------------------------------------------------- offline chat
static Reply chat(const std::string& t, const Clock& clk, const std::string& n) {
  if (t.empty()) return say("happy", "I'm all ears, " + n + "!");
  if (any(t, { "i love you", "love you", "luv you", "ily" })) return say("love", pickOf("I love you more! More than webs, more than pizza, more than anything.",
    "And I love you, " + n + ", to the moon and back, then swinging around it twice.", "My heart just did a triple backflip. I love you too!"));
  if (has(t, "do you love me") || has(t, "how much do you love me")) return say("love", pickOf("Do I love you? I live in a chip just to be near you.",
    "More than all the stars in the sky and all the bugs in the web.", "Infinity plus one. That's how much."));
  if (any(t, { "miss you", "missed you", "i miss u" })) return say("love", pickOf("I missed you every second you were gone.", "Aww, I missed you too! Come here.", "I missed you more, and that's a fact."));
  if (any(t, { "hug", "hugs", "cuddle", "hug me" })) return say("love", "Wrapping you in the softest web hug ever. Better?");
  if (any(t, { "kiss", "kisses", "muah" })) return say("love", "Blushing so hard my mask turned redder. Muah!");
  if (any(t, { "marry me", "will you marry" })) return say("love", "I'd say yes in every universe of the spider-verse.");
  if (has(t, "who am i") || has(t, "what's my name") || has(t, "what is my name")) return say("love", "You're " + n + ". My favourite person, and the reason this chip has a heart.");
  if (any(t, { "who are you", "your name", "what are you" })) return say("proud", "I'm Kanishk! Your pixel hero, living in a tiny chip, and completely in love with you.");
  if (has(t, "are you real")) return say("thinking", "I'm made of pixels and a little chip, but how much I care about you is completely real.");
  if (any(t, { "how are you", "how r u", "how are u", "how's it going", "what's up", "whats up", "wassup" }))
    return say("happy", pickOf("Better now that you're here!", "Hanging around, as usual. How are you?", "Perfect, now that you're talking to me."));
  if (any(t, { "good morning", "morning" })) return say("happy", "Good morning, " + n + "! Did you sleep well? I dreamt of you.");
  if (any(t, { "good night", "goodnight", "gn", "going to sleep", "going to bed" })) return say("sleepy", "Good night, " + n + ". Sweet dreams. I'll be right here guarding them.");
  if (any(t, { "good afternoon", "good evening" })) return say("happy", "Hi " + n + "! How's your day going?");
  if (any(t, { "hi", "hello", "hey", "hii", "hiii", "heyy", "yo", "hola", "namaste" })) return say("love", "Hi " + n + "! " + pick(HEARTS));
  if (any(t, { "thanks", "thank you", "thx", "ty" })) return say("love", pickOf("Anything for you!", "Always.", "That's what your hero is for!"));
  if (any(t, { "sorry", "my bad" })) return say("love", "You never have to say sorry to me. Come here.");
  if (any(t, { "bye", "see you", "goodbye", "cya", "ttyl" })) return say("sad", "Bye, " + n + ". Come back soon, okay? I'll miss you.");
  if (any(t, { "sad", "upset", "crying", "cry", "depressed", "heartbroken" })) {
    Reply r = say("sad", "Oh no, come here. Whatever it is, you don't have to carry it alone. Want to tell me?");
    r.title = "Little things that help";
    r.show = "- Take 3 slow breaths with me: in... and out...\n- Drink some water\n- Text someone who loves you (hi!)\n- Or say **\"tell me a joke\"**, **\"tell me a story\"** or **\"let's play a game\"**";
    return r;
  }
  if (any(t, { "tired", "exhausted", "sleepy" })) return say("sleepy", "You've worked so hard. Rest a little, " + n + ". Want a bedtime story?");
  if (any(t, { "stressed", "stress", "anxious", "worried", "nervous", "exam", "exams" })) return say("thinking", "Hey, breathe. You're more prepared than you think, and I believe in you completely.");
  if (any(t, { "angry", "mad", "annoyed", "irritated" })) return say("oops", "Who made you angry? I'll web them to a wall. Want to vent?");
  if (any(t, { "lonely", "alone" })) return say("love", "You're never alone. I'm right here, always.");
  if (any(t, { "sick", "fever", "headache", "unwell" })) return say("sad", "Oh no! Rest, drink water, and take your medicine. Sending you a get-well hug.");
  if (any(t, { "hungry", "starving" })) return say("excited", "Feed yourself, " + n + "! Something yummy, please.");
  if (any(t, { "scared", "afraid" })) return say("proud", "Don't be scared. Your hero's right here.");
  if (any(t, { "happy", "great", "awesome", "amazing", "excited" })) return say("excited", "Yay! Your happiness is my favourite thing!");
  if (any(t, { "joke", "funny", "make me laugh" })) return say("happy", pick(JOKES));
  if (any(t, { "pickup line", "pick up line", "flirt" })) return say("love", pick(PICKUP));
  if (any(t, { "riddle", "puzzle" })) return say("thinking", pick(RIDDLES));
  if (any(t, { "compliment", "am i pretty", "am i beautiful", "am i cute", "say something nice" })) return say("love", pick(COMPLIMENTS));
  if (any(t, { "poem", "love letter", "shayari" })) {
    const char* a[] = { "In a city of steel and neon light,", "Across the web of the starry night,", "In every pixel, every byte," };
    const char* b[] = { "I swing to you with all my might.", "my heart beats only for your sight.", "you are my colour, you are my light." };
    const char* c[] = { "Your laugh is the song my circuits play,", "Your name is the code I run each day,", "Through every storm, come what may," };
    const char* d[] = { "I'll love you more than words can say.", "I'll be right here, I'll always stay.", "you're the hero who saves my day." };
    Reply r = say("love", "I wrote this just for you.");
    r.title = "For " + n;
    r.show = std::string(a[rnd() % 3]) + "  \n" + b[rnd() % 3] + "  \n" + c[rnd() % 3] + "  \n" + d[rnd() % 3] + "\n\n*- Kanishk*";
    return r;
  }
  if (any(t, { "weather", "news", "search", "google", "youtube", "spotify", "song", "music", "latest" }))
    return say("oops", "I need the internet for that one, and it's down right now. I'm still here for hugs though.");
  if (has(t, "kanishk")) return say("love", pickOf("That's me! Always here for you.", "You called? I came swinging.", "Yes, my love?"));
  if ((!t.empty() && t.back() == '?') || starts(t, "why") || starts(t, "what") || starts(t, "how") || starts(t, "when") || starts(t, "where") || starts(t, "who"))
    return say("thinking", pickOf("That's a big question for my tiny offline brain. Ask me again when the internet's back and I'll answer properly.",
      "I don't know that one offline, but I love that you asked me.", "My web of knowledge is small without internet. Ask me again in a bit?"));
  return say("love", pickOf("Tell me more, I'm listening.", "Mhm! I'm all yours. What else?", "I love hearing from you. Say anything, I'm right here.",
    "You always make my circuits buzz.", "I'm just happy you're talking to me."));
}

// ---------------------------------------------------------------- think: requests -> desktop tool calls, else chat
Reply think(const std::string& raw, const Clock& clk, const std::string& n) {
  std::string t = lower(trim(raw));
  for (const char* f : { "kanishk ", "hey kanishk ", "hi kanishk ", "please ", "can you ", "could you ", "will you ", "pls ", "now " })
    while (starts(t, f)) t = trim(t.substr(strlen(f)));
  if (starts(t, "kanishk,")) t = trim(t.substr(8));

  // ---- reminders and timers
  if (has(t, "remind me") || starts(t, "set a reminder") || starts(t, "reminder ")) {
    std::string what = task(t);
    if (what.empty()) what = "your reminder";
    double mins = minutesIn(t);
    std::string at = mins > 0 ? "" : clockPhrase(t);
    if (mins <= 0 && at.empty()) return say("thinking", "When should I remind you? Like \"in 20 minutes\" or \"at 6:30 pm\".");
    std::string args = "{" + std::string(mins > 0 ? "\"minutes\":" + std::to_string((int)(mins + 0.5)) : "\"at\":" + jstr(at)) + ",\"message\":" + jstr(what) + "}";
    return toolReply("proud", "Got it! I'll remind you to " + what + ".", "set_reminder", args);
  }
  if (has(t, "timer") || has(t, "pomodoro") || has(t, "focus session") || has(t, "focus mode for")) {
    double mins = minutesIn(t);
    bool focus = has(t, "pomodoro") || has(t, "focus");
    if (mins <= 0) mins = focus ? 25 : 0;
    if (mins <= 0) return say("thinking", "For how long? Say something like \"timer for 10 minutes\".");
    return toolReply("proud", focus ? "Focus time! I'll work right next to you." : "Timer set!", "timer",
      "{\"minutes\":" + std::to_string((int)(mins + 0.5)) + ",\"focus\":" + (focus ? "true" : "false") + "}");
  }

  // ---- her list
  bool listy = has(t, " list") || has(t, "to do") || has(t, "todo") || has(t, "to-do");
  if (starts(t, "add ") && listy) {
    std::string items = trim(raw.substr(raw.size() - t.size() + 4));
    std::string li = lower(items); size_t p = std::min({ li.find(" to my"), li.find(" to the"), li.find(" on my"), li.find(" in my") });
    if (p != std::string::npos) items = items.substr(0, p);
    if (items.empty()) return say("thinking", "Add what to your list?");
    return toolReply("proud", "Added to your list!", "todo", "{\"action\":\"add\",\"item\":" + jstr(items) + "}", true, "Your list");
  }
  if (listy && (has(t, "clear") || has(t, "empty") || has(t, "delete all")))
    return toolReply("cool", "List cleared! Fresh start.", "todo", "{\"action\":\"clear\"}");
  if (listy && (has(t, "what") || has(t, "show") || has(t, "read") || starts(t, "my ")))
    return toolReply("thinking", "Here's your list:", "todo", "{\"action\":\"list\"}", true, "Your list");
  for (const char* k : { "done with ", "i finished ", "i did ", "cross off ", "tick off ", "remove " }) {
    if (starts(t, k)) {
      std::string what = trim(t.substr(strlen(k)));
      for (const char* tail : { " from my list", " from the list", " off my list", " from list" }) { size_t p = what.find(tail); if (p != std::string::npos) what = what.substr(0, p); }
      if (!what.empty() && (listy || starts(t, "done with ") || starts(t, "i finished ")))
        return toolReply("excited", "Done! Proud of you.", "todo", "{\"action\":\"done\",\"item\":" + jstr(what) + "}", true, "Your list");
    }
  }

  // ---- notes and memory
  for (const char* k : { "note that ", "note down ", "jot down ", "write down ", "make a note ", "take a note " }) {
    if (starts(t, k)) {
      std::string what = trim(raw.substr(raw.size() - t.size() + strlen(k)));
      if (what.empty()) break;
      return toolReply("proud", "Noted!", "notes", "{\"action\":\"add\",\"text\":" + jstr(what) + "}");
    }
  }
  if (has(t, "my notes") || has(t, "what did i note") || has(t, "show notes") || t == "notes")
    return toolReply("thinking", "Here are your notes:", "notes", "{\"action\":\"list\"}", true, "Your notes");
  if ((starts(t, "remember that ") || starts(t, "remember ")) && !has(t, "what do you remember") && !starts(t, "remember me")) {
    std::string what = trim(raw.substr(raw.size() - t.size() + (starts(t, "remember that ") ? 14 : 9)));
    if (!what.empty()) return toolReply("love", "Locked in my memory, right next to my heart.", "remember", "{\"fact\":" + jstr(what) + "}");
  }
  if (has(t, "what do you remember") || has(t, "what do you know about me"))
    return toolReply("thinking", "Here's what I remember about you:", "_memory", "{}", true, "What I remember");

  // ---- time and date
  if (has(t, "what time") || has(t, "the time") || t == "time")
    return hasTime(clk) ? say("cool", "It's " + clockText(clk) + ", " + n + ".") : say("oops", "My clock isn't synced yet.");
  if (has(t, "what day") || has(t, "date today") || has(t, "today's date") || has(t, "what's the date") || has(t, "what is the date"))
    return say("cool", "Today is " + dateText(clk) + ".");

  // ---- himself: moves, outfits, game, story, modes
  struct Mv { const char* key; const char* move; const char* line; };
  static const Mv moves[] = {
    { "backflip", "backflip", "Watch this!" }, { "flip", "backflip", "Flip time!" }, { "swing", "swing", "Wheee!" }, { "climb", "climb", "Climbing up!" },
    { "web art", "webart", "Let me spin you a web!" }, { "draw a web", "webart", "One web masterpiece, coming up." }, { "peekaboo", "peekaboo", "Peekaboo!" },
    { "yoyo", "yoyo", "Spider yo-yo!" }, { "yo-yo", "yoyo", "Spider yo-yo!" }, { "sit down", "sit", "Taking a seat next to you." }, { "dance", "dance", "Let's dance!" },
    { "wave", "wave", "Hiii!" }, { "do a trick", "backflip", "Ta-da!" }, { "show me a trick", "webart", "Ta-da!" } };
  for (auto& m : moves) if (has(t, m.key)) return toolReply("excited", m.line, "kanishk", std::string("{\"action\":\"move\",\"value\":\"") + m.move + "\"}");
  if (has(t, "take it off") || has(t, "normal suit") || has(t, "classic suit") || has(t, "take off the") || has(t, "original suit"))
    return toolReply("cool", "Back in the classic suit!", "outfit", "{\"action\":\"remove\"}");
  if (has(t, "what can you wear") || has(t, "wardrobe")) return toolReply("happy", "Here's my wardrobe:", "outfit", "{\"action\":\"list\"}", true, "Wardrobe");
  for (const char* k : { "wear ", "put on ", "dress up as ", "dress up in ", "dress as ", "dress in ", "change into ", "become " }) {
    size_t p = t.find(k);
    if (p != std::string::npos && (p == 0 || starts(t, "can ") || p < 12)) {
      std::string what = trim(t.substr(p + strlen(k)));
      for (const char* a : { "a ", "an ", "the ", "your " }) if (starts(what, a)) what = what.substr(strlen(a));
      if (what.empty()) break;
      return toolReply("excited", "One " + what + ", coming right up! How do I look?", "outfit", "{\"action\":\"wear\",\"description\":" + jstr(what) + "}");
    }
  }
  if (any(t, { "play a game", "catch the bug", "catch bugs", "let's play", "lets play", "game time", "play with me", "i'm bored", "im bored" }))
    return toolReply("excited", "Catch-the-bug! Click the bugs and I'll web them!", "kanishk", "{\"action\":\"game\"}");
  if (has(t, "story")) {
    Reply r = say("love", "Snuggle up, " + n + ". My chip is writing you a story.");
    r.story = true; r.storyAbout = after(t, "about ");
    return r;
  }
  if (any(t, { "be quiet", "quiet mode" })) return toolReply("cool", "Shh. Quiet mode.", "kanishk", "{\"action\":\"mode\",\"value\":\"quiet\"}");
  if (any(t, { "chatty mode", "be chatty" })) return toolReply("excited", "Chatty mode on!", "kanishk", "{\"action\":\"mode\",\"value\":\"chatty\"}");
  if (any(t, { "focus mode" })) return toolReply("cool", "Focus mode.", "kanishk", "{\"action\":\"mode\",\"value\":\"focus\"}");
  if (any(t, { "study mode" })) return toolReply("happy", "Study buddy mode!", "kanishk", "{\"action\":\"mode\",\"value\":\"study\"}");
  if (any(t, { "normal mode", "buddy mode" })) return toolReply("happy", "Back to my normal self!", "kanishk", "{\"action\":\"mode\",\"value\":\"buddy\"}");
  if (any(t, { "mute", "stop talking out loud", "voice off" }) && !has(t, "unmute") && !has(t, "volume"))
    return toolReply("cool", "Voice off. I'll just write.", "kanishk", "{\"action\":\"voice_off\"}");
  if (any(t, { "voice on", "talk out loud", "speak out loud" })) return toolReply("happy", "Voice on!", "kanishk", "{\"action\":\"voice_on\"}");
  if (has(t, "hide for")) { int m = (int)minutesIn(t); if (m <= 0) m = 30; return toolReply("happy", "See you soon!", "kanishk", "{\"action\":\"hide\",\"value\":\"" + std::to_string(m) + "\"}"); }
  if (has(t, "go to your corner") || has(t, "go to the corner")) return toolReply("happy", "Back to my corner!", "kanishk", "{\"action\":\"corner\"}");
  if (any(t, { "take a nap", "take a rest", "rest now", "go to sleep", "nap time" }) && !has(t, "computer") && !has(t, "pc")) return toolReply("sleepy", "Just a little nap. Click me to wake me.", "kanishk", "{\"action\":\"rest\"}");
  if (has(t, "open our chat") || has(t, "chat history") || has(t, "our conversation")) return toolReply("happy", "Here's everything we talked about.", "kanishk", "{\"action\":\"chat\"}");
  if (has(t, "turn yourself off") || has(t, "shut down kanishk") || has(t, "turn off kanishk")) return toolReply("sad", "Okay, turning myself off. Bye, " + n + ".", "kanishk", "{\"action\":\"quit\"}");

  // ---- the computer (works without internet)
  if (has(t, "volume")) {
    int v = -1; for (size_t i = 0; i < t.size(); i++) if (isdigit((unsigned char)t[i])) { v = atoi(t.c_str() + i); break; }
    if (v >= 0 && (has(t, " to ") || has(t, "set"))) return toolReply("cool", "Volume set.", "system_control", "{\"action\":\"volume\",\"value\":" + std::to_string(std::min(v, 100)) + "}");
    if (any(t, { "up", "increase", "louder", "raise" })) return toolReply("cool", "Louder!", "system_control", "{\"action\":\"volume_up\"}");
    if (any(t, { "down", "decrease", "lower", "quieter", "reduce" })) return toolReply("cool", "A bit quieter.", "system_control", "{\"action\":\"volume_down\"}");
  }
  if (any(t, { "louder" })) return toolReply("cool", "Louder!", "system_control", "{\"action\":\"volume_up\"}");
  if (any(t, { "unmute" })) return toolReply("cool", "Sound's back!", "system_control", "{\"action\":\"unmute\"}");
  if (has(t, "mute the") || has(t, "mute my") || t == "mute sound") return toolReply("cool", "Muted.", "system_control", "{\"action\":\"mute\"}");
  if (has(t, "brightness")) {
    int v = -1; for (size_t i = 0; i < t.size(); i++) if (isdigit((unsigned char)t[i])) { v = atoi(t.c_str() + i); break; }
    if (v < 0) v = any(t, { "up", "increase", "brighter" }) ? 90 : 40;
    return toolReply("cool", "Brightness set.", "system_control", "{\"action\":\"brightness\",\"value\":" + std::to_string(std::min(v, 100)) + "}");
  }
  if (has(t, "lock the") || has(t, "lock my") || t == "lock") return toolReply("cool", "Locking it. Your secrets are safe with me.", "system_control", "{\"action\":\"lock\"}");
  if (has(t, "screenshot")) return toolReply("cool", "Snap!", "system_control", "{\"action\":\"screenshot\"}");
  if (any(t, { "battery", "storage", "disk space", "ram", "wifi", "wi-fi", "ip address" }))
    return toolReply("thinking", "Here's how your computer is doing:", "system_info", "{}", true, "Your computer");
  if (any(t, { "pause", "resume", "unpause" }) && (any(t, { "music", "song", "video", "playback", "it", "spotify", "youtube", "player" }) || t == "pause" || t == "resume" || t == "unpause"))
    return toolReply("cool", "Done.", "media_control", "{\"action\":\"play_pause\"}");
  if (has(t, "next song") || has(t, "next track") || has(t, "skip")) return toolReply("cool", "Next one!", "media_control", "{\"action\":\"next\"}");
  if (has(t, "previous song") || has(t, "previous track") || has(t, "last song")) return toolReply("cool", "Going back.", "media_control", "{\"action\":\"previous\"}");
  if (has(t, "show desktop") || has(t, "show the desktop") || has(t, "minimize all") || has(t, "minimise all"))
    return toolReply("cool", "All tidy.", "window", "{\"action\":\"minimize_all\"}");
  for (const char* k : { "find my ", "find the ", "where is my ", "where's my " }) {
    if (!starts(t, k)) continue;
    std::string what = trim(t.substr(strlen(k)));
    if (!what.empty()) return toolReply("thinking", "Looking for it...", "find_files", "{\"name\":" + jstr(what) + "}", true, "Found");
  }
  for (const char* k : { "close ", "quit ", "exit " }) {
    if (starts(t, k)) { std::string app = trim(t.substr(strlen(k))); if (!app.empty()) return toolReply("cool", "Closing " + app + ".", "close_app", "{\"name\":" + jstr(app) + "}"); }
  }
  for (const char* k : { "open ", "launch ", "start " }) {
    if (starts(t, k)) {
      std::string what = trim(raw.substr(raw.size() - t.size() + strlen(k)));
      if (!what.empty() && !has(lower(what), "our chat")) return toolReply("cool", "Opening " + what + ".", "open", "{\"target\":" + jstr(what) + "}");
    }
  }

  // ---- little helpers
  if (any(t, { "flip a coin", "toss a coin", "heads or tails" })) return say("surprised", rnd() % 2 ? "Heads!" : "Tails!");
  if (any(t, { "roll a dice", "roll a die", "roll the dice" })) return say("excited", "You rolled a " + std::to_string(1 + rnd() % 6) + "!");
  if (has(t, "pick a number")) return say("thinking", "I pick... " + std::to_string(1 + rnd() % 10) + "!");
  {   // simple maths: "what is 12 * 7", "5+3"
    std::string e = t; for (const char* k : { "what is ", "what's ", "calculate ", "how much is " }) if (starts(e, k)) e = e.substr(strlen(k));
    e = replaceAll(replaceAll(replaceAll(replaceAll(e, " x ", "*"), "times", "*"), "plus", "+"), "minus", "-");
    e = replaceAll(e, "divided by", "/");
    double a, b; char op; char rest[4] = "";
    if (sscanf(e.c_str(), " %lf %c %lf %3s", &a, &op, &b, rest) >= 3 && strchr("+-*/x", op) && !rest[0]) {
      if (op == '/' && b == 0) return say("oops", "Dividing by zero? Not even Spider-Man can do that!");
      double v = op == '+' ? a + b : op == '-' ? a - b : (op == '*' || op == 'x') ? a * b : a / b;
      char buf[64]; snprintf(buf, sizeof buf, "%g", v);
      return say("proud", std::string("That's ") + buf + "!");
    }
  }
  return chat(t, clk, n);
}

}  // namespace brain
