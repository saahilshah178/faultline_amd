// TEST ONLY. A deterministic stand-in for an embedding model: hashed bag of words,
// L2-normalised. The mock server uses it for queries and tests/e2e/prepare.mjs uses it
// for the fixture KB embeddings, so retrieval in the live-mode test is stable.

export const MOCK_DIM = 32;
export const MOCK_EMBED_MODEL = "mock-embedding";

function hash(word) {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function embedText(text, dim = MOCK_DIM) {
  const v = new Float32Array(dim);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (word.length < 3) continue;
    const h = hash(word);
    v[h % dim] += h & 0x10000 ? 1 : -1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) {
    v[0] = 1;
    return v;
  }
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}
