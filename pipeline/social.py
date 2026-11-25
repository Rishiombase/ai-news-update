"""Buzz: what developers are discussing right now, from free and open sources.

Sources (all public, no account or key): Hacker News (Algolia search API), Lobsters, dev.to,
Mastodon hashtag timelines and YouTube channel feeds. X and Reddit are not used: X's API is
paid and Reddit refuses automated clients.

Everything is stored in data/social/ (one line per item, so git diffs stay small) and a trimmed
copy is written to site/data/buzz.json. Items that point at a story or repo we already track are
linked, so those cards can show how much discussion they are getting.
"""
from __future__ import annotations

import json
import logging
import math
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from urllib.parse import urlparse

import feedparser

from . import config
from .classify import _STRONG_AI_RE, is_ai_relevant
from .focus import _PEOPLE_TITLE
from .http import HttpClient
from .textutil import article_id, canonical_url, clean_html, now_utc, parse_iso, summarize, to_utc_iso

log = logging.getLogger(__name__)

DIR = config.DATA_DIR / "social"
ITEMS_FILE = DIR / "items.json"
STATE_FILE = DIR / "state.json"

KEEP_DAYS = 21          # items older than this are dropped
FETCH_DAYS = 14         # how far back each run looks (so week-over-week trends work from day one)
SITE_ITEMS = 400        # items shipped to the website

PLATFORMS = {
    "hn": {"name": "Hacker News", "color": "#FF6600", "home": "https://news.ycombinator.com/"},
    "lobsters": {"name": "Lobsters", "color": "#AC130D", "home": "https://lobste.rs/t/ai"},
    "devto": {"name": "dev.to", "color": "#0A0A0A", "home": "https://dev.to/t/ai"},
    "mastodon": {"name": "Mastodon", "color": "#6364FF", "home": "https://mastodon.social/tags/llm"},
    "youtube": {"name": "YouTube", "color": "#E62117", "home": "https://www.youtube.com/"},
}
# Platforms whose API lets us look FETCH_DAYS back immediately. Mastodon only returns the newest
# posts, so it joins the week-over-week trends once we have collected two weeks of it ourselves.
BACKFILLS = {"hn", "lobsters", "devto", "youtube"}

# Engagement that counts as one "typical hit" on each platform; heat is relative to it.
SCALE = {"hn": 250, "lobsters": 40, "devto": 80, "mastodon": 40, "youtube": 200000}
MIN_ENGAGEMENT = {"hn": 25, "lobsters": 3, "devto": 15, "mastodon": 8, "youtube": 0}

HN_QUERIES = ["AI", "LLM", "GPT", "Claude", "OpenAI", "Anthropic", "Gemini", "agents", "machine learning",
              "language model", "RAG", "MCP", "DeepSeek", "Llama", "neural", "inference", "open weights"]
MASTODON = {
    "mastodon.social": ["llm", "generativeai", "machinelearning", "openai", "anthropic", "claude", "aiagents",
                        "opensourceai", "localllm", "deepseek"],
    "sigmoid.social": ["llm", "machinelearning", "ai"],
}
DEVTO_TAGS = ["ai", "llm", "machinelearning", "openai", "agents", "mcp"]
LAB_CHANNELS = {"UCrDwWp7EBBv4NwvScIpBDOA", "UCP7jMXSY2xbc3KCAE0MHQ-A", "UCXZCJLdBC09xxGZ6gcdrc6A"}
YOUTUBE = {  # official / established AI channels (channel id -> name)
    "UCbfYPyITQ-7l4upoX8nvctg": "Two Minute Papers", "UCZHmQk67mSJgfCCTn7xBfew": "Yannic Kilcher",
    "UCXUPKJO5MZQN11PqgIvyuvQ": "Andrej Karpathy", "UCNJ1Ymd5yFuUPtn21xtRbbw": "AI Explained",
    "UCrDwWp7EBBv4NwvScIpBDOA": "Anthropic", "UCP7jMXSY2xbc3KCAE0MHQ-A": "Google DeepMind",
    "UCXZCJLdBC09xxGZ6gcdrc6A": "OpenAI",
}

TOPICS = {
    "AI agents": r"\bagent(s|ic)?\b|agentic|multi-agent|computer use",
    "MCP & tool use": r"\bmcp\b|model context protocol|tool[- ]calling|function calling",
    "Coding assistants": r"copilot|\bcursor\b|claude code|codex|vibe[- ]coding|ai coding|coding (agent|assistant)|windsurf|devin\b",
    "Open-weight models": r"open[- ]?(weights?|source) (model|llm|ai)|\bllama|qwen|mistral|deepseek|gemma|olmo|kimi|\bglm\b",
    "Local & on-device": r"local(ly)? (llm|model|ai)|on-device|ollama|llama\.cpp|lm studio|\bgguf\b|quantiz",
    "Reasoning models": r"reasoning|chain[- ]of[- ]thought|thinking model|test-time|\bo[134]\b",
    "RAG & search": r"\brag\b|retrieval|vector (db|database|search)|embeddings?",
    "Image & video": r"video (generation|model)|text-to-(image|video)|diffusion|\bsora\b|\bveo\b|midjourney|image generation",
    "Voice & speech": r"\bvoice\b|speech|text-to-speech|\btts\b|transcription|whisper",
    "GPUs & chips": r"\bgpus?\b|nvidia|\btpus?\b|cuda|blackwell|\bh100\b|data ?cent(er|re)|inference chip",
    "Evals & benchmarks": r"benchmark|\bevals?\b|leaderboard|swe-bench|\barena\b",
    "Security & safety": r"jailbreak|prompt injection|alignment|\bsafety\b|red[- ]team|vulnerabilit|\bsecurity\b",
    "Robotics": r"robot|humanoid|embodied",
    "Fine-tuning & training": r"fine[- ]?tun|\blora\b|\brlhf\b|pre-?train|distill|training run",
    "Pricing & cost": r"pricing|\bprice\b|\bcosts?\b|cheaper|token (cost|price)|rate limit",
}
COMPANIES = {
    "OpenAI": r"openai|chatgpt|\bgpt[- ]?\d|\bsora\b",
    "Anthropic": r"anthropic|\bclaude",
    "Google": r"google|gemini|deepmind|gemma",
    "Meta": r"\bmeta\b|\bllama",
    "Microsoft": r"microsoft|copilot|azure",
    "Mistral": r"mistral",
    "DeepSeek": r"deepseek",
    "Qwen / Alibaba": r"qwen|alibaba",
    "xAI": r"\bxai\b|\bgrok",
    "NVIDIA": r"nvidia",
    "Hugging Face": r"hugging ?face",
}
_TOPIC_RE = {k: re.compile(v, re.I) for k, v in TOPICS.items()}
_COMPANY_RE = {k: re.compile(v, re.I) for k, v in COMPANIES.items()}


# ---------------------------------------------------------------- storage
def _read(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def load_items() -> dict[str, dict]:
    return {k: v for k, v in _read(ITEMS_FILE, {}).items() if _not_business(v)}


def save_items(items: dict[str, dict]) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    ordered = sorted(items.items(), key=lambda kv: kv[0])
    body = ",\n".join(f"{json.dumps(k)}:{json.dumps(v, ensure_ascii=False, separators=(',', ':'))}" for k, v in ordered)
    tmp = ITEMS_FILE.with_suffix(".tmp")
    tmp.write_text("{\n" + body + "\n}\n")
    tmp.replace(ITEMS_FILE)


# ---------------------------------------------------------------- fetchers
def _item(platform: str, uid: str, title: str, url: str, discussion: str, published: datetime,
          score: int, comments: int, **extra) -> dict:
    it = {"id": f"{platform}:{uid}", "p": platform, "t": title.strip(), "u": url, "d": discussion,
          "ts": to_utc_iso(published), "s": int(score), "c": int(comments)}
    it.update({k: v for k, v in extra.items() if v})
    return it


# Money and courtroom headlines are not technology news, whatever the platform.
_BUSINESS_TITLE = re.compile(
    r"\b(stocks?|nasdaq|s&p|shares|ipo|valuation|funding round|raises? \$|series [a-d]\b|layoffs?|lawsuit|sues?|sued|"
    r"antitrust|bubble|sell-?off|market cap|earnings|billion)\b", re.I)


def _not_business(it: dict) -> bool:
    return not (_PEOPLE_TITLE.search(it["t"]) or _BUSINESS_TITLE.search(it["t"]))


def _ok_title(title: str, body: str = "") -> bool:
    return (bool(title) and not _PEOPLE_TITLE.search(title) and not _BUSINESS_TITLE.search(title)
            and is_ai_relevant(title, body))


def fetch_hn(http: HttpClient, now: datetime) -> list[dict]:
    since = int((now - timedelta(days=FETCH_DAYS)).timestamp())
    out: dict[str, dict] = {}

    def one(q):
        r = http.get("https://hn.algolia.com/api/v1/search_by_date", params={
            "query": q, "tags": "story", "restrictSearchableAttributes": "title", "hitsPerPage": 100,
            "numericFilters": f"created_at_i>{since},points>={MIN_ENGAGEMENT['hn']}"})
        return r.json().get("hits", [])

    with ThreadPoolExecutor(max_workers=4) as pool:
        for hits in pool.map(one, HN_QUERIES):
            for h in hits:
                title = h.get("title") or ""
                if h["objectID"] in out or not _ok_title(title, h.get("story_text") or ""):
                    continue
                disc = f"https://news.ycombinator.com/item?id={h['objectID']}"
                out[h["objectID"]] = _item("hn", h["objectID"], title, h.get("url") or disc, disc,
                                           parse_iso(h["created_at"]), h.get("points") or 0,
                                           h.get("num_comments") or 0, au=h.get("author"))
    return list(out.values())


def fetch_lobsters(http: HttpClient, now: datetime) -> list[dict]:
    out, cutoff = [], now - timedelta(days=FETCH_DAYS)
    seen = set()
    for page in (1, 2, 3):
        url = "https://lobste.rs/t/ai.json" if page == 1 else f"https://lobste.rs/t/ai/page/{page}.json"
        for h in http.get(url).json():
            ts = parse_iso(h["created_at"])
            if h["short_id"] in seen or ts < cutoff or h["score"] < MIN_ENGAGEMENT["lobsters"] or _PEOPLE_TITLE.search(h["title"]):
                continue
            seen.add(h["short_id"])
            out.append(_item("lobsters", h["short_id"], h["title"], h.get("url") or h["comments_url"],
                             h["comments_url"], ts, h["score"], h["comment_count"],
                             au=(h.get("submitter_user") or {}).get("username") if isinstance(h.get("submitter_user"), dict)
                             else h.get("submitter_user")))
    return out


def fetch_devto(http: HttpClient, now: datetime) -> list[dict]:
    seen, out, cutoff = set(), [], now - timedelta(days=FETCH_DAYS)

    def one(tag):
        return http.get("https://dev.to/api/articles", params={"tag": tag, "top": 30, "per_page": 60}).json()

    with ThreadPoolExecutor(max_workers=3) as pool:
        for arts in pool.map(one, DEVTO_TAGS):
            for a in arts:
                ts = parse_iso(a["published_timestamp"])
                eng = a["public_reactions_count"] + 3 * a["comments_count"]
                if a["id"] in seen or ts < cutoff or eng < MIN_ENGAGEMENT["devto"]:
                    continue
                if not _ok_title(a["title"], a.get("description") or ""):
                    continue
                seen.add(a["id"])
                out.append(_item("devto", str(a["id"]), a["title"], a["url"], a["url"] + "#comments", ts,
                                 a["public_reactions_count"], a["comments_count"], au=(a.get("user") or {}).get("username"),
                                 x=summarize(a.get("description") or "", 200), th=a.get("cover_image") or a.get("social_image")))
    return out


def _body(html: str) -> str:
    """Post text without links and hashtags (which are noise in a one-line summary)."""
    t = clean_html(html)
    t = re.sub(r"https?://\S+|#\s?\w+", " ", t)
    return re.sub(r"\s+", " ", t).strip(" .")


def fetch_mastodon(http: HttpClient, now: datetime) -> list[dict]:
    seen_text, out = set(), {}
    jobs = [(host, tag) for host, tags in MASTODON.items() for tag in tags]

    def one(job):
        host, tag = job
        try:
            return host, http.get(f"https://{host}/api/v1/timelines/tag/{tag}", params={"limit": 40}).json()
        except Exception as exc:  # one failing hashtag must not lose the rest
            log.debug("mastodon %s #%s failed: %s", host, tag, exc)
            return host, []

    with ThreadPoolExecutor(max_workers=4) as pool:
        for host, posts in pool.map(one, jobs):
            for p in posts:
                text = _body(p.get("content") or "")
                eng = p["favourites_count"] + 3 * p["reblogs_count"] + 2 * p["replies_count"]
                acct = p.get("account") or {}
                if (p.get("in_reply_to_id") or p.get("reblog") or p.get("sensitive") or acct.get("bot")
                        or (p.get("language") or "en") != "en" or eng < MIN_ENGAGEMENT["mastodon"]
                        or len(text) < 50 or text.startswith("RE:")):
                    continue
                key = re.sub(r"\W+", "", text.lower())[:80]
                if key in seen_text or p["uri"] in out or not _STRONG_AI_RE.search(text[:200]):
                    continue
                seen_text.add(key)
                out[p["uri"]] = _item("mastodon", re.sub(r"\W+", "_", p["uri"])[-60:], summarize(text, 140),
                                      p["url"], p["url"], parse_iso(p["created_at"]),
                                      p["favourites_count"] + 3 * p["reblogs_count"], p["replies_count"],
                                      au="@" + acct.get("acct", "?"), x=summarize(text, 300))
    return list(out.values())


def fetch_youtube(http: HttpClient, now: datetime) -> list[dict]:
    cutoff, out = now - timedelta(days=FETCH_DAYS), []

    def one(cid):
        return cid, feedparser.parse(http.get("https://www.youtube.com/feeds/videos.xml", params={"channel_id": cid}).content)

    with ThreadPoolExecutor(max_workers=4) as pool:
        for cid, feed in pool.map(one, YOUTUBE):
            for e in feed.entries:
                ts = parse_iso(e.get("published") or e.get("updated"))
                if ts < cutoff:
                    continue
                stats = e.get("media_statistics") or {}
                views = int(stats.get("views", 0) or 0)
                thumbs = e.get("media_thumbnail") or [{}]
                if cid in LAB_CHANNELS and not _ok_title(e["title"]):
                    continue  # company channels also post culture and event videos
                out.append(_item("youtube", e["yt_videoid"], e["title"], e["link"], e["link"], ts, views, 0,
                                 au=YOUTUBE[cid], th=thumbs[0].get("url")))
    return out


FETCHERS = {"hn": fetch_hn, "lobsters": fetch_lobsters, "devto": fetch_devto,
            "mastodon": fetch_mastodon, "youtube": fetch_youtube}


# ---------------------------------------------------------------- scoring and labelling
def engagement(it: dict) -> float:
    p, s, c = it["p"], it["s"], it["c"]
    if p == "hn":
        return s + 2 * c
    if p == "lobsters":
        return s + 2 * c
    if p == "devto":
        return s + 3 * c
    if p == "mastodon":
        return s + 2 * c
    return s  # youtube: views


def heat(it: dict, now: datetime) -> float:
    age_h = max(0.0, (now - parse_iso(it["ts"])).total_seconds() / 3600)
    return round(min(10.0, (engagement(it) / SCALE[it["p"]]) ** 0.8) * 0.5 ** (age_h / 48), 3)


def mood(it: dict) -> str | None:
    """A measurable read on how a thread is going, from comments versus votes (never from guessing tone)."""
    if it["p"] not in ("hn", "lobsters"):
        return None
    s, c = it["s"], it["c"]
    if c >= 60 and c >= 0.9 * s:
        return "debated"      # more people arguing than voting
    if s >= 300 and c <= 0.3 * s:
        return "loved"        # many votes, little to argue about
    return None


def topics_of(it: dict) -> list[str]:
    text = f"{it['t']} {it.get('x', '')}"
    return [k for k, rx in _TOPIC_RE.items() if rx.search(text)][:4]


def companies_of(it: dict) -> list[str]:
    text = f"{it['t']} {it.get('x', '')}"
    return [k for k, rx in _COMPANY_RE.items() if rx.search(text)][:3]


def trends(items: list[dict], now: datetime, platforms: set[str]) -> dict:
    """Mentions this week against last week, only from platforms with a full two weeks of data."""
    wk, wk2 = now - timedelta(days=7), now - timedelta(days=14)
    cur, prev = {"topics": Counter(), "companies": Counter()}, {"topics": Counter(), "companies": Counter()}
    for it in items:
        if it["p"] not in platforms:
            continue
        ts = parse_iso(it["ts"])
        if ts < wk2:
            continue
        bucket = cur if ts >= wk else prev
        bucket["topics"].update(topics_of(it))
        bucket["companies"].update(companies_of(it))

    def rows(kind):
        out = []
        for name in (TOPICS if kind == "topics" else COMPANIES):
            n, p = cur[kind][name], prev[kind][name]
            if n + p < 4:
                continue
            pct = None if p == 0 else round(100 * (n - p) / p)
            if n >= 4 and (p == 0 or pct >= 40):
                state = "rising"
            elif p >= 4 and pct is not None and pct <= -30:
                state = "cooling"
            else:
                state = "steady"
            out.append({"name": name, "now": n, "prev": p, "change_pct": pct, "state": state})
        return sorted(out, key=lambda r: -r["now"])

    return {"topics": rows("topics"), "companies": rows("companies")}


# ---------------------------------------------------------------- linking to our own content
def _repo_key(url: str) -> str | None:
    u = urlparse(url)
    if u.netloc.lower() not in ("github.com", "www.github.com"):
        return None
    parts = [x for x in u.path.split("/") if x]
    return f"{parts[0]}/{parts[1]}".lower().removesuffix(".git") if len(parts) >= 2 else None


def link_index(items: list[dict], articles: dict[str, dict], repo_records: dict[str, dict]) -> tuple[dict, dict]:
    """Best discussion for each tracked story and repo: ({article_id: buzz}, {repo_key: buzz})."""
    known = {}
    for a in articles.values():
        known[a["id"]] = a
        for c in a.get("coverage", []):
            known.setdefault(article_id(canonical_url(c["url"])), a)
    by_article, by_repo = {}, {}
    for it in items:
        if it["p"] not in ("hn", "lobsters", "devto") or it["u"] == it["d"]:
            continue
        buzz = {"p": it["p"], "s": it["s"], "c": it["c"], "d": it["d"]}
        a = known.get(article_id(canonical_url(it["u"])))
        if a and engagement(it) > by_article.get(a["id"], {}).get("_e", -1):
            by_article[a["id"]] = buzz | {"_e": engagement(it)}
        key = _repo_key(it["u"])
        if key in repo_records and engagement(it) > by_repo.get(key, {}).get("_e", -1):
            by_repo[key] = buzz | {"_e": engagement(it)}
    for d in (by_article, by_repo):
        for v in d.values():
            v.pop("_e")
    return by_article, by_repo


# ---------------------------------------------------------------- orchestration
def refresh(now: datetime | None = None) -> dict:
    """Fetch every platform, merge into the stored items, prune old ones. Returns per-platform status."""
    now = now or now_utc()
    http = HttpClient()
    items = load_items()
    state = _read(STATE_FILE, {"since": {}, "status": {}})
    status = {}
    for pid, fn in FETCHERS.items():
        try:
            fresh = fn(http, now)
        except Exception as exc:
            log.warning("buzz: %s failed: %s", pid, exc)
            prev = state["status"].get(pid, {})
            status[pid] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:200],
                           "last_success": prev.get("last_success"), "items": prev.get("items", 0)}
            continue
        for it in fresh:
            old = items.get(it["id"])
            if old:  # scores only grow in practice; never lose a good reading to a stale response
                it["s"], it["c"] = max(it["s"], old["s"]), max(it["c"], old["c"])
            items[it["id"]] = it
        state["since"].setdefault(pid, to_utc_iso(now - timedelta(days=FETCH_DAYS) if pid in BACKFILLS else now))
        status[pid] = {"ok": True, "last_success": to_utc_iso(now), "items": len(fresh)}
        log.info("  buzz %-9s %4d items", pid, len(fresh))
    cutoff = now - timedelta(days=KEEP_DAYS)
    items = {k: v for k, v in items.items() if parse_iso(v["ts"]) >= cutoff}
    save_items(items)
    state["status"] = {**state["status"], **status}
    DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=1))
    return status


def site_payload(now: datetime, articles: dict[str, dict], repo_records: dict[str, dict]) -> dict:
    items = list(load_items().values())
    state = _read(STATE_FILE, {"since": {}, "status": {}})
    by_article, by_repo = link_index(items, articles, repo_records)
    # Trends only use platforms that have two full weeks behind them.
    eligible = {p for p, since in state["since"].items() if parse_iso(since) <= now - timedelta(days=13)}
    news_ids = {a["id"] for a in articles.values()}
    out_items = []
    for it in items:
        h = heat(it, now)
        row = {"id": it["id"], "p": it["p"], "t": it["t"], "u": it["u"], "d": it["d"], "ts": it["ts"],
               "s": it["s"], "c": it["c"], "h": h}
        for k in ("au", "x", "th"):
            if it.get(k):
                row[k] = it[k]
        if (m := mood(it)):
            row["m"] = m
        if (tp := topics_of(it)):
            row["tp"] = tp
        if it["u"] != it["d"]:
            aid = article_id(canonical_url(it["u"]))
            if aid in news_ids:
                row["news"] = True
            if _repo_key(it["u"]) in repo_records:
                row["repo"] = _repo_key(it["u"])
        out_items.append(row)
    out_items.sort(key=lambda r: -r["h"])
    counts = Counter(i["p"] for i in items)
    status = state.get("status", {})
    return {
        "generated": to_utc_iso(now),
        "platforms": [{"id": pid, **meta, "count": counts.get(pid, 0), **{k: status.get(pid, {}).get(k)
                       for k in ("ok", "last_success")}} for pid, meta in PLATFORMS.items()],
        "trends": trends(items, now, eligible) | {"baseline": sorted(eligible)},
        "items": out_items[:SITE_ITEMS],
        "total": len(items),
        "_article_buzz": by_article, "_repo_buzz": by_repo,
    }
