// Cloudflare Pages Function: GET /movement/{slug}
//
// Public, server-rendered, fully-free art-movement page (Linear T1-813).
// Data is fetched at the edge from GET /v1/movements/{slug} (all 83 movements
// are already enriched). Design: Pencil "Movement Web" lane. The page is a
// TOFU/SEO surface — everything is free, richly interlinked, and app CTAs pull
// installs. Mirrors the /a/{slug} share-page architecture.

const API_BASE = "https://api.artwhisper.app";
const PLAY_URL =
  "https://play.google.com/store/apps/details?id=app.artwhisper&utm_source=movement&utm_medium=web&utm_campaign=movement_page";
const APP_STORE_URL =
  "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=movement-web";
const FETCH_TIMEOUT_MS = 5000;

// Build the install links carrying the deferred deep-link destination (this movement
// page, `dl_type`+`dl_slug`, T1-877) so a web→install opens back here, plus any inbound
// campaign UTM (they coexist). `dest` = { type, slug }. iOS deferred = T1-878.
function buildStoreLinks(src, dest) {
  const source = src && /^[a-z0-9_-]{1,40}$/i.test(src) ? src.toLowerCase() : null;
  const destSlug =
    dest && dest.slug && /^[a-z0-9-]{1,140}$/i.test(dest.slug) ? dest.slug : null;
  const ref = new URLSearchParams();
  if (dest && dest.type && destSlug) {
    ref.set("dl_type", dest.type);
    ref.set("dl_slug", destSlug);
  }
  if (source) {
    ref.set("utm_source", source);
    ref.set("utm_medium", "web");
    ref.set("utm_campaign", source);
  }
  const referrer = ref.toString();
  return {
    play: referrer
      ? "https://play.google.com/store/apps/details?id=app.artwhisper&referrer=" + encodeURIComponent(referrer)
      : PLAY_URL,
    appstore: source
      ? "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=" + encodeURIComponent(source.slice(0, 40))
      : APP_STORE_URL,
  };
}

// PostHog (public client key — safe to embed; same project as the app).
const POSTHOG_KEY = "phc_d9QDyua38ePkoqG4KtR2Wa9XUasTPuvfVMJBJInE7eS";
const POSTHOG_HOST = "https://us.i.posthog.com";

// Sentry (public DSN — reused from the mobile app; see share page).
const SENTRY_INGEST =
  "https://o4510820807671808.ingest.us.sentry.io/api/4510900475592704/envelope/?sentry_key=e6024fe36e2671d1048f9c3b1c683f21&sentry_version=7";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ─── helpers ────────────────────────────────────────────────────────
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/** Percent-encode a URL for safe use inside a CSS url('...') in a style attr. */
function cssUrl(u) {
  if (!u) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" && p.protocol !== "http:") return null;
  } catch {
    return null;
  }
  return u.replace(
    /[\s"'()<>\\]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

// ─── route handler ──────────────────────────────────────────────────
export async function onRequestGet(context) {
  const slug = String(context.params.slug || "");
  if (!SLUG_RE.test(slug)) return html(renderNotFound(), 404, 60);

  // The public movement list (85 rows, edge-cached for an hour) lets "came before /
  // after" names link to every movement that has a page (T1-909). Fail-soft: without
  // it the page falls back to the API's own before/after matches.
  const listPromise = fetch(`${API_BASE}/v1/movements`, {
    headers: { accept: "application/json" },
    cf: { cacheTtl: 3600, cacheEverything: true },
    signal: AbortSignal.timeout(2500),
  })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (Array.isArray(j?.movements) ? j.movements : []))
    .catch(() => []);

  let data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(
      `${API_BASE}/v1/movements/${encodeURIComponent(slug)}`,
      { signal: controller.signal, headers: { accept: "application/json" } },
    );
    clearTimeout(timer);
    if (res.status === 404) return html(renderNotFound(), 404, 60);
    if (!res.ok) return html(renderNotFound(), 502, 0);
    data = await res.json();
  } catch {
    return html(renderNotFound(), 502, 0);
  }

  if (!data || !data.movement) return html(renderNotFound(), 404, 60);

  // Canonicalize to the pretty slug URL (T1-832): a UUID request (or a stale
  // alias) 301-redirects to /movement/{slug}, so the UUID and slug versions
  // don't compete as duplicates. Mirrors the artist handler; the movements API
  // returns the canonical `movement.slug` (its `meta` is empty).
  const canonical = data.movement.slug;
  if (canonical && canonical !== slug) {
    return new Response(null, {
      status: 301,
      headers: {
        location: `https://artwhisper.app/movement/${encodeURIComponent(canonical)}`,
        "cache-control": "public, max-age=300, s-maxage=86400",
      },
    });
  }

  // Related + prev/next movements carry their featured-artwork `image_url`
  // straight from GET /v1/movements/:slug, so the cards render thumbnails
  // without any per-movement edge fetch.
  return html(renderPage(data, canonical || slug, context.request.url, await listPromise), 200, 3600);
}

function html(body, status, maxAge) {
  const cache =
    maxAge > 0
      ? `public, max-age=${Math.min(maxAge, 300)}, s-maxage=${maxAge}`
      : "no-store";
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cache,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

// ─── SVG snippets ───────────────────────────────────────────────────
const ARROW = `<svg class="arr" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;

// Prefer the large derivative for full-screen viewing; falls back gracefully.
const lgUrl = (u) => (u ? String(u).replace(/_sm\.(jpe?g|png|webp)(\?|$)/i, "_lg.$1$2") : u);

// Header breadcrumb + BreadcrumbList JSON-LD (T1-845). Pass items as
// [{name, url}] with the last (current page) omitting url.
function renderBreadcrumb(items) {
  const sep = `<span class="crumbs__sep" aria-hidden="true">›</span>`;
  const nav =
    `<nav class="crumbs" aria-label="Breadcrumb">` +
    items
      .map((it, i) =>
        i === items.length - 1
          ? `<span class="crumbs__current" aria-current="page">${esc(it.name)}</span>`
          : `<a href="${esc(it.url)}">${esc(it.name)}</a>`,
      )
      .join(sep) +
    `</nav>`;
  const data = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => {
      const el = { "@type": "ListItem", position: i + 1, name: it.name };
      if (it.url) el.item = it.url;
      return el;
    }),
  };
  const jsonLd = `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
  return { nav, jsonLd };
}



/** "1886s-1905s" → "1886–1905" (the stored period strings carry a stray "s"). */
const cleanPeriod = (p) =>
  String(p || "")
    .replace(/(\d{4})s\b/g, "$1")
    .replace(/\s*-\s*/g, "–")
    .trim();

/** Eyebrow label with a hairline rule running to the right edge (as on /a/{slug}). */
const eyebrow = (label) => `<div class="eyebrow"><span>${label}</span><i aria-hidden="true"></i></div>`;

const countWord = (n) =>
  ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"][n] || String(n);

const svg = (body, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_EXPAND = svg(`<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`);
const ICON_CLOSE = svg(`<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`, 22);
const ICON_CHEV_DOWN = svg(`<polyline points="6 9 12 15 18 9"/>`, 18);
const ICON_PREV = svg(`<polyline points="15 18 9 12 15 6"/>`);
const ICON_NEXT = svg(`<polyline points="9 18 15 12 9 6"/>`);
const ICON_PHONE = svg(`<rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/>`, 18);

/**
 * Escape a "came before / after" phrase and turn every movement name in it that has
 * a page into a link (T1-909) — e.g. "Modernism / Abstract Expressionism" links both
 * when both exist; names without a page stay plain text. Longest names win, and a
 * name only matches as a whole word ("Modernism" never matches inside "Postmodernism").
 */
function nameMatches(src, known) {
  const marks = [];
  const list = known.filter((k) => k?.slug && k.name).sort((a, b) => b.name.length - a.name.length);
  for (const k of list) {
    const re = new RegExp(String.raw`(?<![\p{L}\p{N}])` + k.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + String.raw`(?![\p{L}\p{N}])`, "giu");
    let mm;
    while ((mm = re.exec(src))) {
      const s0 = mm.index, e0 = s0 + mm[0].length;
      if (!marks.some((x) => s0 < x.e && e0 > x.s)) marks.push({ s: s0, e: e0, slug: k.slug, txt: mm[0], mv: k });
    }
  }
  return marks.sort((x, y) => x.s - y.s);
}

/** The first movement (with a page) named in the text, or null. */
function firstNamed(text, known) {
  return nameMatches(String(text || ""), known)[0]?.mv || null;
}

function linkNames(text, known) {
  const src = String(text || "");
  const marks = nameMatches(src, known);
  let out = "", at = 0;
  for (const x of marks) {
    out += esc(src.slice(at, x.s)) + `<a class="dl__link" href="/movement/${esc(x.slug)}">${esc(x.txt)}</a>`;
    at = x.e;
  }
  return out + esc(src.slice(at));
}

/** Split the overview into paragraphs. */
const paragraphs = (text) =>
  String(text || "")
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);

// ─── page ───────────────────────────────────────────────────────────
// Design: Pencil "Art Movement v1.1" (Full-Screen Stage, Browser 1920 + Mobile Web 390),
// the same system as the artwork page (/a/{slug}, T1-879). Everything stays free and in
// the HTML (this is an SEO page, T1-813): "+N more" cards expand in place.
function renderPage(data, slug, reqUrl, allMovements = []) {
  let inParams;
  try {
    inParams = new URL(reqUrl).searchParams;
  } catch {
    inParams = new URLSearchParams();
  }
  const { play: PLAY_LINK, appstore: APP_STORE_LINK } = buildStoreLinks(
    inParams.get("utm_source"),
    { type: "movement", slug },
  );

  const m = data.movement || {};
  const artists = Array.isArray(data.key_artists) ? data.key_artists : [];
  const works = Array.isArray(data.notable_works) ? data.notable_works : [];
  const related = Array.isArray(data.related_movements) ? data.related_movements : [];
  const t = m.timeline || {};
  // Every movement with a page (minus this one) — plus the API's own matches as a fallback.
  const known = [];
  const seenSlug = new Set([slug]);
  for (const o of [...allMovements, data.before_movement, data.after_movement, ...related]) {
    if (o?.slug && o.name && !seenSlug.has(o.slug)) {
      seenSlug.add(o.slug);
      known.push(o);
    }
  }
  // Timeline / prev-next cards: the first movement actually named in the "came before /
  // after" text. The API's fuzzy match is used only when there is no text — it can pick a
  // look-alike ("Impressionism" → Neo-Impressionism).
  const before = t.what_came_before ? firstNamed(t.what_came_before, known) : data.before_movement || null;
  const after = t.what_came_after ? firstNamed(t.what_came_after, known) : data.after_movement || null;

  const name = m.name || "Art Movement";
  const breadcrumb = renderBreadcrumb([
    { name: "Home", url: "https://artwhisper.app" },
    { name: "Movements", url: "https://artwhisper.app/movements" },
    { name },
  ]);
  const period = t.started && t.ended ? `${t.started}–${t.ended}` : cleanPeriod(m.time_period);
  const origin = m.origin_location || "";
  const featured = m.featured_artwork || null;

  // Stage gallery: the featured artwork first, then notable works. Up to 5.
  const gallery = [];
  const seenArt = new Set();
  const pushArt = (o, by) => {
    if (!o?.image_url || !o.id || seenArt.has(o.id)) return;
    seenArt.add(o.id);
    gallery.push({ sm: o.image_url, lg: lgUrl(o.image_url), id: o.id, title: o.title || "", by });
  };
  if (featured) pushArt(featured, [featured.artist_name, featured.year].filter(Boolean).join(", "));
  for (const w of works) {
    if (gallery.length >= 5) break;
    pushArt(w, [w.artist_name, w.year].filter(Boolean).join(", "));
  }
  const heroImg = gallery[0]?.sm || null;

  // Lede = the overview's opening sentence (when it reads as one); About carries the rest,
  // so nothing is shown twice.
  const paras = paragraphs(m.overview);
  let lede = "";
  if (paras.length) {
    const mm = paras[0].match(/^(.{40,260}?[.!?])\s+(.+)$/s);
    if (mm) {
      lede = mm[1];
      paras[0] = mm[2];
    }
  }

  const pageUrl = `https://artwhisper.app/movement/${esc(slug)}`;
  const ogImg = featured?.image_url || heroImg || "";
  const metaDesc = clip(m.overview || `${name} (${period}) — key artists, characteristics, notable works, and how to spot it.`, 180);

  const spotImg = gallery[1] || gallery[0] || null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(name)} — Art Movement Guide · Art Whisper</title>
  <meta name="description" content="${esc(metaDesc)}" />
  <link rel="canonical" href="${pageUrl}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="Art Whisper" />
  <meta property="og:title" content="${esc(name)} — Art Movement Guide" />
  <meta property="og:description" content="${esc(metaDesc)}" />
  ${ogImg ? `<meta property="og:image" content="${esc(ogImg)}" />` : ""}
  <meta property="og:url" content="${pageUrl}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(name)} — Art Movement Guide" />
  <meta name="twitter:description" content="${esc(metaDesc)}" />
  ${ogImg ? `<meta name="twitter:image" content="${esc(ogImg)}" />` : ""}
  ${renderSchema(name, metaDesc, pageUrl, ogImg, period)}
  ${breadcrumb.jsonLd}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="alternate icon" href="/favicon.ico" type="image/png" />
  <link rel="apple-touch-icon" href="/favicon.ico" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&display=swap" rel="stylesheet" />
  <style>${STYLES}</style>
</head>
<body>
  ${renderStage({ name, period, origin, gallery, breadcrumb, playUrl: PLAY_LINK })}
  <main class="page">
  ${lede ? `<section class="lede" id="lede"><span class="lede__rule"></span><p class="lede__text">“${esc(lede)}”</p><span class="lede__rule"></span></section>` : `<span id="lede"></span>`}
  ${renderAbout(paras, { period, peak: t.peaked, origin, artists, before, after, t, known })}
  ${renderTimeline(t, before, after, known)}
  ${renderChars(Array.isArray(m.key_characteristics) ? m.key_characteristics : [], name)}
  ${renderSpot(Array.isArray(m.how_to_spot_it) ? m.how_to_spot_it : [], spotImg, name)}
  ${renderFacts(Array.isArray(m.fun_facts) ? m.fun_facts : [])}
  ${renderArtists(artists)}
  ${renderWorksRail(works)}
  ${renderAppCard(name, PLAY_LINK)}
  ${renderRelated(related)}
  ${renderPrevNext(before, after)}
  </main>

  <footer class="foot">
    <span>© ${new Date().getFullYear()} Bright Star. All rights reserved.</span>
    <a class="foot__report" href="https://artwhisper.app/#support">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
      See something wrong?
    </a>
  </footer>

  <a class="stickybar" data-store-cta href="${PLAY_LINK}" target="_blank" rel="noopener">
    <img class="stickybar__logo" src="/logo.png" alt="" width="34" height="34" />
    <span class="stickybar__txt"><strong>Explore ${esc(clip(name, 30))}</strong><span>Free in the Art Whisper app</span></span>
    <span class="stickybar__btn">Open</span>
  </a>
  ${storeScript(APP_STORE_LINK)}
  ${analyticsScript(slug, name)}
  ${stageScript(slug)}
  ${expandScript()}
  ${railScript()}
  ${spotShapeScript()}
  ${monitorScript(slug, [{ kind: "hero", url: heroImg }])}
</body>
</html>`;
}

// ─── sections ───────────────────────────────────────────────────────
// Stage: the featured works as slides — each painting whole (never cropped) over a
// blurred copy of itself. The header has its own strip at the top and the caption +
// controls their own strip at the bottom, so nothing sits on top of the artwork.
function renderStage({ name, period, origin, gallery, breadcrumb, playUrl }) {
  const slides = gallery
    .map((g, i) => {
      const field = cssUrl(g.sm);
      return `<div class="slide${i === 0 ? " is-on" : ""}" data-i="${i}" data-id="${esc(g.id)}" data-title="${esc(g.title)}" data-by="${esc(g.by)}">
        ${field ? `<div class="stage__field" style="background-image:url('${field}')" aria-hidden="true"></div>` : ""}
        <div class="stage__vignette" aria-hidden="true"></div>
        <div class="stage__frame"><img class="stage__img" src="${esc(g.lg)}" data-f="${esc(g.lg !== g.sm ? g.sm : "")}" onerror="if(this.dataset.f){this.src=this.dataset.f;this.dataset.f=''}" alt="${esc(g.title)}${g.by ? ` — ${esc(g.by)}` : ""}"${i === 0 ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async" draggable="false" /></div>
      </div>`;
    })
    .join("");
  const first = gallery[0];
  const meta = [origin, period ? `c. ${period}` : ""].filter(Boolean).join(" · ");
  const multi = gallery.length > 1;
  const controls = gallery.length
    ? `<div class="viewer" role="toolbar" aria-label="Featured works">
        ${multi ? `<button class="viewer__btn viewer__prev" type="button" aria-label="Previous work">${ICON_PREV}</button>
        <span class="viewer__dots">${gallery.map((_, i) => `<button class="viewer__dot${i === 0 ? " is-on" : ""}" type="button" data-i="${i}" aria-label="Show work ${i + 1}"></button>`).join("")}</span>
        <button class="viewer__btn viewer__next" type="button" aria-label="Next work">${ICON_NEXT}</button>
        <span class="viewer__div" aria-hidden="true"></span>` : ""}
        <button class="viewer__btn viewer__full" type="button" aria-label="Full screen">${ICON_EXPAND}<span class="viewer__lbl">Full screen</span></button>
      </div>`
    : "";
  return `<section class="stage"${gallery.length ? "" : ` data-empty="1"`}>
    <div class="slides">${slides}</div>
    <div class="stage__top">
      <header class="nav">
        <a class="nav__brand" href="https://artwhisper.app">
          <img class="nav__logo" src="/logo.png" alt="" width="37" height="37" />
          <span>Art Whisper</span>
        </a>
        <a class="nav__open" data-store-cta href="${playUrl}" target="_blank" rel="noopener"><span class="nav__open-lg">Open the app</span><span class="nav__open-sm">Open app</span></a>
      </header>
      ${breadcrumb.nav}
    </div>
    <div class="stage__fade" aria-hidden="true"></div>
    <div class="stage__bar">
      <div class="stage__cap">
        <span class="stage__eyebrow">ART MOVEMENT</span>
        <h1>${esc(name)}</h1>
        ${meta ? `<p>${esc(meta)}</p>` : ""}
        ${first ? `<p class="stage__feat">Featured: <a class="stage__feat-link" href="/a/${esc(first.id)}">${esc(first.title)}</a><span class="stage__feat-by">${first.by ? `, ${esc(first.by)}` : ""}</span></p>` : ""}
      </div>
      ${controls}
    </div>
    <a class="stage__scroll" href="#lede"><span>Scroll</span>${ICON_CHEV_DOWN}</a>
    <button class="stage__close" type="button" aria-label="Exit full screen">${ICON_CLOSE}</button>
  </section>`;
}

// About (overview, minus the lede sentence) + "At a glance" facts — each row only when
// its data exists.
function renderAbout(paras, { period, peak, origin, artists, before, after, t, known }) {
  const rows = [];
  const row = (l, v) => rows.push(`<dt>${l}</dt><dd>${v}</dd>`);
  const mvLink = (o) => `<a class="dl__link" href="/movement/${esc(o.slug)}">${esc(o.name)}</a>`;
  if (period) row("Period", esc(`c. ${period}`));
  if (peak) row("Peak", esc(`around ${peak}`));
  if (origin) row("Born in", esc(origin));
  const named = artists.filter((a) => a?.name).slice(0, 4);
  if (named.length)
    row("Key artists", named.map((a) => `<a class="dl__link" href="/artist/${esc(a.slug || a.id)}">${esc(a.name)}</a>`).join(", "));
  if (t.what_came_before) row("Came before", linkNames(t.what_came_before, known));
  else if (before?.slug) row("Came before", mvLink(before));
  if (t.what_came_after) row("Came after", linkNames(t.what_came_after, known));
  else if (after?.slug) row("Came after", mvLink(after));
  if (!paras.length && !rows.length) return "";
  const text = paras.length ? `<div class="about__text">${eyebrow("ABOUT THE MOVEMENT")}${paras.map((p) => `<p>${esc(p)}</p>`).join("")}</div>` : "";
  const glance = rows.length ? `<div class="about__details">${eyebrow("AT A GLANCE")}<dl class="dl">${rows.join("")}</dl></div>` : "";
  return `<section class="sec about${text && glance ? "" : " about--single"}">${text}${glance}</section>`;
}

// Timeline: what came before → started / peaked / ended → what came after.
function renderTimeline(t, before, after, known) {
  const pts = [
    ["STARTED", t.started],
    ["PEAKED", t.peaked],
    ["ENDED", t.ended],
  ].filter(([, y]) => Number.isFinite(y));
  if (pts.length < 2) return "";
  const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
  const span = Math.max(hi - lo, 1);
  const x = (y) => 8 + ((y - lo) / span) * 84; // % inside the track, with room for labels
  const side = (label, o, text) =>
    o?.slug || text
      ? `<div class="tl__side"><span class="tl__lbl">${label}</span>${
          o?.slug
            ? `<a class="tl__mv" href="/movement/${esc(o.slug)}"><span class="tl__img"${cssUrl(o.image_url) ? ` style="background-image:url('${cssUrl(o.image_url)}')"` : ""}></span><span><strong>${esc(o.name)}</strong>${o.time_period ? `<em>${esc(cleanPeriod(o.time_period))}</em>` : ""}</span></a>`
            : ""
        }${text && !(o?.name && text === o.name) ? `<span class="tl__also">${linkNames(text, known)}</span>` : ""}</div>`
      : `<div class="tl__side"></div>`;
  const track = pts
    .map(
      ([k, y], i) =>
        `<div class="tl__pt tl__pt--${i % 2 ? "up" : "down"}" style="left:${x(y).toFixed(2)}%"><i></i><span><b>~${y}</b>${k}</span></div>`,
    )
    .join("");
  const list = [
    before?.slug || t.what_came_before ? `<li class="tlm__mv"><span class="tlm__k">CAME BEFORE</span><span class="tlm__v">${t.what_came_before ? linkNames(t.what_came_before, known) : esc(before.name)}</span></li>` : "",
    ...pts.map(([k, y]) => `<li><span class="tlm__k">~${y} · ${k}</span></li>`),
    after?.slug || t.what_came_after ? `<li class="tlm__mv"><span class="tlm__k">CAME AFTER</span><span class="tlm__v">${t.what_came_after ? linkNames(t.what_came_after, known) : esc(after.name)}</span></li>` : "",
  ].join("");
  return `<section class="sec timeline">
    ${eyebrow("TIMELINE")}
    <h2 class="sec__h">When it happened</h2>
    <div class="tl">
      ${side("CAME BEFORE", before, t.what_came_before)}
      <div class="tl__track" style="--a:${x(lo).toFixed(2)}%;--b:${x(hi).toFixed(2)}%"><span class="tl__line"></span><span class="tl__span"></span>${track}</div>
      ${side("CAME AFTER", after, t.what_came_after)}
    </div>
    <ol class="tlm">${list}</ol>
  </section>`;
}

/** Cards with the first `shown` visible and a "+N" card that reveals the rest in place. */
function withMore(items, shown, card, moreLabel) {
  const visible = items.length <= shown + 1 ? items.length : shown;
  const cards = items.map((it, i) => card(it, i, i >= visible)).join("");
  const rest = items.length - visible;
  const more = rest > 0
    ? `<button class="mcard" type="button" data-more><span class="mcard__n">+${rest}</span><span class="mcard__t">${moreLabel(rest)}</span><span class="mcard__cta">Show all ${ICON_CHEV_DOWN}</span></button>`
    : "";
  return cards + more;
}

function renderChars(chars, name) {
  const list = chars.filter((c) => c && (c.title || c.description));
  if (!list.length) return "";
  const cards = withMore(
    list,
    3,
    (c, i, hidden) => `<div class="ccard${hidden ? " is-extra" : ""}">
      <span class="ccard__n">${String(i + 1).padStart(2, "0")}</span>
      <h3>${esc(c.title || "")}</h3>
      ${c.description ? `<p>${esc(c.description)}</p>` : ""}
      ${c.example_artwork ? `<span class="ccard__eg">e.g. ${esc(c.example_artwork)}</span>` : ""}
    </div>`,
    (n) => `${n} more characteristic${n === 1 ? "" : "s"}, each with an example to look for.`,
  );
  return `<section class="sec chars">
    ${eyebrow("KEY CHARACTERISTICS")}
    <h2 class="sec__h">What makes it ${esc(name)}</h2>
    <div class="cgrid">${cards}</div>
  </section>`;
}

// How to Spot It — the What-to-Notice layout from the artwork page: a painting beside
// numbered cards (no "show me", no markers on the image).
function renderSpot(spot, img, name) {
  const list = spot.filter(Boolean);
  if (!list.length) return "";
  const cards = list
    .map((s, i) => `<div class="ncard"><span class="ncard__num">${String(i + 1).padStart(2, "0")}</span><p>${esc(s)}</p></div>`)
    .join("");
  const intro = `${countWord(list.length)} sign${list.length === 1 ? "" : "s"} you’re standing in front of one${img?.title ? ` — all easy to see in ${esc(img.title)}` : ""}.`;
  return `<section class="sec notice spot">
    <div class="notice__head">
      ${eyebrow("HOW TO SPOT IT")}
      <h2>How to spot ${esc(name)}</h2>
      <p class="notice__intro">${intro}</p>
    </div>
    <div class="notice__row">
      ${img ? `<a class="notice__img" href="/a/${esc(img.id)}"><img src="${esc(img.lg)}" data-f="${esc(img.lg !== img.sm ? img.sm : "")}" onerror="if(this.dataset.f){this.src=this.dataset.f;this.dataset.f=''}" alt="${esc(img.title)}" loading="lazy" decoding="async" /></a>` : ""}
      <div class="ncards">${cards}</div>
    </div>
  </section>`;
}

function renderFacts(facts) {
  const list = facts.filter(Boolean);
  if (!list.length) return "";
  const cards = withMore(
    list,
    2,
    (f, i, hidden) => `<div class="fcard${hidden ? " is-extra" : ""}"><span class="fcard__mark" aria-hidden="true">“</span><p>${esc(f)}</p></div>`,
    (n) => `${n} more fact${n === 1 ? "" : "s"}`,
  );
  return `<section class="sec facts">
    ${eyebrow("DID YOU KNOW?")}
    <div class="fgrid">${cards}</div>
  </section>`;
}

function renderArtists(artists) {
  const list = artists.filter((a) => a?.name);
  if (!list.length) return "";
  const cards = withMore(
    list,
    3,
    (a, i, hidden) => {
      const dates = [a.birth_year, a.death_year].filter(Boolean).join("–");
      const line = [dates, a.nationality].filter(Boolean).join(" · ");
      const c = cssUrl(a.image_url);
      const initials = a.name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
      return `<a class="acard${hidden ? " is-extra" : ""}" href="/artist/${esc(a.slug || a.id)}">
        <span class="acard__pic"${c ? ` style="background-image:url('${c}')"` : ""}>${c ? "" : esc(initials)}</span>
        <strong>${esc(a.name)}</strong>
        ${line ? `<span class="acard__line">${esc(line)}</span>` : ""}
      </a>`;
    },
    (n) => `${n} more artist${n === 1 ? "" : "s"}`,
  );
  return `<section class="sec artists">
    ${eyebrow("KEY ARTISTS")}
    <h2 class="sec__h">The artists who defined it</h2>
    <div class="agrid">${cards}</div>
  </section>`;
}

// Works to know: 4 per view with ‹ › paging + dots on desktop, a swipe on mobile.
// Each painting is shown whole, never cropped (as on the artwork page).
function renderWorksRail(works) {
  const list = works.filter((w) => w?.id && w.title);
  if (!list.length) return "";
  const cards = list
    .map((w) => {
      const img = w.image_url && /^https?:\/\//.test(w.image_url) ? w.image_url : null;
      const sub = [w.artist_name, w.year, w.museum_name].filter(Boolean).map((s) => esc(String(s))).join(" · ");
      return `<a class="wcard" href="/a/${esc(w.id)}">
        <span class="wcard__img">${img ? `<img src="${esc(img)}" alt="${esc(w.title)}" loading="lazy" decoding="async" />` : ""}</span>
        <span class="wcard__t">${esc(w.title)}</span>
        ${sub ? `<span class="wcard__s">${sub}</span>` : ""}
      </a>`;
    })
    .join("");
  const pages = Math.ceil(list.length / 4);
  const nav = list.length > 3
    ? `<div class="rail__nav"><span class="rail__count">1 / ${pages}</span>
        <button class="rail__btn rail__prev" type="button" aria-label="Previous" disabled>‹</button>
        <button class="rail__btn rail__next" type="button" aria-label="Next">›</button></div>`
    : "";
  const dots = list.length > 3
    ? `<div class="rail__dots" aria-hidden="true">${Array.from({ length: pages }, (_, i) => `<i${i === 0 ? ' class="on"' : ""}></i>`).join("")}</div>`
    : "";
  return `<section class="sec works">
    <div class="works__head">
      <div>${eyebrow("NOTABLE WORKS")}<h2>Works to know</h2></div>
      ${nav}
    </div>
    <div class="rail" tabindex="0">${cards}</div>
    ${dots}
  </section>`;
}

// The app card: one "Get the free app" button, routed to the right store by device.
function renderAppCard(name, playUrl) {
  return `<section class="sec appcard">
    <div class="audio__card">
      <div class="audio__main">
        <div class="audio__eyebrow">${ICON_PHONE}IN THE ART WHISPER APP</div>
        <h2>Take ${esc(name)} to the museum</h2>
        <p>Point your phone at any painting and Art Whisper tells you its story — who made it, what to notice, and why it matters. Free to start.</p>
      </div>
      <a class="pillbtn pillbtn--dark appcard__btn" data-store-cta href="${playUrl}" target="_blank" rel="noopener">${ICON_PHONE}Get the free app</a>
    </div>
  </section>`;
}

function renderRelated(related) {
  const chips = related
    .filter((r) => r?.slug && SLUG_RE.test(r.slug))
    .map((r) => {
      const th = cssUrl(r.image_url);
      const img = th
        ? `<span class="chip__img" style="background-image:url('${th}')"></span>`
        : `<span class="chip__img chip__img--ph" aria-hidden="true">${esc((r.name || "?").charAt(0))}</span>`;
      return `<a class="chip" href="/movement/${r.slug}">${img}<span>${esc(r.name)}</span><span class="chip__chev" aria-hidden="true">›</span></a>`;
    })
    .join("");
  if (!chips) return "";
  return `<section class="sec movements">
    ${eyebrow("RELATED MOVEMENTS")}
    <div class="chips">${chips}</div>
  </section>`;
}

function renderPrevNext(before, after) {
  const card = (o, dir) => {
    if (!o?.slug) return "";
    const c = cssUrl(o.image_url);
    return `<a class="pncard pncard--${dir}" href="/movement/${esc(o.slug)}">
      <span class="pncard__img"${c ? ` style="background-image:url('${c}')"` : ""}></span>
      <span class="pncard__txt">
        <span class="pncard__k">${dir === "prev" ? "← PREVIOUS MOVEMENT" : "NEXT MOVEMENT →"}</span>
        <strong>${esc(o.name)}</strong>
        ${o.time_period ? `<span class="pncard__p">${esc(cleanPeriod(o.time_period))}</span>` : ""}
      </span>
      <span class="pncard__btn">${dir === "prev" ? "← PREVIOUS" : "NEXT →"}</span>
    </a>`;
  };
  const html = card(before, "prev") + card(after, "next");
  if (!html) return "";
  return `<section class="sec prevnext"><div class="pn">${html}</div></section>`;
}

// ─── client scripts ─────────────────────────────────────────────────
// Same device rule as the artwork page (T1-906): every [data-store-cta] goes to the
// App Store on Apple devices (iPhone, iPad incl. iPadOS, Mac); the HTML default is
// Google Play with the deferred deep-link referrer. Runs client-side because the page
// is edge-cached for everyone.
function storeScript(appStoreUrl) {
  return `<script>(function(){
  var ua=navigator.userAgent||"",pf=navigator.platform||"";
  if(!(/iPad|iPhone|iPod/.test(ua)||/Mac/.test(pf)||/Mac OS X/.test(ua)))return;
  var u=${JSON.stringify(appStoreUrl)};
  document.querySelectorAll("[data-store-cta]").forEach(function(a){a.href=u});
})();</script>`;
}

// Stage: slide switching (‹ › dots, swipe, keys, 8s autoplay until the visitor takes
// over) and a full-screen overlay (plus the Fullscreen API where allowed).
function stageScript(slug) {
  return `<script>(function(){
  var st=document.querySelector(".stage"); if(!st) return;
  var slides=st.querySelectorAll(".slide"),dots=st.querySelectorAll(".viewer__dot"),n=slides.length; if(!n) return;
  var feat=st.querySelector(".stage__feat-link"),by=st.querySelector(".stage__feat-by"),i=0,timer=null;
  function track(ev,p){try{if(window.__awTrack)window.__awTrack(ev,p||{})}catch(e){}}
  function go(k,via){ i=((k%n)+n)%n;
    Array.prototype.forEach.call(slides,function(s,j){s.classList.toggle("is-on",j===i)});
    Array.prototype.forEach.call(dots,function(d,j){d.classList.toggle("is-on",j===i)});
    var s=slides[i]; if(feat){feat.textContent=s.getAttribute("data-title")||"";feat.setAttribute("href","/a/"+s.getAttribute("data-id"));}
    if(by){var b=s.getAttribute("data-by");by.textContent=b?", "+b:"";}
    if(via) track("movement_stage_slide",{slug:${JSON.stringify(slug)},to:i,via:via}); }
  function stop(){ if(timer){clearInterval(timer);timer=null;} }
  if(n>1&&!(window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches)) timer=setInterval(function(){go(i+1)},8000);
  var p=st.querySelector(".viewer__prev"),nx=st.querySelector(".viewer__next");
  if(p) p.addEventListener("click",function(){stop();go(i-1,"button")});
  if(nx) nx.addEventListener("click",function(){stop();go(i+1,"button")});
  Array.prototype.forEach.call(dots,function(d){d.addEventListener("click",function(){stop();go(parseInt(d.getAttribute("data-i"),10)||0,"dot")})});
  var sx=null; st.querySelector(".slides").addEventListener("touchstart",function(e){sx=e.touches[0].clientX},{passive:true});
  st.querySelector(".slides").addEventListener("touchend",function(e){ if(sx==null||n<2) return; var dx=e.changedTouches[0].clientX-sx; sx=null; if(Math.abs(dx)>40){stop();go(i+(dx<0?1:-1),"swipe");} },{passive:true});
  var bf=st.querySelector(".viewer__full"),bc=st.querySelector(".stage__close");
  function enter(){ stop(); st.classList.add("is-full"); document.documentElement.classList.add("aw-lock");
    try{ if(st.requestFullscreen) st.requestFullscreen().catch(function(){}); }catch(_){}
    track("movement_stage_fullscreen",{slug:${JSON.stringify(slug)}}); }
  function exit(){ if(!st.classList.contains("is-full")) return; st.classList.remove("is-full"); document.documentElement.classList.remove("aw-lock");
    try{ if(document.fullscreenElement&&document.exitFullscreen) document.exitFullscreen().catch(function(){}); }catch(_){} }
  if(bf) bf.addEventListener("click",function(){ st.classList.contains("is-full")?exit():enter(); });
  if(bc) bc.addEventListener("click",exit);
  document.addEventListener("fullscreenchange",function(){ if(!document.fullscreenElement) exit(); });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape") exit(); if(!st.classList.contains("is-full")) return;
    if(e.key==="ArrowRight") go(i+1,"key"); if(e.key==="ArrowLeft") go(i-1,"key"); });
})();</script>`;
}

// "+N more" cards reveal the rest of their section in place (the content is already
// in the HTML for search engines).
function expandScript() {
  return `<script>(function(){
  document.addEventListener("click",function(e){ var b=e.target.closest&&e.target.closest("[data-more]"); if(!b) return;
    var sec=b.closest(".sec"); Array.prototype.forEach.call(sec.querySelectorAll(".is-extra"),function(el){el.classList.remove("is-extra")});
    b.remove(); try{if(window.__awTrack)window.__awTrack("movement_show_more",{section:sec.className})}catch(_){} });
})();</script>`;
}

function railScript() {
  return `<script>(function(){
  Array.prototype.forEach.call(document.querySelectorAll(".works"),function(sec){
    var rail=sec.querySelector(".rail"); if(!rail) return;
    var prev=sec.querySelector(".rail__prev"),next=sec.querySelector(".rail__next"),count=sec.querySelector(".rail__count"),dw=sec.querySelector(".rail__dots"),navEl=sec.querySelector(".rail__nav");
    function gap(){ return parseFloat(getComputedStyle(rail).columnGap)||0; }
    function step(){ return rail.clientWidth+gap(); }
    function sync(){ var pages=Math.max(1,Math.round((rail.scrollWidth+gap())/step())),p=Math.min(pages-1,Math.round(rail.scrollLeft/step()));
      if(count) count.textContent=(p+1)+" / "+pages;
      if(navEl) navEl.style.visibility=pages>1?"":"hidden"; if(dw) dw.style.visibility=pages>1?"":"hidden";
      if(dw){ if(dw.children.length!==pages) dw.innerHTML=new Array(pages+1).join("<i></i>"); Array.prototype.forEach.call(dw.children,function(d,i){d.classList.toggle("on",i===p)}); }
      if(prev) prev.disabled=rail.scrollLeft<4; if(next) next.disabled=rail.scrollLeft+rail.clientWidth>=rail.scrollWidth-4; }
    if(prev) prev.addEventListener("click",function(){rail.scrollBy({left:-step(),behavior:"smooth"})});
    if(next) next.addEventListener("click",function(){rail.scrollBy({left:step(),behavior:"smooth"})});
    rail.addEventListener("scroll",function(){ window.requestAnimationFrame(sync); },{passive:true});
    window.addEventListener("resize",sync); sync();
  });
})();</script>`;
}

// Picks the portrait vs landscape "How to spot it" layout from the painting's real shape.
function spotShapeScript() {
  return `<script>(function(){
  var sec=document.querySelector(".spot"),img=sec&&sec.querySelector(".notice__img img"); if(!img) return;
  function shape(){ if(img.naturalWidth) sec.setAttribute("data-shape",img.naturalWidth/img.naturalHeight>1.15?"landscape":"portrait"); }
  if(img.complete) shape(); else img.addEventListener("load",shape);
})();</script>`;
}

function renderSchema(name, desc, url, img, period) {
  const schema = {
    "@context": "https://schema.org",
    "@type": "DefinedTerm",
    name: name,
    description: desc,
    url: url,
    inDefinedTermSet: "https://artwhisper.app/movements",
    ...(img ? { image: img } : {}),
    ...(period ? { temporalCoverage: period } : {}),
  };
  const crumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Art Whisper", item: "https://artwhisper.app" },
      { "@type": "ListItem", position: 2, name: "Art Movements", item: "https://artwhisper.app/movements" },
      { "@type": "ListItem", position: 3, name: name, item: url },
    ],
  };
  const s = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${s(schema)}</script><script type="application/ld+json">${s(crumbs)}</script>`;
}

function renderNotFound() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Movement not found · Art Whisper</title>
  <meta name="robots" content="noindex" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="alternate icon" href="/favicon.ico" type="image/png" />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600&family=Lora:wght@600&display=swap" rel="stylesheet" />
  <style>${STYLES}</style>
</head>
<body>
  <main class="empty">
    <img class="empty__logo" src="/logo.png" alt="Art Whisper" width="60" height="60" />
    <h1>This movement isn't available</h1>
    <p>The link may be mistyped. Explore art movements, artists, and thousands of works in the app.</p>
    <a class="empty__cta" data-store-cta href="${PLAY_URL}" target="_blank" rel="noopener">Get the app ${ARROW}</a>
    <a class="empty__home" href="https://artwhisper.app">Back to artwhisper.app</a>
  </main>
  ${storeScript(APP_STORE_URL)}
</body>
</html>`;
}

// ─── client scripts ─────────────────────────────────────────────────
function analyticsScript(slug, name) {
  const cfg = JSON.stringify({ key: POSTHOG_KEY, host: POSTHOG_HOST, slug, name });
  return `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  var D=${cfg};
  try{ posthog.init(D.key,{api_host:D.host,capture_pageview:true,persistence:"localStorage+cookie"});
    posthog.capture("movement_page_view",{slug:D.slug,movement:D.name}); }catch(e){}
  window.__awTrack=function(ev,props){try{posthog.capture(ev,Object.assign({slug:D.slug,movement:D.name},props||{}))}catch(e){}};
</script>`;
}

function monitorScript(slug, bgImages) {
  const cfg = JSON.stringify({ slug, ingest: SENTRY_INGEST, bg: bgImages.filter((b) => b && b.url) });
  return `<script>(function(){
  var D=${cfg},seen={};
  function eid(){var a=new Uint8Array(16);if(self.crypto&&crypto.getRandomValues){crypto.getRandomValues(a)}return Array.prototype.map.call(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}
  function report(kind,url){try{
    var id=eid();
    var env=JSON.stringify({event_id:id,sent_at:new Date().toISOString()})+"\\n"+JSON.stringify({type:"event"})+"\\n"+JSON.stringify({event_id:id,level:"warning",platform:"javascript",logger:"movement-web",message:"Movement page image failed to load ("+kind+")",tags:{surface:"movement-web",slug:D.slug,image:kind},request:{url:location.href},extra:{image_url:url||null}});
    if(navigator.sendBeacon){navigator.sendBeacon(D.ingest,new Blob([env],{type:"application/x-sentry-envelope"}))}else{fetch(D.ingest,{method:"POST",body:env,keepalive:true,mode:"no-cors"})}
  }catch(e){}}
  // Same rules as the artist + artwork pages (T1-897): only the real content image (hero),
  // never every <img> on the page — one visitor on a blocked/flaky network used to create a
  // separate Sentry error per image, logo included (T1-919). Retry once before reporting and
  // report each URL at most once per page load.
  D.bg.forEach(function(o){
    if(!o.url||seen[o.url])return;
    var im=new Image();
    im.onerror=function(){setTimeout(function(){
      var rt=new Image();
      rt.onerror=function(){if(!seen[o.url]){seen[o.url]=1;report(o.kind,o.url)}};
      rt.src=o.url;
    },1500)};
    im.src=o.url;
  })
})();</script>`;
}

// ─── styles (design: Pencil "Art Movement v1.1", same system as /a/{slug}) ───
const STYLES = `
:root{
  --bg:#FAF8F3;--card:#FBF9F4;--line:#E3DED2;--rule:#DDD7CA;--chip-line:#C9BFA8;
  --ink:#1F1D1A;--body:#3A352E;--sub:#4B463D;--muted:#6D675C;--brown:#7A5C2E;--chip-ink:#5C4620;
  --gold:#D4882C;--stage:#15120E;--cream:#F5EFE3;--cta:#EF9F27;
  --serif:'Lora',Georgia,serif;--sans:'DM Sans',system-ui,-apple-system,sans-serif;
  --pad:80px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
html.aw-lock{overflow:hidden}
body{margin:0;background:var(--bg);color:var(--body);font-family:var(--sans);
  font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased;}
img{max-width:100%;display:block}
a{color:inherit}
h1,h2,h3{margin:0;font-weight:400}
button{font:inherit;color:inherit}

/* ── Stage (hero) ── */
.stage{position:relative;height:100vh;height:100svh;min-height:600px;background:var(--stage);overflow:hidden;color:var(--cream)}
.stage__field{position:absolute;inset:-160px;background:center/cover no-repeat;filter:blur(64px) saturate(1.1);opacity:.42;transform:translateZ(0)}
.stage__vignette{position:absolute;inset:0;background:radial-gradient(ellipse 65% 60% at 50% 45%,rgba(21,18,14,0) 35%,rgba(21,18,14,.9) 100%)}
.stage__top{position:absolute;left:0;right:0;top:0;z-index:4;padding-bottom:28px;
  background:linear-gradient(180deg,rgba(21,18,14,.8),rgba(21,18,14,0))}
.nav{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:20px var(--pad)}
.nav__brand{display:flex;align-items:center;gap:11px;text-decoration:none;color:var(--cream);font-family:var(--serif);font-size:21px}
.nav__logo{border-radius:50%}
.nav__open{border:1px solid var(--cream);border-radius:99px;padding:11px 20px;color:var(--cream);text-decoration:none;
  font-size:12px;font-weight:500;letter-spacing:1.4px;text-transform:uppercase;transition:background .15s,color .15s}
.nav__open:hover{background:var(--cream);color:var(--ink)}
.nav__open-sm{display:none}
.crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:4px var(--pad) 0;font-size:15px;color:rgba(245,239,227,.85)}
.crumbs a{color:#E7A75A;text-decoration:none}
.crumbs a:hover{text-decoration:underline}
.crumbs__sep{color:rgba(245,239,227,.4)}
.crumbs__current{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50vw}
.stage__frame{position:absolute;inset:0;z-index:1;padding:134px 40px 152px;display:flex}
.stage__pan{width:100%;height:100%;display:flex;align-items:center;justify-content:center;
  transform-origin:center;transition:transform .25s ease;touch-action:pan-y}
.stage__img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;user-select:none;-webkit-user-drag:none;
  box-shadow:0 40px 80px rgba(0,0,0,.6),0 4px 12px rgba(0,0,0,.35)}
.stage.is-zoomed .stage__pan{cursor:grab;touch-action:none;transition:none}
.stage.is-zoomed .stage__pan:active{cursor:grabbing}
.stage__fade{position:absolute;left:0;right:0;bottom:0;height:240px;z-index:2;pointer-events:none;
  background:linear-gradient(180deg,rgba(21,18,14,0),rgba(21,18,14,.7))}
.stage__bar{position:absolute;left:40px;right:40px;bottom:40px;z-index:3;display:flex;align-items:flex-end;justify-content:space-between;gap:32px;pointer-events:none}
.stage__bar>*{pointer-events:auto}
.stage__cap h1{font-family:var(--serif);font-size:48px;line-height:1.1;color:var(--cream);text-shadow:0 2px 20px rgba(0,0,0,.5)}
.stage__cap p{margin:6px 0 0;font-size:19px;color:rgba(245,239,227,.82)}
.stage__cap a{text-decoration:underline;text-decoration-color:rgba(245,239,227,.4);text-underline-offset:3px;text-decoration-thickness:1px}
.stage__cap a:hover{text-decoration-color:var(--cream)}
.viewer{display:flex;align-items:center;gap:2px;padding:6px;border-radius:32px;flex:none;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px)}
.viewer__btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:46px;height:46px;padding:0;border:0;border-radius:23px;
  background:transparent;color:var(--cream);cursor:pointer;transition:background .15s}
.viewer__btn:hover:not(:disabled){background:rgba(255,255,255,.12)}
.viewer__btn:disabled{opacity:.35;cursor:default}
.viewer__pct{min-width:62px;text-align:center;font-size:15px;font-variant-numeric:tabular-nums}
.viewer__div{width:1px;height:26px;background:rgba(255,255,255,.18);margin:0 1px}
.viewer__full{padding:0 16px 0 14px;font-size:15px}
.viewer__zoom{display:none}
.stage__scroll{position:absolute;left:50%;bottom:6px;z-index:3;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;
  color:rgba(245,239,227,.6);text-decoration:none;font-size:12px;letter-spacing:2.5px;text-transform:uppercase;padding:4px 12px 14px}
.stage__scroll svg{display:none}
.stage__close{display:none}
.stage[data-empty]{height:auto;min-height:0}
.stage[data-empty] .stage__top{position:relative}
.stage[data-empty] .stage__frame,.stage[data-empty] .stage__scroll{display:none}
.stage[data-empty] .stage__bar{position:relative;left:auto;right:auto;bottom:auto;padding:80px var(--pad) 56px}
/* Full screen: the stage becomes a fixed overlay (works without the Fullscreen API) */
.stage.is-full{position:fixed;inset:0;z-index:1000;height:100vh;height:100dvh;min-height:0}
.stage.is-full .stage__top,.stage.is-full .stage__scroll{display:none}
.stage.is-full .stage__frame{padding:40px 40px 130px}
.stage.is-full .stage__close{display:flex;position:absolute;top:18px;right:18px;z-index:5;width:46px;height:46px;border-radius:23px;border:1px solid rgba(255,255,255,.18);
  background:rgba(0,0,0,.35);color:var(--cream);align-items:center;justify-content:center;cursor:pointer}

/* ── Page sections ── */
.page{max-width:1760px;margin:0 auto;padding-bottom:112px}
.sec{padding:112px var(--pad) 0}
.eyebrow{display:flex;align-items:center;gap:14px}
.eyebrow span{font-size:10px;font-weight:500;letter-spacing:2.2px;color:var(--muted);text-transform:uppercase;white-space:nowrap}
.eyebrow i{flex:1;height:1px;background:var(--rule)}

/* Lede (pull-quote) */
.lede{display:flex;flex-direction:column;align-items:center;gap:32px;max-width:1200px;margin:0 auto;padding:104px var(--pad) 0;text-align:center}
.lede__rule{width:56px;height:2px;border-radius:2px;background:var(--gold)}
.lede__text{margin:0;font-family:var(--serif);font-style:italic;font-size:32px;line-height:1.45;color:#2B2823}

/* About + Details */
.about{display:grid;grid-template-columns:minmax(0,1040px) 440px;gap:120px;align-items:start;padding-top:104px}
.about--single{grid-template-columns:minmax(0,1040px)}
.about__text p{margin:22px 0 0;font-size:18px;line-height:1.75;color:var(--body)}
.about__details .eyebrow{margin-bottom:14px}
.about__details .eyebrow i{display:none}
.dl{display:grid;grid-template-columns:97px 1fr;gap:10px 0;margin:0;font-size:14px;line-height:1.5}
.dl dt{color:var(--muted)}
.dl dd{margin:0;color:var(--body)}
.dl__link{color:var(--brown);text-decoration:none;display:inline-flex;align-items:center;gap:5px}
.dl__link:hover{text-decoration:underline}
.ext{flex:none;opacity:.85}

/* Art movements */
.movements{padding-top:56px}
.chips{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}
.chip{display:inline-flex;align-items:center;gap:14px;height:66px;padding:9px 21px 9px 9px;border-radius:99px;
  background:var(--card);border:1px solid var(--chip-line);color:var(--chip-ink);font-size:14.5px;font-weight:500;text-decoration:none;white-space:nowrap;
  transition:background .15s,border-color .15s}
a.chip:hover{background:#F5EEDF;border-color:var(--gold)}
.chip__img{width:48px;height:48px;border-radius:50%;flex:none;background:#E8E1D3 center/cover no-repeat}
.chip__img--ph{display:flex;align-items:center;justify-content:center;font-family:var(--serif);font-size:18px;color:var(--brown)}
.chip__chev{font-size:15px}

/* What to Notice — portrait/square (default): image left, cards grid right */
.notice{display:grid;grid-template-columns:540px minmax(0,1fr);grid-template-areas:"img head" "img cards";grid-template-rows:auto 1fr;column-gap:80px;align-items:start;padding-top:104px}
.notice__row{display:contents}
.notice__head{grid-area:head;padding-top:21px}
.notice__head h2{margin-top:26px;font-family:var(--serif);font-size:42px;line-height:1.29;letter-spacing:-.6px;color:var(--ink)}
.notice__intro{margin:20px 0 0;font-size:17px;line-height:1.6;color:var(--sub)}
.notice__img{grid-area:img}
.notice__img img{width:auto;height:auto;max-width:100%;max-height:760px;border-radius:4px}
.ncards{grid-area:cards;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin-top:26px}
.ncard{display:flex;flex-direction:column;gap:14px;padding:27px 25px;border-radius:6px;background:var(--card);border:1px solid var(--line);min-height:197px}
.ncard p{margin:0;font-size:15px;line-height:1.62;color:var(--body)}
.ncard__num{font-family:var(--serif);font-size:26px;line-height:1.27;color:var(--gold)}
.ncard--more{background:transparent;border-color:#C3BBAA;text-decoration:none;transition:background .15s}
.ncard--more:hover{background:var(--card)}
.ncard--more .ncard__num{color:var(--brown)}
.ncard--more p{color:var(--muted)}
.ncard__cta{margin-top:auto;font-size:10px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:var(--brown)}
.notice:not(:has(.notice__img)){grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "cards"}
/* Landscape: heading across, wide image left, stacked cards right */
.notice[data-shape="landscape"]{grid-template-columns:minmax(0,1fr) 464px;grid-template-areas:"head head" "img cards";column-gap:56px}
.notice[data-shape="landscape"] .notice__head{padding-top:0;margin-bottom:28px}
.notice[data-shape="landscape"] .notice__head h2{margin-top:12px}
.notice[data-shape="landscape"] .notice__intro{margin-top:4px}
.notice[data-shape="landscape"] .notice__img{padding-top:16px}
.notice[data-shape="landscape"] .ncards{grid-template-columns:1fr;gap:12px;margin-top:16px}
.notice[data-shape="landscape"] .ncard{min-height:0;padding:18px 22px;gap:6px}
.notice[data-shape="landscape"] .ncard__num{font-size:22px}

/* Audio Deep Dive (visual teaser) */
.audio__card{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:40px;padding:44px 40px;border-radius:10px;
  border:1px solid #E0D6C0;background:linear-gradient(135deg,#F6ECD8 0%,#FBF7EE 58%,#FAF8F3 100%)}
.audio__eyebrow{display:flex;align-items:center;gap:12px;font-size:10px;font-weight:600;letter-spacing:2.2px;color:var(--brown)}
.audio__bars{display:flex;align-items:center;gap:3px;height:22px}
.audio__bars i{width:3px;border-radius:2px;background:var(--brown)}
.audio__main h2{margin-top:16px;font-family:var(--serif);font-size:40px;line-height:1.1;letter-spacing:-.6px;color:var(--ink)}
.audio__main p{margin:16px 0 0;max-width:640px;font-size:15px;line-height:1.7;color:var(--sub)}
.audio__stores{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}
.pillbtn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 20px;border-radius:99px;border:1px solid var(--ink);
  color:var(--ink);text-decoration:none;font-size:12px;font-weight:500;letter-spacing:.72px;transition:background .15s,color .15s}
.pillbtn:hover{background:var(--ink);color:#FAF8F3}
.pillbtn--dark{background:var(--ink);color:#FAF8F3}
.pillbtn--dark:hover{background:#3A352E}
.audio__player{display:flex;align-items:center;gap:18px;text-decoration:none;color:var(--ink)}
.audio__play{width:76px;height:76px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;
  background:#FFFDF8;border:1px solid #CDBF9F;color:var(--ink);transition:transform .15s,border-color .15s}
.audio__player:hover .audio__play{transform:scale(1.05);border-color:var(--gold)}
.audio__track{display:flex;flex-direction:column;gap:8px;width:190px}
.audio__track>i{display:block;height:3px;border-radius:2px;background:#E2D9C6}
.audio__times{display:flex;justify-content:space-between;font-size:10px;letter-spacing:1.4px;color:var(--muted)}
.audio__free,.audio__cta{display:none}

/* The Artist */
.artist .eyebrow{margin-bottom:26px}
.artist__card{display:flex;align-items:center;gap:30px;padding:33px;border-radius:8px;background:var(--card);border:1px solid var(--line)}
.artist__pic{flex:none;text-decoration:none}
.artist__portrait{width:120px;height:120px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:#EFE9DD center/cover no-repeat;border:1px solid var(--line)}
.artist__portrait--initials{font-family:var(--serif);font-size:30px;color:#7A7163}
.artist__body{flex:1;min-width:0}
.artist__body h3{font-family:var(--serif);font-size:28px;line-height:1.29;color:var(--brown)}
.artist__body h3 a{text-decoration:none}
.artist__body h3 a:hover{text-decoration:underline}
.artist__line{display:block;margin-top:8px;font-size:11px;letter-spacing:1.54px;text-transform:uppercase;color:var(--muted)}
.artist__body p{margin:12px 0 0;font-size:15px;line-height:1.7;color:var(--body)}
.artist__btn{flex:none;font-size:11px;letter-spacing:1.1px;text-transform:uppercase;padding:12px 18px}

/* Works rails (Further Works / More from the movement) */
.works__head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:26px}
.works__head .eyebrow i{display:none}
.works__head h2{margin-top:12px;font-family:var(--serif);font-size:42px;line-height:1.29;letter-spacing:-.6px;color:var(--ink)}
.rail__nav{display:flex;align-items:center;gap:14px;flex:none}
.rail__count{font-size:12px;letter-spacing:1.44px;color:var(--muted);font-variant-numeric:tabular-nums}
.rail__btn{width:42px;height:42px;border-radius:50%;border:1px solid var(--chip-line);background:var(--card);color:var(--ink);font-size:20px;line-height:1;cursor:pointer}
.rail__btn:hover:not(:disabled){border-color:var(--gold)}
.rail__btn:disabled{opacity:.35;cursor:default}
.rail__more{font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:var(--brown);text-decoration:none;flex:none}
.rail__more:hover{text-decoration:underline}
.rail{display:flex;gap:20px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;outline:none}
.rail::-webkit-scrollbar{display:none}
.wcard{flex:0 0 calc((100% - 60px) / 4);scroll-snap-align:start;display:flex;flex-direction:column;padding:19px 19px 21px;border-radius:6px;
  background:var(--card);border:1px solid var(--line);text-decoration:none;transition:border-color .15s,transform .15s}
.wcard:hover{border-color:var(--chip-line);transform:translateY(-2px)}
.wcard__img{height:320px;display:flex;align-items:flex-end;justify-content:center;margin-bottom:14px}
.wcard__img img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;border-radius:2px;box-shadow:0 14px 12px -6px rgba(50,42,30,.45)}
.wcard__t{font-family:var(--serif);font-size:21px;line-height:1.2;color:var(--ink);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.wcard__s{margin-top:4px;font-size:13px;line-height:1.31;color:var(--muted)}
.rail__dots{display:flex;justify-content:center;gap:7px;margin-top:22px}
.rail__dots i{width:7px;height:7px;border-radius:4px;background:#CDC6B6;transition:width .2s,background .2s}
.rail__dots i.on{width:22px;background:var(--ink)}

/* Footer */
.foot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;max-width:1760px;margin:0 auto;
  padding:27px var(--pad);border-top:1px solid var(--rule);color:var(--muted);font-size:12px}
.foot__report{display:inline-flex;align-items:center;gap:8px;text-decoration:none}
.foot__report:hover{color:var(--brown)}

/* Mobile sticky bar (hidden on desktop) */
.stickybar{display:none}

/* Empty / not-found */
.empty{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:16px;text-align:center;padding:40px;max-width:520px;margin:0 auto}
.empty__logo{margin-bottom:8px;border-radius:50%}
.empty h1{font-family:var(--serif);font-weight:600;font-size:26px;color:var(--ink)}
.empty p{margin:0;color:var(--muted);font-size:16px;line-height:1.5;max-width:420px}
.empty__cta{display:inline-flex;align-items:center;gap:8px;margin-top:8px;
  background:var(--cta);color:#fff;font-weight:600;font-size:16px;text-decoration:none;
  padding:14px 28px;border-radius:8px}
.empty__home{color:var(--muted);font-size:14px;text-decoration:none}

/* ── Responsive ── */
@media (max-width:1439px){
  :root{--pad:56px}
  .about{grid-template-columns:minmax(0,1fr) 360px;gap:72px}
  .notice{grid-template-columns:minmax(0,42%) minmax(0,1fr);column-gap:56px}
  .ncards{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ncard{min-height:0}
  .notice[data-shape="landscape"]{grid-template-columns:minmax(0,1fr) 380px}
}
@media (max-width:1100px){
  :root{--pad:40px}
  .about{grid-template-columns:minmax(0,1fr);gap:48px}
  .notice,.notice[data-shape="landscape"]{grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "img" "cards"}
  .notice__head,.notice[data-shape="landscape"] .notice__head{padding-top:0;margin-bottom:24px}
  .notice__img img{max-height:640px;margin:0 auto}
  .wcard{flex-basis:calc((100% - 40px) / 3)}
  .audio__card{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:768px){
  :root{--pad:20px}
  /* Stage: header, then the painting full-width, then the caption row */
  .stage{height:auto;min-height:0;display:flex;flex-direction:column}
  .stage__top{position:relative;padding-bottom:0}
  .nav{padding:13px 16px}
  .nav__brand{font-size:19px;gap:9px}
  .nav__logo{width:26px;height:26px}
  .nav__open{padding:7px 14px;font-size:11px}
  .nav__open-lg{display:none}.nav__open-sm{display:inline}
  .crumbs{display:none}
  .stage__frame{position:relative;inset:auto;padding:12px 16px 0;z-index:1}
  .stage__img{max-height:66vh;box-shadow:0 20px 40px rgba(0,0,0,.55)}
  .stage__fade{display:none}
  .stage__bar{position:relative;left:auto;right:auto;bottom:auto;align-items:flex-end;gap:16px;padding:20px 16px 0}
  .stage__cap h1{font-size:32px}
  .stage__cap p{font-size:15px;margin-top:4px}
  .viewer{padding:0;gap:10px;background:none;border:0;-webkit-backdrop-filter:none;backdrop-filter:none}
  .viewer__out,.viewer__in,.viewer__pct,.viewer__div,.viewer__lbl{display:none}
  .viewer__zoom{display:inline-flex}
  .viewer__btn{width:44px;min-width:44px;height:44px;border-radius:22px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18)}
  .viewer__full{padding:0}
  .stage__scroll{position:relative;left:auto;bottom:auto;transform:none;align-self:center;padding:4px 12px 14px}
  .stage__scroll span{display:none}
  .stage__scroll svg{display:block}
  .stage.is-full{display:flex}
  .stage.is-full .stage__frame{flex:1;display:flex;align-items:center;padding:56px 12px 12px}
  .stage.is-full .stage__img{max-height:calc(100dvh - 190px)}
  .stage.is-full .stage__bar{padding-bottom:24px}
  .stage.is-full .stage__close{top:10px;right:10px}

  .page{padding-bottom:40px}
  .sec{padding-top:56px}
  .lede{padding:56px 24px 0;gap:22px}
  .lede__rule{width:40px}
  .lede__text{font-size:21px;line-height:1.55}
  .about{padding-top:56px;gap:40px}
  .about__text p{font-size:16px;line-height:1.75;margin-top:16px}
  .about__details .eyebrow i{display:block}
  .dl{grid-template-columns:116px 1fr;gap:0;font-size:14px}
  .dl dt,.dl dd{padding:10px 0;border-bottom:1px solid #ECE6DA}
  .movements{padding-top:48px}
  .chips{flex-wrap:nowrap;overflow-x:auto;gap:10px;margin:16px calc(var(--pad) * -1) 0 0;padding-right:var(--pad);scrollbar-width:none}
  .chips::-webkit-scrollbar{display:none}
  .chip{height:52px;font-size:14px;gap:10px;padding:7px 16px 7px 7px}
  .chip__img{width:38px;height:38px}
  .notice__head h2,.notice[data-shape="landscape"] .notice__head h2{font-size:30px;margin-top:14px}
  .notice__intro{font-size:15px;margin-top:10px}
  .notice__img img{max-height:420px}
  .ncards,.notice[data-shape="landscape"] .ncards{grid-template-columns:1fr;gap:10px;margin-top:16px}
  .ncard,.notice[data-shape="landscape"] .ncard{flex-direction:row;align-items:center;gap:16px;padding:16px 18px;min-height:0}
  .ncard__num,.notice[data-shape="landscape"] .ncard__num{font-size:24px;flex:none;width:30px}
  .ncard--more{flex-wrap:wrap;row-gap:4px}
  .ncard--more p{flex:1}
  .ncard__cta{margin:0 0 0 46px;width:100%}
  .audio__card{padding:24px;gap:18px}
  .audio__main h2{font-size:26px;margin-top:14px}
  .audio__stores{display:none}
  .audio__player{gap:12px;padding:12px;border-radius:40px;background:#FFFDF8;border:1px solid #E0D6C0}
  .audio__play{width:44px;height:44px;background:var(--ink);border-color:var(--ink);color:#FAF8F3}
  .audio__track{flex:1;width:auto}
  .audio__track>i{background:linear-gradient(90deg,var(--gold) 0 18%,#E2D9C6 18% 100%)}
  .audio__times{display:none}
  .audio__free{display:block;font-size:13px;color:var(--muted)}
  .audio__cta{display:flex;align-items:center;justify-content:center;gap:10px;padding:15px;border-radius:99px;background:var(--ink);color:#FAF8F3;
    text-decoration:none;font-size:15px;font-weight:500}
  .artist .eyebrow{margin-bottom:16px}
  .artist__card{display:grid;grid-template-columns:64px minmax(0,1fr);column-gap:14px;align-items:center;padding:20px}
  .artist__portrait{width:64px;height:64px}
  .artist__portrait--initials{font-size:22px}
  .artist__body{display:contents}
  .artist__body h3{font-size:21px;grid-column:2;align-self:end}
  .artist__line{grid-column:2;align-self:start;margin-top:4px}
  .artist__pic{grid-row:1 / span 2}
  .artist__body p{grid-column:1 / -1;margin-top:16px}
  .artist__btn{grid-column:1 / -1;margin-top:16px;padding:14px;font-size:12px}
  .works__head{margin-bottom:16px}
  .works__head h2{font-size:26px;margin-top:8px}
  .rail__nav,.rail__dots{display:none}
  .rail{gap:12px;margin-right:calc(var(--pad) * -1);padding-right:var(--pad)}
  .wcard{flex:0 0 168px;padding:0;background:none;border:0}
  .wcard:hover{transform:none}
  .wcard__img{height:200px;align-items:flex-end;justify-content:flex-start;margin-bottom:10px}
  .wcard__t{font-size:16px}
  .wcard__s{font-size:12px}
  .foot{flex-direction:column;align-items:flex-start;padding:32px 20px 112px;font-size:13px}
  /* Sticky "hear the story" bar */
  .stickybar{display:flex;align-items:center;gap:12px;position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:50;
    padding:10px 10px 10px 12px;border-radius:16px;background:var(--ink);color:var(--cream);text-decoration:none;box-shadow:0 10px 30px rgba(0,0,0,.28)}
  .stickybar__logo{border-radius:50%;flex:none}
  .stickybar__txt{display:flex;flex-direction:column;min-width:0;flex:1}
  .stickybar__txt strong{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .stickybar__txt span{font-size:12px;color:rgba(245,239,227,.65)}
  .stickybar__btn{flex:none;padding:9px 18px;border-radius:99px;background:#E9A24A;color:var(--ink);font-size:14px;font-weight:600}
  .stage.is-full ~ .stickybar{display:none}
}

/* ── Movement page additions (Pencil "Art Movement v1.1", T1-907) ── */
.slides{position:absolute;inset:0}
.slide{position:absolute;inset:0;opacity:0;transition:opacity .7s ease;pointer-events:none}
.slide.is-on{opacity:1;pointer-events:auto}
.slide .stage__frame{padding:134px 40px 200px}
.stage__eyebrow{display:block;margin-bottom:8px;font-size:12px;font-weight:600;letter-spacing:2.2px;color:#E0A050}
.stage__cap .stage__feat{font-size:14px;color:rgba(245,239,227,.6);margin-top:8px}
.stage__feat a{color:rgba(245,239,227,.85)}
.viewer__dots{display:flex;align-items:center;gap:6px;padding:0 8px;height:46px}
.viewer__dot{width:7px;height:7px;padding:0;border:0;border-radius:4px;background:rgba(255,255,255,.35);cursor:pointer;transition:width .2s,background .2s}
.viewer__dot.is-on{width:20px;background:#E0A050}
.stage.is-full .slide .stage__frame{padding:40px 40px 170px}
.sec__h{margin-top:26px;font-family:var(--serif);font-size:42px;line-height:1.29;letter-spacing:-.6px;color:var(--ink)}

/* Timeline */
.timeline .tl{display:grid;grid-template-columns:240px minmax(0,1fr) 240px;gap:40px;align-items:center;margin-top:26px;padding:36px 40px;border-radius:8px;background:var(--card);border:1px solid var(--line)}
.tl__side{display:flex;flex-direction:column;gap:12px}
.tl__lbl{font-size:12px;font-weight:600;letter-spacing:2px;color:var(--brown)}
.tl__mv{display:flex;align-items:center;gap:12px;text-decoration:none}
.tl__mv strong{display:block;font-family:var(--serif);font-weight:400;font-size:18px;color:var(--ink)}
.tl__mv em{display:block;font-style:normal;font-size:13px;color:var(--muted)}
.tl__mv:hover strong{text-decoration:underline}
.tl__img{width:52px;height:52px;border-radius:50%;flex:none;background:#E8E1D3 center/cover no-repeat;border:1px solid var(--line)}
.tl__also{font-size:13px;line-height:1.45;color:var(--muted)}
.tl__track{position:relative;height:150px}
.tl__line{position:absolute;left:0;right:0;top:50%;height:2px;margin-top:-1px;background:var(--rule)}
.tl__span{position:absolute;left:var(--a);width:calc(var(--b) - var(--a));top:50%;height:4px;margin-top:-2px;border-radius:2px;background:var(--gold)}
.tl__pt{position:absolute;top:50%;width:0;height:0}
.tl__pt i{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;background:var(--gold);border:3px solid var(--card)}
.tl__pt span{position:absolute;left:0;transform:translateX(-50%);white-space:nowrap;text-align:center;font-size:12px;font-weight:600;letter-spacing:1.2px;color:#B06D1C}
.tl__pt span b{display:block;font-family:var(--serif);font-weight:400;font-size:22px;letter-spacing:0;color:var(--ink)}
.tl__pt--down span{top:20px}
.tl__pt--up span{bottom:20px}
.tlm{display:none}

/* Key characteristics, artists + the "+N more" card */
.cgrid,.agrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;margin-top:26px}
.ccard{display:flex;flex-direction:column;gap:10px;padding:28px;border-radius:8px;background:var(--card);border:1px solid var(--line)}
.ccard__n{font-family:var(--serif);font-size:26px;color:var(--gold)}
.ccard h3{font-family:var(--serif);font-size:21px;line-height:1.3;color:var(--ink)}
.ccard p{margin:0;font-size:15px;line-height:1.6;color:var(--body)}
.ccard__eg{margin-top:auto;padding-top:6px;font-size:13px;color:var(--brown)}
.mcard{display:flex;flex-direction:column;justify-content:center;gap:12px;padding:32px;border-radius:8px;border:1px solid #C3BBAA;background:transparent;text-align:left;cursor:pointer;transition:background .15s}
.mcard:hover{background:var(--card)}
.mcard__n{font-family:var(--serif);font-size:44px;line-height:1;color:var(--gold)}
.mcard__t{font-size:16px;line-height:1.6;color:var(--muted)}
.mcard__cta{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:var(--brown)}
.is-extra{display:none!important}

/* How to spot it = the What-to-Notice layout */
.spot .notice__img{display:block}

/* Did you know */
.fgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr)) 300px;gap:20px;margin-top:26px}
.fgrid:not(:has(.mcard)){grid-template-columns:repeat(2,minmax(0,1fr))}
.fcard{display:flex;gap:24px;padding:32px 36px;border-radius:8px;background:#EFE6D4}
.fcard__mark{font-family:var(--serif);font-size:64px;line-height:.9;color:var(--gold)}
.fcard p{margin:0;font-family:var(--serif);font-style:italic;font-size:22px;line-height:1.45;color:#2B2823}
.fgrid .mcard{padding:28px 32px}

/* Key artists */
.acard{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px 20px;border-radius:8px;background:var(--card);border:1px solid var(--line);text-align:center;text-decoration:none;transition:border-color .15s,transform .15s}
.acard:hover{border-color:var(--chip-line);transform:translateY(-2px)}
.acard__pic{width:132px;height:132px;margin-bottom:10px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#EFE9DD center/cover no-repeat;border:1px solid var(--line);font-family:var(--serif);font-size:34px;color:#7A7163}
.acard strong{font-family:var(--serif);font-weight:400;font-size:23px;line-height:1.25;color:var(--ink)}
.acard__line{font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted)}
.agrid .mcard{align-items:center;text-align:center}

/* App card */
.appcard .audio__card{grid-template-columns:minmax(0,1fr) auto}
.appcard .audio__eyebrow svg{width:16px;height:16px}
.appcard__btn{padding:14px 24px;font-size:14px;font-weight:600;letter-spacing:0}

/* Previous / next movement */
.pn{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.pncard{display:flex;align-items:center;gap:24px;padding:24px 28px;border-radius:10px;text-decoration:none;background:linear-gradient(120deg,#EFE2C8,#F8F1E3);transition:transform .15s}
.pncard:hover{transform:translateY(-2px)}
.pncard--next:only-child{grid-column:2}
.pncard__img{width:120px;height:120px;border-radius:50%;flex:none;background:#E8E1D3 center/cover no-repeat;border:1px solid var(--line)}
.pncard__txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.pncard__k{font-size:11px;font-weight:600;letter-spacing:1.6px;color:var(--brown)}
.pncard strong{font-family:var(--serif);font-weight:400;font-size:30px;line-height:1.2;color:var(--ink)}
.pncard__p{font-size:14px;color:var(--sub)}
.pncard__btn{flex:none;padding:12px 18px;border-radius:99px;background:var(--ink);color:#FAF8F3;font-size:11px;letter-spacing:1.1px}

@media (max-width:1439px){
  .timeline .tl{grid-template-columns:200px minmax(0,1fr) 200px;gap:28px}
  .cgrid,.agrid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .fgrid{grid-template-columns:repeat(2,minmax(0,1fr))}
  .pncard__btn{display:none}
}
@media (max-width:1100px){
  .timeline .tl{grid-template-columns:minmax(0,1fr);gap:24px}
  .pn{grid-template-columns:minmax(0,1fr)}
  .pncard--next:only-child{grid-column:auto}
  .appcard .audio__card{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:768px){
  .slides{position:relative;inset:auto;height:min(64vh,520px)}
  .slide .stage__frame{position:absolute;inset:0;padding:12px 16px}
  .stage__eyebrow{font-size:11px;margin-bottom:6px}
  .stage__cap .stage__feat{font-size:12px}
  .viewer__dots,.viewer__prev,.viewer__next,.viewer__div{display:none}
  .stage.is-full .slides{flex:1;height:auto}
  .stage.is-full .slide .stage__frame{padding:56px 12px 12px}
  .sec__h{font-size:28px;margin-top:14px}
  .timeline .tl{display:none}
  .tlm{display:flex;flex-direction:column;margin:18px 0 0;padding:20px;list-style:none;border-radius:10px;background:var(--card);border:1px solid var(--line)}
  .tlm li{position:relative;padding:0 0 18px 26px;border-left:2px solid var(--gold);margin-left:8px}
  .tlm li:last-child{padding-bottom:0;border-left-color:transparent}
  .tlm li::before{content:"";position:absolute;left:-9px;top:1px;width:16px;height:16px;border-radius:50%;background:var(--gold);border:3px solid var(--card)}
  .tlm li.tlm__mv::before{background:var(--rule)}
  .tlm__k{display:block;font-size:11px;font-weight:600;letter-spacing:1.4px;color:#B06D1C}
  .tlm__mv .tlm__k{color:var(--brown)}
  .tlm__v{display:block;margin-top:3px;font-family:var(--serif);font-size:18px;color:var(--ink)}
  .tlm__v a,.tl__also a{color:var(--brown)}
  .cgrid,.agrid{display:flex;overflow-x:auto;gap:12px;margin:16px calc(var(--pad) * -1) 0 0;padding-right:var(--pad);scrollbar-width:none;scroll-snap-type:x mandatory}
  .cgrid::-webkit-scrollbar,.agrid::-webkit-scrollbar{display:none}
  .ccard,.cgrid .mcard{flex:0 0 270px;scroll-snap-align:start;padding:20px}
  .acard,.agrid .mcard{flex:0 0 170px;scroll-snap-align:start;padding:22px 14px}
  .acard__pic{width:96px;height:96px;font-size:26px}
  .acard strong{font-size:17px}
  .ccard h3{font-size:19px}
  .fgrid,.fgrid:not(:has(.mcard)){grid-template-columns:minmax(0,1fr);gap:12px;margin-top:16px}
  .fcard{gap:14px;padding:22px}
  .fcard__mark{font-size:44px}
  .fcard p{font-size:18px}
  .fgrid .mcard{flex-direction:row;align-items:center;padding:16px 18px}
  .mcard__n{font-size:28px}
  .appcard .audio__main h2{font-size:26px}
  .appcard__btn{display:flex;width:100%;padding:15px;font-size:15px}
  .pn{gap:12px}
  .pncard{gap:16px;padding:16px}
  .pncard__img{width:72px;height:72px}
  .pncard strong{font-size:21px}
  .pncard__k{font-size:10px}
}

/* Fixes after render check */
.slide .stage__frame{align-items:center;justify-content:center}
.slide .stage__img{max-width:100%;max-height:100%}
.fgrid:not(:has(.mcard)){grid-template-columns:none;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr)}
.spot .ncards{grid-template-columns:repeat(3,minmax(0,1fr))}
@media (max-width:1439px){ .spot .ncards{grid-template-columns:minmax(0,1fr)} }
@media (max-width:768px){
  .stage__top{order:-1}
  .fgrid:not(:has(.mcard)){grid-auto-flow:row;grid-template-columns:minmax(0,1fr)}
}
`;
