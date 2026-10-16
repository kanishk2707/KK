// Kanishk's on-chip brain for stories: a tiny Llama-2 model (llama2.c "stories260K", 260K parameters)
// running directly on the ESP32. Weights stay in flash (read in place), only the working buffers live in RAM.
#pragma once
#include <stdint.h>
#include <stddef.h>

namespace llm {

struct Info {
  int dim, hidden, layers, heads, kvHeads, vocab, seqLen;
  size_t ramBytes;   // RAM used while generating
};

// model: llama2.c checkpoint bytes (header + float32 weights). tokenizer: llama2.c tokenizer bytes.
bool init(const uint8_t* model, size_t modelLen, const uint8_t* tokenizer, size_t tokLen, int maxSeq = 128);
Info info();

// Called for every generated piece of text. Return false to stop early.
typedef bool (*PieceFn)(const char* piece, void* user);

// Writes a story that starts with `prompt` (the prompt counts toward maxTokens). Buffers are sized for
// maxTokens and allocated for the duration of the call only: about 700 bytes per token + 6 KB.
// Returns the number of tokens generated, or -1 if there was not enough memory.
int generate(const char* prompt, int maxTokens, float temperature, float topp, uint32_t seed, PieceFn fn, void* user);

}  // namespace llm
