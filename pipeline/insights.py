""""Why it matters" lines, written by a language model through any OpenAI-compatible chat API.

Configure with environment variables (GitHub Actions: repository secrets / variables):
    INSIGHT_ENDPOINT   chat-completions URL, e.g. a local llama.cpp/Ollama server or a hosted API
    INSIGHT_API_KEY    API key, if the service needs one
    INSIGHT_MODEL      model name for that service
With no endpoint configured, this step is skipped and stories keep their publisher summaries.


Each story (and each featured repo) gets one sentence explaining why it is relevant to
engineering teams. Guard rails:
  * the model sees only the item's own title and summary, and is told to add nothing else;
  * any line containing a number that is not in the source text is discarded;
  * thin sources get no line rather than a padded one;
  * lines are stored once and never regenerated, so the free quota goes to new items.

Requests carry 8 items each and are capped per run and per day; a 429 stops the run politely.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import timedelta

import requests

from .focus import is_tech
from .repos import load_records, _save, RECORDS
from .textutil import parse_iso, to_utc_iso

log = logging.getLogger(__name__)

ENDPOINT = os.environ.get("INSIGHT_ENDPOINT", "").strip()
MODEL = os.environ.get("INSIGHT_MODEL", "").strip()
API_KEY = os.environ.get("INSIGHT_API_KEY", "").strip()
BATCH = 8
MAX_REQUESTS_PER_RUN = 12
MAX_REQUESTS_PER_DAY = 100
WINDOW_DAYS = 10
MAX_CHARS = 230

STORY_PROMPT = """You write one-line "Why it matters" notes for an AI technology briefing read by engineering leaders and developers at companies.
Rules:
- Use ONLY facts stated in each item's title and summary. Never add numbers, names, dates, prices or claims that are not in that text.
- One sentence, at most 28 words, plain English. No hype words (revolutionary, game-changing, groundbreaking).
- Say what it changes for teams building with AI, or what they could do: evaluate it, adopt it, watch it, plan for it.
- Do not repeat the headline. Do not start with "This".
- If the text is too thin to say anything concrete, return an empty string for that item.
Return JSON only: {"items": [{"id": "<id>", "why": "<sentence or empty>"}]}"""

REPO_PROMPT = """You write one-line "Why it matters" notes about open-source GitHub projects for AI developers.
Rules:
- Use ONLY facts in each item's name, description and topics. Never invent features, numbers or claims.
- One sentence, at most 25 words: what a developer could build or replace with it, or which problem it solves.
- No hype words. Do not start with "This".
- If the description is too vague to say anything concrete, return an empty string for that item.
Return JSON only: {"items": [{"id": "<id>", "why": "<sentence or empty>"}]}"""

_NUM = re.compile(r"\d+(?:[.,]\d+)?")
_HYPE = re.compile(r"\b(revolutionary|game[- ]chang\w*|groundbreaking|unprecedented|cutting[- ]edge)\b", re.I)


class QuotaExhausted(Exception):
    pass


def _numbers(text: str) -> set[str]:
    return {n.replace(",", "") for n in _NUM.findall(text)}


def accept(why: str, source: str) -> str | None:
    """Keep a generated line only if it is short, sober, and adds no numbers of its own."""
    why = " ".join((why or "").split()).strip().strip('"')
    if not why or len(why) > MAX_CHARS or _HYPE.search(why):
        return None
    if not _numbers(why) <= _numbers(source):
        return None  # a number the source does not contain: likely invented
    if not why.endswith((".", "!", "?")):
        why += "."
    return why


class Writer:
    def __init__(self, state: dict, today: str) -> None:
        self.s = requests.Session()
        self.s.headers.update({"Content-Type": "application/json"})
        if API_KEY:
            self.s.headers["Authorization"] = f"Bearer {API_KEY}"
        self.json_mode = True
        self.state, self.today = state, today
        usage = state.get("insights_usage", {})
        self.used_today = usage.get(today, 0)
        self.used_run = 0

    def _budget_left(self) -> bool:
        return self.used_run < MAX_REQUESTS_PER_RUN and self.used_today < MAX_REQUESTS_PER_DAY

    def ask(self, prompt: str, items: list[dict]) -> dict[str, str]:
        if not self._budget_left():
            raise QuotaExhausted
        body = {"model": MODEL, "temperature": 0.2, "max_tokens": 900,
                "messages": [{"role": "system", "content": prompt},
                             {"role": "user", "content": json.dumps({"items": items}, ensure_ascii=False)}]}
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}
        r = self.s.post(ENDPOINT, json=body, timeout=180)
        if r.status_code == 400 and self.json_mode:   # service without JSON mode: retry plainly
            self.json_mode = False
            body.pop("response_format")
            r = self.s.post(ENDPOINT, json=body, timeout=180)
        self.used_run += 1
        self.used_today += 1
        self.state["insights_usage"] = {self.today: self.used_today}
        if r.status_code == 429:
            raise QuotaExhausted
        if r.status_code in (401, 403):
            raise PermissionError(f"the AI service refused the request ({r.status_code}); check INSIGHT_API_KEY")
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", text, re.S)
        data = json.loads(m.group(0)) if m else {}
        return {str(x.get("id")): x.get("why", "") for x in data.get("items", []) if isinstance(x, dict)}


def _story_targets(articles: dict, now) -> list[dict]:
    cutoff = to_utc_iso(now - timedelta(days=WINDOW_DAYS))
    news = [a for a in articles.values() if a["kind"] == "news" and is_tech(a) and a["published"] >= cutoff
            and "why" not in a and len(a.get("summary", "")) >= 60]
    papers = [a for a in articles.values() if a["kind"] == "paper" and a["published"] >= cutoff and "why" not in a
              and a.get("extra", {}).get("upvotes", 0) >= 30]
    news.sort(key=lambda a: -a.get("score", 0))
    papers.sort(key=lambda a: -a.get("extra", {}).get("upvotes", 0))
    return news + papers


def run(articles: dict[str, dict], state: dict, now) -> int:
    """Write missing "why it matters" lines for recent stories and featured repos. Returns lines written."""
    if os.environ.get("NO_INSIGHTS"):
        return 0
    if not ENDPOINT or not MODEL:
        log.info("insights: no AI service configured (INSIGHT_ENDPOINT / INSIGHT_MODEL); skipping")
        return 0
    w = Writer(state, now.date().isoformat())
    written = 0
    try:
        # 1) Stories: the most important first, so a tight quota covers what readers see.
        targets = _story_targets(articles, now)
        for i in range(0, len(targets), BATCH):
            chunk = targets[i:i + BATCH]
            payload = [{"id": a["id"], "title": a["title"], "summary": a["summary"][:600]} for a in chunk]
            out = w.ask(STORY_PROMPT, payload)
            for a in chunk:
                why = accept(out.get(a["id"], ""), f"{a['title']} {a['summary']}")
                a["why"] = why or ""          # empty string: asked, nothing concrete to say
                written += bool(why)
        # 2) Featured repos on the Repos page.
        records = load_records()
        repos = [r for r in records.values() if r.get("featured") and "why" not in r and r.get("desc")]
        repos.sort(key=lambda r: -r.get("stars", 0))
        for i in range(0, len(repos), BATCH):
            chunk = repos[i:i + BATCH]
            payload = [{"id": r["full"], "name": r["full"], "description": r["desc"][:400],
                        "topics": r.get("topics", [])[:8]} for r in chunk]
            out = w.ask(REPO_PROMPT, payload)
            for r in chunk:
                why = accept(out.get(r["full"], ""), f"{r['full']} {r['desc']} {' '.join(r.get('topics', []))}")
                r["why"] = why or ""
                written += bool(why)
            _save(RECORDS, records)
            time.sleep(1)
    except QuotaExhausted:
        log.info("insights: request budget reached for now; the rest continue on the next run")
    except PermissionError as exc:
        log.warning("insights: %s; skipping", exc)
    except (requests.RequestException, ValueError, KeyError) as exc:
        log.warning("insights: stopped early (%s)", exc)
    log.info("insights: %d 'why it matters' lines written (%d requests this run)", written, w.used_run)
    return written
