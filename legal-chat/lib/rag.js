// BM25 retrieval over the corpus built by scripts/build_corpus.py.
// No embeddings or external vector DB needed: a 60-70 page PDF is a few
// hundred chunks, which BM25 ranks in microseconds.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STOPWORDS = new Set(
  `a an the and or but if of in on at to for from by with as is are was were be been
   being this that these those it its i you he she they we do does did not no nor
   than then there here what which who whom whose when where why how all any both
   each few more most other some such only own same so too very can will just
   should now also shall may must under upon any every`
    .split(/\s+/)
    .filter(Boolean)
);

let memo = null;

// The corpus is bundled with the function by vercel.json (includeFiles), so try
// the module-relative path first, then the working directory, then the repo root.
const CANDIDATES = [
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'corpus.json'),
  path.resolve(process.cwd(), 'data', 'corpus.json'),
  path.resolve(process.cwd(), 'legal-chat', 'data', 'corpus.json'),
];

export function corpusPath() {
  if (process.env.CORPUS_FILE) return process.env.CORPUS_FILE;
  return CANDIDATES.find((candidate) => fs.existsSync(candidate)) || CANDIDATES[0];
}

export function getIndex() {
  if (memo) return memo;
  const raw = fs.readFileSync(corpusPath(), 'utf8');
  memo = buildIndex(JSON.parse(raw));
  return memo;
}

export function corpusMeta() {
  const { corpus } = getIndex();
  return {
    title: corpus.title || 'Legal corpus',
    chunks: corpus.chunks ? corpus.chunks.length : 0,
    sources: (corpus.sources || []).map((s) => ({ title: s.title, type: s.type, url: s.url })),
  };
}

export function tokenize(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+(?:[-'][a-z0-9]+)*/g) || [];
  const out = [];
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.push(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

function buildIndex(corpus) {
  const chunks = (corpus.chunks || []).filter((c) => c && typeof c.text === 'string' && c.text.trim());
  const docs = [];
  const df = new Map();
  let totalLen = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(`${chunk.heading || ''} ${chunk.text}`);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ tf, len: tokens.length });
    totalLen += tokens.length;
  }

  return {
    corpus,
    chunks,
    docs,
    df,
    N: chunks.length,
    avgLen: docs.length ? totalLen / docs.length : 1,
  };
}

/**
 * Rank chunks against a question and return the passages that fit a character
 * budget (keeps us inside Groq's free-tier tokens-per-minute allowance).
 */
export function search(query, { limit = 6, maxChars = 8000, perChunk = 1500 } = {}) {
  const idx = getIndex();
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !idx.N) return { passages: [], terms };

  const k1 = 1.5;
  const b = 0.75;
  const scored = [];

  for (let i = 0; i < idx.N; i++) {
    const doc = idx.docs[i];
    let score = 0;
    let covered = 0;
    for (const term of terms) {
      const df = idx.df.get(term);
      const tf = doc.tf.get(term);
      if (!df || !tf) continue;
      covered++;
      const idf = Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
      score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + b * (doc.len / idx.avgLen)));
    }
    if (score > 0) {
      // Reward chunks that cover more distinct question terms.
      score *= 0.7 + 0.3 * (covered / terms.length);
      scored.push({ i, score });
    }
  }

  scored.sort((x, y) => y.score - x.score);

  const passages = [];
  let chars = 0;
  for (const { i, score } of scored) {
    if (passages.length >= limit) break;
    const chunk = idx.chunks[i];
    let text = chunk.text.trim();
    if (text.length > perChunk) text = `${text.slice(0, perChunk).trimEnd()}…`;
    if (chars + text.length > maxChars && passages.length >= 2) break;
    chars += text.length;
    passages.push({
      n: passages.length + 1,
      text,
      source: chunk.source || 'Corpus',
      page: chunk.page ?? null,
      heading: chunk.heading || '',
      url: chunk.url || '',
      score: Math.round(score * 100) / 100,
    });
  }

  return { passages, terms };
}
