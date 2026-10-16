// Port of Andrej Karpathy's llama2.c (run.c, MIT licence) for a microcontroller:
// - weights are read in place (on the ESP32 they sit in flash, mapped into the address space)
// - the attention cache is half precision and capped at maxSeq tokens, so it fits in ~100 KB of RAM
// - everything is allocated per story and freed afterwards, leaving RAM to Wi-Fi the rest of the time
#include "llm.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

namespace llm {

struct Config { int dim, hidden, layers, heads, kvHeads, vocab, seqLen; };

static Config C;
static bool ready = false;
static int maxSeq = 128;
// weights (pointers into the model bytes)
static const float *tokEmb, *rmsAtt, *wq, *wk, *wv, *wo, *rmsFfn, *w1, *w2, *w3, *rmsFinal, *wcls;
// tokenizer
static char** vocab = nullptr;
static float* vocabScores = nullptr;
static int maxTokenLen = 0;
struct Sorted { const char* str; int id; };
static Sorted* sortedVocab = nullptr;
static char bytePieces[512];

// ---------- half floats for the attention cache ----------
static inline uint16_t f2h(float f) {
  uint32_t x; memcpy(&x, &f, 4);
  uint32_t sign = (x >> 16) & 0x8000;
  int32_t e = ((x >> 23) & 0xff) - 127 + 15;
  uint32_t m = x & 0x7fffff;
  if (e <= 0) return (uint16_t)sign;                       // tiny -> 0
  if (e >= 31) return (uint16_t)(sign | 0x7bff);           // huge -> max
  uint32_t h = sign | (e << 10) | (m >> 13);
  if (m & 0x1000) h++;                                     // round
  return (uint16_t)h;
}
static inline float h2f(uint16_t h) {
  uint32_t sign = (uint32_t)(h & 0x8000) << 16;
  uint32_t e = (h >> 10) & 0x1f, m = h & 0x3ff;
  uint32_t x = (e == 0) ? sign : sign | ((e - 15 + 127) << 23) | (m << 13);
  float f; memcpy(&f, &x, 4); return f;
}

// ---------- maths ----------
static void rmsnorm(float* o, const float* x, const float* w, int n) {
  float ss = 0;
  for (int j = 0; j < n; j++) ss += x[j] * x[j];
  ss = 1.0f / sqrtf(ss / n + 1e-5f);
  for (int j = 0; j < n; j++) o[j] = w[j] * (ss * x[j]);
}
static void softmax(float* x, int n) {
  float mx = x[0];
  for (int i = 1; i < n; i++) if (x[i] > mx) mx = x[i];
  float sum = 0;
  for (int i = 0; i < n; i++) { x[i] = expf(x[i] - mx); sum += x[i]; }
  for (int i = 0; i < n; i++) x[i] /= sum;
}
static void matmul(float* out, const float* x, const float* w, int n, int d) {
  for (int i = 0; i < d; i++) {
    const float* row = w + (size_t)i * n;
    float v = 0;
    for (int j = 0; j < n; j++) v += row[j] * x[j];
    out[i] = v;
  }
}

// ---------- model ----------
bool init(const uint8_t* model, size_t modelLen, const uint8_t* tok, size_t tokLen, int seqCap) {
  if (modelLen < sizeof(Config)) return false;
  memcpy(&C, model, sizeof(Config));
  bool shared = C.vocab > 0;
  if (C.vocab < 0) C.vocab = -C.vocab;
  maxSeq = seqCap < C.seqLen ? seqCap : C.seqLen;
  const int hs = C.dim / C.heads;
  const float* p = (const float*)(model + sizeof(Config));
  const size_t L = C.layers;
  tokEmb = p;   p += (size_t)C.vocab * C.dim;
  rmsAtt = p;   p += L * C.dim;
  wq = p;       p += L * C.dim * (C.heads * hs);
  wk = p;       p += L * C.dim * (C.kvHeads * hs);
  wv = p;       p += L * C.dim * (C.kvHeads * hs);
  wo = p;       p += L * (C.heads * hs) * C.dim;
  rmsFfn = p;   p += L * C.dim;
  w1 = p;       p += L * C.dim * C.hidden;
  w2 = p;       p += L * C.hidden * C.dim;
  w3 = p;       p += L * C.dim * C.hidden;
  rmsFinal = p; p += C.dim;
  p += (size_t)C.seqLen * hs / 2;   // old RoPE tables, unused
  p += (size_t)C.seqLen * hs / 2;
  wcls = shared ? tokEmb : p;
  if ((const uint8_t*)p > model + modelLen) return false;

  // tokenizer: [int maxTokenLen] then per token [float score][int len][bytes]
  if (!vocab) {
    vocab = (char**)malloc(C.vocab * sizeof(char*));
    vocabScores = (float*)malloc(C.vocab * sizeof(float));
    sortedVocab = (Sorted*)malloc(C.vocab * sizeof(Sorted));
    if (!vocab || !vocabScores || !sortedVocab) return false;
    size_t o = 0;
    memcpy(&maxTokenLen, tok + o, 4); o += 4;
    for (int i = 0; i < C.vocab; i++) {
      if (o + 8 > tokLen) return false;
      int len;
      memcpy(&vocabScores[i], tok + o, 4); o += 4;
      memcpy(&len, tok + o, 4); o += 4;
      vocab[i] = (char*)malloc(len + 1);
      if (!vocab[i] || o + len > tokLen) return false;
      memcpy(vocab[i], tok + o, len); vocab[i][len] = 0; o += len;
      sortedVocab[i] = { vocab[i], i };
    }
    qsort(sortedVocab, C.vocab, sizeof(Sorted), [](const void* a, const void* b) {
      return strcmp(((const Sorted*)a)->str, ((const Sorted*)b)->str);
    });
    for (int i = 0; i < 256; i++) { bytePieces[i * 2] = (char)i; bytePieces[i * 2 + 1] = 0; }
  }
  ready = true;
  return true;
}

Info info() {
  const int kvDim = C.dim * C.kvHeads / C.heads;
  size_t ram = (size_t)(4 * C.dim + 2 * C.hidden + C.heads * maxSeq + C.vocab) * 4
             + (size_t)2 * C.layers * maxSeq * kvDim * 2 + (size_t)C.vocab * 8;
  return { C.dim, C.hidden, C.layers, C.heads, C.kvHeads, C.vocab, maxSeq, ram };
}

static int lookup(const char* s) {
  int lo = 0, hi = C.vocab - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2, c = strcmp(s, sortedVocab[mid].str);
    if (c == 0) return sortedVocab[mid].id;
    if (c < 0) hi = mid - 1; else lo = mid + 1;
  }
  return -1;
}

// BPE encode, same as llama2.c (with BOS and the leading-space dummy prefix)
static int encode(const char* text, int* tokens, int maxTokens) {
  char* buf = (char*)malloc(maxTokenLen * 2 + 3);
  if (!buf) return 0;
  int n = 0;
  tokens[n++] = 1;
  if (text[0]) { int sp = lookup(" "); if (sp >= 0) tokens[n++] = sp; }
  size_t bl = 0;
  for (const char* c = text; *c && n < maxTokens - 4; c++) {
    if ((*c & 0xC0) != 0x80) bl = 0;
    buf[bl++] = *c; buf[bl] = 0;
    if ((*(c + 1) & 0xC0) == 0x80 && bl < 4) continue;
    int id = lookup(buf);
    if (id != -1) tokens[n++] = id;
    else for (size_t i = 0; i < bl; i++) tokens[n++] = (unsigned char)buf[i] + 3;
    bl = 0;
  }
  while (true) {   // merge the best-scoring adjacent pair until none merge
    float best = -1e10f; int bestId = -1, bestIdx = -1;
    for (int i = 0; i < n - 1; i++) {
      snprintf(buf, maxTokenLen * 2 + 3, "%s%s", vocab[tokens[i]], vocab[tokens[i + 1]]);
      int id = lookup(buf);
      if (id != -1 && vocabScores[id] > best) { best = vocabScores[id]; bestId = id; bestIdx = i; }
    }
    if (bestIdx == -1) break;
    tokens[bestIdx] = bestId;
    for (int i = bestIdx + 1; i < n - 1; i++) tokens[i] = tokens[i + 1];
    n--;
  }
  free(buf);
  return n;
}

static const char* decode(int prev, int token) {
  const char* piece = vocab[token];
  if (prev == 1 && piece[0] == ' ') piece++;
  unsigned char b;
  if (sscanf(piece, "<0x%02hhX>", &b) == 1) piece = bytePieces + b * 2;
  return piece;
}

static uint64_t rng;
static uint32_t randU32() { rng ^= rng >> 12; rng ^= rng << 25; rng ^= rng >> 27; return (uint32_t)((rng * 0x2545F4914F6CDD1Dull) >> 32); }
static float randF() { return (randU32() >> 8) / 16777216.0f; }
struct ProbIdx { float p; int i; };

static int sample(float* logits, float temp, float topp, ProbIdx* pi) {
  const int n = C.vocab;
  if (temp <= 0) { int b = 0; for (int i = 1; i < n; i++) if (logits[i] > logits[b]) b = i; return b; }
  for (int i = 0; i < n; i++) logits[i] /= temp;
  softmax(logits, n);
  float coin = randF();
  if (topp <= 0 || topp >= 1) {
    float cdf = 0;
    for (int i = 0; i < n; i++) { cdf += logits[i]; if (coin < cdf) return i; }
    return n - 1;
  }
  int k = 0;
  const float cutoff = (1.0f - topp) / (n - 1);
  for (int i = 0; i < n; i++) if (logits[i] >= cutoff) pi[k++] = { logits[i], i };
  qsort(pi, k, sizeof(ProbIdx), [](const void* a, const void* b) {
    float d = ((const ProbIdx*)b)->p - ((const ProbIdx*)a)->p; return d > 0 ? 1 : d < 0 ? -1 : 0;
  });
  float cum = 0; int last = k - 1;
  for (int i = 0; i < k; i++) { cum += pi[i].p; if (cum > topp) { last = i; break; } }
  float r = coin * cum, cdf = 0;
  for (int i = 0; i <= last; i++) { cdf += pi[i].p; if (r < cdf) return pi[i].i; }
  return pi[last].i;
}

int generate(const char* prompt, int maxTokens, float temperature, float topp, uint32_t seed, PieceFn fn, void* user) {
  if (!ready) return -1;
  const int dim = C.dim, hidden = C.hidden, hs = dim / C.heads;
  const int kvDim = dim * C.kvHeads / C.heads, kvMul = C.heads / C.kvHeads;
  if (maxTokens > maxSeq) maxTokens = maxSeq;
  if (maxTokens < 8) maxTokens = 8;
  const int S = maxTokens;   // buffers are sized for this story only
  rng = seed ? seed : 0x9E3779B9u;

  // working memory, freed at the end
  float* x = (float*)malloc(dim * 4);   float* xb = (float*)malloc(dim * 4);
  float* xb2 = (float*)malloc(dim * 4); float* q = (float*)malloc(dim * 4);
  float* hb = (float*)malloc(hidden * 4); float* hb2 = (float*)malloc(hidden * 4);
  float* att = (float*)malloc((size_t)C.heads * S * 4);
  float* logits = (float*)malloc(C.vocab * 4);
  ProbIdx* pi = (ProbIdx*)malloc(C.vocab * sizeof(ProbIdx));
  int* ptoks = (int*)malloc(S * sizeof(int));
  uint16_t** kc = (uint16_t**)calloc(C.layers, sizeof(void*));
  uint16_t** vc = (uint16_t**)calloc(C.layers, sizeof(void*));
  bool ok = x && xb && xb2 && q && hb && hb2 && att && logits && pi && ptoks && kc && vc;
  for (int l = 0; ok && l < C.layers; l++) {   // one block per layer: no single huge allocation needed
    kc[l] = (uint16_t*)malloc((size_t)S * kvDim * 2);
    vc[l] = (uint16_t*)malloc((size_t)S * kvDim * 2);
    ok = kc[l] && vc[l];
  }
  int produced = -1;
  if (ok) {
    int nPrompt = encode(prompt, ptoks, S);
    int token = ptoks[0], pos = 0;
    produced = 0;
    float kTmp[64];
    while (pos < maxTokens) {
      // ---- forward(token, pos) ----
      memcpy(x, tokEmb + (size_t)token * dim, dim * 4);
      for (int l = 0; l < C.layers; l++) {
        rmsnorm(xb, x, rmsAtt + l * dim, dim);
        float* k = kTmp; float v[64];
        matmul(q, xb, wq + (size_t)l * dim * dim, dim, dim);
        matmul(k, xb, wk + (size_t)l * dim * kvDim, dim, kvDim);
        matmul(v, xb, wv + (size_t)l * dim * kvDim, dim, kvDim);
        for (int i = 0; i < dim; i += 2) {   // RoPE
          float freq = 1.0f / powf(10000.0f, (i % hs) / (float)hs);
          float fcr = cosf(pos * freq), fci = sinf(pos * freq);
          for (int r = 0; r < (i < kvDim ? 2 : 1); r++) {
            float* vec = r == 0 ? q : k;
            float v0 = vec[i], v1 = vec[i + 1];
            vec[i] = v0 * fcr - v1 * fci; vec[i + 1] = v0 * fci + v1 * fcr;
          }
        }
        for (int i = 0; i < kvDim; i++) { kc[l][pos * kvDim + i] = f2h(k[i]); vc[l][pos * kvDim + i] = f2h(v[i]); }
        for (int h = 0; h < C.heads; h++) {
          float* qh = q + h * hs; float* a = att + h * S;
          const int off = (h / kvMul) * hs;
          for (int t = 0; t <= pos; t++) {
            const uint16_t* kt = kc[l] + t * kvDim + off;
            float s = 0;
            for (int i = 0; i < hs; i++) s += qh[i] * h2f(kt[i]);
            a[t] = s / sqrtf((float)hs);
          }
          softmax(a, pos + 1);
          float* o = xb + h * hs;
          memset(o, 0, hs * 4);
          for (int t = 0; t <= pos; t++) {
            const uint16_t* vt = vc[l] + t * kvDim + off;
            for (int i = 0; i < hs; i++) o[i] += a[t] * h2f(vt[i]);
          }
        }
        matmul(xb2, xb, wo + (size_t)l * dim * dim, dim, dim);
        for (int i = 0; i < dim; i++) x[i] += xb2[i];
        rmsnorm(xb, x, rmsFfn + l * dim, dim);
        matmul(hb, xb, w1 + (size_t)l * dim * hidden, dim, hidden);
        matmul(hb2, xb, w3 + (size_t)l * dim * hidden, dim, hidden);
        for (int i = 0; i < hidden; i++) { float s = hb[i]; s *= 1.0f / (1.0f + expf(-s)); hb[i] = s * hb2[i]; }
        matmul(xb, hb, w2 + (size_t)l * dim * hidden, hidden, dim);
        for (int i = 0; i < dim; i++) x[i] += xb[i];
      }
      rmsnorm(x, x, rmsFinal, dim);
      matmul(logits, x, wcls, dim, C.vocab);
      // ---- next token ----
      int next = pos < nPrompt - 1 ? ptoks[pos + 1] : sample(logits, temperature, topp, pi);
      pos++;
      if (next == 1) break;                    // BOS = the story is over
      const char* piece = decode(token, next);
      produced++;
      if (fn && !fn(piece, user)) break;
      token = next;
    }
  }
  for (int l = 0; l < C.layers; l++) { if (kc) free(kc[l]); if (vc) free(vc[l]); }
  free(kc); free(vc); free(x); free(xb); free(xb2); free(q); free(hb); free(hb2); free(att); free(logits); free(pi); free(ptoks);
  return produced;
}

}  // namespace llm
