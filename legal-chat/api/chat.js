// Serverless endpoint: question -> retrieved passages -> Groq chat completion.
// The API key never reaches the browser.

import { search, corpusMeta, corpusPath } from '../lib/rag.js';
import { lookupCases } from '../lib/caselaw.js';
import { searchWeb, webSearchEnabled } from '../lib/websearch.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const MAX_QUESTION = 600;
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 12;
// Below this BM25 score a passage is noise, so the question counts as outside
// the corpus and the live web search takes over.
const MIN_SCORE = Number(process.env.MIN_SCORE || 2.5);
const hits = new Map();

// Lets the GitHub Pages copy of the page (hamidnaeem.me/legal-chat/) talk to this API.
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  'https://hamidnaeem.me,https://www.hamidnaeem.me,http://localhost:8788'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function tooManyRequests(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  return {};
}

const SYSTEM = (title) =>
  [
    `You are a legal research assistant for "${title}".`,
    'Answer strictly from the numbered EXCERPTS supplied with each question.',
    'A CASE LAW section may also be supplied, looked up live from Pakistan Case Law.',
    'A WEB SOURCES section may also be supplied from a live web search. It is used when the excerpts do not cover the question.',
    '',
    'Rules:',
    '- Cite every substantive point with the excerpt number in square brackets, e.g. [2].',
    '- Quote section, article and case numbers exactly as they appear in the excerpts. Never invent a section number, case name, date or citation.',
    '- If the excerpts do not answer the question, say plainly what is missing and name the closest topic they do cover.',
    '- Do not rely on any knowledge from outside the excerpts.',
    '- Cite a case from the CASE LAW section as [C1], [C2] and so on. Never invent a case name, citation or holding.',
    '- Use a case only if it genuinely bears on the question; if it does not, ignore it silently.',
    '- When you use a case, add one clause on what it decided and its outcome.',
    '- Judgments are not statute: never present a holding as a provision of the Act.',
    '- Some excerpts are from subordinate rules; their heading starts "Rule N". Any point taken from one of those must name the rule in the sentence, written like "(Rule 39) [3]", and must never be called a section of the Act.',
    '- Worked example of the required style: "The Register Girdawari is kept in Form XXIV (Rule 39) [3]."',
    '- Use plain square brackets for citations: [2], [C1], [W1]. Never use 【】 or other bracket styles.',
    '- Cite a web result as [W1], [W2] and so on. Say plainly that the point comes from the open web, not from the Act.',
    '- Name the site you are relying on (for example Punjab Laws or the Board of Revenue). Prefer official sources.',
    '- Never cite a web page for something its snippet does not actually say, and never dress a web claim up as a section of the Act.',
    '- If the web sources and the excerpts disagree, the statute governs and you say so.',
    '- If neither the excerpts nor the web results answer the question, say what is missing instead of guessing.',
    '- Be concise: 120-250 words, short paragraphs or a compact numbered list. Plain text only, no markdown headings or tables.',
    '- You are a research aid, not a lawyer; never present a conclusion as legal advice.',
  ].join('\n');

function contextBlock(passages) {
  return passages
    .map((p) => {
      const where = [p.source, p.page ? `p. ${p.page}` : '', p.heading].filter(Boolean).join(' — ');
      return `[${p.n}] (${where})\n${p.text}`;
    })
    .join('\n\n');
}

function caseBlock(cases) {
  return cases
    .map((c, i) => {
      const where = [c.court, c.result].filter(Boolean).join(' · ');
      const head = `[C${i + 1}] ${c.title}${c.citation ? ` — ${c.citation}` : ''}${where ? ` (${where})` : ''}`;
      return c.snippet ? `${head}\nMatch: ${c.snippet}` : head;
    })
    .join('\n\n');
}

function webBlock(results) {
  return results
    .map((r, i) => {
      const head = `[W${i + 1}] ${r.title}${r.site ? ` (${r.site})` : ''}`;
      return `${head}\n${r.url}${r.snippet ? `\n${r.snippet}` : ''}`;
    })
    .join('\n\n');
}

function trimHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-6)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // GET reports what the bot has been given, so the page can label itself truthfully.
  if (req.method === 'GET') {
    try {
      res.status(200).json(corpusMeta());
    } catch {
      res.status(503).json({ error: 'No corpus built yet.' });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  if (tooManyRequests(clientIp(req))) {
    res.status(429).json({ error: 'Too many questions from this connection. Please wait a minute.' });
    return;
  }

  let body;
  try {
    body = readBody(req);
  } catch {
    res.status(400).json({ error: 'Body must be JSON.' });
    return;
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    res.status(400).json({ error: 'Send a question in the "message" field.' });
    return;
  }
  if (message.length > MAX_QUESTION) {
    res.status(400).json({ error: `Please keep the question under ${MAX_QUESTION} characters.` });
    return;
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    res.status(500).json({
      error: 'Server is not configured: GROQ_API_KEY is missing. Set it in Vercel → Settings → Environment Variables.',
    });
    return;
  }

  // One live case-law search per question. A failure here must not break the answer.
  const casesPromise = lookupCases(message).catch(() => []);

  let meta;
  let passages;
  try {
    meta = corpusMeta();
    ({ passages } = search(message));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      res.status(503).json({ error: 'No corpus built yet. Run: python scripts/build_corpus.py --pdf <file>' });
      return;
    }
    res.status(500).json({ error: 'Could not read the corpus.' });
    return;
  }

  const cases = await casesPromise;

  // Weak or empty retrieval means the question is outside the corpus, so fall
  // back to a live web search instead of shrugging at the user.
  const excerpts = passages.filter((p) => p.score >= MIN_SCORE);
  const web = excerpts.length ? [] : await searchWeb(message);

  if (!excerpts.length && !cases.length && !web.length) {
    const titles = meta.sources.map((s) => s.title).slice(0, 4).join(', ');
    res.status(200).json({
      answer:
        'I could not find that in the documents I have been given, so I will not guess. ' +
        (titles ? `The corpus covers: ${titles}. ` : '') +
        (webSearchEnabled()
          ? 'A live web search also came back empty — try naming the statute, rule or record you mean.'
          : 'Live web search is not configured on this deployment.') +
        ' Try rephrasing with the words used in the statute, or ask about a specific section.',
      sources: [],
      cases: [],
      web: [],
      model: MODEL,
    });
    return;
  }

  const parts = [];
  if (excerpts.length) parts.push(`EXCERPTS:\n\n${contextBlock(excerpts)}`);
  if (web.length) parts.push(`WEB SOURCES (live web search, not the Act):\n\n${webBlock(web)}`);
  if (cases.length) parts.push(`CASE LAW (live lookup):\n\n${caseBlock(cases)}`);
  parts.push(`QUESTION: ${message}`);

  const messages = [
    { role: 'system', content: SYSTEM(meta.title) },
    ...trimHistory(body.history),
    { role: 'user', content: parts.join('\n\n') },
  ];

  const payload = {
    model: MODEL,
    messages,
    temperature: 0.2,
    top_p: 0.9,
    max_completion_tokens: 800,
  };
  if (MODEL.includes('gpt-oss')) payload.reasoning_effort = process.env.GROQ_REASONING || 'medium';

  let upstream;
  try {
    upstream = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    res.status(502).json({ error: `Could not reach Groq (${err.name}). Try again shortly.` });
    return;
  }

  if (!upstream.ok) {
    let detail = '';
    try {
      const data = await upstream.json();
      detail = data?.error?.message || '';
    } catch {
      /* ignore */
    }
    if (upstream.status === 429) {
      res.status(429).json({ error: 'The model is rate-limited right now. Try again in a minute.' });
      return;
    }
    res.status(502).json({
      error: `Groq returned ${upstream.status}${detail ? `: ${detail}` : ''}`,
    });
    return;
  }

  const data = await upstream.json();
  const answer = data?.choices?.[0]?.message?.content?.trim();
  if (!answer) {
    res.status(502).json({ error: 'Groq returned an empty answer.' });
    return;
  }

  res.status(200).json({
    answer,
    model: data.model || MODEL,
    sources: excerpts.map((p) => ({
      n: p.n,
      title: p.source,
      page: p.page,
      heading: p.heading,
      url: p.url,
    })),
    cases: cases.map((c, i) => ({
      n: `C${i + 1}`,
      title: c.title,
      citation: c.citation,
      court: c.court,
      result: c.result,
      url: c.url,
    })),
    web: web.map((r, i) => ({ n: `W${i + 1}`, title: r.title, site: r.site, url: r.url })),
  });
}

export { corpusPath };
