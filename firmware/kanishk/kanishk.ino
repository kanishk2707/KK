// Kanishk's chip: plug it into the computer by USB and Kanishk pops up in the corner of the screen.
//
// The desktop app (desktop/) is Kanishk himself: Spidey's companion, renamed and in love with Varuna.
// It watches the USB ports; when it finds this chip (it answers "hello" with its name) it shows him,
// and when the chip is unplugged he leaves. When the PC is online, Groq is his brain. When it is
// offline, this chip is: it understands her requests (turning them into the same tool calls the PC
// normally gets from Groq), chats in his loving voice, and writes bedtime stories with a tiny Llama
// model (llama2.c stories260K) that runs right here on the ESP32.
//
// Serial protocol, 115200 baud: the PC sends one JSON object per line; the chip answers each with one
// line "@K{...json...}". Lines that don't start with '{' are a human test console.
#include <ArduinoJson.h>
#include "esp_system.h"
#include "brain.h"
#include "llm.h"
#include "model_data.h"

static const char* NAME = "Kanishk";
static const int FW_VERSION = 3;
static brain::Clock clk;
static int64_t timeBase = 0;           // unix time at boot, learned from the PC

static int64_t nowUnix() { return timeBase ? timeBase + (int64_t)(millis() / 1000) : 0; }
static void syncTime(int64_t pcNow, int tz) {
  if (pcNow > 1600000000) timeBase = pcNow - (int64_t)(millis() / 1000);
  if (tz >= -720 && tz <= 840) clk.tzMinutes = tz;
}
static brain::Clock nowClock() { clk.now = nowUnix(); return clk; }

// ---------------------------------------------------------------- bedtime stories (tiny model, on core 0)
static volatile bool storyRunning = false;
static String storyBuf, storyPrompt;
static int storyTokens = 0;
static float storyTps = 0;
static SemaphoreHandle_t storyLock;
static TaskHandle_t storyTaskH;

static bool onPiece(const char* piece, void*) {
  xSemaphoreTake(storyLock, portMAX_DELAY);
  storyBuf += piece;
  xSemaphoreGive(storyLock);
  vTaskDelay(1);                        // let the idle task (watchdog) run
  return storyRunning;
}
static void storyTask(void*) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    int tokens = constrain(((int)ESP.getFreeHeap() - 60000) / 720, 48, 256);
    uint32_t t0 = millis();
    int n = llm::generate(storyPrompt.c_str(), tokens, 0.8f, 0.9f, esp_random(), onPiece, nullptr);
    storyTokens = n;
    storyTps = n > 0 ? n * 1000.0f / (millis() - t0 + 1) : 0;
    if (n < 0) { xSemaphoreTake(storyLock, portMAX_DELAY); storyBuf = "Once upon a time... oh no, my tiny brain ran out of room. Ask me again in a moment?"; xSemaphoreGive(storyLock); }
    storyRunning = false;
  }
}
static String storyOpening(String about) {
  about.replace("\"", ""); about.trim();
  if (about.length() > 40) about = about.substring(0, 40);
  for (size_t i = 0; i < about.length(); i++) if (!isalpha((unsigned char)about[i]) && about[i] != ' ') about[i] = ' ';
  about.trim();
  if (about.length()) {
    String a = about; a.toLowerCase();
    if (!a.startsWith("a ") && !a.startsWith("an ") && !a.startsWith("the ")) a = (strchr("aeiou", a[0]) ? "an " : "a ") + a;
    return "Once upon a time, Lily and Tim found " + a + ".";
  }
  const char* openers[] = { "Once upon a time, there was a girl named Lily and a boy named Tim. They", "One day, Lily and Tim went to the park.",
                            "Once upon a time, Tim had a big surprise for Lily.", "Lily and Tim were best friends. One sunny day," };
  return openers[esp_random() % 4];
}
static bool startStory(const String& about) {
  if (storyRunning) return false;
  storyPrompt = storyOpening(about);
  xSemaphoreTake(storyLock, portMAX_DELAY); storyBuf = ""; xSemaphoreGive(storyLock);
  storyTokens = 0; storyRunning = true;
  xTaskNotifyGive(storyTaskH);
  return true;
}

// ---------------------------------------------------------------- protocol
static void reply(JsonDocument& d) {
  Serial.print("@K");
  serializeJson(d, Serial);
  Serial.print('\n');
}

static void handleCommand(JsonDocument& in) {
  String cmd = in["cmd"] | "";
  JsonDocument out;

  if (cmd == "hello") {
    syncTime(in["now"] | 0LL, in["tz"] | clk.tzMinutes);
    out["name"] = NAME; out["fw"] = FW_VERSION;
    auto i = llm::info();
    out["model"] = String("stories260K (") + i.layers + " layers, dim " + i.dim + ")";

  } else if (cmd == "think") {                     // offline brain: reply + optional tool call for the PC
    syncTime(in["now"] | 0LL, in["tz"] | clk.tzMinutes);
    String text = in["text"] | "";
    text.trim(); if (text.length() > 400) text = text.substring(0, 400);
    String name = in["name"] | "Varuna";
    brain::Reply r = brain::think(text.c_str(), nowClock(), name.c_str());
    out["mood"] = r.mood.c_str(); out["say"] = r.say.c_str();
    if (!r.show.empty()) out["show"] = r.show.c_str();
    if (!r.title.empty()) out["title"] = r.title.c_str();
    if (!r.tool.empty()) {
      out["tool"] = r.tool.c_str();
      JsonDocument args;
      if (deserializeJson(args, r.args) == DeserializationError::Ok) out["args"] = args;
      out["showResult"] = r.showResult;
    }
    if (r.story) out["story"] = r.storyAbout.length() ? r.storyAbout.c_str() : "";

  } else if (cmd == "story") {                     // {"cmd":"story","start":true,"about":"..."} then polls {"cmd":"story"}
    if (in["start"].as<bool>()) out["started"] = startStory(in["about"] | "");
    xSemaphoreTake(storyLock, portMAX_DELAY); out["text"] = storyBuf; xSemaphoreGive(storyLock);
    out["done"] = !storyRunning; out["tokens"] = storyTokens; out["tps"] = round(storyTps * 10) / 10;

  } else if (cmd == "status") {
    out["name"] = NAME; out["fw"] = FW_VERSION;
    out["heap"] = ESP.getFreeHeap(); out["minHeap"] = ESP.getMinFreeHeap(); out["uptime"] = millis() / 1000;

  } else {
    out["error"] = "unknown cmd";
  }
  if (!in["id"].isNull()) out["id"] = in["id"];
  reply(out);
}

// ---------------------------------------------------------------- human test console
static void console(const String& line) {
  if (line == "status") {
    Serial.printf("%s fw %d | heap %u (min %u) | time %lld\n", NAME, FW_VERSION, (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMinFreeHeap(), (long long)nowUnix());
  } else if (line.startsWith("time ")) {
    syncTime(atoll(line.substring(5).c_str()), clk.tzMinutes);
    Serial.printf("time: %s %s\n", brain::dateText(nowClock()).c_str(), brain::clockText(nowClock()).c_str());
  } else if (line.startsWith("think ")) {
    brain::Reply r = brain::think(line.substring(6).c_str(), nowClock());
    Serial.printf("[%s] %s | tool=%s %s\n", r.mood.c_str(), r.say.c_str(), r.tool.c_str(), r.args.c_str());
  } else if (line.startsWith("story")) {
    startStory(line.substring(5));
    while (storyRunning) delay(50);
    Serial.printf("[story %d tokens, %.1f/s] %s\n", storyTokens, storyTps, storyBuf.c_str());
  } else {
    Serial.println("commands: status | think <text> | story [about] | time <unix>");
  }
}

static void readSerial() {
  static String line;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch != '\n') { if (line.length() < 1500) line += ch; continue; }
    line.trim();
    if (line.length()) {
      if (line[0] == '{') {
        JsonDocument in;
        if (deserializeJson(in, line) == DeserializationError::Ok) handleCommand(in);
        else { JsonDocument e; e["error"] = "bad json"; reply(e); }
      } else console(line);
    }
    line = "";
  }
}

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n[kanishk] waking up");
  brain::seed(esp_random());
  bool ok = llm::init(MODEL_BIN, sizeof(MODEL_BIN), TOKENIZER_BIN, sizeof(TOKENIZER_BIN), 256);
  storyLock = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(storyTask, "story", 10240, nullptr, 1, &storyTaskH, 0);
  Serial.printf("[kanishk] ready (story model %s) | free heap %u\n", ok ? "ok" : "FAILED", (unsigned)ESP.getFreeHeap());
  Serial.println("@Kready");
}

void loop() {
  readSerial();
  delay(2);
}
