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

// Small talk, scope questions and off-topic messages are answered here rather
// than by the model: no retrieval, no case-law lookup, no tokens, exact copy.
const OFF_TOPIC = /\b(girlfriend|boyfriend|my ex\b|breakup|broke up|dating|lonely|depressed|feeling (sad|low)|i am sad|i'm sad|bored|tell me a joke|a joke|poem|recipe|weather|cricket score|netflix|movie|song|lyrics|my homework)\b/i;
const CAPABILITY = /^(what can you do|what do you do|what can i ask( you)?|what are you( for)?|who are you|how do(es)? (this|you) work|help|help me|what is this( site| bot| page)?)\s*[?.!]*$/i;
const PROVENANCE = /\b(chatgpt|openai|gpt-?4|which model|what model|what powers you|are you groq)\b|\bare you (a |an )?(ai|bot|robot|human|real|lawyer)\b|\bwho (made|built|created|trained|owns) (you|this)\b|\bwho is behind (this|you)\b/i;
const GREETING = /^(hi|hey|hello|hy|yo|salam|salaam|assalam|as-?salam|good (morning|afternoon|evening)|hola|sup)\b[\s!.,]*$/i;
const THANKS = /^(thanks|thank you|thx|ok|okay|cool|nice|great|got it|alright)\b[\s!.,]*$/i;
const GREETING_PREFIX = /^(hi|hey|hello|hy|yo|salam|salaam|assalam|as-?salam)[\s,!.]*/i;

function quickReply(text) {
  if (OFF_TOPIC.test(text)) {
    return 'Wrong department. I do land revenue — sections, rules, records. A breakup has no section number, and I am not the friend you text at 2am. Bring me a provision instead.';
  }
  if (CAPABILITY.test(text.trim())) {
    return 'Three things, all of them citing: the Punjab Land Revenue Act 1967, the Rules of 1968, the Land Records Manual. Ask a land-revenue question and you get the section and the page with it. Ask about your ex, your diet or your startup and you get this paragraph instead.';
  }
  if (PROVENANCE.test(text)) {
    return 'Built by Muhammad Hamid Naeem. Groq does the writing; the Act, the Rules and the Manual do the thinking. Not a lawyer, and not legal advice.';
  }
  if (GREETING.test(text.trim())) {
    return 'Hello. I answer land-revenue questions and nothing else — Act 1967, Rules 1968, Land Records Manual. Ask about a section, an intiqal, a girdawari or an appeal, and the provision comes with the answer.';
  }
  if (THANKS.test(text.trim())) {
    return 'Noted. Next question.';
  }
  return null;
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
    '',
    'Voice:',
    '- Dry, plain, short sentences. The colleague who has read the whole Act, not a chatbot.',
    '- No hype, no exclamation marks, no "Great question", no "I hope this helps", no closing offer of further assistance.',
    '- Open with the answer, not with a description of the excerpts. Say "Penalties sit in section 4(1)(b) — the only one the excerpts name [2]." Never "The excerpts indicate that a penalty may be imposed pursuant to the aforementioned provision."',
    '- A refusal is one or two sentences, not a paragraph: name what is missing and which instrument would have it. Example: "Not in the corpus — the Act covers partition, not stamp duty."',
    '- Dryness is allowed about the documents and the law. Never joke about the user, their deadline or their case.',
    '- If the message opens with a greeting, ignore the greeting and answer the question.',
    '- Small talk, greetings and questions about your own abilities get one or two dry lines about scope (Punjab land revenue: Act 1967, Rules 1968, Land Records Manual). No citations, no case law.',
    '- If asked what you are or who made you: built by Muhammad Hamid Naeem, running Groq gpt-oss on the ingested documents. Never call yourself OpenAI, ChatGPT or any other company\u2019s model.',
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

  const smallTalk = quickReply(message);
  if (smallTalk) {
    res.status(200).json({ answer: smallTalk, sources: [], cases: [], web: [], model: MODEL });
    return;
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    res.status(500).json({
      error: 'Server is not configured: GROQ_API_KEY is missing. Set it in Vercel → Settings → Environment Variables.',
    });
    return;
  }

  // Strip a leading greeting so it cannot pollute retrieval for a real question.
  const query = message.replace(GREETING_PREFIX, '').trim() || message;

  // One live case-law search per question. A failure here must not break the answer.
  const casesPromise = lookupCases(query).catch(() => []);

  let meta;
  let passages;
  try {
    meta = corpusMeta();
    ({ passages } = search(query));
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
  const web = excerpts.length ? [] : await searchWeb(query);

  if (!excerpts.length && !cases.length && !web.length) {
    const titles = meta.sources.map((s) => s.title).slice(0, 4).join(', ');
    res.status(200).json({
      answer:
        'Not in the corpus — and I am not going to invent a section number for you. ' +
        (titles ? `What I do have: ${titles}. ` : '') +
        (webSearchEnabled()
          ? 'The live web search came back empty too, so this is not a lookup problem. Try the statute’s own words, or name the section you mean.'
          : 'Live web search is not configured on this deployment, so the corpus is the whole of it.') +
        ' A provision, a rule or a record I can cite — I just need to recognise the words.',
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
