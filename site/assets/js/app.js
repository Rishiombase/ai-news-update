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
  const views = { latest: LatestView, research: ResearchView, repos: ReposView, newsletters: NewslettersView, sources: SourcesView, about: AboutView };
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
        <span class="cover__title">Gen <em>AI</em> Pulse</span>
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
    main.innerHTML = `<header class="page-head"><h1>Gen AI Pulse newsletters</h1>
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
        ${a.summary ? `<p>${esc(a.summary)}</p>` : ""}${tagsHTML(a)}</article>`;
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
        <h1>Gen AI Pulse: ${esc(i.title)}</h1><p>Issue #${i.issue_no || 1}, ${i.type === "monthly" ? "monthly" : "quarterly"} edition covering ${esc(fmtDate(i.start))} to ${esc(fmtDate(i.end))}.${i.status === "in_progress" ? " This period is still under way; the edition updates as stories arrive." : ""}</p>
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
  trending: ["Trending", "Most stars gained in the last 7 days across open-source AI."],
  new: ["New & rising", "Created in the last 90 days and growing fast for their age."],
  recognized: ["Getting recognized", "Broke through this week: in the news, code behind a top research paper, a star milestone, or a major release."],
  gems: ["Hidden gems", "Under 2,500 stars, actively developed, with releases and steady growth. Easy to miss, worth a look."],
  essentials: ["Proven essentials", "Established projects that are still actively maintained: the safe choices for real products."],
  saved: ["Saved", "Repos you saved. They are stored in this browser; use Export to move them to another device."],
};
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
    main.querySelector("#rexport").addEventListener("click", () => this.exportSaved());
    main.querySelector("#rimport").addEventListener("change", (e) => this.importSaved(e.target.files[0]));
    this.update(params);
  },
  set(patch, push = false) { this.params = { ...this.params, ...patch }; setParams("/repos", this.params, { push }); this.update(this.params); },
  update(params) {
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
    if (data) {
      main.querySelector("#themes").innerHTML = data.themes.map((th) => `<button type="button" data-topic="${esc(th.topic)}" aria-pressed="${p.topic === th.topic}">
        ${esc(th.topic.replace(/-/g, " "))}<span class="c">${th.repos}</span>${th.rising ? `<span class="up" title="Growing faster than last week">&#9650;</span>` : ""}${th.new ? `<span class="badge-new">new</span>` : ""}</button>`).join("");
    }
    // Build the list for this tab.
    let list;
    if (tab === "saved") {
      list = Object.values(saved).sort((a, b) => b.savedAt.localeCompare(a.savedAt))
        .map((s) => ({ r: (data && data.repos[s.repo.id]) || s.repo, reason: `Saved ${relTime(s.savedAt)}`, saved: true }));
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
    if (!data && tab !== "saved") { grid.innerHTML = `<p class="empty">Repo data has not been collected yet. It refreshes once a day.</p>`; return; }
    grid.innerHTML = list.length ? list.map((x) => this.card(x.r, x.reason, saved)).join("")
      : `<p class="empty">${tab === "saved" ? "Nothing saved yet. Use the bookmark on any repo card to save it here." : "No repos match these filters."}</p>`;
  },
  card(r, reason, saved) {
    const [owner, name] = r.full.split("/");
    const isSaved = !!saved[r.id];
    const license = !r.license || r.license === "NOASSERTION" ? `<span class="lic warn" title="No standard license detected: check before using">License unclear</span>`
      : `<span class="lic ${r.permissive ? "ok" : ""}" title="${r.permissive ? "Permissive license: generally fine for commercial use" : "Check the license terms before commercial use"}">${esc(r.license)}${r.permissive ? " &#10003;" : ""}</span>`;
    return `<article class="repo">
      <button class="save" type="button" data-save="${esc(r.id)}" aria-pressed="${isSaved}" aria-label="${isSaved ? "Remove from saved" : "Save"} ${esc(r.full)}" title="${isSaved ? "Saved: click to remove" : "Save this repo"}">${bookmark(isSaved)}</button>
      <h3 class="repo__name"><a href="${esc(r.url)}" target="_blank" rel="noopener"><span>${esc(owner)}/</span>${esc(name)}</a></h3>
      <p class="repo__desc">${esc(r.desc)}</p>
      <p class="repo__why"><b>${reason && reason.startsWith("Saved") ? "" : "Why it's here: "}</b>${esc(reason || "")}</p>
      ${r.quickstart ? `<div class="qs"><code>${esc(r.quickstart)}</code><button type="button" data-copy="${esc(r.quickstart)}">Copy</button></div>` : ""}
      <div class="repo__stats">
        <span title="Stars">&#9733; ${kfmt(r.stars)}</span>
        ${r.week ? `<span class="grow" title="${r.est ? "Average weekly pace since launch" : "Stars gained in the last 7 days"}">&#9650; ${kfmt(r.week)}/week${r.est ? "*" : ""}</span>` : ""}
        ${r.pushed ? `<span>Updated ${esc(relTime(r.pushed))}</span>` : ""}
        ${r.lang ? `<span>${esc(r.lang)}</span>` : ""}
        ${license}
      </div>
      ${(r.topics || []).length ? `<div class="repo__topics">${r.topics.map((tp) => `<button type="button" data-topic="${esc(tp)}">${esc(tp)}</button>`).join("")}</div>` : ""}
      <div class="repo__links"><a href="${esc(r.url)}" target="_blank" rel="noopener">GitHub</a>${r.home ? `<a href="${esc(r.home)}" target="_blank" rel="noopener">Website</a>` : ""}${r.release ? `<a href="${esc(r.url)}/releases" target="_blank" rel="noopener">Release ${esc(r.release.tag)}</a>` : ""}<a href="${esc(r.url)}" target="_blank" rel="noopener" title="Opens the repo on GitHub, where you can star it">Star on GitHub</a></div>
    </article>`;
  },
  click(e) {
    const tab = e.target.closest("[data-tab]"); if (tab) return this.set({ tab: tab.dataset.tab, topic: "" }, true);
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
        const r = store.repos?.repos[id] || null;
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
    main.innerHTML = `<header class="page-head"><h1>How Gen AI Pulse works</h1><p>A technology briefing for companies: new AI models, tools, research, and infrastructure, and how teams are putting them to use. No paid APIs, no ads, no tracking.</p></header>
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
