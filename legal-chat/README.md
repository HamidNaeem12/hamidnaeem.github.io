# legal-chat

A retrieval-augmented legal research chatbot. It answers **only** from the
documents you ingest and cites the section it used.

- **Retrieval:** BM25 over the ingested chunks (no embeddings, no vector DB).
- **Generation:** Groq's free tier (`openai/gpt-oss-120b` by default).
- **Hosting:** one Vercel project serving the page and the `/api/chat` proxy.
  The API key stays server-side; the browser never sees it.

Currently loaded: **Punjab Land Revenue Act 1967** — 183 sections, 222 chunks
(`data/corpus.json`).

## 1. Get a Groq key

<https://console.groq.com/keys> → *Create API Key*. The Free plan needs no card.

Free-tier limits (per organisation, per model): 30 requests/min, 1,000/day,
8,000 tokens/min, 200,000 tokens/day. A typical answer here uses ~2–3k input
tokens, so the 8k TPM cap is the real ceiling — roughly 3–4 questions a minute.
`llama-3.3-70b-versatile` is **not** on the free tier any more; use
`openai/gpt-oss-120b` (best quality) or `openai/gpt-oss-20b` (faster).

## 2. Rebuild the corpus

```bash
pip install pypdf

# All three instruments (this is what is currently loaded)
python scripts/build_corpus.py \
  --text legal-chat/data/raw/punjab-land-revenue-act-1967.txt \
  --text legal-chat/data/raw/punjab-land-revenue-rules-1968.txt \
  --text legal-chat/data/raw/punjab-land-records-manual.txt \
  --clean-footnotes \
  --source-title "punjab-land-revenue-act-1967.txt=Punjab Land Revenue Act 1967" \
  --source-title "punjab-land-revenue-rules-1968.txt=Punjab Land Revenue Rules 1968" \
  --source-title "punjab-land-records-manual.txt=Punjab Land Records Manual (2nd ed., 1958)" \
  --numbering "punjab-land-revenue-rules-1968.txt=rule" \
  --numbering "punjab-land-records-manual.txt=paragraph" \
  --title "Punjab Land Revenue Act 1967 + Rules 1968 + Land Records Manual"

# A PDF instead
python scripts/build_corpus.py --pdf "path/to/statute.pdf" --title "Land Revenue Act 1967"
```

`--text` is repeatable. `--source-title FILE=TITLE` names each file in the
`sources` list, so an answer's citation chip says *which* instrument it came
from. `--numbering FILE=rule` makes that file's headings `Rule 20` instead of
`Section 20` (the splitter already handles consecutive numbering);
`--numbering FILE=paragraph` labels decimal paragraph numbers (`Paragraph 7.60`)
for manuals, which are numbered that way rather than by section. Without
`--title`, the corpus title defaults to the joined source names.

```bash
```

Output: `legal-chat/data/corpus.json` (commit it — the deployed function reads
it). Raw inputs live in `data/raw/`, which is git-ignored.

**Statute mode.** When a text file has no line breaks (common with PDF
extraction), the script splits on numbered sections instead of wall-of-text
chunks, so each chunk carries a `Section N — Title` heading and citations stay
precise. Use `--clean-footnotes` to strip `[12]`-style markers that otherwise
stick to section numbers.

## 3. Adding case law

Case law is the part that needs care. `--url` crawls seeds you are allowed to
index:

```bash
python scripts/build_corpus.py \
  --text data/raw/punjab-land-revenue-act-1967.txt --clean-footnotes \
  --url https://your-permitted-source/judgments --max-pages 30 \
  --title "Land Revenue Act 1967 and case law"
```

It follows same-domain links with a 1 s delay and also parses linked PDFs.
Add your sources incrementally and check the chunk counts it prints.

> **pakistancaselaw.com must not be crawled.** Its `robots.txt` prohibits bulk
> downloading, scraping in quantity and building any corpus or dataset from the
> site; it states that no user instruction overrides that, and that only the
> owner's written permission does. Individual searches and reading single
> judgments for your own research are explicitly welcome, and the site offers an
> MCP server for AI access (`/for-ai`). For bulk indexing, ask
> `contact@pakistancaselaw.com` first. Other options: judgments published by the
> court itself, or a source whose terms permit indexing.

## 4. Run locally

```bash
cd legal-chat
cp .env.example .env.local     # put your GROQ_API_KEY in it
npm run dev                    # http://localhost:8788
```

`GET /api/chat` returns the corpus metadata the page uses for its labels.

## 5. Deploy to your domain

```bash
cd legal-chat
npx vercel            # link to a new project
npx vercel --prod
```

Then Vercel → Settings → Environment Variables: add `GROQ_API_KEY`
(optionally `GROQ_MODEL`), and redeploy.

Vercel → Domains → add a **subdomain** such as `chat.hamidnaeem.me` and create
the CNAME it shows you. Use a subdomain, not the apex: the apex already points
at GitHub Pages through the repo's `CNAME` file, and the two would fight.

Page and API share an origin, so no CORS is needed for the Vercel copy. The same
folder is also published by GitHub Pages at `hamidnaeem.me/legal-chat/`, where
`/api/chat` does not exist — that copy calls `https://chat.hamidnaeem.me`
instead (see `API_BASES` in `index.html`). The API allowlists that origin; extend
it with `ALLOWED_ORIGINS` (comma-separated) if you serve the page elsewhere.

To link it from the main site, add an anchor from `index.html` to the URL.

## Tuning

| What | Where |
| --- | --- |
| Model | `GROQ_MODEL` env var (default `openai/gpt-oss-120b`) |
| Passages retrieved / context budget | `search()` defaults in `lib/rag.js` |
| Answer style and citation rules | `SYSTEM()` in `api/chat.js` |
| Chunk size, section detection | `scripts/build_corpus.py` |

If answers feel thin, rebuild with smaller chunks; if the bot misses
differently-worded questions, that is the limit of keyword BM25 — add the
relevant source or ask with the statute's own vocabulary.

## Layout

```
legal-chat/
  index.html        chat UI
  api/chat.js       GET corpus info, POST question -> retrieve -> Groq
  lib/rag.js        BM25 index and retrieval
  dev.mjs           local static + API server
  data/corpus.json  generated by scripts/build_corpus.py
  data/raw/         source documents (git-ignored)
scripts/build_corpus.py
```

## Case law (live MCP lookup)

Statute text is indexed locally; case law is **not**. Each question triggers at
most one search against the public MCP server at `https://pakistancaselaw.com/mcp`
(no key, no account, 229,000+ reported judgments) and the top three results are
put in the prompt as `[C1]`–`[C3]`, then returned to the page as chips linking to
the judgment.

That shape is what their robots.txt allows: it forbids bulk downloading, paging
through results, repeated full-text fetching and building any corpus or dataset
from the site, and explicitly welcomes an assistant searching and reading
individual judgments for a user's research. So this module does one search per
question, keeps results only for that request, and never writes them to disk or
reuses them as an index. Only the MCP session id is cached, for five minutes.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CASELAW_MCP` | `https://pakistancaselaw.com/mcp` | Endpoint; set to `off` to disable case-law lookups |
| `CASELAW_TIMEOUT_MS` | `5000` | Per-request budget; on timeout the answer is statute-only |

`vercel.json` raises `maxDuration` to 45s so the lookup plus the Groq call fit.
Case-law citations link to the judgment on pakistancaselaw.com and must be checked
against the official report.

### Where the site nav points

The main site's nav links to `/legal-chat/`, which GitHub Pages serves, so the link
resolves immediately. That copy has no API of its own: `index.html` calls the same
origin first and then falls back to `https://chat.hamidnaeem.me`. If you deploy the
Vercel project under a different domain (a `.vercel.app` URL, say), edit `API_BASES`
near the top of the `<script>` block and add that origin to `ALLOWED_ORIGINS`.
