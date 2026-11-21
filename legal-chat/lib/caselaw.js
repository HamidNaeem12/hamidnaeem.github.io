// Live case-law lookup through pakistancaselaw.com's public MCP server.
//
// Compliance: their robots.txt forbids bulk downloading, paging through results,
// repeated full-text fetching and building any corpus, mirror or dataset from the
// site, while searching and reading individual judgments for a user's research is
// explicitly welcome. So this module does exactly one search per user question,
// keeps the few summary results only for that request, and never writes them to
// disk or reuses them as an index. Only the MCP session id is held in memory.
//
// Set CASELAW_MCP=off to disable case-law lookups entirely.

const MCP_URL = process.env.CASELAW_MCP || 'https://pakistancaselaw.com/mcp';
const TIMEOUT_MS = Number(process.env.CASELAW_TIMEOUT_MS || 5000);
const SESSION_TTL_MS = 5 * 60 * 1000;

let session = { id: null, at: 0 };
let opening = null;

function rpcEnvelope(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to SSE framing */
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      return JSON.parse(payload);
    } catch {
      /* ignore malformed frame */
    }
  }
  return null;
}

function headers(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extra,
  };
}

// Initialize once per warm instance and reuse the session id for a few minutes.
async function openSession() {
  if (session.id && Date.now() - session.at < SESSION_TTL_MS) return session.id;
  if (opening) return opening;

  opening = (async () => {
    const res = await fetch(MCP_URL, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'hamidnaeem-legal-bot', version: '1.0' },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const id = res.headers.get('mcp-session-id');
    await res.text();
    if (!res.ok || !id) throw new Error(`MCP initialize failed (${res.status})`);

    await fetch(MCP_URL, {
      method: 'POST',
      headers: headers({ 'mcp-session-id': id }),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((r) => r.text())
      .catch(() => {});

    session = { id, at: Date.now() };
    return id;
  })().finally(() => {
    opening = null;
  });

  return opening;
}

async function callTool(name, args) {
  const id = await openSession();
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: headers({ 'mcp-session-id': id }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 400 || res.status === 404 || res.status === 410) {
    session = { id: null, at: 0 };
    throw new Error(`MCP session rejected (${res.status})`);
  }
  if (!res.ok) throw new Error(`MCP ${name} failed (${res.status})`);

  const envelope = rpcEnvelope(await res.text());
  if (envelope?.error) throw new Error(envelope.error.message || 'MCP error');
  const content = envelope?.result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

// The tool's own `response_format: 'json'` is preferred; this is the fallback for
// the markdown rendering if the server ignores that option.
function parseMarkdown(text, limit) {
  const cases = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length && cases.length < limit; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith('- **')) continue;
    const body = line.slice(4);
    const close = body.indexOf('**');
    if (close < 1) continue;
    const title = body.slice(0, close).trim();
    const parts = body
      .slice(close + 2)
      .replace(/^\s*[—-]\s*/, '')
      .split(' · ')
      .map((part) => part.trim())
      .filter(Boolean);

    const entry = { title, citation: parts[0] || '', court: '', result: '', url: '', snippet: '' };
    parts.slice(1).forEach((part) => {
      const bold = part.match(/^\*\*(.+)\*\*$/);
      if (bold) entry.result = bold[1].trim();
      else if (/^author:/i.test(part)) return;
      else if (/^\d+\s+judges?$/i.test(part)) return;
      else if (!entry.court) entry.court = part;
    });

    for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
      const next = lines[j].trim();
      const url = next.match(/^https?:\/\/[^\s]*\/case\/(\d+)/);
      if (url && !entry.url) entry.url = `https://pakistancaselaw.com/case/${url[1]}`;
      if (/^Match:/i.test(next) && !entry.snippet) {
        entry.snippet = next.replace(/^Match:\s*/i, '').replace(/^…/, '').replace(/…$/, '').trim();
      }
    }
    cases.push(entry);
  }
  return cases;
}

export function parseCases(text, limit = 3) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{')) return parseMarkdown(trimmed, limit);
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return parseMarkdown(trimmed, limit);
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.slice(0, limit).map((item) => ({
    title: String(item.title || '').trim(),
    citation: String(item.citation || '').trim(),
    court: String(item.court || '').trim(),
    result: String(item.result || '').trim(),
    author: String(item.author || '').trim(),
    url: String(item.url || '').trim(),
    snippet: String(item.snippet || '').replace(/^…/, '').replace(/…$/, '').trim().slice(0, 240),
  }));
}

// One search per question. Returns [] on any failure so the statute answer still forms.
export async function lookupCases(question, options = {}) {
  if (MCP_URL === 'off' || process.env.CASELAW_MCP === 'off') return [];
  const limit = Math.min(Math.max(options.limit || 3, 1), 5);
  try {
    const text = await callTool('caselaw_search', {
      query: String(question).slice(0, 300),
      limit,
      response_format: 'json',
    });
    return parseCases(text, limit);
  } catch {
    return [];
  }
}
