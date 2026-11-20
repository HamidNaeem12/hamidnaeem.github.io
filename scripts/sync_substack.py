#!/usr/bin/env python3
"""Regenerate the newsletter issue cards in newsletter.html from the Substack RSS feed.

Run by .github/workflows/sync-newsletter.yml on a schedule; safe to run locally.
Only the regions between the substack:* markers are rewritten, so anything you
type inside those markers is replaced on the next run. Edit outside them.
"""

from __future__ import annotations

import html
import io
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime
from email.utils import parsedate_to_datetime

FEED = "https://digitalgavel.substack.com/feed"
TARGET = "newsletter.html"
PUBLICATION = "https://digitalgavel.substack.com"

FEATURED = 2        # cards in the wide top row
MAX_CARDS = 10      # cards after the top row
SUMMARY_CHARS = 190


def fetch(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "hamidnaeem.me newsletter sync (+https://hamidnaeem.me)",
            "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", "replace")


def clean(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def shorten(text: str, limit: int = SUMMARY_CHARS) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(" ,.;:—-")
    return cut + "…"


def parse(xml: str) -> list[dict]:
    posts = []
    for raw in re.findall(r"<item>(.*?)</item>", xml, re.S):
        def field(tag: str) -> str:
            m = re.search(
                rf"<{tag}[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?</{tag}>", raw, re.S
            )
            return m.group(1).strip() if m else ""

        title = clean(field("title"))
        link = field("link").strip()
        if not title or not link.startswith("http"):
            continue
        try:
            published = parsedate_to_datetime(field("pubDate"))
        except (TypeError, ValueError):
            published = None
        posts.append(
            {
                "title": title,
                "link": link,
                "summary": shorten(clean(field("description"))),
                "date": published.strftime("%b %Y") if published else "",
                "ts": published.timestamp() if published else 0.0,
            }
        )
    posts.sort(key=lambda p: p["ts"], reverse=True)
    return posts


def esc(text: str) -> str:
    return html.escape(text, quote=True)


def card(post: dict, label: str, featured: bool = False) -> str:
    classes = "issue-card featured reveal-up" if featured else "issue-card reveal-up"
    return f"""        <a href="{esc(post['link'])}" target="_blank" rel="noopener noreferrer" class="{classes}">
          <div class="issue-n">{label}</div>
          <h3>{esc(post['title'])}</h3>
          <p>{esc(post['summary'])}</p>
          <div class="issue-footer">
            <span class="issue-date">{esc(post['date'])}</span>
            <span class="issue-link">Read on Substack <i data-lucide="arrow-up-right" width="11" height="11"></i></span>
          </div>
        </a>"""


def subscribe_card() -> str:
    return f"""        <div class="issue-card issue-subscribe-card reveal-up">
          <p>New issues come out regularly. Subscribe and you won't miss them.</p>
          <a href="{PUBLICATION}" target="_blank" rel="noopener noreferrer" class="btn-solid">
            <i data-lucide="rss" width="13" height="13"></i>
            Subscribe
          </a>
        </div>"""


def build(posts: list[dict]) -> str:
    total = len(posts)
    number_of = lambda index: total - 1 - index  # oldest post is Issue 00

    featured_posts = posts[:FEATURED]
    featured = "\n".join(
        card(post, "Latest issue" if i == 0 else f"Issue {number_of(i):02d}", featured=(i == 0))
        for i, post in enumerate(featured_posts)
    )

    rest = posts[FEATURED:FEATURED + MAX_CARDS]
    grid = "\n".join(
        card(post, f"Issue {number_of(FEATURED + i):02d}")
        for i, post in enumerate(rest)
    )

    return (
        "      <div class=\"issue-featured\">\n"
        f"{featured}\n"
        "      </div>\n\n"
        "      <div class=\"issues-grid\">\n"
        f"{grid}\n"
        f"{subscribe_card()}\n"
        "      </div>\n"
    )


def replace_region(source: str, name: str, body: str) -> str:
    pattern = re.compile(
        rf"(<!-- substack:{name}:start -->).*?(<!-- substack:{name}:end -->)", re.S
    )
    if not pattern.search(source):
        sys.exit(f"error: markers for '{name}' not found in {TARGET}")
    return pattern.sub(lambda m: f"{m.group(1)}\n{body}    {m.group(2)}", source, count=1)


def main() -> int:
    try:
        xml = fetch(FEED)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"error: could not fetch {FEED}: {exc}", file=sys.stderr)
        return 1

    posts = parse(xml)
    if not posts:
        print(f"error: no posts parsed from {FEED}", file=sys.stderr)
        return 1

    source = io.open(TARGET, encoding="utf-8").read()
    updated = replace_region(source, "issues", build(posts))
    updated = replace_region(updated, "count", f"{len(posts)}\n    ")

    if updated == source:
        print(f"up to date: {len(posts)} issues")
        return 0

    io.open(TARGET, "w", encoding="utf-8", newline="\r\n").write(updated)
    print(f"updated: {len(posts)} issues ({posts[0]['title']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
