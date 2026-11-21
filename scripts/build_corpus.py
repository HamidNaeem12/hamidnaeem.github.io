#!/usr/bin/env python3
"""Build the retrieval corpus for legal-chat.

Ingests a PDF (e.g. a 60-70 page statute or report) and/or pages from an
open-access case-law site, splits them into overlapping chunks, and writes
legal-chat/data/corpus.json, which the chat endpoint retrieves from.

Examples
--------
  # A single PDF
  python scripts/build_corpus.py --pdf "data/raw/statute.pdf" --title "Land Revenue Act 1967"

  # PDF plus an open case-law site (follows same-domain links, max 40 pages)
  python scripts/build_corpus.py --pdf statute.pdf \
      --url https://example.org/judgments --max-pages 40 \
      --title "Statute and case law"

  # Several sources at once
  python scripts/build_corpus.py --pdf statute.pdf --url https://site/a --url https://site/b

PDF support needs pypdf:  pip install pypdf
"""

from __future__ import annotations

import argparse
import html as htmlmod
import io
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "legal-chat" / "data" / "corpus.json"
USER_AGENT = "legal-chat-corpus-builder/1.0 (+https://hamidnaeem.me)"
TARGET_CHARS = 1100
OVERLAP_CHARS = 200
MIN_CHUNK_CHARS = 120

HEADING_RE = re.compile(
    r"^(chapter|part|title|section|article|rule|regulation|schedule|order|annex|annexure)"
    r"\b\.?\s*[\dIVXLCivxlc\-\.]*\b",
    re.IGNORECASE,
)
PAGE_NOISE_RE = re.compile(r"^\s*(page\s*)?\d{1,4}\s*$", re.IGNORECASE)


# ── text cleaning ────────────────────────────────────────────────────────────


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u00ad", "")
    # De-hyphenate words broken across lines.
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)
    lines = []
    for line in text.split("\n"):
        if PAGE_NOISE_RE.match(line):
            continue
        lines.append(line.rstrip())
    text = "\n".join(lines)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def is_heading(line: str) -> bool:
    stripped = line.strip()
    if not stripped or len(stripped) > 110:
        return False
    words = stripped.split()
    # Statutes often start operative text with "Section 12. ..." — that is body,
    # not a heading, or the section's text gets swallowed by the heading.
    if re.match(r"^(section|article|rule|regulation|clause)\b", stripped, re.I) and len(words) > 5:
        return False
    if HEADING_RE.match(stripped):
        if len(words) <= 6:
            return True
        if len(words) <= 12 and not stripped.rstrip().endswith((".", ";", ",")):
            return True
        return False
    letters = [c for c in stripped if c.isalpha()]
    if letters and len(words) <= 12 and len(stripped) > 3:
        if stripped.rstrip().endswith(".") and len(words) > 4:
            return False
        upper_ratio = sum(c.isupper() for c in letters) / len(letters)
        if upper_ratio > 0.85:
            return True
    return False


def paragraphs(text: str):
    for block in re.split(r"\n\s*\n", text):
        block = " ".join(block.split())
        if block:
            yield block


def lines_to_blocks(text: str, page):
    """PDF text arrives as wrapped lines; pull headings out and regroup the rest."""
    blocks = []
    buffer: list[str] = []

    def flush():
        if buffer:
            blocks.append((page, " ".join(buffer)))
            buffer.clear()

    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        if is_heading(stripped):
            flush()
            blocks.append((page, stripped))
            continue
        buffer.append(stripped)
    flush()
    return blocks


# Section numbers are sometimes glued to a stray "[" or "(" left by footnote markers.
SECTION_BOUNDARY_RE = re.compile(r"(?:^|[\s\[\(])(\d{1,3})\.\s+(?=[A-Z])")
MAX_CHUNK_CHARS = 1800


def statute_sections(text: str):
    """Split a statute whose text has no paragraph breaks into numbered sections.

    Only boundaries with consecutive numbers are accepted, so years and clause
    numbers inside sentences are ignored. If the document opens with a table of
    contents (a second run of 1..N), the second run wins.
    """
    restarts = [m.start() for m in re.finditer(r"(?:^|[\s\[\(])(1)\.\s+(?=[A-Z])", text)]
    start_at = restarts[1] if len(restarts) > 1 else 0

    bounds = []
    expected = 1
    for match in SECTION_BOUNDARY_RE.finditer(text, start_at):
        number = int(match.group(1))
        # Consecutive numbering, tolerating a few repealed/skipped sections.
        if number == expected or (bounds and expected < number <= expected + 5):
            bounds.append((number, match.start(1)))
            expected = number + 1
    if len(bounds) < 10:
        return []

    sections = []
    for index, (number, start) in enumerate(bounds):
        end = bounds[index + 1][1] if index + 1 < len(bounds) else len(text)
        body = text[start:end].strip()
        title = ""
        head = re.match(rf"{number}\.\s+(.{{0,90}}?)(?:\.(?:\s|$)|[—–-])", body)
        if head:
            title = head.group(1).strip().rstrip(".,;")
        sections.append((number, title, body))
    return sections


def sections_to_chunks(sections, source: str, url: str = ""):
    chunks = []
    for number, title, body in sections:
        heading = f"Section {number}" + (f" — {title}" if title else "")
        for piece in split_long(body, MAX_CHUNK_CHARS):
            if len(piece) < 40:
                continue
            chunks.append(
                {"text": piece, "source": source, "page": None, "heading": heading[:140], "url": url}
            )
    return chunks


def split_long(text: str, limit: int = 900):
    """Break an oversized block on sentence boundaries so chunks stay readable."""
    if len(text) <= limit:
        return [text]
    parts, current = [], ""
    for sentence in re.split(r"(?<=[.;:])\s+", text):
        if current and len(current) + len(sentence) + 1 > limit:
            parts.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        parts.append(current)
    return parts


# ── chunking ─────────────────────────────────────────────────────────────────


def pack_chunks(blocks, source: str, url: str = ""):
    """blocks: iterable of (page_or_None, paragraph) -> chunk dicts."""
    chunks = []
    buffer: list[str] = []
    length = 0
    page_start = None
    heading = ""

    def flush():
        nonlocal buffer, length, page_start
        if not buffer:
            return
        text = " ".join(buffer).strip()
        buffer = []
        length = 0
        if len(text) >= MIN_CHUNK_CHARS:
            chunks.append(
                {
                    "text": text,
                    "source": source,
                    "page": page_start,
                    "heading": heading,
                    "url": url,
                }
            )
        page_start = None

    for page, para in blocks:
        if is_heading(para):
            flush()
            heading = para.strip()[:140]
            continue
        for piece in split_long(para):
            if length + len(piece) > TARGET_CHARS and buffer:
                flush()
            if page_start is None:
                page_start = page
            buffer.append(piece)
            length += len(piece) + 1
    flush()

    # Carry a tail of the previous chunk only when it was cut mid-sentence;
    # otherwise the overlap just duplicates a finished passage and blurs the page.
    for i in range(1, len(chunks)):
        previous = chunks[i - 1]["text"].rstrip()
        if previous.endswith((".", ";", ":", "?", "!", '"', "”")):
            continue
        tail = previous[-OVERLAP_CHARS:]
        cut = tail.find(" ")
        if cut != -1:
            tail = tail[cut + 1 :]
        chunks[i]["text"] = f"{tail} {chunks[i]['text']}".strip()
    return chunks


# ── PDF ──────────────────────────────────────────────────────────────────────


def pdf_blocks(path: Path):
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("PDF support needs pypdf. Install it with:  pip install pypdf")

    reader = PdfReader(str(path))
    for number, page in enumerate(reader.pages, start=1):
        text = clean_text(page.extract_text() or "")
        if not text:
            continue
        for block in lines_to_blocks(text, number):
            yield block


def pdf_blocks_from_bytes(data: bytes):
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("PDF support needs pypdf. Install it with:  pip install pypdf")
    reader = PdfReader(io.BytesIO(data))
    for number, page in enumerate(reader.pages, start=1):
        text = clean_text(page.extract_text() or "")
        if not text:
            continue
        for block in lines_to_blocks(text, number):
            yield block


# ── web pages ────────────────────────────────────────────────────────────────


def fetch(url: str, timeout: int = 30):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.geturl(), response.headers.get_content_type()


def html_to_text(raw: str) -> tuple[str, str]:
    title_match = re.search(r"<title[^>]*>(.*?)</title>", raw, re.IGNORECASE | re.DOTALL)
    title = htmlmod.unescape(" ".join(title_match.group(1).split())) if title_match else ""

    body = re.sub(r"(?is)<(script|style|noscript|svg|nav|header|footer|form|aside)\b.*?</\1>", " ", raw)
    body = re.sub(r"(?is)<!--.*?-->", " ", body)
    body = re.sub(r"(?i)<br\s*/?>", "\n", body)
    body = re.sub(r"(?i)</(p|div|li|tr|h[1-6]|section|article|blockquote)>", "\n\n", body)
    body = re.sub(r"(?s)<[^>]+>", " ", body)
    body = htmlmod.unescape(body)
    return title, clean_text(body)


def links_in(raw: str, base: str) -> list[str]:
    found = []
    for href in re.findall(r'(?i)href\s*=\s*["\']([^"\']+)["\']', raw):
        absolute = urllib.parse.urljoin(base, href.split("#")[0])
        if absolute.startswith(("http://", "https://")):
            found.append(absolute)
    return found


def crawl(seeds: list[str], max_pages: int, delay: float = 1.0):
    """Breadth-first crawl restricted to the seed hosts. Yields (url, title, blocks)."""
    queue = list(dict.fromkeys(seeds))
    seen: set[str] = set()
    hosts = {urllib.parse.urlparse(u).netloc for u in seeds}
    visited = 0

    while queue and visited < max_pages:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            raw, final_url, content_type = fetch(url)
        except Exception as exc:  # noqa: BLE001 - report and continue
            print(f"  ! {url}: {exc}", file=sys.stderr)
            continue

        if "pdf" in content_type or final_url.lower().endswith(".pdf"):
            try:
                blocks = list(pdf_blocks_from_bytes(raw))
            except SystemExit:
                raise
            except Exception as exc:  # noqa: BLE001
                print(f"  ! {url}: unreadable PDF ({exc})", file=sys.stderr)
                continue
            title = urllib.parse.unquote(Path(urllib.parse.urlparse(final_url).path).name)
            print(f"  + {url} (PDF, {len(blocks)} paragraphs)")
            visited += 1
            yield final_url, title or url, blocks
            time.sleep(delay)
            continue

        if "html" not in content_type and "text" not in content_type:
            continue

        text_html = raw.decode("utf-8", "replace")
        title, text = html_to_text(text_html)
        if len(text) < 400:
            continue
        blocks = [(None, para) for para in paragraphs(text)]
        print(f"  + {url} ({len(blocks)} paragraphs)")
        visited += 1
        yield final_url, title or url, blocks

        for link in links_in(text_html, final_url):
            parsed = urllib.parse.urlparse(link)
            if parsed.netloc in hosts and link not in seen and len(queue) < max_pages * 4:
                queue.append(link)
        time.sleep(delay)


# ── main ─────────────────────────────────────────────────────────────────────


def main() -> int:
    # Windows consoles default to cp1252 and choke on arrows/ellipses.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:  # noqa: BLE001 - never fail on console setup
                pass

    parser = argparse.ArgumentParser(description="Build legal-chat/data/corpus.json")
    parser.add_argument("--pdf", action="append", default=[], metavar="FILE", help="PDF to ingest (repeatable)")
    parser.add_argument("--text", action="append", default=[], metavar="FILE", help="plain .txt/.md file (repeatable)")
    parser.add_argument("--url", action="append", default=[], metavar="URL", help="page or site to crawl (repeatable)")
    parser.add_argument("--max-pages", type=int, default=40, help="max pages per crawl (default 40)")
    parser.add_argument(
        "--clean-footnotes",
        action="store_true",
        help="strip [12]-style footnote markers from --text input",
    )
    parser.add_argument("--title", default="", help="display title of the corpus")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="output JSON path")
    args = parser.parse_args()

    if not (args.pdf or args.url or args.text):
        parser.error("give at least one --pdf, --text or --url")

    sources = []
    chunks: list[dict] = []

    for raw_path in args.pdf:
        path = Path(raw_path)
        if not path.exists():
            sys.exit(f"Not found: {path}")
        print(f"Reading PDF {path.name} …")
        blocks = list(pdf_blocks(path))
        source_name = path.stem.replace("_", " ").replace("-", " ").strip()
        new = pack_chunks(blocks, source_name)
        print(f"  -> {len(new)} chunks from {len(blocks)} paragraphs")
        chunks.extend(new)
        sources.append({"title": source_name, "type": "pdf", "url": ""})

    for raw_path in args.text:
        path = Path(raw_path)
        if not path.exists():
            sys.exit(f"Not found: {path}")
        raw_text = path.read_text(encoding="utf-8", errors="replace")
        if args.clean_footnotes:
            raw_text = re.sub(r"\[\d{1,3}\]", "", raw_text)
            raw_text = raw_text.replace("[(", "(").replace(")]", ")")
        text = clean_text(raw_text)
        source_name = args.title or path.stem.replace("_", " ").replace("-", " ")

        sections = statute_sections(text) if text.count("\n") < 5 else []
        if sections:
            new = sections_to_chunks(sections, source_name)
            print(f"Reading {path.name} -> {len(new)} chunks from {len(sections)} sections")
        else:
            new = pack_chunks([(None, p) for p in paragraphs(text)], source_name)
            print(f"Reading {path.name} -> {len(new)} chunks")
        chunks.extend(new)
        sources.append({"title": source_name, "type": "text", "url": ""})

    if args.url:
        print(f"Crawling {len(args.url)} seed URL(s), max {args.max_pages} pages …")
        for url, title, blocks in crawl(args.url, args.max_pages):
            new = pack_chunks(blocks, title[:120] or url, url)
            if not new:
                continue
            chunks.extend(new)
            sources.append({"title": title[:120] or url, "type": "web", "url": url})

    # Number chunks and drop exact duplicates.
    unique: list[dict] = []
    seen: set[str] = set()
    for chunk in chunks:
        key = re.sub(r"\W+", "", chunk["text"].lower())[:400]
        if key in seen:
            continue
        seen.add(key)
        chunk["id"] = f"c{len(unique) + 1}"
        unique.append(chunk)

    if not unique:
        sys.exit("No text extracted — check the PDF is text-based (not scanned) or the URLs render server-side HTML.")

    corpus = {
        "title": args.title or (sources[0]["title"] if sources else "Legal corpus"),
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sources": sources,
        "chunk_count": len(unique),
        "chunks": unique,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(corpus, ensure_ascii=False, indent=1), encoding="utf-8")

    size_kb = out.stat().st_size / 1024
    print(f"\nWrote {out} - {len(unique)} chunks, {size_kb:.0f} KB, from {len(sources)} source(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
