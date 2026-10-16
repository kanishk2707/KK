// Native (PC) test of the on-chip story model: loads the same files the ESP32 embeds and prints a story.
// build: g++ -O2 -I../firmware/kanishk llm_test.cpp ../firmware/kanishk/llm.cpp -o llm_test
// usage: llm_test <model.bin> <tok.bin> "<prompt>" [temperature] [seed] [steps]
#include "llm.h"
#include <cstdio>
#include <cstdlib>
#include <vector>
#include <chrono>

static std::vector<uint8_t> slurp(const char* p) {
  FILE* f = fopen(p, "rb"); std::vector<uint8_t> b;
  if (!f) { perror(p); exit(1); }
  fseek(f, 0, SEEK_END); b.resize(ftell(f)); fseek(f, 0, SEEK_SET);
  if (fread(b.data(), 1, b.size(), f) != b.size()) exit(1);
  fclose(f); return b;
}

int main(int argc, char** argv) {
  if (argc < 4) { fprintf(stderr, "usage: llm_test model tok prompt [temp] [seed] [steps]\n"); return 1; }
  auto m = slurp(argv[1]), t = slurp(argv[2]);
  float temp = argc > 4 ? atof(argv[4]) : 0.0f;
  unsigned seed = argc > 5 ? strtoul(argv[5], 0, 10) : 42;
  int steps = argc > 6 ? atoi(argv[6]) : 128;
  if (!llm::init(m.data(), m.size(), t.data(), t.size(), 128)) { fprintf(stderr, "init failed\n"); return 1; }
  auto i = llm::info();
  fprintf(stderr, "dim=%d layers=%d vocab=%d seq=%d ram=%u bytes\n", i.dim, i.layers, i.vocab, i.seqLen, (unsigned)i.ramBytes);
  auto t0 = std::chrono::steady_clock::now();
  int n = llm::generate(argv[3], steps, temp, 0.9f, seed, [](const char* p, void*) { fputs(p, stdout); return true; }, nullptr);
  double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  fprintf(stderr, "\n[%d tokens, %.0f tok/s]\n", n, n / s);
  return 0;
}
