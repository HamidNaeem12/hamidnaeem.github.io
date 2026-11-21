// Live web search fallback for questions the statute corpus does not cover.
// Called only when BM25 retrieval finds nothing relevant. Exa returns titles,
// URLs and page text, which is what the model needs to cite a real URL.
// Enabled by EXA_API_KEY; set WEB_SEARCH=off to disable it explicitly.

const EXA_URL = 'https://api.exa.ai/search';
const TIMEOUT_MS = 8000;
const MAX_RESULTS = 5;

export function webSearchEnabled() {
  return Boolean(process.env.EXA_API_KEY) && process.env.WEB_SEARCH !== 'off';
}

function site(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export async function searchWeb(question) {
  const key = process.env.EXA_API_KEY;
  if (!key || process.env.WEB_SEARCH === 'off') return [];

  // Nudge the search toward the jurisdiction the corpus is written for.
  const query = `${question} Punjab land revenue Pakistan`;

  try {
    const res = await fetch(EXA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({
        query,
        numResults: MAX_RESULTS,
        type: 'auto',
        contents: { text: { maxCharacters: 900 } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];

    const data = await res.json();
    return (data.results || [])
      .filter((r) => r && typeof r.url === 'string' && r.url)
      .slice(0, MAX_RESULTS)
      .map((r) => ({
        title: String(r.title || site(r.url) || r.url).trim(),
        url: r.url,
        site: site(r.url),
        snippet: String(r.text || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 800),
      }));
  } catch {
    return [];
  }
}
