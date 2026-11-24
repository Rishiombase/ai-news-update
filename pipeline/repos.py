"""Open-source AI repos: discovery, daily star snapshots, and the Repos page sections.

Sections (all computed from real GitHub data):
  trending      most stars gained this week (from our own daily snapshots; exact for new repos)
  new           created in the last 90 days and growing fast for their age
  recognized    broke through this week: star milestone, in the news, code for a top paper, major release
  gems          small (<= 2,500 stars) but healthy: active, releases, license, steady growth
  essentials    established projects that are still actively maintained

Repos whose popularity looks inflated (very few watchers and forks for their stars) are
flagged and kept out of the gems and essentials lists.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import subprocess
import time
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

import requests

from . import config
from .textutil import parse_iso, to_utc_iso

log = logging.getLogger(__name__)

REPO_DIR = config.DATA_DIR / "repos"
RECORDS = REPO_DIR / "repos.json"
THEMES_FILE = REPO_DIR / "themes.json"
PICKS_FILE = REPO_DIR / "newsletter_picks.json"
API, GQL = "https://api.github.com", "https://api.github.com/graphql"
REFRESH_HOURS = 20          # refresh repo data about once a day
SECTION_SIZE = 30
MAX_TRACKED = 1500

# Discovery queries (GitHub search). {d14}/{d30}/{d90} are replaced by ISO dates.
NEW_TOPICS = ["llm", "ai-agents", "agents", "agentic-ai", "generative-ai", "large-language-models", "rag", "mcp",
              "model-context-protocol", "ai", "machine-learning", "deep-learning", "llmops", "computer-vision",
              "speech-recognition", "text-to-speech", "diffusion-models", "chatbot", "claude-code", "ollama",
              "ai-coding", "multimodal", "fine-tuning", "inference"]
ACTIVE_TOPICS = ["llm", "ai-agents", "generative-ai", "rag", "mcp", "machine-learning", "deep-learning",
                 "large-language-models", "ai"]
GEM_TOPICS = ["llm", "ai-agents", "rag", "mcp", "generative-ai", "agentic-ai", "llmops", "fine-tuning", "inference"]
QUERIES = ([f"topic:{t} created:>{{d90}} stars:>=50" for t in NEW_TOPICS] +
           [f"topic:{t} pushed:>{{d14}} stars:>=1000" for t in ACTIVE_TOPICS] +
           [f"topic:{t} stars:100..2500 pushed:>{{d30}}" for t in GEM_TOPICS])

PERMISSIVE = {"MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "0BSD", "Zlib", "MIT-0",
              "BSL-1.0", "CC0-1.0", "PostgreSQL", "UPL-1.0"}
USES = {  # light "use case" filters, matched on name, description and topics
    "Agents": r"agent|agentic|multi-agent|autonomous|crew|swarm",
    "MCP": r"\bmcp\b|model-context-protocol|model context protocol",
    "RAG": r"\brag\b|retrieval|vector|embedding|knowledge[- ]base|semantic search",
    "Local & inference": r"inference|serving|ollama|llama\.?cpp|gguf|quantiz|on-device|local llm|vllm|runtime|edge",
    "Coding tools": r"coding|claude-code|codex|copilot|cursor|\bide\b|developer-tools|devtools|code review|\bcli\b",
    "Fine-tuning": r"fine-?tun|finetun|\blora\b|rlhf|\bgrpo\b|\bdpo\b|training framework",
    "Multimodal": r"vision|image|video|speech|audio|voice|\btts\b|\basr\b|\bocr\b|multimodal|diffusion",
}
GENERIC_TOPICS = {"ai", "llm", "llms", "machine-learning", "deep-learning", "artificial-intelligence", "python",
                  "openai", "chatgpt", "gpt", "large-language-models", "generative-ai", "nlp", "pytorch", "genai",
                  "llm-inference", "ml", "typescript", "javascript", "golang", "rust", "nodejs", "react", "awesome",
                  "deepseek", "claude", "anthropic", "gemini", "gpt-4", "langchain", "hacktoberfest", "ai-tools",
                  "claude-code", "codex", "claude-code-plugin", "cursor", "vibe-coding", "gemini-cli", "open-source",
                  "android", "ios", "macos", "windows", "linux", "cli", "docker", "self-hosted"}
# One-line installers for general tools (uv, Docker, Rust...) are not the project's own quick start.
_GENERIC_INSTALLERS = re.compile(r"astral\.sh/uv|get\.docker|rustup|sh\.rustup|nvm-sh|brew\.sh|bun\.sh/install|deno\.land/install")
_INSTALL_RE = re.compile(
    r"^\s*(?:\$\s*)?((?:pip3?|uv pip|pipx|uv tool) install\s+\S.*|uvx\s+\S.*|npm (?:i|install)\s+(?:-g\s+)?\S.*|"
    r"npx\s+\S.*|pnpm (?:add|dlx)\s+\S.*|brew install\s+\S.*|cargo install\s+\S.*|go install\s+\S.*|"
    r"docker (?:run|pull)\s+\S.*|ollama (?:run|pull)\s+\S.*|conda install\s+\S.*|"
    r"curl\s+-[a-zA-Z]+\s+\S+\s*\|\s*(?:sh|bash))\s*$", re.M)
# A repo counts as an AI project when its name or description is about AI, or it carries a
# specific AI topic. Tags like "claude-code" alone only say the code was written with AI.
_AI_TEXT = re.compile(
    r"\b(ai|a\.i\.|llms?|gpts?|agents?|agentic|machine learning|deep learning|neural|transformers?|language models?|"
    r"diffusion|embeddings?|rag|retrieval|inference|fine-?tun\w*|lora|prompts?|chatbots?|copilot|mcp|"
    r"model context protocol|computer vision|speech|text-to-\w+|multimodal|reasoning|vlm|vla|robot\w*|"
    r"openai|anthropic|claude|gemini|deepseek|qwen|llama|mistral|ollama|hugging ?face|whisper|stable diffusion)\b",
    re.I)
_AI_TOPICS = {"llm", "llms", "ai-agents", "ai-agent", "agents", "agentic-ai", "agent", "generative-ai", "rag", "mcp",
              "model-context-protocol", "large-language-models", "machine-learning", "deep-learning", "llmops",
              "computer-vision", "speech-recognition", "text-to-speech", "diffusion-models", "fine-tuning", "inference",
              "multimodal", "agent-skills", "ai-coding", "coding-agent", "llm-inference", "vector-database",
              "embeddings", "transformers", "nlp", "reinforcement-learning", "mcp-server", "ai-assistant", "genai",
              "artificial-intelligence", "openai", "chatgpt", "ollama", "langchain", "rag-pipeline", "vlm"}


def is_ai_project(r: dict) -> bool:
    if _AI_TEXT.search(f"{r['name'].replace('-', ' ')} {r.get('desc') or ''}"):
        return True
    return bool(_AI_TOPICS & set(r.get("topics", [])))


def clean_command(cmd: str | None) -> str | None:
    """Tidy an install command, or drop it if it would not help anyone get started."""
    if not cmd:
        return None
    cmd = re.split(r"\s+#\s", cmd)[0].strip()          # trailing shell comment
    if (cmd.endswith("\\") or "$" in cmd or _GENERIC_INSTALLERS.search(cmd) or re.search(r"-r\s+requirements|install\s+-e\s+\.|install\s+\.(\s|$)", cmd)
            or len(cmd) > 100 or len(cmd) < 8):
        return None
    return cmd


_GH_LINK = re.compile(r"github\.com/([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100})")


# --------------------------------------------------------------------------- GitHub client
def _token() -> str | None:
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok:
        return tok
    try:  # local development: reuse the GitHub CLI login if present
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10)
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


class GitHub:
    def __init__(self, token: str) -> None:
        self.s = requests.Session()
        self.s.headers.update({"Authorization": f"Bearer {token}", "User-Agent": config.USER_AGENT,
                               "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})

    def search(self, q: str) -> list[dict]:
        r = self.s.get(f"{API}/search/repositories", params={"q": q, "sort": "stars", "order": "desc", "per_page": 100},
                       timeout=30)
        if r.status_code == 403 and "rate limit" in r.text.lower():
            wait = max(5, int(r.headers.get("X-RateLimit-Reset", time.time() + 60)) - int(time.time()) + 1)
            log.info("repos: search rate limit, waiting %ds", min(wait, 70))
            time.sleep(min(wait, 70))
            r = self.s.get(f"{API}/search/repositories", params={"q": q, "sort": "stars", "per_page": 100}, timeout=30)
        r.raise_for_status()
        return r.json().get("items", [])

    def details(self, names: list[str]) -> dict[str, dict]:
        """Batch-fetch repository details through GraphQL (50 per request)."""
        frag = ("fragment R on Repository { nameWithOwner description stargazerCount forkCount watchers{totalCount} "
                "createdAt pushedAt isArchived isFork homepageUrl primaryLanguage{name} licenseInfo{spdxId} "
                "repositoryTopics(first:8){nodes{topic{name}}} latestRelease{tagName publishedAt} "
                "owner{login __typename} }")
        out = {}
        for i in range(0, len(names), 50):
            chunk = names[i:i + 50]
            parts = []
            for k, full in enumerate(chunk):
                owner, name = full.split("/", 1)
                parts.append(f'r{k}: repository(owner:{json.dumps(owner)}, name:{json.dumps(name)}){{...R}}')
            body = {"query": "query { " + " ".join(parts) + " } " + frag}
            try:
                r = self.s.post(GQL, json=body, timeout=60)
                r.raise_for_status()
                data = r.json().get("data") or {}
            except (requests.RequestException, ValueError) as exc:
                log.warning("repos: details batch failed (%s)", exc)
                continue
            for node in data.values():
                if node:
                    out[node["nameWithOwner"].lower()] = node
        return out

    def readme(self, full: str) -> str:
        r = self.s.get(f"{API}/repos/{full}/readme", headers={"Accept": "application/vnd.github.raw"}, timeout=20)
        return r.text if r.status_code == 200 else ""


# --------------------------------------------------------------------------- helpers
def quickstart(readme: str) -> str | None:
    """First install/run command inside a fenced code block of the README."""
    for block in re.findall(r"```[^\n]*\n(.*?)```", readme, re.S):
        for m in _INSTALL_RE.finditer(block):
            cmd = clean_command(m.group(1).strip())
            if cmd and "<" not in cmd:
                return cmd
    return None


def low_engagement(r: dict) -> bool:
    """Stars far out of line with watchers and forks: a common sign of bought or inflated stars."""
    s = r["stars"]
    if s < 1000:
        return False
    return (r.get("watchers", 0) / s) < 0.002 and (r.get("forks", 0) / s) < 0.06


def uses(r: dict) -> list[str]:
    text = " ".join([r["name"], r.get("desc") or "", " ".join(r.get("topics", []))]).lower()
    return [u for u, pat in USES.items() if re.search(pat, text)]


def _load(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _save(path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1, sort_keys=True))


def load_records() -> dict[str, dict]:
    return _load(RECORDS, {})


def load_snapshots() -> dict[str, dict[str, int]]:
    """{date: {repo: stars}} across all monthly snapshot files."""
    snaps = {}
    for f in sorted(REPO_DIR.glob("stars-*.json")):
        snaps.update(_load(f, {}))
    return snaps


def _stars_at(snaps: dict, day: datetime, repo: str) -> int | None:
    for delta in (0, 1, -1, 2):
        d = (day + timedelta(days=delta)).date().isoformat()
        if d in snaps and repo in snaps[d]:
            return snaps[d][repo]
    return None


# --------------------------------------------------------------------------- refresh (network)
def _from_search(item: dict) -> dict:
    return {
        "full": item["full_name"], "name": item["name"], "owner": item["owner"]["login"],
        "owner_type": item["owner"].get("type", "User"), "desc": (item.get("description") or "").strip(),
        "stars": item.get("stargazers_count", 0), "forks": item.get("forks_count", 0),
        "lang": item.get("language"), "license": (item.get("license") or {}).get("spdx_id"),
        "topics": item.get("topics", [])[:8], "created": item.get("created_at"), "pushed": item.get("pushed_at"),
        "home": item.get("homepage") or None, "archived": item.get("archived", False), "fork": item.get("fork", False),
    }


def _merge_details(rec: dict, d: dict) -> None:
    rec.update({
        "desc": (d.get("description") or rec.get("desc") or "").strip(), "stars": d["stargazerCount"],
        "forks": d["forkCount"], "watchers": d["watchers"]["totalCount"], "created": d["createdAt"],
        "pushed": d["pushedAt"], "archived": d["isArchived"], "fork": d["isFork"], "home": d.get("homepageUrl") or None,
        "lang": (d.get("primaryLanguage") or {}).get("name"), "license": (d.get("licenseInfo") or {}).get("spdxId"),
        "topics": [n["topic"]["name"] for n in d["repositoryTopics"]["nodes"]],
        "owner_type": d["owner"]["__typename"],
    })
    rel = d.get("latestRelease")
    rec["release"] = {"tag": rel["tagName"], "date": rel["publishedAt"]} if rel else None


def _mentions(articles: dict[str, dict], now: datetime) -> dict[str, list[dict]]:
    """GitHub repos linked from recent news stories and research papers."""
    cutoff = to_utc_iso(now - timedelta(days=14))
    out: dict[str, list[dict]] = defaultdict(list)
    for a in articles.values():
        if a["published"] < cutoff:
            continue
        text = " ".join([a.get("url", ""), a.get("summary", ""), a.get("extra", {}).get("github") or ""])
        for owner, name in set(_GH_LINK.findall(text)):
            name = re.sub(r"\.git$", "", name).rstrip(".")
            if owner.lower() in ("orgs", "topics", "features", "sponsors", "marketplace", "apps") or not name:
                continue
            out[f"{owner}/{name}"].append({
                "kind": "paper" if a["kind"] == "paper" else "news", "title": a["title"], "url": a["url"],
                "date": a["published"], "source": a["source_id"],
                "upvotes": a.get("extra", {}).get("upvotes", 0)})
    return out


def refresh(articles: dict[str, dict], state: dict, now: datetime, force: bool = False) -> bool:
    """Discover and update repos (network). Returns True when data was refreshed."""
    last = state.get("repos_last_refresh")
    if not force and last and now - parse_iso(last) < timedelta(hours=REFRESH_HOURS):
        return False
    token = _token()
    if not token:
        log.warning("repos: no GitHub token (set GITHUB_TOKEN); skipping the repo refresh")
        return False
    gh = GitHub(token)
    records = load_records()
    dates = {f"d{n}": (now - timedelta(days=n)).date().isoformat() for n in (14, 30, 90)}

    found: dict[str, dict] = {}
    for i, q in enumerate(QUERIES):
        if i:
            time.sleep(2.2)  # stay under 30 searches per minute
        try:
            for item in gh.search(q.format(**dates)):
                found[item["full_name"].lower()] = _from_search(item)
        except requests.RequestException as exc:
            log.warning("repos: search failed for %r (%s)", q, exc)
    log.info("repos: %d candidates from %d searches", len(found), len(QUERIES))

    mentions = _mentions(articles, now)
    keys = set(found) | {k.lower() for k in mentions} | {k for k, r in records.items() if r.get("featured")}
    # Track the most relevant candidates; keep previously tracked repos so their history continues.
    def prio(k):
        r = found.get(k) or records.get(k) or {}
        return (k in records, k in {m.lower() for m in mentions}, r.get("stars", 0))
    keys = sorted(keys, key=prio, reverse=True)[:MAX_TRACKED]
    names = [(found.get(k) or records.get(k) or {}).get("full") or next(m for m in mentions if m.lower() == k)
             for k in keys]
    details = gh.details(names)
    log.info("repos: details for %d of %d repos", len(details), len(names))

    today = now.date().isoformat()
    mention_by_key = {k.lower(): v for k, v in mentions.items()}
    for k, full in zip(keys, names):
        rec = records.get(k) or found.get(k) or {"full": full, "name": full.split("/", 1)[1], "owner": full.split("/")[0]}
        if k in found:  # search results carry today's numbers
            rec.update({f: v for f, v in found[k].items() if v is not None or f not in rec})
        if k in details:
            _merge_details(rec, details[k])
        elif k not in found:
            continue  # renamed or deleted, and not in search results
        rec["first_seen"] = rec.get("first_seen") or today
        rec["last_seen"] = today
        rec["mentions"] = mention_by_key.get(k, [])
        records[k] = rec

    # Drop repos we have not seen for 45 days.
    cutoff = (now - timedelta(days=45)).date().isoformat()
    records = {k: r for k, r in records.items() if r.get("last_seen", today) >= cutoff}

    snaps_file = REPO_DIR / f"stars-{today[:7]}.json"
    snaps = _load(snaps_file, {})
    snaps[today] = {k: r["stars"] for k, r in records.items() if r.get("last_seen") == today}
    _save(snaps_file, snaps)

    # README quick-start commands for repos likely to be shown (refreshed weekly).
    sections = build_sections(records, load_snapshots(), now)
    shown = {e["id"] for sec in sections["sections"].values() for e in sec}
    week_ago = (now - timedelta(days=7)).date().isoformat()
    fetched = 0
    for k in shown:
        r = records[k]
        r["featured"] = True
        if r.get("readme_checked", "") >= week_ago:
            continue
        try:
            r["quickstart"] = quickstart(gh.readme(r["full"]))
        except requests.RequestException:
            continue
        r["readme_checked"] = today
        fetched += 1
    for k, r in records.items():
        if k not in shown:
            r.pop("featured", None)
    log.info("repos: %d READMEs checked for quick-start commands", fetched)

    _save(RECORDS, records)
    themes_hist = _load(THEMES_FILE, {})
    themes_hist[today] = dict(_theme_weights(records, load_snapshots(), now).most_common(40))
    _save(THEMES_FILE, {d: v for d, v in themes_hist.items() if d >= (now - timedelta(days=30)).date().isoformat()})
    state["repos_last_refresh"] = to_utc_iso(now)
    return True


# --------------------------------------------------------------------------- metrics & sections (offline)
def _age_days(r: dict, now: datetime) -> float:
    return max(1.0, (now - parse_iso(r["created"])).total_seconds() / 86400) if r.get("created") else 9999.0


def _days_since(iso: str | None, now: datetime) -> float:
    return (now - parse_iso(iso)).total_seconds() / 86400 if iso else 9999.0


def growth(r: dict, k: str, snaps: dict, now: datetime) -> tuple[int | None, bool, int | None]:
    """(stars gained in 7 days, whether that is an estimate, stars gained in 1 day)."""
    age = _age_days(r, now)
    week_ago = _stars_at(snaps, now - timedelta(days=7), k)
    day_ago = _stars_at(snaps, now - timedelta(days=1), k)
    day = r["stars"] - day_ago if day_ago is not None else None
    if week_ago is not None:
        return max(0, r["stars"] - week_ago), False, day
    if age <= 7:
        return r["stars"], False, day                       # every star arrived this week
    if age <= 30:
        return int(r["stars"] * 7 / age), True, day         # average pace since launch
    return None, False, day


def _ago(days: float) -> str:
    if days < 1:
        return "today"
    if days < 2:
        return "yesterday"
    return f"{int(days)} days ago"


def _theme_weights(records: dict, snaps: dict, now: datetime) -> Counter:
    weights: Counter = Counter()
    for k, r in records.items():
        if r.get("archived") or r.get("fork") or not r.get("created"):
            continue
        g, _, _ = growth(r, k, snaps, now)
        if g is None:
            continue
        for t in r.get("topics", []):
            if t not in GENERIC_TOPICS:
                weights[t] += math.log1p(g)
    return weights


def build_sections(records: dict[str, dict], snaps: dict, now: datetime) -> dict:
    """Pick and explain the repos for each section. Pure function of stored data."""
    rows = []
    for k, r in records.items():
        if r.get("archived") or r.get("fork") or not r.get("desc") or not r.get("created"):
            continue
        if re.match(r"awesome[-_]", r["name"], re.I):
            continue  # link lists, not projects
        if not is_ai_project(r) or low_engagement(r):
            continue  # not an AI project, or popularity looks inflated
        g, est, day = growth(r, k, snaps, now)
        rows.append({"k": k, "r": r, "week": g, "est": est, "day": day, "age": _age_days(r, now),
                     "pushed": _days_since(r.get("pushed"), now), "flag": low_engagement(r)})

    def entry(x, reason):
        return {"id": x["k"], "reason": reason}

    # Trending: most stars this week.
    trending = sorted((x for x in rows if x["week"] and x["week"] >= 20), key=lambda x: -x["week"])[:SECTION_SIZE]
    trending_out = [entry(x, f"+{x['week']:,} stars this week" + (" (average since launch)" if x["est"] else "")
                          + (f", +{x['day']:,} today" if x["day"] else "")) for x in trending]

    # New and rising: young and fast for their age.
    new = sorted((x for x in rows if x["age"] <= 90 and x["r"]["stars"] >= 100),
                 key=lambda x: -(x["r"]["stars"] / max(x["age"], 3) ** 0.75))[:SECTION_SIZE]
    new_out = [entry(x, f"{int(x['age'])} days old with {x['r']['stars']:,} stars"
                     + (f", +{x['week']:,} this week" if x["week"] and not x["est"] else "")) for x in new]

    # Getting recognized: something happened this week.
    recog = []
    for x in rows:
        r, reasons, weight = x["r"], [], 0.0
        before = _stars_at(snaps, now - timedelta(days=7), x["k"])
        if before is not None and not x["flag"]:
            for m in (100000, 50000, 25000, 10000, 5000, 1000):
                if before < m <= r["stars"]:
                    reasons.append(f"Crossed {m:,} stars this week")
                    weight += math.log10(m)
                    break
        news = [m for m in r.get("mentions", []) if m["kind"] == "news"]
        papers = [m for m in r.get("mentions", []) if m["kind"] == "paper" and m.get("upvotes", 0) >= 15]
        if news:
            src = config.SOURCE_BY_ID.get(news[0]["source"], {}).get("name", news[0]["source"])
            reasons.append(f"In the news: “{news[0]['title']}” ({src})")
            weight += 3 + len(news)
        if papers:
            reasons.append(f"Code for the paper “{papers[0]['title']}” ({papers[0]['upvotes']} upvotes)")
            weight += 2 + math.log10(1 + papers[0]["upvotes"])
        rel = r.get("release")
        if rel and _days_since(rel["date"], now) <= 14 and re.match(r"^v?\d+\.0(\.0)?$", rel["tag"]) and r["stars"] >= 500:
            reasons.append(f"Released {rel['tag']} {_ago(_days_since(rel['date'], now))}")
            weight += 2.5
        if reasons:
            recog.append((weight + math.log10(1 + r["stars"]) / 2, x, reasons))
    recog.sort(key=lambda t: -t[0])
    recog_out = [entry(x, "; ".join(reasons)) for _, x, reasons in recog[:SECTION_SIZE]]

    # Hidden gems: small, healthy, and growing steadily.
    new_ids = {e["id"] for e in new_out}
    gems = []
    for x in rows:
        r = x["r"]
        if not (100 <= r["stars"] <= 2500) or x["flag"] or x["age"] < 21 or x["pushed"] > 30 or x["k"] in new_ids:
            continue
        rel = r.get("release")
        rel_recent = bool(rel and _days_since(rel["date"], now) <= 90)
        monthly = (x["week"] * 4.3) if (x["week"] is not None and not x["est"]) else r["stars"] / x["age"] * 30
        q = (1.0 if r.get("license") in PERMISSIVE else 0) + (1.5 if rel_recent else 0) + (0.5 if r.get("home") else 0) \
            + (0.5 if len(r.get("topics", [])) >= 3 else 0) + (0.5 if r.get("owner_type") == "Organization" else 0) \
            + (1.0 if r.get("watchers", 0) / max(1, r["stars"]) >= 0.01 else 0) + (0.5 if x["pushed"] <= 7 else 0)
        score = q + 1.5 * math.log10(1 + monthly)
        bits = [f"updated {_ago(x['pushed'])}"]
        if rel_recent:
            bits.append(f"release {rel['tag']}")
        bits.append(f"about {int(monthly):,} new stars a month")
        if r.get("license") in PERMISSIVE:
            bits.append(f"{r['license']} license")
        gems.append((score, x, "Small but healthy: " + ", ".join(bits)))
    gems.sort(key=lambda t: -t[0])
    gems_out = [entry(x, why) for _, x, why in gems[:SECTION_SIZE]]

    # Proven essentials: big, established, still maintained.
    ess = []
    for x in rows:
        r = x["r"]
        rel = r.get("release")
        rel_days = _days_since(rel["date"], now) if rel else 9999
        if r["stars"] < 5000 or x["flag"] or x["age"] < 180 or x["pushed"] > 30 or (rel_days > 120 and x["pushed"] > 7):
            continue
        score = math.log10(r["stars"]) + (1 if x["pushed"] <= 7 else 0) + (1 if rel_days <= 30 else 0)
        why = f"{r['stars']:,} stars, updated {_ago(x['pushed'])}" + (f", latest release {rel['tag']}" if rel else "")
        ess.append((score, x, why))
    ess.sort(key=lambda t: -t[0])
    ess_out = [entry(x, why) for _, x, why in ess[:SECTION_SIZE]]

    # Emerging themes: topics carrying the most growth, compared with a week ago.
    weights = _theme_weights(records, snaps, now)
    hist = _load(THEMES_FILE, {})
    prev_day = (now - timedelta(days=7)).date().isoformat()
    prev = next((hist[d] for d in sorted(hist) if d >= prev_day), {}) if hist else {}
    themes, taken = [], []
    for t, w in weights.most_common(30):
        members = {x["k"] for x in rows if t in x["r"].get("topics", [])}
        count = len(members)
        if count < 3:
            continue
        names = {th["topic"] for th in themes}
        if t.rstrip("s") in {n.rstrip("s") for n in names}:
            continue  # singular/plural of a theme already listed
        if any(len(members & prev_set) / count >= 0.6 for prev_set in taken):
            continue  # mostly the same repos as a theme already listed
        taken.append(members)
        before = prev.get(t)
        themes.append({"topic": t, "repos": count, "rising": bool(before) and w > before * 1.25, "new": before is None and bool(prev)})

    sections = {"trending": trending_out, "new": new_out, "recognized": recog_out, "gems": gems_out,
                "essentials": ess_out}
    history_days = len({d for d in snaps if d <= now.date().isoformat()})
    return {"sections": sections, "themes": themes[:10], "history_days": history_days,
            "growth_by_id": {x["k"]: (x["week"], x["est"], x["day"]) for x in rows}}


def compact(k: str, r: dict, g: tuple) -> dict:
    week, est, day = g
    return {
        "id": k, "full": r["full"], "desc": r["desc"][:280], "url": f"https://github.com/{r['full']}",
        "home": r.get("home"), "stars": r["stars"], "forks": r.get("forks", 0), "week": week, "est": est, "day": day,
        "lang": r.get("lang"), "license": r.get("license"), "permissive": r.get("license") in PERMISSIVE,
        "created": r.get("created"), "pushed": r.get("pushed"), "release": r.get("release"),
        "quickstart": clean_command(r.get("quickstart")), "topics": [t for t in r.get("topics", []) if t not in GENERIC_TOPICS][:5],
        "uses": uses(r), "unverified": low_engagement(r), "owner_type": r.get("owner_type"),
    }


def site_payload(now: datetime) -> dict | None:
    """Everything the Repos page needs, or None if no repo data has been collected yet."""
    records = load_records()
    if not records:
        return None
    snaps = load_snapshots()
    built = build_sections(records, snaps, now)
    ids = {e["id"] for sec in built["sections"].values() for e in sec}
    return {
        "generated": to_utc_iso(now), "history_days": built["history_days"],
        "tracking_since": min(snaps) if snaps else None, "tracked": len(records),
        "sections": built["sections"], "themes": built["themes"],
        "repos": {k: compact(k, records[k], built["growth_by_id"].get(k, (None, False, None))) for k in ids},
    }


def newsletter_picks(period_id: str, in_progress: bool, payload: dict | None) -> dict | None:
    """Repos for a newsletter edition. Saved while the period runs, frozen once it ends."""
    picks = _load(PICKS_FILE, {})
    if in_progress and payload:
        used: set[str] = set()

        def take(sec, n=4):  # each repo appears once on the newsletter page
            out = []
            for e in payload["sections"][sec]:
                if e["id"] not in used:
                    used.add(e["id"])
                    out.append(payload["repos"][e["id"]] | {"reason": e["reason"]})
                if len(out) == n:
                    break
            return out
        picks[period_id] = {"as_of": payload["generated"], "trending": take("trending"), "new": take("new"),
                            "gems": take("gems")}
        _save(PICKS_FILE, picks)
    return picks.get(period_id)
