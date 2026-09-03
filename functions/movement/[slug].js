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
  return html(renderPage(data, canonical || slug), 200, 3600);
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
const CHEV_R = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
const CHEV_L = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
const CHEV_D = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
const CHEV_U = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>`;
const EXPAND = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
const CLOSE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

// Prefer the large derivative for full-screen viewing; falls back gracefully.
const lgUrl = (u) => (u ? String(u).replace(/_sm\.(jpe?g|png|webp)(\?|$)/i, "_lg.$1$2") : u);

// ─── page ───────────────────────────────────────────────────────────
function renderPage(data, slug) {
  const m = data.movement || {};
  const artists = Array.isArray(data.key_artists) ? data.key_artists : [];
  const works = Array.isArray(data.notable_works) ? data.notable_works : [];
  const related = Array.isArray(data.related_movements) ? data.related_movements : [];
  const before = data.before_movement || null;
  const after = data.after_movement || null;

  const name = m.name || "Art Movement";
  const period = m.time_period || "";
  const origin = m.origin_location || "";
  const subtitle = [period, origin].filter(Boolean).join(" · ");
  const overview = m.overview || "";
  const chars = Array.isArray(m.key_characteristics) ? m.key_characteristics : [];
  const facts = Array.isArray(m.fun_facts) ? m.fun_facts : [];
  const spot = Array.isArray(m.how_to_spot_it) ? m.how_to_spot_it : [];
  const timeline = m.timeline || null;
  const featured = m.featured_artwork || null;

  // Hero gallery: featured artwork first, then notable works. Up to 5.
  // Each entry carries a caption + artwork id so the immersive hero can open
  // the full, uncropped image in a lightbox (matching the mobile app).
  const gallery = [];
  const seenArt = new Set();
  const pushArt = (o) => {
    if (!o?.image_url || !o.id || seenArt.has(o.id)) return;
    seenArt.add(o.id);
    gallery.push({
      url: o.image_url,
      full: lgUrl(o.image_url),
      id: o.id,
      title: o.title || "",
      by: o.artist_name || [o.year, o.museum_name].filter(Boolean).join(" · "),
    });
  };
  if (featured) pushArt(featured);
  for (const w of works) {
    if (gallery.length >= 5) break;
    pushArt(w);
  }
  const heroImg = gallery[0]?.url || null;

  const pageUrl = `https://artwhisper.app/movement/${esc(slug)}`;
  const ogImg = featured?.image_url || heroImg || "";
  const metaDesc = clip(overview || `${name} (${period}) — key artists, characteristics, notable works, and how to spot it.`, 180);

  // Sections
  const heroHtml = renderHero(name, subtitle, gallery);
  const overviewHtml = overview ? renderOverview(overview) : "";
  const factsHtml = renderFacts(facts);
  const charsHtml = renderChars(chars);
  const artistsHtml = renderArtists(artists);
  const worksHtml = renderWorks(works);
  const timelineHtml = renderTimeline(timeline);
  const spotHtml = renderSpot(spot);
  const relatedHtml = renderRelated(related);
  const navHtml = renderPrevNext(before, after);

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
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="alternate icon" href="/favicon.ico" type="image/png" />
  <link rel="apple-touch-icon" href="/favicon.ico" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&display=swap" rel="stylesheet" />
  <style>${STYLES}</style>
</head>
<body>
  <header class="nav">
    <a class="nav__brand" href="https://artwhisper.app">
      <img class="nav__logo" src="/logo.png" alt="Art Whisper" width="30" height="30" />
      <span>Art Whisper</span>
    </a>
    <div class="nav__right">
      <a class="nav__link" href="/movements">All movements</a>
      <a class="nav__open" href="${PLAY_URL}" target="_blank" rel="noopener">
        <span class="nav__open-lg">Open in Art Whisper</span><span class="nav__open-sm">Open the App</span> ${ARROW}
      </a>
    </div>
  </header>

  ${heroHtml}
  ${overviewHtml}

  <section class="band cta">
    <div class="cta__left">
      <img class="cta__mark" src="/logo.png" alt="" width="26" height="26" />
      <span>Explore this movement in depth in Art Whisper</span>
    </div>
    <div class="badges">
      <a class="badge" href="${PLAY_URL}" target="_blank" rel="noopener" aria-label="Get Art Whisper on Google Play"><img src="/badges/google-play.svg" alt="Get it on Google Play" height="44" /></a>
      <a class="badge" href="${APP_STORE_URL}" target="_blank" rel="noopener" aria-label="Download Art Whisper on the App Store"><img src="/badges/app-store.svg" alt="Download on the App Store" height="44" /></a>
    </div>
  </section>

  ${factsHtml}
  ${charsHtml}
  ${artistsHtml}
  ${worksHtml}
  ${timelineHtml}
  ${spotHtml}
  ${relatedHtml}
  ${navHtml}

  <section class="report">
    <a href="https://artwhisper.app/#support">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
      See something wrong?
    </a>
  </section>

  <footer class="foot"><span>© ${new Date().getFullYear()} Bright Star. All rights reserved.</span></footer>

  <a class="stickybar" href="${PLAY_URL}" target="_blank" rel="noopener">
    <span class="stickybar__left"><img class="stickybar__logo" src="/logo.png" alt="" width="32" height="32" /><strong>Open the App</strong></span>
    ${ARROW}
  </a>

  <div class="lightbox" id="awlb" hidden>
    <button class="lb__close" type="button" aria-label="Close">${CLOSE}</button>
    <figure class="lb__fig">
      <img class="lb__img" alt="" />
      <figcaption class="lb__cap">
        <strong class="lb__t"></strong>
        <span class="lb__b"></span>
        <a class="lb__link" href="#" target="_blank" rel="noopener">View artwork ${CHEV_R}</a>
      </figcaption>
    </figure>
  </div>

  ${analyticsScript(slug, name)}
  ${carouselScript()}
  ${showMoreScript(slug)}
  ${lightboxScript(slug)}
  ${monitorScript(slug, [{ kind: "hero", url: heroImg }])}
</body>
</html>`;
}

// ─── sections ───────────────────────────────────────────────────────
function renderHero(name, subtitle, gallery) {
  const items = gallery.length ? gallery : [null];
  const slides = items
    .map((g) => {
      if (!g) return `<div class="hero__slide"></div>`;
      const c = cssUrl(g.url);
      const full = cssUrl(g.full || g.url);
      const orig = cssUrl(g.url);
      return `<div class="hero__slide"${c ? ` style="background-image:url('${c}')"` : ""} data-full="${esc(full || "")}" data-orig="${esc(orig || "")}" data-id="${esc(g.id || "")}" data-title="${esc(g.title || "")}" data-by="${esc(g.by || "")}"></div>`;
    })
    .join("");
  const dots =
    gallery.length > 1
      ? `<div class="hero__dots">${gallery.map((_, i) => `<button class="hero__dot${i === 0 ? " is-active" : ""}" data-i="${i}" aria-label="Go to slide ${i + 1}"></button>`).join("")}</div>`
      : "";
  const expand = gallery.length
    ? `<button class="hero__expand" type="button" aria-label="View full artwork">${EXPAND}<span>View full</span></button>`
    : "";
  return `<section class="hero">
    <div class="hero__track">${slides}</div>
    <div class="hero__scrim"></div>
    ${expand}
    ${dots}
    <div class="hero__title">
      <span class="hero__eyebrow">ART MOVEMENT</span>
      <h1>${esc(name)}</h1>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
    </div>
  </section>`;
}

function renderOverview(text) {
  const paras = String(text)
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const all = paras.length ? paras : [text];
  // Show the opening paragraph; collapse the rest behind a Show more.
  const body = all
    .map((p, i) => `<p${i >= 1 ? ' class="xtra is-hidden"' : ""}>${esc(p)}</p>`)
    .join("");
  const more =
    all.length > 1
      ? `<button class="showmore" data-section="overview"><span class="showmore__t">Show more</span><span class="showmore__i">${CHEV_D}</span></button>`
      : "";
  return `<section class="sec overview">
    <span class="eyebrow eyebrow--muted">OVERVIEW</span>
    <div class="overview__body">${body}</div>
    ${more}
  </section>`;
}

/** Generic collapsible list: shows `initial`, rest hidden behind a Show-more. */
function collapsible(items, initial, sectionKey, cardHtml) {
  const cards = items
    .map((it, i) => cardHtml(it, i, i >= initial))
    .join("");
  const more = items.length > initial
    ? `<button class="showmore" data-section="${esc(sectionKey)}"><span class="showmore__t">Show more</span><span class="showmore__i">${CHEV_D}</span></button>`
    : "";
  return { cards, more };
}

function renderFacts(facts) {
  if (!facts.length) return "";
  const { cards, more } = collapsible(facts, 4, "did_you_know", (f, i, hidden) =>
    `<div class="fcard${hidden ? " xtra is-hidden" : ""}"><span class="fcard__mark">${esc(String(i + 1))}</span><p>${esc(f)}</p></div>`,
  );
  return `<section class="sec facts">
    <span class="eyebrow eyebrow--gold">DID YOU KNOW?</span>
    <div class="fgrid">${cards}</div>
    ${more}
  </section>`;
}

function renderChars(chars) {
  if (!chars.length) return "";
  const { cards, more } = collapsible(chars, 3, "key_characteristics", (c, i, hidden) =>
    `<div class="ccard${hidden ? " xtra is-hidden" : ""}">
      <strong>${esc(c.title || "")}</strong>
      <p>${esc(c.description || "")}</p>
      ${c.example_artwork ? `<span class="ccard__eg">e.g. ${esc(c.example_artwork)}</span>` : ""}
    </div>`,
  );
  return `<section class="sec chars">
    <span class="eyebrow eyebrow--muted">KEY CHARACTERISTICS</span>
    <div class="cgrid">${cards}</div>
    ${more}
  </section>`;
}

function renderArtists(artists) {
  if (!artists.length) return "";
  const items = artists
    .map((a) => {
      const dates = [a.birth_year, a.death_year].filter(Boolean).join("–");
      const line = [dates, a.nationality].filter(Boolean).join(" · ");
      const c = cssUrl(a.image_url);
      const av = c
        ? `<span class="acard__av" style="background-image:url('${c}')"></span>`
        : `<span class="acard__av acard__av--ph">${esc((a.name || "?").slice(0, 1))}</span>`;
      // Artist deep-link — prefer the pretty slug URL, fall back to UUID (T1-818).
      return `<a class="acard" href="https://artwhisper.app/artist/${esc(a.slug || a.id)}">
        ${av}
        <strong>${esc(a.name || "")}</strong>
        ${line ? `<span class="acard__line">${esc(line)}</span>` : ""}
        <span class="acard__link">${CHEV_R}</span>
      </a>`;
    })
    .join("");
  return `<section class="sec artists">
    <span class="eyebrow eyebrow--muted">KEY ARTISTS</span>
    <div class="arow">${items}</div>
  </section>`;
}

function renderWorks(works) {
  if (!works.length) return "";
  const { cards, more } = collapsible(works, 6, "notable_works", (w, i, hidden) => {
    const c = cssUrl(w.image_url);
    const meta = [w.year, w.museum_name].filter(Boolean).join(" · ");
    return `<a class="wcard${hidden ? " xtra is-hidden" : ""}" href="/a/${esc(w.id)}">
      <span class="wcard__img"${c ? ` style="background-image:url('${c}')"` : ""}></span>
      <span class="wcard__t">${esc(w.title || "")}</span>
      ${meta ? `<span class="wcard__m">${esc(meta)}</span>` : ""}
    </a>`;
  });
  return `<section class="sec works">
    <span class="eyebrow eyebrow--muted">NOTABLE WORKS</span>
    <div class="wgrid">${cards}</div>
    ${more}
  </section>`;
}

function renderTimeline(t) {
  if (!t) return "";
  const points = [
    ["Started", t.started],
    ["Peaked", t.peaked],
    ["Ended", t.ended],
  ].filter(([, v]) => v);
  if (!points.length && !t.what_came_before && !t.what_came_after) return "";
  const dots = points
    .map(([label, year]) => `<div class="tpoint"><span class="tpoint__dot"></span><span class="tpoint__year">${esc(String(year))}</span><span class="tpoint__lbl">${label}</span></div>`)
    .join("");
  const flow = [
    t.what_came_before ? tflowCard("Grew out of", t.what_came_before, "back") : "",
    t.what_came_after ? tflowCard("Led to", t.what_came_after, "fwd") : "",
  ].filter(Boolean).join("");
  return `<section class="sec timeline">
    <span class="eyebrow eyebrow--muted">TIMELINE</span>
    <div class="tline">${dots}</div>
    ${flow ? `<div class="tflows">${flow}</div>` : ""}
  </section>`;
}

function tflowCard(label, val, dir) {
  const icon = dir === "back" ? CHEV_L : CHEV_R;
  return `<div class="tflow tflow--${dir}"><span class="tflow__ic">${icon}</span><span class="tflow__txt"><span class="tflow__lbl">${label}</span><span class="tflow__v">${esc(val)}</span></span></div>`;
}

function renderSpot(spot) {
  if (!spot.length) return "";
  const { cards, more } = collapsible(spot, 3, "how_to_spot_it", (s, i, hidden) =>
    `<div class="spot${hidden ? " xtra is-hidden" : ""}"><span class="spot__num">${esc(String(i + 1))}</span><p>${esc(s)}</p></div>`,
  );
  return `<section class="sec spotit">
    <span class="eyebrow eyebrow--gold">LOOK CLOSER</span>
    <h2>How to Spot It</h2>
    <div class="spots">${cards}</div>
    ${more}
  </section>`;
}

function movementCard(m, label) {
  if (!m) return "";
  const years = m.time_period || "";
  const c = cssUrl(m.image_url); // present only if the API supplies it
  const thumb = c
    ? `<span class="mvc__thumb" style="background-image:url('${c}')"></span>`
    : `<span class="mvc__thumb mvc__thumb--ph"></span>`;
  return `<a class="mvc" href="/movement/${esc(m.slug)}">
    ${thumb}
    <span class="mvc__txt">${label ? `<span class="mvc__lbl">${label}</span>` : ""}<strong>${esc(m.name || "")}</strong>${years ? `<span class="mvc__yr">${esc(years)}</span>` : ""}</span>
    <span class="mvc__chev">${CHEV_R}</span>
  </a>`;
}

function renderRelated(related) {
  if (!related.length) return "";
  const cards = related.map((r) => movementCard(r, "")).join("");
  return `<section class="sec related">
    <span class="eyebrow eyebrow--muted">RELATED MOVEMENTS</span>
    <div class="mvgrid">${cards}</div>
  </section>`;
}

function pnCard(m, dir) {
  if (!m) return "<span></span>";
  const years = m.time_period || "";
  const c = cssUrl(m.image_url);
  const thumb = `<span class="mvc__thumb${c ? "" : " mvc__thumb--ph"}"${c ? ` style="background-image:url('${c}')"` : ""}></span>`;
  const txt = `<span class="mvc__txt"><span class="mvc__lbl">${dir === "prev" ? "Previous" : "Next"}</span><strong>${esc(m.name || "")}</strong>${years ? `<span class="mvc__yr">${esc(years)}</span>` : ""}</span>`;
  const chev = `<span class="mvc__chev">${dir === "prev" ? CHEV_L : CHEV_R}</span>`;
  const inner = dir === "prev" ? `${chev}${thumb}${txt}` : `${txt}${thumb}${chev}`;
  return `<a class="mvc mvc--${dir}" href="/movement/${esc(m.slug)}">${inner}</a>`;
}

function renderPrevNext(before, after) {
  if (!before && !after) return "";
  return `<section class="sec prevnext">
    <div class="pn">
      ${pnCard(before, "prev")}
      ${pnCard(after, "next")}
    </div>
  </section>`;
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
    <a class="empty__cta" href="${PLAY_URL}" target="_blank" rel="noopener">Get the app ${ARROW}</a>
    <a class="empty__home" href="https://artwhisper.app">Back to artwhisper.app</a>
  </main>
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

function carouselScript() {
  return `<script>(function(){
  var track=document.querySelector(".hero__track"); if(!track) return;
  var n=track.children.length; if(n<2) return;
  var dots=document.querySelectorAll(".hero__dot");
  var i=0,timer;
  function setActive(){Array.prototype.forEach.call(dots,function(d,k){d.classList.toggle("is-active",k===i)});}
  function go(k){i=((k%n)+n)%n;track.style.transform="translateX("+(-i*100)+"%)";setActive();}
  function next(){go(i+1);}
  function reset(){clearInterval(timer);timer=setInterval(next,8000);}
  Array.prototype.forEach.call(dots,function(d){d.addEventListener("click",function(){go(parseInt(d.getAttribute("data-i"),10)||0);reset();});});
  reset();
})();</script>`;
}

function lightboxScript(slug) {
  return `<script>(function(){
  var lb=document.getElementById("awlb"); if(!lb) return;
  var img=lb.querySelector(".lb__img"),t=lb.querySelector(".lb__t"),b=lb.querySelector(".lb__b"),lk=lb.querySelector(".lb__link");
  var slides=document.querySelectorAll(".hero__slide");
  function ai(){var d=document.querySelector(".hero__dot.is-active");return d?(parseInt(d.getAttribute("data-i"),10)||0):0;}
  function open(){
    var s=slides[ai()]||slides[0]; if(!s) return;
    var full=s.getAttribute("data-full")||s.getAttribute("data-orig")||""; if(!full) return;
    var orig=s.getAttribute("data-orig")||"";
    img.onerror=function(){ if(orig && img.src!==orig){ img.onerror=null; img.src=orig; } };
    img.src=full; img.alt=s.getAttribute("data-title")||"";
    t.textContent=s.getAttribute("data-title")||"";
    b.textContent=s.getAttribute("data-by")||"";
    var id=s.getAttribute("data-id");
    if(id){ lk.href="/a/"+id; lk.style.display=""; } else { lk.style.display="none"; }
    lb.hidden=false; document.documentElement.style.overflow="hidden";
    try{ if(window.__awTrack) window.__awTrack("movement_hero_expand",{slug:${JSON.stringify(slug)},artwork_id:id||null}); }catch(e){}
  }
  function close(){ lb.hidden=true; document.documentElement.style.overflow=""; img.removeAttribute("src"); }
  var btn=document.querySelector(".hero__expand"); if(btn) btn.addEventListener("click",open);
  lb.addEventListener("click",function(e){ if(e.target===lb || e.target.closest(".lb__close")) close(); });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape" && !lb.hidden) close(); });
})();</script>`;
}

function showMoreScript() {
  return `<script>(function(){
  var UP=${JSON.stringify(CHEV_U)},DOWN=${JSON.stringify(CHEV_D)};
  Array.prototype.forEach.call(document.querySelectorAll(".showmore"),function(btn){
    var sec=btn.closest(".sec"); if(!sec) return;
    var t=btn.querySelector(".showmore__t"),ic=btn.querySelector(".showmore__i");
    btn.addEventListener("click",function(){
      var extras=sec.querySelectorAll(".xtra");
      var collapsed=sec.querySelector(".xtra.is-hidden")!=null;
      Array.prototype.forEach.call(extras,function(el){el.classList.toggle("is-hidden",!collapsed);});
      if(t)t.textContent=collapsed?"Show less":"Show more";
      if(ic)ic.innerHTML=collapsed?UP:DOWN;
      if(window.__awTrack)window.__awTrack(collapsed?"movement_show_more":"movement_show_less",{section:btn.getAttribute("data-section")});
    });
  });
})();</script>`;
}

function monitorScript(slug, bgImages) {
  const cfg = JSON.stringify({ slug, ingest: SENTRY_INGEST, bg: bgImages.filter((b) => b && b.url) });
  return `<script>(function(){
  var D=${cfg};
  function eid(){var a=new Uint8Array(16);if(self.crypto&&crypto.getRandomValues){crypto.getRandomValues(a)}return Array.prototype.map.call(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}
  function report(kind,url){try{
    var id=eid();
    var env=JSON.stringify({event_id:id,sent_at:new Date().toISOString()})+"\\n"+JSON.stringify({type:"event"})+"\\n"+JSON.stringify({event_id:id,level:"error",platform:"javascript",logger:"movement-web",message:"Movement page image failed to load ("+kind+")",tags:{surface:"movement-web",slug:D.slug,image:kind},request:{url:location.href},extra:{image_url:url||null}});
    if(navigator.sendBeacon){navigator.sendBeacon(D.ingest,new Blob([env],{type:"application/x-sentry-envelope"}))}else{fetch(D.ingest,{method:"POST",body:env,keepalive:true,mode:"no-cors"})}
  }catch(e){}}
  Array.prototype.forEach.call(document.images||[],function(img){img.addEventListener("error",function(){report("img:"+(img.getAttribute("alt")||"")||img.src,img.currentSrc||img.src)})});
  D.bg.forEach(function(o){var im=new Image();im.onerror=function(){report(o.kind,o.url)};im.src=o.url})
})();</script>`;
}

// ─── styles ─────────────────────────────────────────────────────────
const STYLES = `
:root{
  --bg:#FAF8F5;--surface:#FFFFFF;--band-light:#F5F3F0;--card:#F8F7F5;
  --border:#E8E4DF;--line:#F0F0F0;--gold:#D4882C;--cta:#EF9F27;
  --t-primary:#1A1A1A;--t-body:#3D3D3D;--t-secondary:#6B6B6B;--t-label:#999999;--t-sub:#8A8175;
  --serif:'Lora',Georgia,serif;--sans:'DM Sans',system-ui,-apple-system,sans-serif;
  --pad:80px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--t-body);font-family:var(--sans);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}
a{color:inherit;text-decoration:none}
h1,h2{margin:0}
.eyebrow{font-weight:600;font-size:11px;letter-spacing:2px;display:block}
.eyebrow--muted{color:var(--t-label)} .eyebrow--gold{color:var(--gold)}

/* Nav */
.nav{display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 var(--pad);background:var(--surface);border-bottom:1px solid var(--border)}
.nav__brand{display:flex;align-items:center;gap:10px;color:var(--t-secondary);font-size:14px}
.nav__logo{border-radius:50%;display:block}
.nav__brand span{color:var(--t-primary);font-weight:600;font-size:15px}
.nav__open{display:inline-flex;align-items:center;gap:6px;color:var(--gold);font-size:14px;font-weight:500}
.nav__right{display:flex;align-items:center;gap:22px}
.nav__link{color:var(--t-secondary);font-size:14px;font-weight:500}.nav__link:hover{color:var(--gold)}
.nav__open-sm{display:none}

/* Hero gallery */
.hero{position:relative;height:min(560px,64vh);overflow:hidden;background:#141428}
.hero__track{display:flex;height:100%;transition:transform .6s cubic-bezier(.4,0,.2,1)}
.hero__slide{flex:0 0 100%;height:100%;background:#141428 center/cover no-repeat}
.hero__scrim{position:absolute;inset:0;pointer-events:none;background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,.28) 44%,rgba(0,0,0,.7) 72%,rgba(0,0,0,.94) 100%)}
.hero__dots{position:absolute;left:0;right:0;bottom:18px;display:flex;justify-content:center;gap:8px;z-index:2}
.hero__dot{width:8px;height:8px;padding:0;border:0;border-radius:5px;background:rgba(255,255,255,.5);cursor:pointer;transition:width .25s,background .25s}
.hero__dot:hover{background:rgba(255,255,255,.85)}
.hero__dot.is-active{width:22px;background:#fff}
.hero__expand{position:absolute;right:16px;top:16px;z-index:3;display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border:0;border-radius:22px;background:rgba(0,0,0,.42);color:#fff;font-family:var(--sans);font-size:13px;font-weight:500;cursor:pointer;transition:background .2s;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.hero__expand:hover{background:rgba(0,0,0,.66)}
.hero__title{position:absolute;left:0;bottom:0;padding:0 var(--pad) 40px;max-width:1100px}
.hero__eyebrow{color:rgba(255,255,255,.8);font-size:11px;letter-spacing:2.5px;font-weight:600}
.hero__title h1{font-family:var(--serif);font-weight:700;font-size:58px;line-height:1.05;color:#fff;margin-top:10px;text-shadow:0 2px 24px rgba(0,0,0,.85)}
.hero__title p{margin:12px 0 0;color:rgba(255,255,255,.9);font-size:19px;letter-spacing:.4px;text-shadow:0 1px 16px rgba(0,0,0,.7)}

/* Sections */
.sec{padding:48px var(--pad);background:var(--bg)}
.sec .eyebrow{margin-bottom:18px}
.sec h2{font-family:var(--serif);font-weight:600;font-size:28px;color:var(--t-primary);margin-bottom:24px}
.overview__body{max-width:820px;display:flex;flex-direction:column;gap:16px}
.overview__body p{margin:0;font-size:17px;line-height:1.75;color:var(--t-body)}

/* Did You Know */
.fgrid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
.fcard{display:flex;gap:12px;align-items:flex-start;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
.fcard__mark{flex:none;width:24px;height:24px;border-radius:12px;background:var(--gold);color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
.fcard p{margin:0;font-size:15px;line-height:1.55;color:var(--t-body)}

/* Key characteristics */
.cgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;align-items:stretch}
.ccard{display:flex;flex-direction:column;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px}
.ccard strong{font-family:var(--serif);font-size:17px;color:var(--t-primary)}
.ccard p{margin:0;font-size:14.5px;line-height:1.55;color:var(--t-body)}
.ccard__eg{margin-top:auto;font-size:12.5px;color:var(--gold);font-weight:500}

/* Key artists */
.arow{display:flex;flex-wrap:wrap;gap:20px}
.acard{flex:1 1 160px;max-width:200px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;position:relative;padding:8px}
.acard__av{width:88px;height:88px;border-radius:50%;background:#E8E4DF center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--t-secondary);font-weight:600;font-size:26px}
.acard strong{font-size:15px;color:var(--t-primary)}
.acard__line{font-size:12.5px;color:var(--t-secondary)}
.acard__link{color:#B0A99E;transition:color .2s} .acard:hover .acard__link{color:var(--gold)}

/* Notable works */
.wgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.wcard{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:box-shadow .2s}
.wcard:hover{box-shadow:0 6px 20px rgba(26,20,13,.08)}
.wcard__img{height:180px;background:#E8E4DF center/cover no-repeat}
.wcard__t{padding:14px 16px 2px;font-family:var(--serif);font-weight:600;font-size:16px;color:var(--t-primary)}
.wcard__m{padding:0 16px 16px;font-size:13px;color:var(--t-secondary)}

/* Timeline */
.tline{display:flex;align-items:flex-start;gap:0;position:relative;width:100%}
.tpoint{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;position:relative}
.tpoint:not(:last-child)::after{content:"";position:absolute;top:6px;left:50%;width:100%;height:2px;background:var(--border)}
.tpoint__dot{width:14px;height:14px;border-radius:7px;background:var(--gold);position:relative;z-index:1}
.tpoint__year{font-family:var(--serif);font-weight:700;font-size:20px;color:var(--t-primary);margin-top:4px}
.tpoint__lbl{font-size:12px;letter-spacing:.5px;text-transform:uppercase;color:var(--t-label)}
.tflows{display:flex;flex-wrap:wrap;gap:16px;margin-top:34px}
.tflow{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 18px;flex:1;min-width:260px}
.tflow__ic{flex:none;width:34px;height:34px;border-radius:17px;background:var(--band-light);color:var(--gold);display:flex;align-items:center;justify-content:center}
.tflow__txt{display:flex;flex-direction:column;gap:2px;min-width:0}
.tflow__lbl{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:var(--t-label)}
.tflow__v{font-family:var(--serif);font-size:16px;color:var(--t-primary)}
.tflow--fwd{flex-direction:row-reverse;text-align:right} .tflow--fwd .tflow__txt{align-items:flex-end}

/* How to spot it */
.spots{display:flex;flex-direction:column;gap:10px;max-width:820px}
.spot{display:flex;gap:12px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.spot__num{flex:none;width:24px;height:24px;border-radius:12px;background:var(--gold);color:#fff;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
.spot p{margin:0;font-size:15px;line-height:1.5;color:var(--t-body)}

/* Related + prev/next movement cards */
.mvgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.mvc{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:8px 14px 8px 8px;transition:box-shadow .2s}
.mvc:hover{box-shadow:0 4px 14px rgba(26,20,13,.07)}
.mvc__thumb{flex:none;width:54px;height:54px;border-radius:8px;background:#E8E4DF center/cover no-repeat}
.mvc__thumb--ph{background:linear-gradient(135deg,#EDE7DF,#DED5C8)}
.mvc__txt{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}
.mvc__lbl{font-size:11px;letter-spacing:.5px;color:var(--t-sub)}
.mvc__txt strong{font-family:var(--serif);font-size:16px;color:var(--t-primary)}
.mvc__yr{font-size:12px;color:var(--t-sub)}
.mvc__chev{color:var(--gold);flex:none}
.pn{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pn .mvc--prev{justify-content:flex-start}
.pn .mvc--next{justify-content:flex-end;text-align:right} .pn .mvc--next .mvc__txt{align-items:flex-end}

/* Show more */
.showmore{display:inline-flex;align-items:center;gap:5px;margin:20px auto 0;padding:9px 18px;background:none;border:1px solid var(--border);border-radius:20px;color:var(--gold);font-family:var(--sans);font-size:13px;font-weight:500;cursor:pointer;transition:background .2s}
.showmore:hover{background:var(--band-light)}
.showmore__i{display:inline-flex;align-items:center}
.sec .showmore{display:flex;width:fit-content;margin-left:auto;margin-right:auto}
.is-hidden{display:none!important}

/* CTA band */
.band{padding:0 var(--pad)}
.cta{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;background:var(--band-light);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:18px var(--pad)}
.cta__left{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:500;color:var(--t-body)}
.cta__mark{width:26px;height:26px;border-radius:50%;flex:none;display:block}
.badges{display:flex;align-items:center;gap:12px}
.badge{display:inline-flex;transition:opacity .15s ease} .badge:hover{opacity:.85}
.badge img{height:44px;width:auto;display:block}

/* Report + footer */
.report{display:flex;justify-content:flex-end;padding:8px var(--pad) 40px;background:var(--bg)}
.report a{display:inline-flex;align-items:center;gap:8px;color:var(--t-label);font-size:13px}
.foot{display:flex;align-items:center;padding:20px var(--pad);background:var(--band-light);border-top:1px solid var(--border);color:var(--t-label);font-size:13px}

/* Lightbox — full, uncropped artwork */
.lightbox{position:fixed;inset:0;z-index:100;background:rgba(12,10,8,.93);display:flex;align-items:center;justify-content:center;padding:40px}
.lightbox[hidden]{display:none}
.lb__close{position:absolute;top:18px;right:20px;width:42px;height:42px;border:0;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s}
.lb__close:hover{background:rgba(255,255,255,.24)}
.lb__fig{margin:0;display:flex;flex-direction:column;align-items:center;gap:16px;max-width:94vw}
.lb__img{max-width:94vw;max-height:78vh;width:auto;height:auto;object-fit:contain;border-radius:4px;box-shadow:0 16px 60px rgba(0,0,0,.55);background:#1a1a1a}
.lb__cap{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;color:#fff}
.lb__t{font-family:var(--serif);font-size:18px;font-weight:600}
.lb__b{font-size:13px;color:rgba(255,255,255,.68)}
.lb__link{display:inline-flex;align-items:center;gap:4px;margin-top:4px;color:var(--cta);font-size:13px;font-weight:500}

/* Sticky bar (mobile) */
.stickybar{display:none}

/* Empty */
.empty{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding:40px;max-width:520px;margin:0 auto}
.empty__logo{margin-bottom:8px;border-radius:50%}
.empty h1{font-family:var(--serif);font-weight:600;font-size:26px;color:var(--t-primary)}
.empty p{margin:0;color:var(--t-secondary);font-size:16px;line-height:1.5;max-width:420px}
.empty__cta{display:inline-flex;align-items:center;gap:8px;margin-top:8px;background:var(--cta);color:#fff;font-weight:600;font-size:16px;padding:14px 28px;border-radius:8px}
.empty__home{color:var(--t-label);font-size:14px}

/* Responsive */
@media (max-width:768px){
  :root{--pad:20px}
  .nav__open-lg{display:none} .nav__open-sm{display:inline}
  .hero{height:min(400px,52vh)}
  .hero__title{padding:0 20px 26px} .hero__title h1{font-size:32px} .hero__title p{font-size:16px}
  .hero__dots{bottom:14px}
  .sec{padding:32px 20px}
  .overview__body p{font-size:16px}
  .fgrid,.cgrid,.wgrid,.mvgrid{grid-template-columns:1fr}
  .arow{gap:14px}.acard{flex-basis:calc(50% - 7px);max-width:none}
  .cta{padding:20px} .badges{width:100%;justify-content:center;flex-wrap:wrap} .badge img{height:48px}
  .pn{grid-template-columns:1fr}
  .report{justify-content:flex-start;padding:8px 20px 28px}
  .foot{padding:20px}
  body{padding-bottom:56px}
  .stickybar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:20;align-items:center;justify-content:space-between;height:56px;padding:0 16px;background:var(--surface);border-top:1px solid var(--border);box-shadow:0 -2px 12px rgba(0,0,0,.08);color:var(--t-primary)}
  .stickybar__left{display:flex;align-items:center;gap:10px;font-size:14px} .stickybar__left strong{font-weight:600}
  .stickybar__logo{border-radius:50%} .stickybar .arr{color:var(--gold)}
}
`;
