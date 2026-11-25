// AIT Newsletter frontend. Static, dependency-free, reads JSON produced by the pipeline.
const DATA = "data/";
const PAGE = 30;
const store = { meta: null, latest: null, papers: null, issues: null, archive: new Map() };
const main = document.getElementById("main");

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fold = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
async function getJSON(path) {
  const r = await fetch(DATA + path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`Could not load ${path} (HTTP ${r.status}).`);
  return r.json();
}
const cat = (id) => store.meta.categories.find((c) => c.id === id);
const src = (id) => store.meta.sources.find((s) => s.id === id) || { name: id, tier: 4, home: "#" };
const tierVar = (t) => `var(--tier-${t})`;

const DAY = 864e5;
function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 6e4), h = Math.round(ms / 36e5), d = Math.round(ms / DAY);
  if (m < 60) return m <= 1 ? "just now" : `${m} min ago`;
  if (h < 24) return `${h} h ago`;
  if (d < 7) return `${d} d ago`;
  return fmtDate(iso);
}
const fmtDate = (iso, opts = { day: "numeric", month: "short", year: "numeric" }) => new Date(iso).toLocaleDateString("en-GB", opts);
function dayLabel(iso) {
  const d = new Date(iso); const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / DAY);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}
const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`);
const plural = (n, w, p = w + "s") => `${n.toLocaleString("en-GB")} ${n === 1 ? w : p}`;

function indexArticles(list) {
  for (const a of list) {
    if (a._hay) continue;
    a._hay = fold([a.title, a.summary, src(a.source).name, ...(a.cats || []).map((c) => cat(c)?.name),
      ...(a.coverage || []).map((c) => src(c.source).name), ...(a.authors || [])].join(" "));
  }
  return list;
}
function matches(a, terms) { return terms.every((t) => a._hay.includes(t)); }

// ------------------------------------------------------------------ routing
function parseHash() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { path: path.replace(/\/+$/, "") || "/", params: Object.fromEntries(new URLSearchParams(qs || "")) };
}
function hashFor(path, params) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "" && v !== null)).toString();
  return `#${path}${qs ? "?" + qs : ""}`;
}
function setParams(path, params, { push = false } = {}) {
  const h = hashFor(path, params);
  if (h === location.hash) return;
  history[push ? "pushState" : "replaceState"](null, "", h);
}

let current = null;
async function route() {
  const { path, params } = parseHash();
  const name = path === "/" ? "latest" : path.split("/")[1];
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.dataset.route === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  const views = { latest: LatestView, research: ResearchView, repos: ReposView, buzz: BuzzView, newsletters: NewslettersView, sources: SourcesView, about: AboutView };
  const View = views[name];
  try {
    if (!View) { main.innerHTML = `<div class="empty">This page does not exist. <a href="#/">See the latest stories</a>.</div>`; return; }
    if (current && current.name === name && current.update) {
      await current.update(params, path);
    } else {
      current = { name, ...View };
      await current.mount(params, path);
    }
  } catch (err) {
    console.error(err);
    main.innerHTML = `<div class="error-box"><strong>Stories could not be loaded.</strong><p>${esc(err.message)} Check your connection and reload the page.</p></div>`;
  }
}
window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);

// ------------------------------------------------------------------ shared components
function coverage(a) {
  const s = src(a.source);
  const outlets = [{ source: a.source, url: a.url, title: a.title }, ...(a.coverage || [])];
  const dots = outlets.map((o) => { const os = src(o.source); return `<i data-tier="${os.tier}" style="--tier:${tierVar(os.tier)}" title="${esc(os.name)}"></i>`; }).join("");
  if (outlets.length === 1) {
    return `<div class="cov"><span class="cov__row"><span class="dots" aria-hidden="true">${dots}</span><span>${esc(store.meta.tiers[s.tier].label)}</span></span></div>`;
  }
  const list = outlets.slice(1).map((o) => { const os = src(o.source);
    return `<li><i style="--tier:${tierVar(os.tier)}" aria-hidden="true"></i><span><strong>${esc(os.name)}</strong>: <a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.title)}</a></span></li>`; }).join("");
  return `<div class="cov"><button class="cov__row" type="button" aria-expanded="false">
      <span class="dots" aria-hidden="true">${dots}</span><span class="cov__label">Reported by ${outlets.length} outlets</span></button>
      <ul class="cov__list" hidden>${list}</ul></div>`;
}
function thumb(a, cls = "") {
  const c = cat(a.cats?.[0]);
  return `<span class="thumb ${cls}" style="--cat:${c?.color || "#2B47D9"}"><span class="thumb__fb" aria-hidden="true"><b>${esc(src(a.source).name)}</b></span>${a.img
    ? `<img src="${esc(a.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span>`;
}
const BUZZ_PLAT = { hn: ["Hacker News", "points"], lobsters: ["Lobsters", "votes"], devto: ["dev.to", "reactions"], mastodon: ["Mastodon", "engagement"], youtube: ["YouTube", "views"] };
const buzzBadge = (b) => (b ? `<a class="buzz-badge" href="${esc(b.d)}" target="_blank" rel="noopener" title="Open the discussion">\u{1F525} ${kfmt(b.s)} ${BUZZ_PLAT[b.p][1]}${b.c ? ` &middot; ${kfmt(b.c)} comments` : ""} on ${esc(BUZZ_PLAT[b.p][0])}</a>` : "");
const whyHTML = (a) => (a.why ? `<p class="why"><b>Why it matters</b> ${esc(a.why)} <span class="ai-tag" title="Written by an AI model from the article's own text. Check the source for details.">AI</span></p>` : "");
const tagsHTML = (a) => (a.tags?.length ? `<span class="tags">${a.tags.map((t) => `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`).join("")}</span>` : "");
function catStyle(id) { const c = cat(id); return c ? `--cat:${c.color}` : ""; }
function storyHTML(a) {
  const c = cat(a.cats[0]);
  return `<article class="story" style="${catStyle(a.cats[0])}"><div class="story__body">
    <div class="story__meta">
      <button class="story__cat" type="button" data-cat="${esc(a.cats[0])}">${esc(c?.name || "AI")}</button>
      <span class="story__src">${esc(src(a.source).name)}</span>
      <time datetime="${esc(a.date)}" title="${esc(new Date(a.date).toLocaleString("en-GB"))}">${esc(relTime(a.date))}</time>
    </div>
    <h3 class="story__title"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
    ${a.summary ? `<p class="story__summary">${esc(a.summary)}</p>` : ""}
    ${whyHTML(a)}${a.buzz ? `<p class="buzz-line">${buzzBadge(a.buzz)}</p>` : ""}
    <div class="story__foot">${tagsHTML(a)}${coverage(a)}</div></div>
    <a class="story__thumb" href="${esc(a.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${thumb(a)}</a>
  </article>`;
}
const searchIcon = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="m21 21-4.3-4.3M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"/></svg>`;
const dlIcon = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M12 3v12m0 0-5-5m5 5 5-5M4 19h16"/></svg>`;

main.addEventListener("click", (e) => {
  const cov = e.target.closest("button.cov__row");
  if (cov) {
    const list = cov.nextElementSibling; const open = cov.getAttribute("aria-expanded") === "true";
    cov.setAttribute("aria-expanded", String(!open)); list.hidden = open;
  }
});

// ------------------------------------------------------------------ Latest
const LatestView = {
  async mount(params) {
    main.innerHTML = `
      <section class="hero" id="hero" aria-label="Lead stories"><div class="hero__inner" id="lead"></div></section>
      <section class="pulse" id="pulse" aria-label="This week by category"></section>
      <section class="topweek" id="topweek" aria-label="Most important this week"></section>
      <div class="toolbar" role="search">
        <label class="search"><span class="visually-hidden">Search stories</span>${searchIcon}
          <input id="q" type="search" placeholder="Search headlines, companies, models" autocomplete="off"></label>
        <label><span class="visually-hidden">Time period</span><select class="select" id="period"></select></label>
        <div class="seg" role="group" aria-label="Sort stories">
          <button type="button" data-sort="latest">Latest</button><button type="button" data-sort="top">Most important</button>
        </div>
      </div>
      <p class="result-line" id="resultline" aria-live="polite"></p>
      <div class="board">
        <aside class="rail" aria-label="Categories"><nav><h2 class="visually-hidden">Categories</h2><ul id="rail"></ul></nav></aside>
        <section class="feed" id="feed" aria-label="Stories"></section>
        <aside class="aside" id="aside" aria-label="Highlights"></aside>
      </div>`;
    const q = main.querySelector("#q");
    let t;
    q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => this.set({ q: q.value.trim() }), 160); });
    main.querySelector("#period").addEventListener("change", (e) => this.set({ period: e.target.value }, true));
    main.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => this.set({ sort: b.dataset.sort }, true)));
    main.querySelector(".board").addEventListener("click", (e) => {
      const c = e.target.closest("[data-cat]");
      if (c) { this.set({ cat: this.params.cat === c.dataset.cat ? "" : c.dataset.cat }, true); window.scrollTo({ top: main.querySelector(".toolbar").offsetTop - 8 }); }
      const tq = e.target.closest("[data-q]");
      if (tq) { q.value = tq.dataset.q; this.set({ q: tq.dataset.q }, true); }
      if (e.target.closest("#more")) { this.shown += PAGE; this.renderFeed(false); }
      if (e.target.closest("[data-reset]")) { q.value = ""; this.set({ q: "", cat: "", period: "" }, true); }
    });
    for (const id of ["#pulse", "#topweek"]) main.querySelector(id).addEventListener("click", (e) => {
      const c = e.target.closest("[data-cat]");
      if (c) { this.set({ cat: c.dataset.cat }, true); window.scrollTo({ top: main.querySelector(".toolbar").offsetTop - 8 }); }
    });
    this.renderAside();
    await this.update(params);
  },
  set(patch, push = false) {
    this.params = { ...this.params, ...patch };
    setParams("/", this.params, { push });
    this.update(this.params);
  },
  async update(params) {
    this.params = { ...params };
    const { period = "", sort = "latest" } = this.params;
    const qInput = main.querySelector("#q");
    if (qInput.value.trim() !== (this.params.q || "")) qInput.value = this.params.q || "";
    main.querySelectorAll("[data-sort]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.sort === sort)));
    const sel = main.querySelector("#period");
    sel.innerHTML = [["", "Last 45 days"], ["7", "Last 7 days"], ["1", "Last 24 hours"],
      ...store.meta.archive_months.map((m) => [m.month, `${fmtDate(m.month + "-01T00:00:00Z", { month: "long", year: "numeric" })} (${m.count})`])]
      .map(([v, l]) => `<option value="${v}" ${v === period ? "selected" : ""}>${esc(l)}</option>`).join("");

    let pool;
    if (/^\d{4}-\d{2}$/.test(period)) {
      if (!store.archive.has(period)) store.archive.set(period, indexArticles((await getJSON(`archive/${period}.json`)).articles));
      pool = store.archive.get(period);
    } else {
      pool = store.latest;
      if (period) { const cut = Date.now() - Number(period) * DAY; pool = pool.filter((a) => new Date(a.date) >= cut); }
    }
    const terms = fold(this.params.q || "").split(/\s+/).filter(Boolean);
    const searched = terms.length ? pool.filter((a) => matches(a, terms)) : pool;
    const showLead = !terms.length && !this.params.cat && !period && sort === "latest";
    this.renderLead(showLead);
    this.renderRail(searched);
    let list = this.params.cat ? searched.filter((a) => a.cats.includes(this.params.cat)) : searched;
    if (showLead) list = list.filter((a) => !this.heroIds.has(a.id));
    list = [...list].sort(sort === "top" ? (a, b) => b.score - a.score || b.date.localeCompare(a.date) : (a, b) => b.date.localeCompare(a.date));
    this.list = list; this.shown = PAGE;
    const filtered = terms.length || this.params.cat || period;
    const bits = [];
    if (this.params.cat) bits.push(`in ${cat(this.params.cat)?.name}`);
    if (terms.length) bits.push(`matching “${esc(this.params.q)}”`);
    main.querySelector("#resultline").innerHTML = filtered
      ? `${plural(list.length, "story", "stories")} ${bits.join(" ")} <button type="button" data-reset>Clear filters</button>` : "";
    this.renderFeed(true);
  },
  renderLead(show) {
    const hero = main.querySelector("#hero"), el = main.querySelector("#lead");
    const extras = [main.querySelector("#pulse"), main.querySelector("#topweek")];
    this.heroIds = new Set();
    hero.hidden = !show; extras.forEach((x) => (x.hidden = !show));
    if (!show) return;
    const recent = store.latest.filter((a) => Date.now() - new Date(a.date) < 4 * DAY);
    const ranked = [...(recent.length >= 5 ? recent : store.latest)].sort((a, b) => b.hot - a.hot);
    const lead = ranked.find((a) => a.img) || ranked[0];
    if (!lead) { hero.hidden = true; return; }
    const seen = new Set([lead.source]); const leading = [];
    for (const a of ranked) { if (a !== lead && !seen.has(a.source)) { leading.push(a); seen.add(a.source); } if (leading.length === 4) break; }
    this.heroIds = new Set([lead.id, ...leading.map((a) => a.id)]);
    const c = cat(lead.cats[0]);
    el.innerHTML = `
      <article class="lead" style="${catStyle(lead.cats[0])}">
        <a class="lead__media" href="${esc(lead.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${thumb(lead, "thumb--lead")}</a>
        <div class="lead__body">
          <span class="pill">${esc(c?.name)}</span>
          <h1 class="lead__title"><a href="${esc(lead.url)}" target="_blank" rel="noopener">${esc(lead.title)}</a></h1>
          ${lead.summary ? `<p class="lead__summary">${esc(lead.summary)}</p>` : ""}
          ${whyHTML(lead)}
          ${tagsHTML(lead)}
          <div class="lead__meta"><strong>${esc(src(lead.source).name)}</strong><time datetime="${esc(lead.date)}">${esc(relTime(lead.date))}</time>${coverage(lead)}</div>
        </div>
      </article>
      <div class="leading"><h2>Leading now</h2><ol>${leading.map((a) => `
        <li style="${catStyle(a.cats[0])}">
          <a class="leading__thumb" href="${esc(a.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${thumb(a, "thumb--s")}</a>
          <div><div class="story__meta"><span class="story__cat" style="cursor:auto">${esc(cat(a.cats[0])?.name)}</span><time datetime="${esc(a.date)}">${esc(relTime(a.date))}</time></div>
          <a class="t" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a>
          <div class="leading__src">${esc(src(a.source).name)}${a.coverage ? `, plus ${a.coverage.length} more` : ""}</div></div>
        </li>`).join("")}</ol></div>`;
    this.renderPulse();
    this.renderTopWeek();
  },
  renderPulse() {
    const week = store.latest.filter((a) => Date.now() - new Date(a.date) < 7 * DAY);
    const counts = {}; for (const a of week) counts[a.cats[0]] = (counts[a.cats[0]] || 0) + 1;
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ c: cat(id), n })).filter((r) => r.c);
    const total = week.length || 1;
    main.querySelector("#pulse").innerHTML = `
      <div class="pulse__head"><h2>This week in AI</h2><p>${plural(week.length, "story", "stories")} across ${rows.length} categories. Select one to filter.</p></div>
      <div class="pulse__bar">${rows.map((r) => `<button type="button" data-cat="${r.c.id}" style="--cat:${r.c.color};flex:${r.n}" title="${esc(r.c.name)}: ${r.n}" aria-label="${esc(r.c.name)}, ${r.n} stories"></button>`).join("")}</div>
      <ul class="pulse__legend">${rows.slice(0, 8).map((r) => `<li><button type="button" data-cat="${r.c.id}" style="--cat:${r.c.color}"><span class="sw"></span>${esc(r.c.name)}<b>${Math.round(100 * r.n / total)}%</b></button></li>`).join("")}</ul>`;
  },
  renderTopWeek() {
    const week = store.latest.filter((a) => Date.now() - new Date(a.date) < 7 * DAY && !this.heroIds.has(a.id))
      .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date));
    const seen = new Set(); const picks = [];
    for (const a of week) { if (!seen.has(a.source)) { picks.push(a); seen.add(a.source); } if (picks.length === 4) break; }
    picks.forEach((a) => this.heroIds.add(a.id));
    main.querySelector("#topweek").innerHTML = picks.length ? `<h2 class="sec-title">Most important this week</h2>
      <div class="cards">${picks.map((a) => `<article class="card" style="${catStyle(a.cats[0])}">
        <a class="card__media" href="${esc(a.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${thumb(a)}</a>
        <div class="card__body"><button type="button" class="card__cat" data-cat="${esc(a.cats[0])}">${esc(cat(a.cats[0])?.name)}</button>
          <h3><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
          <div class="story__meta"><span class="story__src">${esc(src(a.source).name)}</span><time datetime="${esc(a.date)}">${esc(relTime(a.date))}</time></div>
          ${tagsHTML(a)}</div></article>`).join("")}</div>` : "";
  },
  renderRail(pool) {
    const counts = {}; for (const a of pool) for (const c of a.cats) counts[c] = (counts[c] || 0) + 1;
    const active = this.params.cat || "";
    main.querySelector("#rail").innerHTML =
      `<li><button type="button" data-cat="" aria-pressed="${!active}" style="--cat:var(--ink)"><span class="sw"></span>All stories<span class="n">${pool.length}</span></button></li>` +
      store.meta.categories.map((c) => `<li><button type="button" data-cat="${c.id}" aria-pressed="${active === c.id}" style="--cat:${c.color}">
        <span class="sw"></span>${esc(c.name)}<span class="n">${counts[c.id] || 0}</span></button></li>`).join("");
  },
  renderFeed(reset) {
    const feed = main.querySelector("#feed");
    if (!this.list.length) {
      feed.innerHTML = `<div class="empty">No stories match these filters. Try a broader search or <button class="btn" type="button" data-reset>clear filters</button></div>`;
      return;
    }
    const byDate = (this.params.sort || "latest") === "latest";
    let html = "", lastDay = "";
    for (const a of this.list.slice(0, this.shown)) {
      const d = dayLabel(a.date);
      if (byDate && d !== lastDay) { html += `<h2 class="day">${esc(d)}</h2>`; lastDay = d; }
      html += storyHTML(a);
    }
    if (this.shown < this.list.length) html += `<button class="more" id="more" type="button">Show more stories (${this.list.length - this.shown} remaining)</button>`;
    feed.innerHTML = html;
  },
  async renderAside() {
    const aside = main.querySelector("#aside");
    const trending = store.meta.trending.map((t) => `<li><button type="button" data-q="${esc(t.query)}">${esc(t.topic)}
      <span class="c">${t.count}</span>${t.change >= 1.4 ? `<span class="up" title="Rising">▲</span>` : ""}</button></li>`).join("");
    aside.innerHTML = `
      <section class="panel"><h2>Trending this week</h2>${trending ? `<ul class="trend">${trending}</ul>` : `<p class="empty">Not enough stories yet.</p>`}</section>
      <section class="panel" id="dl-panel"><h2>Newsletters</h2><div class="dl"><p class="result-line">Loading editions</p></div></section>
      <section class="panel" id="papers-panel"><h2>Most upvoted papers</h2><ul class="papers-mini"><li><span>Loading papers</span></li></ul></section>
      <section class="panel"><h2>Coverage strip</h2>
        <ul class="legend">${Object.entries(store.meta.tiers).map(([t, v]) => `<li><span class="dots"><i data-tier="${t}" style="--tier:${tierVar(t)}"></i></span>${esc(v.label)}</li>`).join("")}</ul>
        <p class="result-line">Each dot is one outlet that reported the story.</p></section>`;
    loadIssues().then((issues) => {
      const pick = ["monthly", "quarterly"].map((t) => issues.find((i) => i.type === t)).filter(Boolean);
      main.querySelector("#dl-panel .dl").innerHTML = pick.length ? pick.map((i) => `
        <div class="dl__item"><span class="mini-cover" aria-hidden="true">${esc(i.type === "monthly" ? i.title.slice(0, 3) : i.title.split(" ")[0])}</span><strong>${esc(i.title)}</strong><span>${i.type === "monthly" ? "Monthly" : "Quarterly"}${i.status === "in_progress" ? ", in progress" : ""}, ${kb(i.pdf_bytes)}</span>
          <a class="btn btn--primary" href="${esc(i.pdf)}" download aria-label="Download ${esc(i.title)} ${i.type} newsletter as PDF">${dlIcon}PDF</a></div>`).join("") +
        `<a class="link" href="#/newsletters">All editions</a>` : `<p class="result-line">The first edition will appear once enough stories are collected.</p>`;
    }).catch(() => { main.querySelector("#dl-panel .dl").innerHTML = `<p class="result-line">Editions could not be loaded.</p>`; });
    loadPapers().then((papers) => {
      const week = papers.filter((p) => Date.now() - new Date(p.date) < 10 * DAY).slice(0, 5);
      main.querySelector("#papers-panel .papers-mini").innerHTML = (week.length ? week : papers.slice(0, 5)).map((p) => `
        <li><a href="${esc(p.hf || p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><span>${p.upvotes ? `${p.upvotes} upvotes, ` : ""}${esc(fmtDate(p.date))}</span></li>`).join("")
        + `<li style="border:0"><a class="link" href="#/research">All research</a></li>`;
    }).catch(() => {});
  },
};

async function loadPapers() { if (!store.papers) store.papers = indexArticles((await getJSON("papers.json")).papers); return store.papers; }
async function loadIssues() { if (!store.issues) store.issues = (await getJSON("newsletters.json")).issues; return store.issues; }

// ------------------------------------------------------------------ Research
const ResearchView = {
  async mount(params) {
    main.innerHTML = `<header class="page-head"><h1>Research</h1>
      <p>Papers from the last 30 days, ranked by community upvotes on Hugging Face Daily Papers, with the latest arXiv preprints in AI, language, vision, learning, robotics, and multi-agent systems. Preprints are not peer reviewed.</p></header>
      <div class="toolbar" role="search"><label class="search"><span class="visually-hidden">Search papers</span>${searchIcon}<input id="pq" type="search" placeholder="Search titles, abstracts, authors"></label></div>
      <div class="board" style="grid-template-columns:minmax(0,1fr)"><aside class="rail" aria-label="Topics"><ul id="prail"></ul></aside><section id="plist"></section></div>`;
    const q = main.querySelector("#pq"); let t;
    q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => this.set({ q: q.value.trim() }), 160); });
    main.querySelector("#prail").addEventListener("click", (e) => { const b = e.target.closest("[data-cat]"); if (b) this.set({ cat: this.params.cat === b.dataset.cat ? "" : b.dataset.cat }, true); });
    main.querySelector("#plist").addEventListener("click", (e) => { if (e.target.closest("#pmore")) { this.shown += PAGE; this.render(); } });
    await loadPapers();
    q.value = params.q || "";
    this.update(params);
  },
  set(patch, push) { this.params = { ...this.params, ...patch }; setParams("/research", this.params, { push }); this.update(this.params); },
  update(params) {
    this.params = { ...params }; this.shown = PAGE;
    const terms = fold(params.q || "").split(/\s+/).filter(Boolean);
    const pool = terms.length ? store.papers.filter((p) => matches(p, terms)) : store.papers;
    const counts = {}; for (const p of pool) for (const c of p.cats) if (c !== "research") counts[c] = (counts[c] || 0) + 1;
    const cats = store.meta.categories.filter((c) => counts[c.id]);
    main.querySelector("#prail").innerHTML = `<li><button type="button" data-cat="" aria-pressed="${!params.cat}" style="--cat:var(--ink)"><span class="sw"></span>All papers<span class="n">${pool.length}</span></button></li>` +
      cats.map((c) => `<li><button type="button" data-cat="${c.id}" aria-pressed="${params.cat === c.id}" style="--cat:${c.color}"><span class="sw"></span>${esc(c.name)}<span class="n">${counts[c.id]}</span></button></li>`).join("");
    this.list = params.cat ? pool.filter((p) => p.cats.includes(params.cat)) : pool;
    this.render();
  },
  render() {
    const el = main.querySelector("#plist");
    if (!this.list.length) { el.innerHTML = `<p class="empty">No papers match this search.</p>`; return; }
    el.innerHTML = this.list.slice(0, this.shown).map((p) => {
      const c = cat(p.cats.find((x) => x !== "research") || "research");
      return `<article class="paper" style="--cat:${c.color}">
        <div class="paper__votes">${p.upvotes ? `<b>${p.upvotes}</b><span>upvotes</span>` : `<span>arXiv</span>`}</div>
        <div><div class="story__meta"><span class="story__cat" style="cursor:auto">${esc(c.name)}</span><span>${esc(src(p.source).name)}</span><time datetime="${esc(p.date)}">${esc(fmtDate(p.date))}</time></div>
          <h3 class="story__title"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a></h3>
          ${p.authors ? `<p class="paper__authors">${esc(p.authors.join(", "))}${p.authors.length >= 4 ? " et al." : ""}</p>` : ""}
          <p class="story__summary">${esc(p.summary)}</p>
          <div class="paper__links"><a href="${esc(p.url)}" target="_blank" rel="noopener">Abstract on arXiv</a>${p.hf ? `<a href="${esc(p.hf)}" target="_blank" rel="noopener">Discussion on Hugging Face</a>` : ""}</div></div>
        ${p.img ? `<a class="paper__thumb" href="${esc(p.hf || p.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${thumb(p)}</a>` : "<span></span>"}
      </article>`;
    }).join("") + (this.shown < this.list.length ? `<button class="more" id="pmore" type="button">Show more papers (${this.list.length - this.shown} remaining)</button>` : "");
  },
};

// ------------------------------------------------------------------ Newsletters
const NewslettersView = {
  async mount(params, path) {
    const id = path.split("/")[2];
    const issues = await loadIssues();
    if (id) return this.reader(issues.find((i) => i.id === id), id);
    const kindLabel = (i) => (i.type === "monthly" ? "Monthly" : "Quarterly");
    const cover = (i) => `<a class="cover" href="#/newsletters/${esc(i.id)}" aria-hidden="true" tabindex="-1">
        <span class="cover__top"><img src="assets/mark.svg" alt=""><b>ISSUE #${i.issue_no || 1}</b></span>
        <span class="cover__title">AI <em>News</em> Update</span>
        <span class="cover__hero"><span>${esc(kindLabel(i).toUpperCase())}</span><strong>${esc(i.title)}</strong></span>
        <span class="cover__kpis"><i class="k0"></i><i class="k1"></i><i class="k2"></i><i class="k3"></i></span></a>`;
    const row = (i) => `<article class="issue">${cover(i)}<div class="issue__main">
      <div class="issue__top"><h3 class="issue__title"><a href="#/newsletters/${esc(i.id)}">${esc(i.title)}</a></h3>
        ${i.status === "in_progress" ? `<span class="badge badge--live">In progress, updated ${esc(relTime(i.generated))}</span>` : `<span class="badge">Issue #${i.issue_no || 1}, published ${esc(fmtDate(i.generated))}</span>`}</div>
      <p class="issue__stats">${plural(i.stats.stories, "technology story", "technology stories")}, ${plural(i.stats.papers, "paper")}, ${plural(i.stats.sources, "source")}. ${esc(fmtDate(i.start))} to ${esc(fmtDate(i.end))}.</p>
      ${i.headline ? `<p class="issue__headline">Leading with: ${esc(i.headline)}</p>` : ""}
      <div class="issue__actions"><a class="btn btn--primary" href="${esc(i.pdf)}" download>${dlIcon}Download PDF (${kb(i.pdf_bytes)})</a>
        <a class="btn" href="#/newsletters/${esc(i.id)}">Read online</a></div></div>
    </article>`;
    const monthly = issues.filter((i) => i.type === "monthly"), quarterly = issues.filter((i) => i.type === "quarterly");
    main.innerHTML = `<header class="page-head"><h1>AI News Update newsletters</h1>
      <p>Each edition is a technology briefing for companies: the most important AI developments, organised into chapters, with quick stats, what is ready to use, and what it means for your business. Every headline links to its original source.</p></header>
      ${issues.length ? `<div class="editions">
        <section aria-labelledby="mh"><h2 id="mh">Monthly editions</h2><p>The current month updates as new stories arrive.</p>${monthly.map(row).join("")}</section>
        <section aria-labelledby="qh"><h2 id="qh">Quarterly editions</h2><p>A wider view across three months.</p>${quarterly.map(row).join("")}</section>
      </div>` : `<p class="empty">The first edition will appear once enough stories have been collected.</p>`}`;
  },
  async reader(meta, id) {
    if (!meta) { main.innerHTML = `<div class="empty">That edition does not exist. <a href="#/newsletters">See all editions</a>.</div>`; return; }
    const i = await getJSON(`newsletters/${id}.json`);
    const unit = i.type === "monthly" ? "month" : "quarter";
    const dev = (a) => `<article class="dev" style="${catStyle(a.cats[0])}"><div class="dev__top">
        <a href="${esc(a.url)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${thumb(a)}</a>
        <div><h3><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a></h3>
        <div class="story__meta"><span class="story__src">${esc(src(a.source).name)}</span><span>${esc(fmtDate(a.date))}</span>${a.upvotes ? `<span>${a.upvotes} upvotes</span>` : ""}</div></div></div>
        ${a.summary ? `<p>${esc(a.summary)}</p>` : ""}${whyHTML(a)}${tagsHTML(a)}</article>`;
    const chapter = (c) => {
      const st = c.stats, lab = c.stat_labels || {};
      const stats = [[st.stories, lab.stories || "Stories"], [st.sources, "Sources"], [st.available, lab.available || "Available now"], [st.open_source, "Open source"]];
      const more = c.more.map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.title)}</a> <span>${esc(src(a.source).name)}</span></li>`).join("");
      const ready = c.ready.map((x) => `<li><span class="tag" data-tag="${esc(x.tag)}">${esc(x.tag)}</span><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></li>`).join("");
      return `<section class="rsec" id="ch-${c.number}" style="--cat:${c.color}">
        <div class="ch-banner"><small>CHAPTER ${String(c.number).padStart(2, "0")} / ${esc(c.name.toUpperCase())}</small><h2>${esc(c.kicker)}</h2><p>${esc(c.intro)}</p><div class="num" aria-hidden="true">${String(c.number).padStart(2, "0")}</div></div>
        <div class="dev-grid">${c.items.map(dev).join("")}</div>
        <div class="boxes">
          <div class="box"><span class="box-h">QUICK STATS</span><div class="stats">${stats.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${esc(l)}</span></div>`).join("")}</div>
            ${more ? `<strong>More this ${unit}</strong><ul class="mlist" style="margin-top:8px">${more}</ul>` : ""}</div>
          <div class="box"><span class="box-h red">${ready ? "READY TO USE" : "WATCH LIST"}</span>${ready ? `<ul class="rlist">${ready}</ul>` : `<p class="result-line">Nothing here is generally available yet. Worth tracking.</p>`}</div>
        </div>
        <div class="callout"><div class="ico" aria-hidden="true">&#10148;</div><div><h4>WHAT THIS MEANS FOR YOUR BUSINESS</h4><p>${esc(c.advice)}</p>
          ${c.actions.length ? `<ul>${c.actions.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div></div>
      </section>`;
    };
    const total = i.category_share.reduce((n, c) => n + c.count, 0) || 1;
    const max = Math.max(...i.category_share.map((c) => c.count), 1);
    const trends = `<section class="rsec" id="ch-trends" style="--cat:#0F1A3A">
      <div class="ch-banner"><small>SIGNALS</small><h2>Trends and sources</h2><p>What the coverage was about, and what changed against the previous period.</p></div>
      <div class="boxes">
        <div class="box"><span class="box-h">MOST DISCUSSED TOPICS</span><table class="data"><thead><tr><th>Topic</th><th class="num">Mentions</th><th class="num">Before</th><th class="num">Change</th></tr></thead><tbody>
          ${i.rising.map((r) => `<tr><td>${esc(r.topic)}</td><td class="num">${r.mentions}</td><td class="num">${r.previous}</td><td class="num">${r.change_pct === null ? "new" : (r.change_pct > 0 ? "+" : "") + r.change_pct + "%"}</td></tr>`).join("")}</tbody></table></div>
        <div class="box"><span class="box-h">COVERAGE BY CATEGORY</span><table class="data"><tbody>
          ${i.category_share.map((c) => `<tr><td>${esc(c.name)}</td><td style="width:40%"><div class="bar-cell" style="--cat:${c.color};width:${(100 * c.count / max).toFixed(1)}%"></div></td><td class="num">${Math.round(100 * c.count / total)}%</td></tr>`).join("")}</tbody></table></div>
      </div>
      <div class="box" style="margin-top:14px"><span class="box-h">SOURCES</span><table class="data"><tbody>
        ${i.sources.map((s) => `<tr><td><a href="${esc(src(s.id).home)}" target="_blank" rel="noopener">${esc(s.name)}</a></td><td>${esc(store.meta.tiers[s.tier].label)}</td><td class="num">${s.count}</td></tr>`).join("")}</tbody></table></div>
    </section>`;
    const toc = [["top", "&#9733;", "Top stories", "#5B3DF5"], ...i.chapters.map((c) => [String(c.number), String(c.number).padStart(2, "0"), c.kicker, c.color]), ["trends", "&#8599;", "Trends and sources", "#0F1A3A"]];
    main.innerHTML = `<header class="page-head"><p class="crumb"><a href="#/newsletters">All editions</a></p>
        <h1>AI News Update: ${esc(i.title)}</h1><p>Issue #${i.issue_no || 1}, ${i.type === "monthly" ? "monthly" : "quarterly"} edition covering ${esc(fmtDate(i.start))} to ${esc(fmtDate(i.end))}.${i.status === "in_progress" ? " This period is still under way; the edition updates as stories arrive." : ""}</p>
        <div class="issue__actions" style="margin-top:16px"><a class="btn btn--primary" href="${esc(meta.pdf)}" download>${dlIcon}Download PDF (${kb(meta.pdf_bytes)})</a></div></header>
      <div class="reader"><div>
        <div class="issue-hero"><small>LEADING THIS ${unit.toUpperCase()}</small><h2>${esc(i.headline)}</h2><div class="pills">${(i.pills || []).map((p) => `<span>${esc(p)}</span>`).join("")}</div></div>
        <div class="kpi-row">${i.kpis.map((k, n) => `<div class="kpi k${n}"><b>${k.value.toLocaleString("en-GB")}</b><span>${esc(k.label)}</span></div>`).join("")}</div>
        <div class="brief"><h2>What&#8217;s new in AI: ${esc(i.title)}</h2><div class="bar"></div>${i.brief.map((l) => `<p>${esc(l)}</p>`).join("")}
          ${i.backfilled ? `<p class="note">Assembled from source archives when the service started, so news-outlet coverage is thinner than in later editions.</p>` : ""}</div>
        <section class="rsec" id="ch-top" style="--cat:#5B3DF5"><div class="ch-banner"><small>THE BIG PICTURE</small><h2>Top stories</h2><p>Ranked by source authority, independent coverage and real-world availability.</p></div>
          <div class="dev-grid">${i.top_stories.map(dev).join("")}</div></section>
        ${i.chapters.map(chapter).join("")}
        ${trends}
      </div>
      <nav class="reader__toc" aria-label="In this edition"><h2>In this edition</h2><ol>${toc.map(([k, n, t, c]) => `<li><a href="#/newsletters/${esc(id)}" data-jump="ch-${k}"><b style="--cat:${c}">${n}</b>${esc(t)}</a></li>`).join("")}</ol></nav></div>`;
    main.querySelector(".reader__toc").addEventListener("click", (e) => { const a = e.target.closest("[data-jump]"); if (a) { e.preventDefault(); document.getElementById(a.dataset.jump).scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); } });
    window.scrollTo(0, 0);
  },
};

// ------------------------------------------------------------------ Sources
// ------------------------------------------------------------------ Repos
const SAVED_KEY = "gap-saved-repos";
function loadSaved() { try { return JSON.parse(localStorage.getItem(SAVED_KEY) || "{}"); } catch (e) { return {}; } }
function writeSaved(obj) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(obj)); return true; } catch (e) { return false; } }
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const bookmark = (on) => `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1Z" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
const REPO_TABS = {
  trending: ["\u{1F525} Trending", "Most stars gained in the last 7 days across open-source AI."],
  new: ["\u{1F680} New & rising", "Created in the last 90 days and growing fast for their age."],
  recognized: ["\u{1F3C6} Getting recognized", "Broke through this week: in the news, code behind a top research paper, a star milestone, or a major release."],
  gems: ["\u{1F48E} Hidden gems", "Under 2,500 stars, actively developed, with releases and steady growth. Easy to miss, worth a look."],
  essentials: ["\u2705 Proven essentials", "Established projects that are still actively maintained: the safe choices for real products."],
  history: ["\u{1F4DA} History", "Every repo this page has featured, kept permanently so older picks stay findable. Star counts are re-checked daily; \"+N\" is growth since the day it was first featured."],
  saved: ["\u{1F516} Saved", "Repos you saved. They are stored in this browser; use Export to move them to another device."],
};
const LANG_COLORS = { Python: "#3572A5", TypeScript: "#3178C6", JavaScript: "#E5B700", Rust: "#DEA584", Go: "#00ADD8", "C++": "#F34B7D", C: "#555555",
  Java: "#B07219", Kotlin: "#A97BFF", Swift: "#F05138", "Jupyter Notebook": "#DA5B0B", Shell: "#4EAA25", Ruby: "#701516", "C#": "#178600", Zig: "#EC915C", Dart: "#00B4AB" };
const langColor = (l) => LANG_COLORS[l] || "#9AA3BF";
const USE_FILTERS = ["Agents", "MCP", "RAG", "Local & inference", "Coding tools", "Fine-tuning", "Multimodal"];

const ReposView = {
  async mount(params) {
    if (!store.repos) {
      try { store.repos = await getJSON("repos.json"); } catch (e) { store.repos = null; }
    }
    main.innerHTML = `<header class="page-head"><h1>Open-source AI repos</h1>
        <p>What AI developers are building and starring on GitHub, updated daily: trending projects, fast-rising newcomers, hidden gems and the proven essentials. Save the ones you like to come back to them.</p></header>
      ${store.repos ? `<section class="themes" aria-label="Emerging use cases"><h2>Emerging use cases</h2><div class="themes__list" id="themes"></div></section>` : ""}
      <div class="repo-tabs" role="tablist" id="rtabs"></div>
      <p class="tab-desc" id="rdesc"></p>
      <div class="repo-tools">
        <label class="search"><span class="visually-hidden">Search repos</span>${searchIcon}<input id="rq" type="search" placeholder="Search name, description or topic" autocomplete="off"></label>
        <div class="chips" id="ruse" role="group" aria-label="Use case"></div>
        <label class="check"><input type="checkbox" id="rcomm"> Commercial-friendly license</label>
        <label class="sortbox" id="rsortbox" hidden><span class="visually-hidden">Sort</span><select class="select" id="rsort">
          <option value="recent">Recently featured</option><option value="first">First featured (oldest first)</option>
          <option value="gained">Most stars gained since featured</option><option value="stars">Most stars</option></select></label>
        <div class="seg" role="group" aria-label="Layout"><button type="button" data-view="cards">Cards</button><button type="button" data-view="list">List</button></div>
      </div>
      <p class="result-line" id="rline" aria-live="polite"></p>
      <div class="repo-grid" id="rgrid"></div>
      <div class="saved-tools" id="rsavedtools" hidden>
        <button class="btn" type="button" id="rexport">Export saved list</button>
        <label class="btn"><input type="file" id="rimport" accept="application/json" hidden>Import saved list</label>
      </div>`;
    const q = main.querySelector("#rq"); let t;
    q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => this.set({ q: q.value.trim() }), 150); });
    main.querySelector("#rcomm").addEventListener("change", (e) => this.set({ comm: e.target.checked ? "1" : "" }));
    main.querySelector("#rsort").addEventListener("change", (e) => this.set({ sort: e.target.value }));
    main.querySelector("#rexport").addEventListener("click", () => this.exportSaved());
    main.querySelector("#rimport").addEventListener("change", (e) => this.importSaved(e.target.files[0]));
    this.update(params);
  },
  set(patch, push = false) { this.params = { ...this.params, ...patch }; setParams("/repos", this.params, { push }); this.update(this.params); },
  update(params, keepLimit = false) {
    if (keepLimit !== true || !this.limit) this.limit = 30;
    this.params = { tab: "trending", ...params };
    const p = this.params, data = store.repos, saved = loadSaved();
    const tab = REPO_TABS[p.tab] ? p.tab : "trending";
    main.querySelector("#rtabs").innerHTML = Object.entries(REPO_TABS).map(([k, [label]]) =>
      `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}">${esc(label)}${k === "saved" ? ` <span class="count">${Object.keys(saved).length}</span>` : ""}</button>`).join("");
    main.querySelector("#rdesc").textContent = REPO_TABS[tab][1];
    main.querySelector("#rq").value = p.q || "";
    main.querySelector("#rcomm").checked = p.comm === "1";
    main.querySelector("#ruse").innerHTML = USE_FILTERS.map((u) => `<button type="button" data-use="${esc(u)}" aria-pressed="${p.use === u}">${esc(u)}</button>`).join("");
    main.querySelector("#rsavedtools").hidden = tab !== "saved";
    main.querySelector("#rsortbox").hidden = tab !== "history";
    main.querySelector("#rsort").value = p.sort || "recent";
    if (tab === "history" && !store.reposArchive) {
      if (!this.loadingArchive) {
        this.loadingArchive = true;
        getJSON("repos-archive.json").then((d) => { store.reposArchive = d; store.archiveById = new Map(d.items.map((x) => [x.id, x])); })
          .catch(() => { store.reposArchive = { items: [], count: 0 }; store.archiveById = new Map(); })
          .finally(() => { this.loadingArchive = false; if (current?.name === "repos") this.update(this.params, true); });
      }
      main.querySelector("#rgrid").innerHTML = `<p class="loading">Loading the history</p>`; return;
    }
    if (data) {
      main.querySelector("#themes").innerHTML = data.themes.map((th) => `<button type="button" data-topic="${esc(th.topic)}" aria-pressed="${p.topic === th.topic}">
        ${esc(th.topic.replace(/-/g, " "))}<span class="c">${th.repos}</span>${th.rising ? `<span class="up" title="Growing faster than last week">&#9650;</span>` : ""}${th.new ? `<span class="badge-new">new</span>` : ""}</button>`).join("");
    }
    // Build the list for this tab.
    let list;
    if (tab === "saved") {
      list = Object.values(saved).sort((a, b) => b.savedAt.localeCompare(a.savedAt))
        .map((s) => ({ r: (data && data.repos[s.repo.id]) || s.repo, reason: `Saved ${relTime(s.savedAt)}`, saved: true }));
    } else if (tab === "history") {
      const sortBy = { recent: (a, b) => b.last.localeCompare(a.last) || b.repo.stars - a.repo.stars, first: (a, b) => a.first.localeCompare(b.first) || b.repo.stars - a.repo.stars,
        gained: (a, b) => b.gained - a.gained, stars: (a, b) => b.repo.stars - a.repo.stars }[p.sort || "recent"];
      const names = { trending: "Trending", new: "New & rising", recognized: "Getting recognized", gems: "Hidden gems", essentials: "Proven essentials" };
      list = [...store.reposArchive.items].sort(sortBy).map((x) => ({ r: x.repo, saved: false,
        reason: `Featured ${fmtDate(x.first + "T00:00:00Z", { day: "numeric", month: "short" })}${x.days > 1 ? `, ${x.days} days on the lists` : ""} in ${x.sections.map((k) => names[k]).join(", ")}`
          + (x.gained > 0 ? `. +${kfmt(x.gained)} stars since` : "") }));
    } else if (!data) {
      list = [];
    } else if (p.topic) {
      // A theme spans all sections: show every tracked repo carrying that topic.
      const seen = new Set(); list = [];
      for (const sec of Object.keys(data.sections)) for (const e of data.sections[sec]) {
        const r = data.repos[e.id]; if (!seen.has(e.id) && r.topics.concat([]).includes(p.topic)) { seen.add(e.id); list.push({ r, reason: e.reason }); }
      }
    } else {
      list = data.sections[tab].map((e) => ({ r: data.repos[e.id], reason: e.reason }));
    }
    const terms = fold(p.q || "").split(/\s+/).filter(Boolean);
    list = list.filter(({ r }) => (!p.use || (r.uses || []).includes(p.use)) && (p.comm !== "1" || r.permissive)
      && (!terms.length || terms.every((w) => fold(`${r.full} ${r.desc} ${(r.topics || []).join(" ")}`).includes(w))));
    const bits = [];
    if (p.topic) bits.push(`about "${p.topic.replace(/-/g, " ")}" across all sections`);
    if (p.use) bits.push(`for ${p.use}`);
    if (p.comm === "1") bits.push("with commercial-friendly licenses");
    let line = `${plural(list.length, "repo")}${bits.length ? " " + bits.join(", ") : ""}.`;
    if (p.topic || p.use || p.q || p.comm) line += ` <button type="button" data-reset>Clear filters</button>`;
    if (data && data.history_days < 8 && (tab === "trending" || tab === "recognized") && !p.topic)
      line += ` <span class="warm">Tracking started ${esc(fmtDate(data.tracking_since + "T00:00:00Z"))}. Weekly growth for older projects appears after 7 days of history; until then this list favours new projects, whose growth is known from launch.</span>`;
    main.querySelector("#rline").innerHTML = line;
    const grid = main.querySelector("#rgrid");
    const view = (() => { try { return localStorage.getItem("gap-repo-view") || "cards"; } catch (e) { return "cards"; } })();
    main.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
    grid.classList.toggle("list", view === "list");
    const featured = view === "cards" && tab !== "saved" && tab !== "history" && !p.topic && !p.use && !p.q && p.comm !== "1" && list.length > 3;
    if (!data && tab !== "saved") { grid.innerHTML = `<p class="empty">Repo data has not been collected yet. It refreshes once a day.</p>`; return; }
    const shownList = list.slice(0, this.limit);
    grid.innerHTML = list.length ? shownList.map((x, i) => this.card(x.r, x.reason, saved, tab, featured && i === 0, view)).join("")
        + (list.length > this.limit ? `<button class="more repo-more" type="button" data-more>Show more repos (${list.length - this.limit} left)</button>` : "")
      : `<p class="empty">${tab === "saved" ? "Nothing saved yet. Use the bookmark on any repo card to save it here." : "No repos match these filters."}</p>`;
  },
  card(r, reason, saved, tab, top = false, view = "cards") {
    const [owner, name] = r.full.split("/");
    const isSaved = !!saved[r.id];
    const icon = { history: "\u{1F4DA}", trending: "\u{1F525}", new: "\u{1F680}", recognized: "\u{1F3C6}", gems: "\u{1F48E}", essentials: "✅", saved: "\u{1F516}" }[tab] || "";
    const avatar = `<img class="repo__avatar" src="https://github.com/${encodeURIComponent(owner)}.png?size=80" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`;
    const license = !r.license || r.license === "NOASSERTION" ? `<span class="lic warn" title="No standard license detected: check before using">License unclear</span>`
      : `<span class="lic ${r.permissive ? "ok" : ""}" title="${r.permissive ? "Permissive license: generally fine for commercial use" : "Check the license terms before commercial use"}">${esc(r.license)}${r.permissive ? " &#10003;" : ""}</span>`;
    const saveBtn = `<button class="save" type="button" data-save="${esc(r.id)}" aria-pressed="${isSaved}" aria-label="${isSaved ? "Remove from saved" : "Save"} ${esc(r.full)}" title="${isSaved ? "Saved: click to remove" : "Save this repo"}">${bookmark(isSaved)}</button>`;
    const lang = r.lang ? `<span class="lang"><i style="background:${langColor(r.lang)}"></i>${esc(r.lang)}</span>` : "";
    const growth = r.week ? `<span class="grow" title="${r.est ? "Average weekly pace since launch" : "Stars gained in the last 7 days"}">&#9650; ${kfmt(r.week)}/wk${r.est ? "*" : ""}</span>` : "";
    if (view === "list") {
      return `<article class="repo repo--row">${avatar}
        <div class="row__main"><h3 class="repo__name"><a href="${esc(r.url)}" target="_blank" rel="noopener"><span>${esc(owner)}/</span>${esc(name)}</a></h3>
          <p class="row__desc">${esc(r.why || r.desc)}</p><p class="row__reason">${icon} ${esc(reason || "")}</p></div>
        <div class="row__stats"><span>&#9733; ${kfmt(r.stars)}</span>${growth}${lang}${license}</div>${saveBtn}</article>`;
    }
    return `<article class="repo${top ? " repo--top" : ""}">
      ${top ? `<span class="toppick">Top pick</span>` : ""}
      <header class="repo__head">${avatar}<div class="repo__title">
        <h3 class="repo__name"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(name)}</a></h3>
        <span class="repo__owner">${esc(owner)}${r.owner_type === "Organization" ? ` <span class="org" title="Owned by an organization">org</span>` : ""}</span></div>${saveBtn}</header>
      <p class="repo__reason"><span aria-hidden="true">${icon}</span> ${esc(reason || "")}</p>
      <p class="repo__desc">${esc(r.desc)}</p>
      ${r.why ? `<p class="why"><b>Why it matters</b> ${esc(r.why)} <span class="ai-tag" title="Written by an AI model from the repo's own description">AI</span></p>` : ""}
      ${r.quickstart ? `<div class="qs"><code>${esc(r.quickstart)}</code><button type="button" data-copy="${esc(r.quickstart)}">Copy</button></div>` : ""}
      <div class="repo__stats"><span title="Stars">&#9733; ${kfmt(r.stars)}</span>${growth}
        ${r.forks ? `<span title="Forks">&#5833; ${kfmt(r.forks)}</span>` : ""}${lang}
        ${r.pushed ? `<span>Updated ${esc(relTime(r.pushed))}</span>` : ""}${license}</div>
      ${r.buzz ? `<p class="buzz-line">${buzzBadge(r.buzz)}</p>` : ""}
      ${(r.topics || []).length ? `<div class="repo__topics">${r.topics.map((tp) => `<button type="button" data-topic="${esc(tp)}">${esc(tp)}</button>`).join("")}</div>` : ""}
      <div class="repo__links"><a href="${esc(r.url)}" target="_blank" rel="noopener">GitHub</a>${r.home ? `<a href="${esc(r.home)}" target="_blank" rel="noopener">Website</a>` : ""}${r.release ? `<a href="${esc(r.url)}/releases" target="_blank" rel="noopener">Release ${esc(r.release.tag)}</a>` : ""}<a href="${esc(r.url)}" target="_blank" rel="noopener" title="Opens the repo on GitHub, where you can star it">Star on GitHub</a></div>
    </article>`;
  },
  click(e) {
    const tab = e.target.closest("[data-tab]"); if (tab) return this.set({ tab: tab.dataset.tab, topic: "" }, true);
    const view = e.target.closest("[data-view]");
    if (view) { try { localStorage.setItem("gap-repo-view", view.dataset.view); } catch (err) {} return this.update(this.params, true); }
    if (e.target.closest("[data-more]")) { this.limit += 30; return this.update(this.params, true); }
    const use = e.target.closest("[data-use]"); if (use) return this.set({ use: this.params.use === use.dataset.use ? "" : use.dataset.use });
    const topic = e.target.closest("[data-topic]"); if (topic) { window.scrollTo({ top: 0 }); return this.set({ topic: this.params.topic === topic.dataset.topic ? "" : topic.dataset.topic }, true); }
    if (e.target.closest("[data-reset]")) return this.set({ q: "", use: "", topic: "", comm: "" });
    const copy = e.target.closest("[data-copy]");
    if (copy) { navigator.clipboard?.writeText(copy.dataset.copy).then(() => { copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1400); }); return; }
    const save = e.target.closest("[data-save]");
    if (save) {
      const id = save.dataset.save, saved = loadSaved();
      if (saved[id]) delete saved[id];
      else {
        const r = store.repos?.repos[id] || store.archiveById?.get(id)?.repo || null;
        if (r) saved[id] = { repo: r, savedAt: new Date().toISOString() };
      }
      if (!writeSaved(saved)) alert("Saving needs browser storage, which is blocked in this window (for example in private browsing).");
      this.update(this.params);
    }
  },
  exportSaved() {
    const blob = new Blob([JSON.stringify(loadSaved(), null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "saved-repos.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  async importSaved(file) {
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      const merged = { ...loadSaved() };
      for (const [id, v] of Object.entries(incoming)) if (v && v.repo && v.savedAt) merged[id] = merged[id] || v;
      writeSaved(merged);
      this.update(this.params);
    } catch (err) { alert("That file is not a saved-repos export."); }
  },
};

// One listener for the Repos page, routed to whichever Repos view is current.
main.addEventListener("click", (e) => { if (current?.name === "repos") current.click(e); });

// ------------------------------------------------------------------ Buzz
const BUZZ_KEY = "gap-saved-buzz";
const loadBuzzSaved = () => { try { return JSON.parse(localStorage.getItem(BUZZ_KEY) || "{}"); } catch (e) { return {}; } };
const writeBuzzSaved = (o) => { try { localStorage.setItem(BUZZ_KEY, JSON.stringify(o)); return true; } catch (e) { return false; } };
const BUZZ_MOOD = {
  debated: ["\u{1F4AC} Heated debate", "High comment volume relative to score — active community debate."],
  loved: ["\u{1F44D} Crowd favourite", "Highly upvoted with strong community agreement."]
};
const BUZZ_WIN = { "1": ["Last 24 hours", 1], "7": ["This week", 7], "14": ["Last 2 weeks", 14] };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };

const BUZZ_ICONS = {
  hn: `<svg class="plat-svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#FF6600"/><path fill="#fff" d="M12.8 13.8v5.4h-2v-5.4L6.9 6h2.2l2.9 5.8 2.8-5.8h2.2l-4.2 7.8z"/></svg>`,
  lobsters: `<svg class="plat-svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#AC130D"/><path fill="#fff" d="M12 4a8 8 0 0 0-8 8c0 3.3 2 6.1 4.9 7.3.3-.8.7-1.5 1.1-2.1-1.7-.8-2.9-2.4-2.9-4.3a5 5 0 0 1 10 0c0 1.9-1.2 3.5-2.9 4.3.4.6.8 1.3 1.1 2.1 2.9-1.2 4.9-4 4.9-7.3a8 8 0 0 0-8-8z"/></svg>`,
  devto: `<svg class="plat-svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#0A0A0A"/><path fill="#fff" d="M7.4 8h2.1c1.8 0 2.8 1 2.8 2.7v2.6c0 1.7-1 2.7-2.8 2.7H7.4V8zm2.1 6.3c.7 0 1-.4 1-1.2v-2.2c0-.8-.3-1.2-1-1.2h-.4v4.6h.4zm3.8-6.3h4.3v1.7h-2.5v1.4h2.2v1.7h-2.2v1.5h2.5V16h-4.3V8zm5.5 0h1.8l1.3 5.4 1.3-5.4h1.8L23 16h-1.9l-1.3-5-1.3 5h-1.9l-1.4-8z"/></svg>`,
  mastodon: `<svg class="plat-svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#6364FF"/><path fill="#fff" d="M18.8 9.5c-.2-1.7-1.6-3-3.3-3.2-2.8-.4-5.6-.4-8.3 0-1.7.2-3.1 1.5-3.3 3.2-.5 3.2-.5 6.5 0 9.7.3 1.8 2.1 3.1 3.8 3.1 2 .1 4.1 0 6.1-.4.5-.1 1-.3 1.4-.6l-.1-1.4c-.4.2-.8.3-1.3.3-1.7.3-3.4.3-5.1 0-1-.2-1.5-.7-1.7-1.7 1.8.5 3.8.7 5.6.7 2.2 0 4.5-.2 6.6-1 .2-.1.3-.3.3-.6v-8.1zm-2.6 5.5h-1.7v-4.3h-1.3v3h-1.7v-3h-1.3v4.3H8.5V9.7h2.2l1.4 2.8 1.4-2.8h2.2v5.3z"/></svg>`,
  youtube: `<svg class="plat-svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="4" fill="#E62117"/><path fill="#fff" d="M19 8.2c-.2-.7-.7-1.2-1.4-1.4C16.4 6.5 12 6.5 12 6.5s-4.4 0-5.6.3c-.7.2-1.2.7-1.4 1.4-.3 1.2-.3 3.8-.3 3.8s0 2.6.3 3.8c.2.7.7 1.2 1.4 1.4 1.2.3 5.6.3 5.6.3s4.4 0 5.6-.3c.7-.2 1.2-.7 1.4-1.4.3-1.2.3-3.8.3-3.8s0-2.6-.3-3.8zM10.5 14.5v-5l4.3 2.5-4.3 2.5z"/></svg>`,
};
const platBadge = (p, name, color) => `<span class="plat plat--${p}" style="--p:${color}">${BUZZ_ICONS[p] || `<i style="background:${color}"></i>`}<span>${esc(name)}</span></span>`;

const BuzzView = {
  async mount(params) {
    if (!store.buzz) store.buzz = await getJSON("buzz.json");
    const b = store.buzz;
    const t = b.trends, up = (rows) => rows.filter((r) => r.state === "rising"), down = (rows) => rows.filter((r) => r.state === "cooling");
    const chip = (r, kind) => `<button type="button" class="buzz-chip" data-${kind}="${esc(r.name)}"><span class="chip-name">${esc(r.name)}</span><span class="c">${r.now}</span><span class="${r.change_pct !== null && r.change_pct < 0 ? "dn" : "up"}">${r.change_pct === null ? "new" : (r.change_pct > 0 ? "+" : "") + r.change_pct + "%"}</span></button>`;
    
    const board = (id, icon, title, note, topics, comps, emptyMsg) => `
      <div class="box buzzbox buzzbox--${id}">
        <div class="buzzbox__head">
          <span class="buzzbox__badge">${icon}</span>
          <div>
            <span class="box-h">${title}</span>
            <p class="buzzbox__note">${note}</p>
          </div>
        </div>
        ${topics.length ? `
          <div class="buzzbox__sec">
            <span class="buzzbox__sec-title">Key Topics</span>
            <div class="themes__list">${topics.map((r) => chip(r, "topic")).join("")}</div>
          </div>` : ""}
        ${comps.length ? `
          <div class="buzzbox__sec">
            <span class="buzzbox__sec-title">Companies &amp; Labs</span>
            <div class="themes__list">${comps.map((r) => chip(r, "q")).join("")}</div>
          </div>` : ""}
        ${!topics.length && !comps.length ? `<span class="muted">${emptyMsg}</span>` : ""}
      </div>`;

    const base = t.baseline.map((id) => BUZZ_PLAT[id][0]).join(", ");
    const steady = t.companies.filter((r) => r.state === "steady");

    main.innerHTML = `<header class="page-head">
        <div class="buzz-head-pill">&#128293; Developer Pulse &amp; Community Threads</div>
        <h1>What developers are talking about</h1>
        <p>The AI discussions gaining the fastest momentum across Hacker News, Lobsters, dev.to, Mastodon and YouTube. Filter by heat, sentiment, or topic, jump straight into the comment threads, and track what's heating up or cooling off week-over-week.</p>
      </header>
      <section class="buzzboards" aria-label="Topic trends">
        ${board("heat", "&#128293;", "HEATING UP", "Gaining velocity vs last week", up(t.topics), up(t.companies), "Nothing is climbing sharply right now.")}
        ${board("cool", "&#10052;", "COOLING OFF", "Slowing down vs last week", down(t.topics), down(t.companies), "Nothing is fading sharply right now.")}
        ${board("steady", "&#128172;", "STEADY TOPICS", "Consistent community anchors", t.topics.filter((r) => r.state === "steady").slice(0, 6), steady.slice(0, 4), "Not enough baseline data yet.")}
      </section>
      <p class="trend-note">Week-over-week baseline tracked across ${esc(base)}. Mastodon joins once two weeks of its posts have been collected. Click any topic or company to filter the feed.</p>
      
      <div class="repo-tabs" role="tablist" id="btabs"></div>
      
      <div class="repo-tools buzz-tools">
        <label class="search"><span class="visually-hidden">Search discussions</span>${searchIcon}<input id="bq" type="search" placeholder="Search headlines, posts, authors..." autocomplete="off"></label>
        <div class="buzz-filters" role="group" aria-label="Quick filters">
          <button type="button" data-filter="" class="buzz-pill" aria-pressed="true">All</button>
          <button type="button" data-filter="hot" class="buzz-pill" aria-pressed="false">&#128293; Blazing</button>
          <button type="button" data-filter="debated" class="buzz-pill" aria-pressed="false">&#128172; Heated debates</button>
          <button type="button" data-filter="loved" class="buzz-pill" aria-pressed="false">&#128402; Crowd favourites</button>
          <button type="button" data-filter="news" class="buzz-pill" aria-pressed="false">&#128240; In our news</button>
          <button type="button" data-filter="repo" class="buzz-pill" aria-pressed="false">&#128187; Tracked repos</button>
        </div>
        <label class="sortbox"><span class="visually-hidden">Time window</span><select class="select" id="bwin">${Object.entries(BUZZ_WIN).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
        <label class="sortbox"><span class="visually-hidden">Sort</span><select class="select" id="bsort"><option value="hot">Buzzing now</option><option value="new">Newest first</option></select></label>
        <div class="seg" role="group" aria-label="Layout">
          <button type="button" data-view="cards" aria-pressed="true">Cards</button>
          <button type="button" data-view="compact" aria-pressed="false">Compact</button>
        </div>
      </div>
      
      <p class="result-line" id="bline" aria-live="polite"></p>
      <div class="buzz-list" id="blist"></div>
      
      <div class="saved-tools" id="bsavedtools" hidden>
        <button class="btn" type="button" id="bexport">Export saved discussions</button>
        <label class="btn"><input type="file" id="bimport" accept="application/json" hidden>Import saved discussions</label>
      </div>

      <p class="trend-note" id="bsrc"></p>`;

    const q = main.querySelector("#bq"); let tm;
    q.addEventListener("input", () => { clearTimeout(tm); tm = setTimeout(() => this.set({ q: q.value.trim() }), 150); });
    main.querySelector("#bwin").addEventListener("change", (e) => this.set({ win: e.target.value }));
    main.querySelector("#bsort").addEventListener("change", (e) => this.set({ sort: e.target.value }));
    main.querySelector("#bexport")?.addEventListener("click", () => this.exportSaved());
    main.querySelector("#bimport")?.addEventListener("change", (e) => this.importSaved(e.target.files[0]));
    this.update(params);
  },
  exportSaved() {
    const data = JSON.stringify(loadBuzzSaved(), null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `saved-buzz-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  async importSaved(file) {
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      const merged = { ...loadBuzzSaved() };
      for (const [id, v] of Object.entries(incoming)) if (v && v.t && v.savedAt) merged[id] = merged[id] || v;
      writeBuzzSaved(merged);
      this.update(this.params, true);
    } catch (err) { alert("That file is not a saved-buzz export."); }
  },
  set(patch, push = false) { this.params = { ...this.params, ...patch }; setParams("/buzz", this.params, { push }); this.update(this.params); },
  update(params, keepLimit = false) {
    if (keepLimit !== true || !this.limit) this.limit = 30;
    this.params = { src: "all", win: "7", sort: "hot", view: "cards", filter: "", ...params };
    const p = this.params, b = store.buzz, saved = loadBuzzSaved();
    const win = BUZZ_WIN[p.win] ? p.win : "7";
    const tabs = [["all", "All Discussions", b.items.length], ...b.platforms.map((x) => [x.id, x.name, x.count]), ["saved", "\u{1F516} Saved", Object.keys(saved).length]];
    main.querySelector("#btabs").innerHTML = tabs.map(([k, l, n]) => `<button type="button" role="tab" data-src="${k}" aria-selected="${k === p.src}">${esc(l)} <span class="count">${n}</span></button>`).join("");
    main.querySelector("#bq").value = p.q || "";
    main.querySelector("#bwin").value = win; main.querySelector("#bsort").value = p.sort === "new" ? "new" : "hot";
    
    main.querySelectorAll(".buzz-pill[data-filter]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.filter === (p.filter || ""))));
    main.querySelectorAll("[data-view]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.view === (p.view || "cards"))));
    main.querySelectorAll("[data-topic]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.topic === p.topic)));
    main.querySelectorAll(".buzzbox [data-q]").forEach((el) => el.setAttribute("aria-pressed", String(el.dataset.q === p.q)));
    
    const savedTools = main.querySelector("#bsavedtools");
    if (savedTools) savedTools.hidden = p.src !== "saved";

    const cutoff = Date.now() - BUZZ_WIN[win][1] * DAY, needle = fold(p.q || "");
    let list = p.src === "saved" ? Object.values(saved).sort((a, c) => c.savedAt - a.savedAt) : b.items.filter((it) => new Date(it.ts) >= cutoff && (p.src === "all" || it.p === p.src));
    if (p.topic) list = list.filter((it) => (it.tp || []).includes(p.topic));
    if (needle) list = list.filter((it) => fold(`${it.t} ${it.x || ""} ${it.au || ""}`).includes(needle));
    
    if (p.filter === "hot") list = list.filter((it) => (it.h || 0) >= 0.5);
    else if (p.filter === "debated") list = list.filter((it) => it.m === "debated");
    else if (p.filter === "loved") list = list.filter((it) => it.m === "loved");
    else if (p.filter === "news") list = list.filter((it) => !!it.news);
    else if (p.filter === "repo") list = list.filter((it) => !!it.repo);

    if (p.src !== "saved") list = [...list].sort(p.sort === "new" ? (a, c) => new Date(c.ts) - new Date(a.ts) : (a, c) => c.h - a.h);
    const shown = list.slice(0, this.limit);
    
    const filterLabel = {
      hot: "blazing discussions",
      debated: "heated debates",
      loved: "crowd favourites",
      news: "discussions in our news",
      repo: "discussions tracking open repos"
    }[p.filter] || "";

    const activeParts = [];
    if (p.topic) activeParts.push(`about <strong>${esc(p.topic)}</strong>`);
    if (p.filter) activeParts.push(`filtered by <strong>${filterLabel}</strong>`);
    if (p.q) activeParts.push(`matching &ldquo;${esc(p.q)}&rdquo;`);
    const hasFilters = p.topic || p.q || p.filter;

    main.querySelector("#bline").innerHTML = `${plural(list.length, "discussion")}${activeParts.length ? " " + activeParts.join(" ") : ""}${hasFilters ? ` <button type="button" class="clear-btn" data-clear>Clear filters</button>` : ""}`;
    
    const blist = main.querySelector("#blist");
    blist.className = `buzz-list buzz-list--${p.view === "compact" ? "compact" : "cards"}`;
    
    if (shown.length) {
      const renderCard = p.view === "compact" ? (it) => this.cardRow(it, !!saved[it.id]) : (it) => this.card(it, !!saved[it.id]);
      blist.innerHTML = shown.map(renderCard).join("") + (list.length > this.limit ? `<button class="more repo-more" type="button" data-more>Show more (${list.length - this.limit} left)</button>` : "");
    } else {
      blist.innerHTML = `<div class="buzz-empty">
        <p class="empty">${p.src === "saved" ? "Nothing saved yet. Use the bookmark icon on any discussion card to save it for later." : "No discussions match your current filters."}</p>
        ${hasFilters ? `<button type="button" class="btn" data-clear>Reset all filters</button>` : ""}
      </div>`;
    }
    
    main.querySelector("#bsrc").innerHTML = "Sources: " + b.platforms.map((x) => `<a href="${esc(x.home)}" target="_blank" rel="noopener">${esc(x.name)}</a>${x.ok === false ? " (last fetch failed)" : ""}`).join(", ") + `. X and Reddit are not included: X charges for access and Reddit blocks automated readers.`;
  },
  card(it, isSaved) {
    const [pname, unit] = BUZZ_PLAT[it.p], pm = store.buzz.platforms.find((x) => x.id === it.p) || { color: "#5B3DF5" };
    const stat = it.p === "youtube" ? `${kfmt(it.s)} views` : `${kfmt(it.s)} ${unit}`;
    const host = it.u !== it.d ? hostOf(it.u) : "";
    const mood = it.m ? `<span class="mood mood--${it.m}" title="${esc(BUZZ_MOOD[it.m][1])}">${BUZZ_MOOD[it.m][0]}</span>` : "";
    const hotBadge = it.h >= 1.5 ? `<span class="bz__hotness bz__hotness--blazing" title="Blazing hot: score velocity ${it.h.toFixed(1)}">&#128293;&#128293; Blazing</span>`
      : it.h >= 0.5 ? `<span class="bz__hotness bz__hotness--surge" title="Surging interest: score velocity ${it.h.toFixed(1)}">&#128293; Surging</span>` : "";
    const save = `<button class="save" type="button" data-save="${esc(it.id)}" aria-pressed="${isSaved}" aria-label="${isSaved ? "Remove from saved" : "Save"} discussion" title="${isSaved ? "Saved: click to remove" : "Save this discussion"}">${bookmark(isSaved)}</button>`;
    
    const discussLink = it.u !== it.d
      ? `<a class="bz__action-discuss" href="${esc(it.d)}" target="_blank" rel="noopener" title="Open discussion on ${esc(pname)}">&#128172; ${it.c ? `${kfmt(it.c)} comments` : "View thread"} &rarr;</a>`
      : `<span class="bz__self-badge" title="Original community thread">&#128172; ${it.c ? `${kfmt(it.c)} comments` : "Community thread"}</span>`;

    return `<article class="bz bz--card">
      <div class="bz__main">
        <div class="bz__meta">
          ${platBadge(it.p, pname, pm.color)}
          <span class="heat" title="Community Engagement">${stat}${it.c ? ` &middot; ${kfmt(it.c)} comments` : ""}</span>
          ${hotBadge}
          ${mood}
          <time datetime="${esc(it.ts)}" title="${esc(new Date(it.ts).toLocaleString("en-GB"))}">${esc(relTime(it.ts))}</time>
        </div>
        <h3 class="bz__title">
          <a href="${esc(it.u)}" target="_blank" rel="noopener">${esc(it.t)}</a>
          ${host ? ` <span class="host">${esc(host)}</span>` : ""}
        </h3>
        ${it.x && it.x !== it.t ? `<p class="bz__text">${esc(it.x)}</p>` : ""}
        <div class="bz__foot">
          <div class="bz__tags">
            ${(it.tp || []).map((tp) => `<button type="button" class="tag" data-topic="${esc(tp)}">${esc(tp)}</button>`).join("")}
            ${it.news ? `<span class="tag tag--ok" title="This story is also featured in our news dashboard">&#128240; In our news</span>` : ""}
            ${it.repo ? `<a class="tag tag--ok" href="#/repos?q=${encodeURIComponent(it.repo.split("/")[1])}" title="Open-source repository we track">&#128187; Tracked repo</a>` : ""}
            ${it.au ? `<span class="by">by ${esc(it.au)}</span>` : ""}
          </div>
          <div class="bz__actions">
            ${discussLink}
          </div>
        </div>
      </div>
      ${it.th && it.p !== "mastodon" ? `<a class="bz__thumb" href="${esc(it.u)}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true"><img src="${esc(it.th)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.remove()"></a>` : ""}
      ${save}
    </article>`;
  },
  cardRow(it, isSaved) {
    const [pname, unit] = BUZZ_PLAT[it.p], pm = store.buzz.platforms.find((x) => x.id === it.p) || { color: "#5B3DF5" };
    const host = it.u !== it.d ? hostOf(it.u) : "";
    const mood = it.m ? `<span class="mood mood--${it.m}" title="${esc(BUZZ_MOOD[it.m][1])}">${BUZZ_MOOD[it.m][0]}</span>` : "";
    const hotBadge = it.h >= 1.5 ? `<span class="bz__hotness bz__hotness--blazing">&#128293;&#128293;</span>`
      : it.h >= 0.5 ? `<span class="bz__hotness bz__hotness--surge">&#128293;</span>` : "";
    const save = `<button class="save" type="button" data-save="${esc(it.id)}" aria-pressed="${isSaved}" aria-label="${isSaved ? "Remove from saved" : "Save"} discussion">${bookmark(isSaved)}</button>`;

    return `<article class="bz bz--row">
      <div class="bz__row-stat" title="Score: ${it.s}">
        <span class="num">${kfmt(it.s)}</span>
        <span class="unit">${it.p === "youtube" ? "views" : unit}</span>
      </div>
      <div class="bz__row-main">
        <div class="bz__row-meta">
          ${platBadge(it.p, pname, pm.color)}
          ${hotBadge}
          ${mood}
          <time datetime="${esc(it.ts)}">${esc(relTime(it.ts))}</time>
          ${it.news ? `<span class="tag tag--ok tag--mini">News</span>` : ""}
          ${it.repo ? `<span class="tag tag--ok tag--mini">Repo</span>` : ""}
        </div>
        <h3 class="bz__row-title">
          <a href="${esc(it.u)}" target="_blank" rel="noopener">${esc(it.t)}</a>
          ${host ? `<span class="host">${esc(host)}</span>` : ""}
        </h3>
        <div class="bz__row-foot">
          ${(it.tp || []).slice(0, 3).map((tp) => `<button type="button" class="tag tag--mini" data-topic="${esc(tp)}">${esc(tp)}</button>`).join("")}
          ${it.u !== it.d ? `<a class="bz__row-discuss" href="${esc(it.d)}" target="_blank" rel="noopener">&#128172; ${it.c ? `${kfmt(it.c)} comments` : "Thread"} &rarr;</a>` : ""}
        </div>
      </div>
      ${save}
    </article>`;
  },
  click(e) {
    const t = e.target.closest("button, a"); if (!t) return;
    const d = t.dataset;
    if (d.src) { this.set({ src: d.src }, true); }
    else if (d.topic) { this.set({ topic: this.params.topic === d.topic ? "" : d.topic }, true); }
    else if (d.filter !== undefined) { this.set({ filter: this.params.filter === d.filter ? "" : d.filter }, true); }
    else if (d.view) { this.set({ view: d.view }, true); }
    else if (d.q !== undefined && t.closest(".buzzbox")) { this.set({ q: this.params.q === d.q ? "" : d.q }, true); }
    else if (d.clear !== undefined) { this.set({ topic: "", q: "", filter: "" }, true); }
    else if (d.more !== undefined) { this.limit += 30; this.update(this.params, true); }
    else if (d.save) {
      const saved = loadBuzzSaved(), it = store.buzz.items.find((x) => x.id === d.save) || saved[d.save];
      if (saved[d.save]) delete saved[d.save]; else if (it) saved[d.save] = { ...it, savedAt: Date.now() };
      if (!writeBuzzSaved(saved)) alert("Your browser blocked saving. Check that site data is allowed.");
      this.update(this.params, true);
    }
  },
};
main.addEventListener("click", (e) => { if (current?.name === "buzz") current.click(e); });

const SourcesView = {
  mount() {
    const groups = Object.entries(store.meta.tiers).map(([t, info]) => {
      const rows = store.meta.sources.filter((s) => String(s.tier) === t);
      return `<section class="src-group"><h2><span class="dots"><i data-tier="${t}" style="--tier:${tierVar(t)}"></i></span>${esc(info.label)}</h2><p>${esc(info.desc)}</p>
        <table class="data src-table"><thead><tr><th>Source</th><th class="num">Items, last 30 days</th><th>Status</th></tr></thead><tbody>
        ${rows.map((s) => `<tr><td><a href="${esc(s.home)}" target="_blank" rel="noopener">${esc(s.name)}</a></td><td class="num">${s.items_30d}</td>
          <td>${s.ok === false ? `<span class="fail">Last fetch failed</span>${s.last_success ? `, last success ${esc(relTime(s.last_success))}` : ""}` : s.ok ? `<span class="ok">Working</span>, checked ${esc(relTime(s.last_success))}` : "Not yet checked"}</td></tr>`).join("")}
        </tbody></table></section>`;
    }).join("");
    main.innerHTML = `<header class="page-head"><h1>Sources</h1><p>${store.meta.sources.length} sources, grouped by how authoritative they are for AI news. The tier affects how prominently a story is ranked, and stories reported by several independent outlets rank higher.</p></header>${groups}`;
  },
};

// ------------------------------------------------------------------ About
const AboutView = {
  mount() {
    const s = store.meta.stats;
    main.innerHTML = `<header class="page-head"><h1>How AI News Update works</h1><p>A technology briefing for companies: new AI models, tools, research, and infrastructure, and how teams are putting them to use. No paid APIs, no ads, no tracking.</p></header>
    <div class="prose">
      <h2>Technology only</h2>
      <p>Stories that are mainly about people, politics, lawsuits, or money (executive moves, scandals, funding rounds, stock prices) are filtered out, so you see what changed in the technology and what you can do with it. A keyword check and the local language model make this call together. ${plural(s.hidden_non_technical || 0, "story has", "stories have")} been left out so far.</p>
      <h2>What the badges mean</h2>
      <p><strong>Available now</strong>: released and usable today. <strong>Preview</strong>: beta, early access, or waitlist. <strong>Open source</strong>: code or model weights you can download. <strong>API</strong>: usable from your own software. <strong>For developers</strong>: frameworks, libraries, and tooling. <strong>Enterprise</strong>: built for or proven in companies. <strong>Research</strong>: results to watch before they become products.</p>
      <h2>Collection</h2>
      <p>Every few hours a scheduled job reads the public RSS feeds and APIs of ${s.sources} sources: official blogs from AI labs and companies, university and corporate research groups, Hugging Face Daily Papers, arXiv, and established technology newsrooms. Labs that publish no feed are read from their sitemaps. Only items with a real publication date are kept.</p>
      <h2>Duplicates and same-story grouping</h2>
      <p>Articles that share a canonical address are merged. When several outlets report the same story, the most authoritative report becomes the headline and the others are listed beneath it, so you can compare coverage. The coloured dots on each story show who reported it.</p>
      <h2>Categorisation</h2>
      <p>A small language model runs locally (bge-small, through the open-source fastembed library) and compares each story with a description of every category. Its judgement is combined with a curated vocabulary for each field. Stories can belong to up to three of these ${store.meta.categories.length} categories:</p>
      <ul>${store.meta.categories.map((c) => `<li><span style="color:${c.color}">●</span> ${esc(c.name)}</li>`).join("")}</ul>
      <h2>Ranking</h2>
      <p>Importance combines the source's authority, the number of independent outlets covering the story, signals that something is usable (launches, releases, APIs, open-source code, benchmark results), and for papers, community upvotes. The front page also weighs recency, so the lead story is the most significant development of the last few days.</p>
      <h2>Buzz</h2>
      <p>The Buzz page shows what developers are actually talking about. Every few hours it reads Hacker News, Lobsters, dev.to, Mastodon hashtags and the feeds of established AI channels on YouTube, all through their free public interfaces. Threads are ranked by votes, comments and freshness. Topic boards compare this week with last week to show what is heating up and what is cooling off. &ldquo;Heated debate&rdquo; means a thread has more comments than votes; &ldquo;Crowd favourite&rdquo; means many votes and little argument. Both are counted from the numbers, not guessed from tone. X and Reddit are not included because X charges for access and Reddit blocks automated readers.</p>
      <h2>Repos</h2>
      <p>Once a day the GitHub API is searched for open-source AI projects. Star counts are saved daily so weekly growth is measured, not guessed. Projects whose popularity looks inflated (very few watchers and forks for their stars) or that are not about AI are left out. Saved repos stay in your browser; export them to move them to another device.</p>
      <h2>Newsletters</h2>
      <p>Monthly and quarterly editions are compiled from the same archive and typeset as PDFs with clickable links to every original source. The current period's edition is refreshed as new stories arrive.</p>
      <h2>Accuracy</h2>
      <p>Summaries are the publishers' own descriptions, shortened, never rewritten by a model, so nothing is invented. Always follow the link to the original source before relying on a detail. Archive size today: ${plural(s.archive_total, "item")} since ${esc(fmtDate(store.meta.tracking_since))}.</p>
    </div>`;
  },
};

// ------------------------------------------------------------------ boot
let newDataAvailable = false;
function renderUpdated() {
  const m = store.meta;
  document.getElementById("updated").innerHTML =
    `<span class="dot" aria-hidden="true"></span>Updated ${esc(relTime(m.last_fetch || m.generated))} from ${m.stats.sources} sources. ${plural(m.stats.articles_7d, "story", "stories")} this week.` +
    (newDataAvailable ? ` <button type="button" class="refresh" onclick="location.reload()">New stories are in. Refresh</button>` : "");
}
async function checkForNewData() {
  try {
    const fresh = await getJSON("meta.json");
    if (fresh.generated !== store.meta.generated && (fresh.last_fetch || fresh.generated) !== (store.meta.last_fetch || store.meta.generated)) {
      newDataAvailable = true; renderUpdated();
    }
  } catch (e) { /* offline: try again next time */ }
}

(async function boot() {
  try {
    const [meta, latest] = await Promise.all([getJSON("meta.json"), getJSON("latest.json")]);
    store.meta = meta; store.latest = latest.articles;
    indexArticles(store.latest);
    renderUpdated();
    setInterval(renderUpdated, 60e3);
    setInterval(checkForNewData, 5 * 60e3);
    await route();
  } catch (err) {
    console.error(err);
    main.innerHTML = `<div class="error-box"><strong>Stories could not be loaded.</strong><p>${esc(err.message)} If you are running the site locally, serve it over HTTP (for example <code>python -m http.server -d site</code>) rather than opening the file directly.</p></div>`;
  }
})();
