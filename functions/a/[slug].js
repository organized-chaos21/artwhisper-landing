// Cloudflare Pages Function: GET /a/{slug}
//
// Phase 3 of the "Share scanned artwork" feature (Linear T1-712, parent T1-328).
// The public, server-rendered web preview for a shared artwork. A link like
// artwhisper.app/a/the-bedroom-vincent-van-gogh must:
//   1. Unfurl with a rich link preview (Open Graph / Twitter) in WhatsApp,
//      iMessage, etc. — crawlers don't run JS, so the meta tags are rendered
//      here on the edge, not client-side.
//   2. Render a fast, on-brand immersive page (design: Pencil "Share Web" lane).
//   3. Convert viewers with a clear "Get the app" CTA.
//   4. 404 gracefully on an unknown slug.
//
// This is a Pages Function (not an Astro SSR page) so the rest of the site stays
// a static build and the existing functions/ dir keeps working — an Astro
// Cloudflare adapter would emit a _worker.js that disables functions/.

const API_BASE = "https://api.artwhisper.app";
const PLAY_URL =
  "https://play.google.com/store/apps/details?id=app.artwhisper&utm_source=share&utm_medium=web_preview&utm_campaign=share_page";
const APP_STORE_URL =
  "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=share-web_preview";
const FETCH_TIMEOUT_MS = 5000;

// PostHog (public client key — safe to embed; same project as the app and the
// movement/artist web pages). Added so pin/link traffic to /a/{slug} is measured.
const POSTHOG_KEY = "phc_d9QDyua38ePkoqG4KtR2Wa9XUasTPuvfVMJBJInE7eS";
const POSTHOG_HOST = "https://us.i.posthog.com";

// Build the store-install links, carrying BOTH the deferred deep-link destination
// and inbound campaign attribution through to the app.
// - Android: Google Play reads the `referrer` param via the Install Referrer API.
//   We always encode the destination (`dl_type` + `dl_slug`, T1-877) so the app can
//   open this same page after install, and — when present — the campaign UTM tags
//   (utm_source + the pin's slug as utm_content, T1-830) for per-pin attribution.
//   The two coexist in one referrer string.
// - iOS: Apple only exposes a campaign-level token (`ct`), never a per-page deferred
//   link, so we set ct to the source (e.g. "pinterest"); iOS deferred = T1-878.
// `dest` is the deep-link destination { type, slug }; omit it to build a plain link.
function buildStoreLinks(src, content, dest, medium) {
  const source = src && /^[a-z0-9_-]{1,40}$/i.test(src) ? src.toLowerCase() : null;
  const slug = content && /^[a-z0-9-]{1,140}$/i.test(content) ? content : null;
  const destSlug =
    dest && dest.slug && /^[a-z0-9-]{1,140}$/i.test(dest.slug) ? dest.slug : null;

  const ref = new URLSearchParams();
  // Deferred deep-link destination — carried on every install link, independent of
  // any campaign attribution, so an organic web→install still opens the same page.
  if (dest && dest.type && destSlug) {
    ref.set("dl_type", dest.type);
    ref.set("dl_slug", destSlug);
  }
  // Campaign attribution — added only for a real inbound source.
  if (source) {
    ref.set("utm_source", source);
    // Preserve the inbound medium (e.g. comment-dm from a comment-to-DM link, T1-886)
    // so installs are attributed to the real channel, not a generic "web".
    ref.set("utm_medium", medium && /^[a-z0-9_-]{1,40}$/i.test(medium) ? medium.toLowerCase() : "web");
    ref.set("utm_campaign", source);
    if (slug) ref.set("utm_content", slug);
  }

  const referrer = ref.toString();
  return {
    play: referrer
      ? "https://play.google.com/store/apps/details?id=app.artwhisper&referrer=" + encodeURIComponent(referrer)
      : "https://play.google.com/store/apps/details?id=app.artwhisper&utm_source=share&utm_medium=web_preview&utm_campaign=share_page",
    appstore: source
      ? "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=" + encodeURIComponent(source.slice(0, 40))
      : "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=share-web_preview",
  };
}

// Slugs are lowercase words joined by hyphens (see backend slug.ts). Reject
// anything else up front so we never proxy junk into the API.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ─── HTML escaping ──────────────────────────────────────────────────
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Collapse whitespace and hard-cap length for meta descriptions. */
const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

/**
 * Make a URL safe to drop into a CSS `url('...')` inside an HTML style attribute.
 * esc() is HTML-context, not CSS-context: it turns ' into &#39;, which the browser
 * decodes back to a literal ' inside the CSS, letting a crafted URL break out of
 * url('...') and inject a CSS declaration. Image URLs can come from upstream
 * external sources via the API's proxy pass-through, so treat them as untrusted:
 * accept only http(s) and percent-encode every char that could break out of
 * either the CSS string or the surrounding attribute. Returns null if unusable.
 */
function cssUrl(u) {
  if (!u) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" && p.protocol !== "http:") return null;
  } catch {
    return null;
  }
  // Percent-encode by byte value. NB: encodeURIComponent leaves ' ( ) unencoded
  // (they're "unreserved"), so it would NOT close this hole — encode explicitly.
  return u.replace(
    /[\s"'()<>\\]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
}

// ─── Route handler ──────────────────────────────────────────────────
export async function onRequestGet(context) {
  const slug = String(context.params.slug || "");

  if (!SLUG_RE.test(slug)) {
    return html(renderNotFound(), 404, 60);
  }

  // The "Further Works" / "More from [movement]" rows + chip thumbnails (T1-879)
  // load in parallel and are optional: a slow or failed call just hides them.
  const relatedP = fetchRelated(slug);

  let data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(
      `${API_BASE}/v1/artworks/${encodeURIComponent(slug)}`,
      { signal: controller.signal, headers: { accept: "application/json" } },
    );
    clearTimeout(timer);

    if (res.status === 404) return html(renderNotFound(), 404, 60);
    if (!res.ok) return html(renderNotFound(), 502, 0);
    data = await res.json();
  } catch {
    // Network error / timeout — don't cache, let a retry succeed.
    return html(renderNotFound(), 502, 0);
  }

  if (!data || !data.artwork) return html(renderNotFound(), 404, 60);

  // Canonicalize to the pretty slug URL (T1-832): a UUID request 301-redirects
  // to /a/{slug}, so the UUID and slug versions don't compete as duplicates in
  // search. Mirrors the artist handler.
  const canonical = data.artwork.slug;
  if (canonical && canonical !== slug) {
    return new Response(null, {
      status: 301,
      headers: {
        location: `https://artwhisper.app/a/${encodeURIComponent(canonical)}`,
        "cache-control": "public, max-age=300, s-maxage=86400",
      },
    });
  }

  // Success — cache at the edge for an hour; the underlying artwork is stable.
  const related = await relatedP;
  // Without the related rows, cache briefly so the full page returns soon.
  return html(renderPage(data, canonical || slug, context.request.url, related), 200, related ? 3600 : 300);
}

const RELATED_TIMEOUT_MS = 2500;

/** GET /v1/artworks/{slug}/web-related — null on any failure (sections hide). */
async function fetchRelated(slug) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RELATED_TIMEOUT_MS);
    const res = await fetch(`${API_BASE}/v1/artworks/${encodeURIComponent(slug)}/web-related`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Wrap an HTML string in a Response with sane caching + security headers. */
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

// ─── Page rendering ─────────────────────────────────────────────────
// Design: Pencil "Artwork Page — Full-Screen Stage (Option 1)" (portrait + landscape,
// Browser 1920) and "Artwork Page v1.1 — Mobile Web 390" (T1-879). The hero is a
// full-screen stage: the whole, uncropped painting is bound on both axes and centred
// on a blurred copy of itself, so no shape is ever cropped (the old fixed band +
// `cover` lost ~half of most paintings).
function renderPage(data, slug, reqUrl, related) {
  const art = data.artwork;
  const artist = data.artist || null;

  // Carry inbound attribution (e.g. a Pinterest pin's utm_source + utm_content)
  // through to the store-install links.
  let inParams;
  try {
    inParams = new URL(reqUrl).searchParams;
  } catch {
    inParams = new URLSearchParams();
  }
  const { play: PLAY_LINK, appstore: APP_STORE_LINK } = buildStoreLinks(
    inParams.get("utm_source"),
    inParams.get("utm_content"),
    { type: "artwork", slug },
    inParams.get("utm_medium"),
  );

  const title = art.title || "Untitled";
  const artistName = artist?.name || null;
  // Public artist page slug, when the artist has one — lets the hero byline and
  // the artist card link into the /artist/{slug} SEO hub (internal linking).
  const artistSlug =
    artist && typeof artist.slug === "string" && SLUG_RE.test(artist.slug) ? artist.slug : null;
  const year = art.year || null;

  // Hero image: prefer a self-hosted/proxied full image; fall back to the
  // artwork's source image_url. All URLs from the API are absolute.
  const heroImg =
    art.images?.[0]?.full_url ||
    art.images?.[0]?.medium_url ||
    art.image_url ||
    null;
  // A lighter copy for the blurred field and the What-to-Notice image.
  const midImg = art.images?.[0]?.medium_url || heroImg;

  // A hero-less page is a thin, image-free page: it hurts SEO and looks broken
  // when opened directly (usually a raw-UUID hit from a crawler or a stale link,
  // since the sitemap already gates these out). Keep it out of the search index
  // until the image sweep fills a hero, at which point it re-enters naturally.
  const noindex = !heroImg;

  // OG image is the 1200×630 share card, keyed by artwork id. `v=2` = the
  // uncropped "stage" card (T1-879) — a new URL so link-preview caches refetch.
  const shareCard = `${API_BASE}/v1/artworks/${art.id}/share-card.png?v=2`;
  const pageUrl = `https://artwhisper.app/a/${esc(slug)}`;

  // Curiosity hook for the link preview: the quick_context one-liner, else the
  // first "what to notice" detail.
  const hookRaw =
    art.quick_context ||
    (Array.isArray(art.what_to_notice) ? art.what_to_notice[0] : "") ||
    "Every painting has a story. Art Whisper tells it.";
  const ogTitle = artistName ? `${title} — ${artistName}` : title;
  const ogDesc = clip(hookRaw, 180);

  // ── Sections ──
  const structuredData = renderStructuredData(art, artist, pageUrl, heroImg);
  // Header breadcrumb (T1-845): Home › Artist › Artwork. Home → the landing site;
  // Artist → /artist/{slug} when it has one; the artwork title is the current page.
  const breadcrumb = renderBreadcrumb(title, artistName, artistSlug, pageUrl);
  const stage = renderStage({ title, artistName, artistSlug, year, heroImg, midImg, breadcrumb, playUrl: PLAY_LINK });
  const pullQuote = art.quick_context
    ? `<section class="lede" id="lede">
         <span class="lede__rule"></span>
         <p class="lede__text">“${esc(art.quick_context)}”</p>
         <span class="lede__rule"></span>
       </section>`
    : `<span id="lede"></span>`;

  const about = renderAboutDetails(art, artistName, artistSlug);
  const movements = renderMovements(art.movement_tags, related?.movement_thumbs || {});
  const notice = renderNotice(art.what_to_notice, art.what_to_notice_meta, midImg, heroImg, title, PLAY_LINK);
  const audio = art.narration_available === false ? "" : renderAudio(title, PLAY_LINK);
  const artistSection = renderArtist(artist, PLAY_LINK);
  const further = renderWorksRail({
    key: "further",
    eyebrow: "MORE FROM THIS ARTIST",
    heading: artistName ? `Further Works by ${surname(artistName)}` : "Further Works",
    works: related?.further_works,
    withArtist: false,
  });
  const fromMovement = related?.movement
    ? renderWorksRail({
        key: "movement",
        eyebrow: "EXPLORE THE MOVEMENT",
        heading: `More from ${related.movement.name}`,
        works: related.movement.works,
        withArtist: true,
        moreHref: SLUG_RE.test(related.movement.slug || "") ? `/movement/${related.movement.slug}` : null,
      })
    : "";
  const explore = renderExplore(related?.explore, {
    title,
    artistName,
    movementName: related?.movement?.name || null,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${esc(ogTitle)} · Art Whisper</title>
  <meta name="description" content="${esc(ogDesc)}" />
  ${noindex ? '<meta name="robots" content="noindex, follow" />' : ""}
  <link rel="canonical" href="${pageUrl}" />
  ${structuredData}
  ${breadcrumb.jsonLd}

  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Art Whisper" />
  <meta property="og:title" content="${esc(ogTitle)}" />
  <meta property="og:description" content="${esc(ogDesc)}" />
  <meta property="og:image" content="${esc(shareCard)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:url" content="${pageUrl}" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(ogTitle)}" />
  <meta name="twitter:description" content="${esc(ogDesc)}" />
  <meta name="twitter:image" content="${esc(shareCard)}" />

  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="alternate icon" href="/favicon.ico" type="image/png" />
  <link rel="apple-touch-icon" href="/favicon.ico" />
  ${heroImg ? `<link rel="preload" as="image" href="${esc(heroImg)}" />` : ""}
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&display=swap" rel="stylesheet" />
  <style>${STYLES}</style>
</head>
<body>
  ${stage}
  <main class="page">
  ${pullQuote}
  ${about}
  ${movements}
  ${notice}
  ${audio}
  ${artistSection}
  ${further}
  ${fromMovement}
  ${explore}
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
    <span class="stickybar__txt"><strong>Hear ${esc(clip(title, 34))}’s story</strong><span>Free in the Art Whisper app</span></span>
    <span class="stickybar__btn">Open</span>
  </a>
  ${storeScript(APP_STORE_LINK)}
  ${viewerScript(slug)}
  ${noticeScript(slug)}
  ${railScript(slug)}
  ${exploreScript()}
  ${analyticsScript(slug, title)}
  ${monitorScript(slug, [
    { kind: "hero", url: heroImg },
    { kind: "artist-portrait", url: artist?.image_url || null },
  ])}
</body>
</html>`;
}

// The artist's family name for headings ("Further Works by Rossetti"), keeping
// name particles attached ("van Gogh", "da Vinci"). Single names stay whole.
const PARTICLES = new Set(["van", "von", "de", "da", "di", "del", "della", "der", "den", "du", "la", "le", "ter", "ten"]);
function surname(name) {
  const w = String(name).trim().split(/\s+/);
  if (w.length < 2) return w[0] || "";
  for (let i = 1; i < w.length - 1; i++) {
    if (PARTICLES.has(w[i].toLowerCase())) return w.slice(i).join(" ");
  }
  return w[w.length - 1];
}

function renderStage({ title, artistName, artistSlug, year, heroImg, midImg, breadcrumb, playUrl }) {
  const field = cssUrl(midImg);
  const byline = artistName
    ? `${artistSlug ? `<a href="/artist/${artistSlug}">${esc(artistName)}</a>` : esc(artistName)}${year ? ` · ${esc(String(year))}` : ""}`
    : year
      ? esc(String(year))
      : "";
  const controls = heroImg
    ? `<div class="viewer" role="toolbar" aria-label="Artwork viewer">
        <button class="viewer__btn viewer__out" type="button" aria-label="Zoom out" disabled>${ICON_MINUS}</button>
        <span class="viewer__pct" aria-live="polite">100%</span>
        <button class="viewer__btn viewer__in" type="button" aria-label="Zoom in">${ICON_PLUS}</button>
        <button class="viewer__btn viewer__zoom" type="button" aria-label="Zoom">${ICON_ZOOM}</button>
        <span class="viewer__div" aria-hidden="true"></span>
        <button class="viewer__btn viewer__full" type="button" aria-label="Full screen">${ICON_EXPAND}<span class="viewer__lbl">Full screen</span></button>
      </div>`
    : "";
  return `<section class="stage"${heroImg ? "" : ` data-empty="1"`}>
    ${field ? `<div class="stage__field" style="background-image:url('${field}')" aria-hidden="true"></div>` : ""}
    <div class="stage__vignette" aria-hidden="true"></div>
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
    <div class="stage__frame">
      ${heroImg ? `<div class="stage__pan"><img class="stage__img" src="${esc(heroImg)}" alt="${esc(title)}${artistName ? ` by ${esc(artistName)}` : ""}" fetchpriority="high" decoding="async" draggable="false" /></div>` : ""}
    </div>
    <div class="stage__fade" aria-hidden="true"></div>
    <div class="stage__bar">
      <div class="stage__cap">
        <h1>${esc(title)}</h1>
        ${byline ? `<p>${byline}</p>` : ""}
      </div>
      ${controls}
    </div>
    <a class="stage__scroll" href="#lede"><span>Scroll</span>${ICON_CHEV_DOWN}</a>
    <button class="stage__close" type="button" aria-label="Exit full screen">${ICON_CLOSE}</button>
  </section>`;
}

// Append our attribution tag to a museum object-page URL. The museum's own analytics
// then show artwhisper.app as the referring source (T1-730, Ziv's call). museum_url is
// a bare canonical URL from our API, so a simple ?/& join is safe.
function withUtm(url) {
  const u = String(url);
  return u + (u.includes("?") ? "&" : "?") + "utm_source=artwhisper.app";
}

// Small diagonal "opens in a new tab" glyph for the outbound museum link.
const EXT_ARROW = `<svg class="ext" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>`;

// Header breadcrumb + BreadcrumbList JSON-LD (T1-845). Trail: Home › Artist › Artwork
// — Home links to the landing site, Artist to /artist/{slug} (when it has one), and
// the artwork title is the current page (not a link). Movement stays as the metadata
// chip; artist + movement are parallel, so only the artist is the breadcrumb parent.
function renderBreadcrumb(title, artistName, artistSlug, pageUrl) {
  const SITE = "https://artwhisper.app";
  const items = [{ name: "Home", url: SITE }];
  if (artistName && artistSlug) items.push({ name: artistName, url: `${SITE}/artist/${artistSlug}` });
  items.push({ name: title, url: null });

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
      if (it.url) el.item = it.url; // the current page (last) omits item per Google guidance
      return el;
    }),
  };
  const jsonLd = `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
  return { nav, jsonLd };
}

// schema.org/VisualArtwork structured data (T1-730, the original SEO ask). Emitted only
// with the fields we actually have, so search engines get a real machine-readable record
// of the work, its creator, the holding museum and provenance. JSON-LD is escaped so a
// stray "</script>" or "<" in museum text can't break out of the script element.
function renderStructuredData(art, artist, pageUrl, heroImg) {
  const data = {
    "@context": "https://schema.org",
    "@type": "VisualArtwork",
    name: art.title || "Untitled",
    url: pageUrl,
  };
  if (heroImg) data.image = heroImg;
  if (artist?.name) data.creator = { "@type": "Person", name: artist.name };
  if (art.year) data.dateCreated = String(art.year);
  if (art.medium) data.artMedium = art.medium;
  if (art.credit_line) data.creditText = art.credit_line;
  if (art.culture) data.locationCreated = { "@type": "Place", name: art.culture };
  if (art.museum_name) {
    data.isPartOf = { "@type": "Museum", name: art.museum_name };
    if (art.museum_url) data.isPartOf.url = art.museum_url;
  }
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}

/** Escape, then render the *title* emphasis our generated text sometimes carries. */
const inlineEm = (s) => esc(s).replace(/\*([^*\n]{1,120})\*/g, "<em>$1</em>");

/** Eyebrow label with a hairline rule running to the right edge. */
const eyebrow = (label) => `<div class="eyebrow"><span>${label}</span><i aria-hidden="true"></i></div>`;

// About (left) + Details (right). Details carries the "object label" facts that used
// to sit in the meta bar, each shown only when present — coverage varies a lot by
// source, so a blank label is never rendered (T1-730). The museum name doubles as the
// outbound "view on museum website" link when we can build one.
function renderAboutDetails(art, artistName, artistSlug) {
  const rows = [];
  const row = (l, vHtml) => rows.push(`<dt>${l}</dt><dd>${vHtml}</dd>`);
  if (artistName) {
    row("Artist", artistSlug ? `<a class="dl__link" href="/artist/${artistSlug}">${esc(artistName)}</a>` : esc(artistName));
  }
  if (art.year) row("Date", esc(String(art.year)));
  if (art.medium) row("Medium", esc(art.medium));
  if (art.museum_name) {
    const label = esc(art.museum_name);
    row(
      "Location",
      art.museum_url
        ? `<a class="dl__link" href="${esc(withUtm(art.museum_url))}" target="_blank" rel="noopener noreferrer"
            onclick="window.__awTrack&&window.__awTrack('museum_link_clicked')">${label}${EXT_ARROW}</a>`
        : label,
    );
  }
  if (art.dimensions) row("Dimensions", esc(art.dimensions));
  if (art.department) row("Collection", esc(art.department));
  if (art.culture) row("Culture", esc(art.culture));
  if (art.credit_line) row("Credit line", esc(art.credit_line));

  const paras = art.about
    ? String(art.about)
        .split(/\n{2,}|\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  if (!paras.length && !rows.length) return "";
  const aboutCol = paras.length
    ? `<div class="about__text">${eyebrow("ABOUT THIS WORK")}${paras.map((p) => `<p>${inlineEm(p)}</p>`).join("")}</div>`
    : "";
  const detailsCol = rows.length
    ? `<div class="about__details">${eyebrow("DETAILS")}<dl class="dl">${rows.join("")}</dl></div>`
    : "";
  return `<section class="sec about${aboutCol && detailsCol ? "" : " about--single"}">${aboutCol}${detailsCol}</section>`;
}

function renderMovements(tags, thumbs) {
  if (!Array.isArray(tags) || !tags.length) return "";
  const chips = tags
    .filter((t) => t?.name)
    .map((t) => {
      // Link the chip to the public movement page when we have a valid slug
      // (interlinks share pages into the /movement/{slug} SEO hub). Fall back to
      // a plain chip if a tag somehow lacks a well-formed slug.
      const slug = typeof t.slug === "string" && SLUG_RE.test(t.slug) ? t.slug : null;
      const th = slug ? cssUrl(thumbs[slug]) : null;
      const img = th
        ? `<span class="chip__img" style="background-image:url('${th}')"></span>`
        : `<span class="chip__img chip__img--ph" aria-hidden="true">${esc(t.name.charAt(0))}</span>`;
      return slug
        ? `<a class="chip" href="/movement/${slug}">${img}<span>${esc(t.name)}</span><span class="chip__chev" aria-hidden="true">›</span></a>`
        : `<span class="chip">${img}<span>${esc(t.name)}</span></span>`;
    })
    .join("");
  if (!chips) return "";
  return `<section class="sec movements">
    ${eyebrow("ART MOVEMENTS")}
    <div class="chips">${chips}</div>
  </section>`;
}

// One "Get the app" link per CTA, routed by device (T1-906). The page is edge-cached
// for everyone, so the server can't pick a store per visitor: the HTML carries the
// Google Play link (with the deferred deep-link referrer) and this swaps every
// [data-store-cta] to the App Store on Apple devices: iPhone/iPod, iPad (incl. iPadOS,
// which reports a Mac UA) and Mac desktops. Same rule as the landing site's appLinks.js.
function storeScript(appStoreUrl) {
  return `<script>(function(){
  var ua=navigator.userAgent||"",pf=navigator.platform||"";
  if(!(/iPad|iPhone|iPod/.test(ua)||/Mac/.test(pf)||/Mac OS X/.test(ua)))return;
  var u=${JSON.stringify(appStoreUrl)};
  document.querySelectorAll("[data-store-cta]").forEach(function(a){a.href=u});
})();</script>`;
}

// What to Notice: the painting beside the details. Layout follows the painting's real
// shape (set on <body> by the viewer script once the image loads): portrait/square =
// image left + card grid; landscape = wide image + stacked cards on the right.
//
// T1-857 "show me where": when the API sends `what_to_notice_meta` (title + 0..1
// region per point, written while the AI looked at the image), every point is shown
// (no "+N"), each located point gets a marker on the painting, and picking one dims
// the rest of the painting, outlines the detail and points at it with a caption.
// Without regions the section renders exactly as before (legacy text-only points).
const NOTICE_SHOWN = 4;
function renderNotice(items, meta, img, zoomImg, title, playUrl) {
  if (!Array.isArray(items) || !items.length) return "";
  const regions = noticeRegions(items, meta);
  if (regions) return renderNoticeRegions(items, regions, img, zoomImg, title);
  const shown = items.slice(0, NOTICE_SHOWN);
  const remaining = items.length - shown.length;
  const cards = shown
    .map(
      (t, i) =>
        `<div class="ncard"><span class="ncard__num">${String(i + 1).padStart(2, "0")}</span><p>${esc(t)}</p></div>`,
    )
    .join("");
  const more =
    remaining > 0
      ? `<a class="ncard ncard--more" data-store-cta href="${playUrl}" target="_blank" rel="noopener">
          <span class="ncard__num">+${remaining}</span>
          <p>${remaining} more detail${remaining === 1 ? " is" : "s are"} waiting.</p>
          <span class="ncard__cta">See all ${items.length} in Art Whisper →</span>
        </a>`
      : "";
  const intro = items.length === 1 ? "One detail hides in plain sight. Here’s where to look." : `${countWord(items.length)} details hide in plain sight. Here’s where to look.`;
  return `<section class="sec notice">
    <div class="notice__head">
      ${eyebrow("LOOK CLOSER")}
      <h2>What to Notice</h2>
      <p class="notice__intro">${intro}</p>
    </div>
    <div class="notice__row">
      ${img ? `<div class="notice__img"><img src="${esc(img)}" alt="${esc(title)}" loading="lazy" decoding="async" /></div>` : ""}
      <div class="ncards">${cards}${more}</div>
    </div>
  </section>`;
}

/**
 * The per-point regions, validated: one entry per point (same length), each either a
 * 0..1 box inside the image or null ("whole painting"). Null when the meta is missing,
 * misaligned, malformed, or locates no point at all — the caller then falls back to
 * the plain text section.
 */
function noticeRegions(items, meta) {
  if (!Array.isArray(meta) || meta.length !== items.length) return null;
  const ok = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const out = meta.map((m) => {
    const r = m && m.scope === "detail" ? m.region : null;
    const box = r && ok(r.x) && ok(r.y) && ok(r.w) && ok(r.h) && r.w > 0 && r.h > 0 && r.x + r.w <= 1.001 && r.y + r.h <= 1.001 ? r : null;
    const t = m && typeof m.title === "string" ? m.title.trim().slice(0, 60) : "";
    return { title: t, box };
  });
  return out.some((o) => o.box) ? out : null;
}

// A marker sits on its region's top-left corner, nudged inside the painting so a
// region touching the edge doesn't get a half-clipped number.
const markerPct = (v) => (Math.min(0.94, Math.max(0.06, v)) * 100).toFixed(2);

function renderNoticeRegions(items, regions, img, zoomImg, title) {
  const located = regions.filter((r) => r.box).length;
  let k = 0;
  const cards = items
    .map((t, i) => {
      const r = regions[i];
      const num = String(i + 1).padStart(2, "0");
      const kth = r.box ? ++k : 0;
      const chip = r.box
        ? `<button class="nt-chip" type="button" data-nt-show="${i}">${ICON_SCAN}<span class="nt-chip__a">Show on painting</span><span class="nt-chip__b">On the painting</span></button>`
        : `<span class="nt-chip nt-chip--whole">${ICON_FRAME}<span>Whole painting</span></span>`;
      return `<article class="ncard nt-card" data-nt-i="${i}"${r.box ? ` data-nt-k="${kth}"` : ""}>
        <div class="nt-card__top"><span class="ncard__num">${num}</span>${chip}</div>
        ${r.title ? `<h3 class="nt-card__title">${esc(r.title)}</h3>` : ""}
        <p>${esc(t)}</p>
        ${r.box ? `<div class="nt-card__step"><button type="button" class="nt-step" data-nt-step="-1">‹ Prev</button><span>${kth} of ${located} on the painting</span><button type="button" class="nt-step" data-nt-step="1">Next ›</button></div>` : ""}
      </article>`;
    })
    .join("");
  const markers = regions
    .map((r, i) =>
      r.box
        ? `<button type="button" class="nt-marker" data-nt-i="${i}" style="left:${markerPct(r.box.x)}%;top:${markerPct(r.box.y)}%" aria-label="Detail ${i + 1}${r.title ? `: ${esc(r.title)}` : ""}">${String(i + 1).padStart(2, "0")}</button>`
        : "",
    )
    .join("");
  // Point data for the script; `<` escaped so text can't close the script element.
  const data = JSON.stringify(items.map((t, i) => ({ t: regions[i].title, text: t, b: regions[i].box }))).replace(/</g, "\\u003c");
  const intro = `${countWord(items.length)} details hide in plain sight. Pick one and we’ll show you exactly where to look.`;
  return `<section class="sec notice nt" data-nt-located="${located}">
    <div class="notice__head">
      ${eyebrow("LOOK CLOSER")}
      <h2>What to Notice</h2>
      <p class="notice__intro">${intro}</p>
    </div>
    <div class="notice__row">
      <div class="notice__img nt-figure">
        <div class="nt-sticky" aria-hidden="true"><span>What to Notice</span><span class="nt-sticky__count"></span><button type="button" class="nt-close" aria-label="Close">${ICON_CLOSE_SM}</button></div>
        <div class="nt-stage">
          <div class="nt-img"${zoomImg && zoomImg !== img ? ` data-zoom-src="${esc(zoomImg)}"` : ""}>
            <img src="${esc(img)}" alt="${esc(title)}" loading="lazy" decoding="async" draggable="false" />
            <div class="nt-spot" aria-hidden="true"></div>
            ${markers}
          </div>
          <svg class="nt-arrow" aria-hidden="true"><line /></svg>
          <div class="nt-cap" role="status" aria-live="polite"><strong><span class="nt-cap__n"></span> <span class="nt-cap__t"></span></strong><p class="nt-cap__x"></p><span class="nt-cap__hint">← → step through · Esc to close</span></div>
          <button type="button" class="nt-zoom" aria-pressed="false">${ICON_ZOOM_SM}<span>Zoom to detail</span></button>
          <div class="nt-hint"><span>${located} detail${located === 1 ? " is" : "s are"} marked · pick a number</span></div>
        </div>
        <div class="nt-bar" role="toolbar" aria-label="Details on the painting">
          <button type="button" class="nt-bar__step" data-nt-step="-1" aria-label="Previous detail">‹</button>
          <span class="nt-bar__count">${located} on the painting</span>
          <button type="button" class="nt-bar__step" data-nt-step="1" aria-label="Next detail">›</button>
          <i aria-hidden="true"></i>
          <button type="button" class="nt-tour" aria-pressed="false">${PLAY_TRI_SM}<span>Guided tour</span></button>
          <button type="button" class="nt-markers" aria-pressed="true">${ICON_PIN}<span>Markers on</span></button>
        </div>
      </div>
      <div class="ncards nt-cards">${cards}</div>
    </div>
    <script type="application/json" class="nt-data">${data}</script>
  </section>`;
}

function countWord(n) {
  const w = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  return w[n] || String(n);
}

// Audio Deep Dive — a visual teaser (Ziv, T1-879): the play button and preview bar
// hand off to the app; no audio streams on the web (that would generate narration
// on demand for every visitor).
function renderAudio(title, playUrl) {
  const bars = [9, 18, 13, 22, 8].map((h) => `<i style="height:${h}px"></i>`).join("");
  return `<section class="sec audio">
    <div class="audio__card">
      <div class="audio__main">
        <div class="audio__eyebrow"><span class="audio__bars" aria-hidden="true">${bars}</span>AUDIO DEEP DIVE</div>
        <h2>Stand in front of it and listen</h2>
        <p>The full narration walks you through ${esc(title)} — the story behind it, the details most visitors miss, and why it matters. Free in the Art Whisper app.</p>
        <div class="audio__stores">
          <a class="pillbtn pillbtn--dark" data-store-cta href="${playUrl}" target="_blank" rel="noopener">${ICON_PHONE}Get the free app</a>
        </div>
      </div>
      <a class="audio__player" data-store-cta href="${playUrl}" target="_blank" rel="noopener" aria-label="Play a preview in the Art Whisper app"
         onclick="window.__awTrack&&window.__awTrack('audio_teaser_clicked')">
        <span class="audio__play">${PLAY_TRI}</span>
        <span class="audio__track"><i></i><span class="audio__times"><span>0:00</span><span>Preview · 0:30</span></span><span class="audio__free">Free preview · 0:30</span></span>
      </a>
      <a class="audio__cta" data-store-cta href="${playUrl}" target="_blank" rel="noopener">${ICON_PHONE}Hear the full story in the app</a>
    </div>
  </section>`;
}

function renderArtist(artist, playUrl) {
  if (!artist || !artist.name) return "";
  const name = artist.name;
  const dates = [artist.birth_year, artist.death_year].filter(Boolean).join("–");
  const line = [dates, artist.nationality].filter(Boolean).join(" · ");
  const bio = artist.one_liner || artist.bio || "";
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const portraitCss = cssUrl(artist.image_url);
  const portrait = portraitCss
    ? `<span class="artist__portrait" style="background-image:url('${portraitCss}')"></span>`
    : `<span class="artist__portrait artist__portrait--initials">${esc(initials)}</span>`;
  // The public artist page when it exists (artwork→artist internal link), else the app.
  const slug = typeof artist.slug === "string" && SLUG_RE.test(artist.slug) ? artist.slug : null;
  const href = slug ? `/artist/${slug}` : playUrl;
  const ext = slug ? "" : ` target="_blank" rel="noopener" data-store-cta`;
  return `<section class="sec artist">
    ${eyebrow("THE ARTIST")}
    <div class="artist__card">
      <a class="artist__pic" href="${href}"${ext} tabindex="-1" aria-hidden="true">${portrait}</a>
      <div class="artist__body">
        <h3><a href="${href}"${ext}>${esc(name)}</a></h3>
        ${line ? `<span class="artist__line">${esc(line)}</span>` : ""}
        ${bio ? `<p>${esc(bio)}</p>` : ""}
      </div>
      <a class="pillbtn artist__btn" href="${href}"${ext}>Read ${esc(surname(name))}’s full story</a>
    </div>
  </section>`;
}

// A row of work cards: 4 per view on desktop with ‹ › paging + dots when there are
// more; a sideways swipe on mobile. Every work has a live /a/{slug} page (the API
// applies the sitemap gate), and each painting is shown whole — never cropped.
function renderWorksRail({ key, eyebrow: eb, heading, works, withArtist, moreHref }) {
  const list = (Array.isArray(works) ? works : []).filter((w) => w && SLUG_RE.test(w.slug || ""));
  if (!list.length) return "";
  const cards = list
    .map((w) => {
      const img = w.image_url && /^https?:\/\//.test(w.image_url) ? w.image_url : null;
      const sub = [withArtist && w.artist_name ? surname(w.artist_name) : null, w.year, w.museum_name]
        .filter(Boolean)
        .map((s) => esc(String(s)))
        .join(" · ");
      return `<a class="wcard" href="/a/${w.slug}" data-rail="${key}">
        <span class="wcard__img">${img ? `<img src="${esc(img)}" alt="${esc(w.title)}" loading="lazy" decoding="async" />` : ""}</span>
        <span class="wcard__t">${esc(w.title)}</span>
        ${sub ? `<span class="wcard__s">${sub}</span>` : ""}
      </a>`;
    })
    .join("");
  const pages = Math.ceil(list.length / 4);
  // Paging controls whenever a smaller screen could need them; the rail script
  // hides them again when everything fits on one page.
  const nav =
    list.length > 3
      ? `<div class="rail__nav"><span class="rail__count">1 / ${pages}</span>
          <button class="rail__btn rail__prev" type="button" aria-label="Previous" disabled>‹</button>
          <button class="rail__btn rail__next" type="button" aria-label="Next">›</button></div>`
      : moreHref
        ? `<a class="rail__more" href="${moreHref}">See the movement →</a>`
        : "";
  const dots =
    list.length > 3
      ? `<div class="rail__dots" aria-hidden="true">${Array.from({ length: pages }, (_, i) => `<i${i === 0 ? ' class="on"' : ""}></i>`).join("")}</div>`
      : "";
  return `<section class="sec works" data-key="${key}">
    <div class="works__head">
      <div>${eyebrow(eb)}<h2>${esc(heading)}</h2></div>
      ${nav}
    </div>
    <div class="rail" tabindex="0">${cards}</div>
    ${dots}
  </section>`;
}

// "More works to explore" (T1-847, Pencil "Artwork Page v1.2"): a grid of works
// beyond this artist and the movement row, each tagged with why it's here — same era
// or one of the work's other movements. 8 show; "Show 8 more" reveals the rest (all
// are in the HTML, so every card is a crawlable internal link). Chips filter by reason.
const EXPLORE_MIN = 4;
const EXPLORE_PAGE = 8;
function renderExplore(explore, { title, artistName, movementName }) {
  const list = (Array.isArray(explore?.works) ? explore.works : []).filter(
    (w) => w && SLUG_RE.test(w.slug || "") && (w.reason === "era" || w.reason === "movement"),
  );
  if (list.length < EXPLORE_MIN) return "";
  const year = Number.isFinite(explore.year) ? explore.year : null;
  // "1850s–1880s" for a work from 1866 (the API's window is ±15 years).
  const era = year ? `${Math.floor((year - 15) / 10) * 10}s–${Math.floor((year + 15) / 10) * 10}s` : "";
  const why = (w) =>
    w.reason === "era" ? `Same era${era ? ` · ${era}` : ""}` : `Same movement${w.movement_name ? ` · ${w.movement_name}` : ""}`;
  const cards = list
    .map((w, i) => {
      const img = w.image_url && /^https?:\/\//.test(w.image_url) ? w.image_url : null;
      const sub = [w.artist_name, w.year, w.museum_name].filter(Boolean).map((x) => esc(String(x))).join(" · ");
      return `<a class="wcard xcard" href="/a/${w.slug}" data-rail="explore" data-reason="${w.reason}"${i >= EXPLORE_PAGE ? " hidden" : ""}>
        <span class="wcard__img">${img ? `<img src="${esc(img)}" alt="${esc(w.title)}" loading="lazy" decoding="async" />` : ""}</span>
        <span class="xcard__why">${esc(why(w))}</span>
        <span class="wcard__t">${esc(w.title)}</span>
        ${sub ? `<span class="wcard__s">${sub}</span>` : ""}
      </a>`;
    })
    .join("");
  const hasEra = list.some((w) => w.reason === "era");
  const hasMovement = list.some((w) => w.reason === "movement");
  const chips =
    hasEra && hasMovement
      ? `<div class="xchips" role="group" aria-label="Filter works">${[
          ["all", "All"],
          ["era", "Same era"],
          ["movement", "Same movement"],
        ]
          .map(([k, l]) => `<button type="button" class="xchip" data-x-filter="${k}" aria-pressed="${k === "all"}">${l}</button>`)
          .join("")}</div>`
      : "";
  const beyond = [artistName ? surname(artistName) : null, movementName].filter(Boolean).join(" and ");
  const what = [hasEra ? "from the same years" : null, hasMovement ? `from the other movements ${title} belongs to` : null]
    .filter(Boolean)
    .join(", and ");
  const sub = `${beyond ? `Beyond ${beyond}: works` : "Works"} ${what}.`;
  const more =
    list.length > EXPLORE_PAGE
      ? `<div class="xmore"><button type="button" class="xmore__btn">Show ${Math.min(EXPLORE_PAGE, list.length - EXPLORE_PAGE)} more works</button></div>`
      : "";
  return `<section class="sec works explore" data-key="explore">
    <div class="works__head">
      <div>${eyebrow("KEEP EXPLORING")}<h2>More works to explore</h2><p class="explore__sub">${esc(sub)}</p></div>
      ${chips}
    </div>
    <div class="xgrid">${cards}</div>
    ${more}
  </section>`;
}

function renderNotFound() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Artwork not found · Art Whisper</title>
  <meta name="robots" content="noindex" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="alternate icon" href="/favicon.ico" type="image/png" />
  <link rel="apple-touch-icon" href="/favicon.ico" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600&family=Lora:wght@600&display=swap" rel="stylesheet" />
  <style>${STYLES}</style>
</head>
<body>
  <main class="empty">
    <img class="empty__logo" src="/logo.png" alt="Art Whisper" width="60" height="60" />
    <h1>This artwork isn't available</h1>
    <p>The link may have expired, or the artwork can't be shared publicly. You can still explore thousands of works in the app.</p>
    <a class="empty__cta" href="${PLAY_URL}" target="_blank" rel="noopener">Get the app ${ARROW}</a>
    <a class="empty__home" href="https://artwhisper.app">Back to artwhisper.app</a>
  </main>
</body>
</html>`;
}

// ─── Inline SVG snippets ────────────────────────────────────────────
const ARROW = `<svg class="arr" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
const PLAY_TRI = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7 4 20 12 7 20 7 4"/></svg>`;
const svg = (body, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON_MINUS = svg(`<line x1="5" y1="12" x2="19" y2="12"/>`);
const ICON_PLUS = svg(`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`);
const ICON_ZOOM = svg(`<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>`);
const ICON_EXPAND = svg(`<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`);
const ICON_CLOSE = svg(`<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`, 22);
const ICON_CHEV_DOWN = svg(`<polyline points="6 9 12 15 18 9"/>`, 18);
const ICON_SCAN = svg(`<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/>`, 12);
const ICON_FRAME = svg(`<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>`, 12);
const ICON_CLOSE_SM = svg(`<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`, 16);
const ICON_ZOOM_SM = svg(`<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>`, 15);
const ICON_PIN = svg(`<path d="M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>`, 15);
const PLAY_TRI_SM = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7 4 20 12 7 20 7 4"/></svg>`;
const ICON_PHONE = svg(`<rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/>`, 18);

// ─── Viewer: zoom + pan + full screen (T1-879) ──────────────────────
// Zoom steps scale the uncropped painting in place; when zoomed, drag (or one-finger
// swipe) pans and a two-finger pinch steps the zoom. "Full screen" turns the stage
// into a fixed overlay (plus the Fullscreen API where the browser allows it — iPhone
// Safari doesn't for non-video elements, so the overlay alone must work). The script
// also tags <body data-shape> from the painting's real aspect ratio, which picks the
// portrait vs landscape What-to-Notice layout.
function viewerScript(slug) {
  return `<script>(function(){
  var st=document.querySelector(".stage"); if(!st) return;
  var img=st.querySelector(".stage__img"), pan=st.querySelector(".stage__pan");
  function track(ev,p){try{if(window.__awTrack)window.__awTrack(ev,p||{})}catch(e){}}
  function shape(){ if(img&&img.naturalWidth){ document.body.setAttribute("data-shape", img.naturalWidth/img.naturalHeight>1.15?"landscape":"portrait"); } }
  if(!img) return;
  if(img.complete) shape(); else img.addEventListener("load",shape);
  var S=[1,1.5,2,3,4],z=0,x=0,y=0;
  var pct=st.querySelector(".viewer__pct"),bin=st.querySelector(".viewer__in"),bout=st.querySelector(".viewer__out"),bz=st.querySelector(".viewer__zoom"),bf=st.querySelector(".viewer__full"),bc=st.querySelector(".stage__close");
  function clamp(){ var s=S[z],mx=img.offsetWidth*(s-1)/2+40,my=img.offsetHeight*(s-1)/2+40; if(z===0){x=0;y=0;return;} x=Math.max(-mx,Math.min(mx,x)); y=Math.max(-my,Math.min(my,y)); }
  function apply(){ clamp(); pan.style.transform="translate("+x+"px,"+y+"px) scale("+S[z]+")"; st.classList.toggle("is-zoomed",z>0); if(pct)pct.textContent=Math.round(S[z]*100)+"%"; if(bout)bout.disabled=z===0; if(bin)bin.disabled=z===S.length-1; }
  function set(n,via){ var nz=Math.max(0,Math.min(S.length-1,n)); if(nz===z) return; z=nz; apply(); track("artwork_viewer_zoom",{level:S[z],via:via}); }
  if(bin) bin.addEventListener("click",function(){set(z+1,"button")});
  if(bout) bout.addEventListener("click",function(){set(z-1,"button")});
  if(bz) bz.addEventListener("click",function(){set(z===S.length-1?0:z+1,"button")});
  img.addEventListener("dblclick",function(){set(z>0?0:2,"dblclick")});
  // Drag to pan + pinch to zoom (pointer events cover mouse, pen and touch).
  var pts={},drag=null,pinch=null;
  function dist(){var k=Object.keys(pts);if(k.length<2)return 0;var a=pts[k[0]],b=pts[k[1]];return Math.hypot(a.x-b.x,a.y-b.y);}
  pan.addEventListener("pointerdown",function(e){ pts[e.pointerId]={x:e.clientX,y:e.clientY}; var n=Object.keys(pts).length;
    if(n===2){ pinch={d:dist()}; drag=null; } else if(n===1&&z>0){ drag={x:e.clientX-x,y:e.clientY-y}; try{pan.setPointerCapture(e.pointerId)}catch(_){} } });
  pan.addEventListener("pointermove",function(e){ if(!pts[e.pointerId]) return; pts[e.pointerId]={x:e.clientX,y:e.clientY};
    if(pinch){ var d=dist(); if(d>pinch.d*1.25){set(z+1,"pinch");pinch.d=d;} else if(d<pinch.d*0.8){set(z-1,"pinch");pinch.d=d;} return; }
    if(drag){ x=e.clientX-drag.x; y=e.clientY-drag.y; apply(); } });
  function up(e){ delete pts[e.pointerId]; if(Object.keys(pts).length<2) pinch=null; if(!Object.keys(pts).length) drag=null; }
  pan.addEventListener("pointerup",up); pan.addEventListener("pointercancel",up);
  // Mouse wheel zooms only in full screen, so it never hijacks page scrolling.
  st.addEventListener("wheel",function(e){ if(!st.classList.contains("is-full")) return; e.preventDefault(); set(z+(e.deltaY<0?1:-1),"wheel"); },{passive:false});
  function enter(){ st.classList.add("is-full"); document.documentElement.classList.add("aw-lock");
    try{ if(st.requestFullscreen) st.requestFullscreen().catch(function(){}); }catch(_){}
    track("artwork_viewer_fullscreen",{slug:${JSON.stringify(slug)}}); }
  function exit(){ if(!st.classList.contains("is-full")) return; st.classList.remove("is-full"); document.documentElement.classList.remove("aw-lock"); z=0; apply();
    try{ if(document.fullscreenElement&&document.exitFullscreen) document.exitFullscreen().catch(function(){}); }catch(_){} }
  if(bf) bf.addEventListener("click",function(){ st.classList.contains("is-full")?exit():enter(); });
  if(bc) bc.addEventListener("click",exit);
  document.addEventListener("fullscreenchange",function(){ if(!document.fullscreenElement) exit(); });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape") exit(); if(!st.classList.contains("is-full")) return; if(e.key==="+"||e.key==="=") set(z+1,"key"); if(e.key==="-") set(z-1,"key"); });
  window.addEventListener("resize",apply);
})();</script>`;
}

// ─── What to Notice "show me where" (T1-857) ─────────────────────────
// Pencil: "What to Notice Regions" (desktop selected + default + interaction spec)
// and "Mobile Web 390 · DEFAULT / SELECTED / notes". Only runs when the section was
// rendered with regions; a text-only section has no .nt and this exits at once.
function noticeScript(slug) {
  return `<script>(function(){
  var sec=document.querySelector(".nt"); if(!sec) return;
  var pts; try{ pts=JSON.parse(sec.querySelector(".nt-data").textContent) }catch(e){ return; }
  var fig=sec.querySelector(".nt-figure"),stage=sec.querySelector(".nt-stage"),box=sec.querySelector(".nt-img"),img=box.querySelector("img");
  var spot=sec.querySelector(".nt-spot"),cap=sec.querySelector(".nt-cap"),arrow=sec.querySelector(".nt-arrow"),line=arrow.querySelector("line");
  var hint=sec.querySelector(".nt-hint"),tourBtn=sec.querySelector(".nt-tour"),mkBtn=sec.querySelector(".nt-markers"),zoomBtn=sec.querySelector(".nt-zoom");
  var count=sec.querySelector(".nt-bar__count"),stickyCount=sec.querySelector(".nt-sticky__count");
  var located=[]; pts.forEach(function(p,i){ if(p.b) located.push(i); });
  var cards=[].slice.call(sec.querySelectorAll(".nt-card")),markers=[].slice.call(sec.querySelectorAll(".nt-marker"));
  var sel=-1,tour=null,paused=false,pushed=false,zoomed=false;
  var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  var mobile=function(){ return window.matchMedia&&matchMedia("(max-width: 768px)").matches; };
  function track(ev,p){ try{ if(window.__awTrack) window.__awTrack(ev,Object.assign({slug:${JSON.stringify(slug)}},p||{})) }catch(e){} }
  var two=function(i){ return (i+1<10?"0":"")+(i+1); };
  // One-line hint: hidden after the first pick, and stays dismissed.
  try{ if(localStorage.getItem("aw_nt_hint")==="1") hint.hidden=true; }catch(e){}
  function dismissHint(){ if(hint.hidden) return; hint.hidden=true; try{ localStorage.setItem("aw_nt_hint","1") }catch(e){} }

  function setBox(el,b){ el.style.left=(b.x*100)+"%"; el.style.top=(b.y*100)+"%"; el.style.width=(b.w*100)+"%"; el.style.height=(b.h*100)+"%"; }

  // Desktop caption: beside the region on the emptiest side (right / left, else
  // below / above), with an arrow ending at the region's edge. Mobile: the caption
  // sits under the image (CSS), no arrow.
  function placeCaption(b){
    arrow.style.display="none";
    if(mobile()){ cap.style.left=cap.style.top=""; return; }
    var W=box.clientWidth,H=box.clientHeight,cw=cap.offsetWidth,ch=cap.offsetHeight,gap=36;
    var rx=b.x*W,ry=b.y*H,rw=b.w*W,rh=b.h*H,cx,cy,ax,ay,bx,by;
    var right=W-(rx+rw),left=rx,below=H-(ry+rh),above=ry;
    if(right>=cw+gap||left>=cw+gap){
      var onRight=right>=left; cx=onRight?rx+rw+gap:rx-gap-cw; cy=Math.max(8,Math.min(H-ch-8,ry+rh/2-ch/2));
      ax=onRight?cx:cx+cw; ay=cy+ch/2; bx=onRight?rx+rw:rx; by=Math.max(ry,Math.min(ry+rh,ay));
    }else{
      var onBelow=below>=above; cx=Math.max(8,Math.min(W-cw-8,rx+rw/2-cw/2)); cy=onBelow?Math.min(H-ch-8,ry+rh+gap):Math.max(8,ry-gap-ch);
      ax=cx+cw/2; ay=onBelow?cy:cy+ch; bx=Math.max(rx,Math.min(rx+rw,ax)); by=onBelow?ry+rh:ry;
    }
    cap.style.left=cx+"px"; cap.style.top=cy+"px";
    arrow.setAttribute("viewBox","0 0 "+W+" "+H); arrow.setAttribute("width",W); arrow.setAttribute("height",H);
    line.setAttribute("x1",ax); line.setAttribute("y1",ay); line.setAttribute("x2",bx); line.setAttribute("y2",by);
    arrow.style.display="block";
  }

  function show(i,via){
    var p=pts[i]; if(!p) return;
    dismissHint(); if(zoomed) setZoom(false);
    sel=i;
    cards.forEach(function(c){ c.classList.toggle("is-sel",+c.dataset.ntI===i); });
    if(!p.b){ // "whole painting": highlight the card only — no dimming, no outline
      sec.classList.remove("is-open"); spot.classList.remove("on"); cap.classList.remove("on"); arrow.style.display="none";
      markers.forEach(function(m){ m.classList.remove("is-sel"); }); track("notice_point_selected",{i:i,via:via,whole:true}); return;
    }
    sec.classList.add("is-open");
    setBox(spot,p.b); spot.classList.add("on");
    markers.forEach(function(m){ var on=+m.dataset.ntI===i; m.classList.toggle("is-sel",on); if(on&&!reduce){ m.classList.remove("pulse"); void m.offsetWidth; m.classList.add("pulse"); } });
    var k=located.indexOf(i)+1;
    cap.querySelector(".nt-cap__n").textContent=two(i); cap.querySelector(".nt-cap__t").textContent=p.t||"";
    cap.querySelector(".nt-cap__x").textContent=p.text; cap.classList.add("on");
    count.textContent=k+" / "+located.length; stickyCount.textContent=k+" of "+located.length+" on the painting";
    placeCaption(p.b);
    // Bring the painting into view (mobile: it pins under the slim bar).
    var r=fig.getBoundingClientRect();
    if(mobile()){ if(!pushed){ try{ history.pushState({nt:1},""); pushed=true; }catch(e){} } if(r.top<0||r.top>innerHeight*0.4) fig.scrollIntoView({block:"start",behavior:reduce?"auto":"smooth"}); }
    else if(r.top<0||r.bottom>innerHeight) stage.scrollIntoView({block:"center",behavior:reduce?"auto":"smooth"});
    track("notice_point_selected",{i:i,via:via});
  }
  function clear(fromPop){
    if(sel<0) return; sel=-1; stopTour(); if(zoomed) setZoom(false);
    sec.classList.remove("is-open"); spot.classList.remove("on"); cap.classList.remove("on"); arrow.style.display="none";
    cards.forEach(function(c){ c.classList.remove("is-sel"); }); markers.forEach(function(m){ m.classList.remove("is-sel","pulse"); });
    count.textContent=located.length+" on the painting";
    if(pushed&&!fromPop){ pushed=false; try{ history.back(); }catch(e){} } else pushed=false;
  }
  function step(d){
    if(!located.length) return;
    var k=located.indexOf(sel);
    var n=k<0?(d>0?0:located.length-1):(k+d+located.length)%located.length;
    show(located[n],"step");
  }

  // Tour: ~6 s per located point; pauses while the pointer is over the section.
  function stopTour(){ if(tour){ clearInterval(tour); tour=null; } tourBtn.setAttribute("aria-pressed","false"); tourBtn.querySelector("span").textContent="Guided tour"; }
  function startTour(){ stopTour(); if(sel<0||!pts[sel].b) show(located[0],"tour"); tourBtn.setAttribute("aria-pressed","true"); tourBtn.querySelector("span").textContent="Pause tour";
    tour=setInterval(function(){ if(paused) return; var k=located.indexOf(sel); if(k>=located.length-1){ stopTour(); return; } step(1); },6000); track("notice_tour_started"); }

  function setZoom(on){
    var p=pts[sel]; if(on&&(!p||!p.b)) return;
    zoomed=on; zoomBtn.setAttribute("aria-pressed",String(on)); zoomBtn.querySelector("span").textContent=on?"Zoom out":"Zoom to detail"; box.classList.toggle("is-zoom",on);
    if(on){ var z=box.getAttribute("data-zoom-src"); if(z&&img.getAttribute("src")!==z){ img.setAttribute("src",z); }
      box.style.transformOrigin=((p.b.x+p.b.w/2)*100)+"% "+((p.b.y+p.b.h/2)*100)+"%"; cap.classList.remove("on"); arrow.style.display="none"; track("notice_zoom",{i:sel}); }
    else { box.style.transformOrigin=""; if(sel>=0&&pts[sel].b){ cap.classList.add("on"); placeCaption(pts[sel].b); } }
  }

  // ── wiring ──
  markers.forEach(function(m){ m.addEventListener("click",function(e){ e.stopPropagation(); show(+m.dataset.ntI,"marker"); }); });
  cards.forEach(function(c){
    var i=+c.dataset.ntI;
    c.addEventListener("click",function(e){ if(e.target.closest("[data-nt-step]")) return; show(i,"card"); });
    // Hover (desktop): outline preview only.
    c.addEventListener("mouseenter",function(){ if(mobile()||!pts[i].b||sel===i) return; setBox(spot,pts[i].b); spot.classList.add("preview"); });
    c.addEventListener("mouseleave",function(){ spot.classList.remove("preview"); if(sel>=0&&pts[sel].b) setBox(spot,pts[sel].b); });
  });
  sec.addEventListener("click",function(e){ var s=e.target.closest("[data-nt-step]"); if(s){ e.stopPropagation(); stopTour(); step(+s.getAttribute("data-nt-step")); } });
  // A click on the painting outside the outlined detail closes it.
  box.addEventListener("click",function(e){ if(sel<0||!pts[sel].b||e.target.closest(".nt-marker")) return;
    var r=box.getBoundingClientRect(),b=pts[sel].b,x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
    if(zoomed) return; if(x<b.x||x>b.x+b.w||y<b.y||y>b.y+b.h) clear(); });
  sec.querySelector(".nt-close").addEventListener("click",function(){ clear(); });
  tourBtn.addEventListener("click",function(){ tour?stopTour():startTour(); });
  mkBtn.addEventListener("click",function(){ var on=!sec.classList.toggle("nt-nomarkers"); mkBtn.setAttribute("aria-pressed",String(on)); mkBtn.querySelector("span").textContent=on?"Markers on":"Markers off"; });
  zoomBtn.addEventListener("click",function(){ setZoom(!zoomed); });
  sec.addEventListener("mouseenter",function(){ paused=true; }); sec.addEventListener("mouseleave",function(){ paused=false; });
  document.addEventListener("keydown",function(e){ if(sel<0) return; var t=e.target; if(t&&/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    if(e.key==="Escape"){ clear(); } else if(e.key==="ArrowRight"){ e.preventDefault(); stopTour(); step(1); } else if(e.key==="ArrowLeft"){ e.preventDefault(); stopTour(); step(-1); } });
  window.addEventListener("popstate",function(){ if(pushed){ pushed=false; clear(true); } });
  // Mobile: swipe the caption to step.
  var sx=null; cap.addEventListener("touchstart",function(e){ sx=e.touches[0].clientX; },{passive:true});
  cap.addEventListener("touchend",function(e){ if(sx==null) return; var dx=e.changedTouches[0].clientX-sx; sx=null; if(Math.abs(dx)>40){ stopTour(); step(dx<0?1:-1); } },{passive:true});
  window.addEventListener("resize",function(){ if(sel>=0&&pts[sel].b&&!zoomed) placeCaption(pts[sel].b); });
  // v1.2 (T1-847): the list is locked to the painting's height; when the painting is
  // too short to give each point ~88px (panoramas), stack the list under it instead.
  function fit(){ if(!img.naturalWidth) return; sec.classList.toggle("nt-flow",fig.offsetHeight<cards.length*88); }
  if(img.complete) fit(); else img.addEventListener("load",fit);
  window.addEventListener("resize",fit);
})();</script>`;
}

// ─── Works rails: ‹ › paging, page count + dots (T1-879) ────────────
function railScript() {
  return `<script>(function(){
  Array.prototype.forEach.call(document.querySelectorAll(".works"),function(sec){
    var rail=sec.querySelector(".rail"); if(!rail) return;
    var prev=sec.querySelector(".rail__prev"),next=sec.querySelector(".rail__next"),count=sec.querySelector(".rail__count"),dw=sec.querySelector(".rail__dots");
    var key=sec.getAttribute("data-key"),navEl=sec.querySelector(".rail__nav");
    function gap(){ return parseFloat(getComputedStyle(rail).columnGap)||0; }
    function step(){ return rail.clientWidth+gap(); }
    // Pages follow how many cards fit (4 desktop, 3 tablet), so recount live.
    function sync(){ var pages=Math.max(1,Math.round((rail.scrollWidth+gap())/step())),p=Math.min(pages-1,Math.round(rail.scrollLeft/step()));
      if(count) count.textContent=(p+1)+" / "+pages;
      if(navEl) navEl.style.visibility=pages>1?"":"hidden"; if(dw) dw.style.visibility=pages>1?"":"hidden";
      if(dw){ if(dw.children.length!==pages) dw.innerHTML=new Array(pages+1).join("<i></i>"); Array.prototype.forEach.call(dw.children,function(d,i){d.classList.toggle("on",i===p)}); }
      if(prev) prev.disabled=rail.scrollLeft<4; if(next) next.disabled=rail.scrollLeft+rail.clientWidth>=rail.scrollWidth-4; }
    function go(dir){ rail.scrollBy({left:dir*step(),behavior:"smooth"}); try{if(window.__awTrack)window.__awTrack("related_rail_paged",{rail:key,dir:dir})}catch(e){} }
    if(prev) prev.addEventListener("click",function(){go(-1)});
    if(next) next.addEventListener("click",function(){go(1)});
    rail.addEventListener("scroll",function(){ window.requestAnimationFrame(sync); },{passive:true});
    window.addEventListener("resize",sync);
    sync();
  });
  document.addEventListener("click",function(e){ var a=e.target.closest&&e.target.closest("a.wcard"); if(!a) return;
    try{if(window.__awTrack)window.__awTrack("related_work_clicked",{rail:a.getAttribute("data-rail"),to:a.getAttribute("href")})}catch(_){} });
})();</script>`;
}

// ─── "More works to explore": chips filter by reason, "Show more" reveals 8 more (T1-847) ──
function exploreScript() {
  return `<script>(function(){
  var sec=document.querySelector(".explore"); if(!sec) return;
  var cards=[].slice.call(sec.querySelectorAll(".xcard")),chips=[].slice.call(sec.querySelectorAll(".xchip")),btn=sec.querySelector(".xmore__btn");
  var filter="all",limit=${EXPLORE_PAGE};
  function track(ev,p){ try{ if(window.__awTrack) window.__awTrack(ev,p||{}) }catch(e){} }
  function render(){
    var match=cards.filter(function(c){ return filter==="all"||c.getAttribute("data-reason")===filter; });
    cards.forEach(function(c){ c.hidden=true; }); match.forEach(function(c,i){ c.hidden=i>=limit; });
    var left=match.length-limit;
    if(btn){ btn.parentNode.hidden=left<=0; btn.textContent="Show "+Math.min(${EXPLORE_PAGE},Math.max(left,0))+" more works"; }
    chips.forEach(function(c){ c.setAttribute("aria-pressed",String(c.getAttribute("data-x-filter")===filter)); });
  }
  chips.forEach(function(c){ c.addEventListener("click",function(){ filter=c.getAttribute("data-x-filter"); limit=${EXPLORE_PAGE}; render(); track("explore_filter",{filter:filter}); }); });
  if(btn) btn.addEventListener("click",function(){ limit+=${EXPLORE_PAGE}; render(); track("explore_more",{filter:filter,shown:limit}); });
  render();
})();</script>`;
}

// ─── Error monitoring ───────────────────────────────────────────────
// The page is served from the edge as static HTML; the hero and artist portrait
// are CSS background-images (no `error` event), so a broken image would fail
// silently. This tiny client watches every <img> plus the background-image URLs
// and posts a Sentry event when one fails to load (T1-729 bug 3). It reuses the
// Art Whisper Sentry project via its public DSN (safe to embed — it's the same
// key shipped in the mobile app).
const SENTRY_INGEST =
  "https://o4510820807671808.ingest.us.sentry.io/api/4510900475592704/envelope/?sentry_key=e6024fe36e2671d1048f9c3b1c683f21&sentry_version=7";

// ─── Analytics ──────────────────────────────────────────────────────
// Mirrors the movement/artist web pages: loads PostHog (public client key)
// and captures an artwork_page_view. This is what lets UTM-tagged inbound
// traffic (e.g. Pinterest pins) be attributed in the same PostHog project.
function analyticsScript(slug, title) {
  const cfg = JSON.stringify({ key: POSTHOG_KEY, host: POSTHOG_HOST, slug, title });
  return `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  var D=${cfg};
  try{ posthog.init(D.key,{api_host:D.host,capture_pageview:true,persistence:"localStorage+cookie"});
    posthog.capture("artwork_page_view",{slug:D.slug,artwork:D.title}); }catch(e){}
  window.__awTrack=function(ev,props){try{posthog.capture(ev,Object.assign({slug:D.slug,artwork:D.title},props||{}))}catch(e){}};
</script>`;
}

function monitorScript(slug, bgImages) {
  const cfg = JSON.stringify({
    slug,
    ingest: SENTRY_INGEST,
    bg: bgImages.filter((b) => b && b.url),
  });
  return `<script>(function(){
  var D=${cfg},seen={};
  function eid(){var a=new Uint8Array(16);if(self.crypto&&crypto.getRandomValues){crypto.getRandomValues(a)}return Array.prototype.map.call(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}
  function report(kind,url){try{
    var id=eid();
    var env=JSON.stringify({event_id:id,sent_at:new Date().toISOString()})+"\\n"+JSON.stringify({type:"event"})+"\\n"+JSON.stringify({event_id:id,level:"warning",platform:"javascript",logger:"share-web",message:"Share page image failed to load ("+kind+")",tags:{surface:"share-web",slug:D.slug,image:kind},request:{url:location.href},extra:{image_url:url||null}});
    if(navigator.sendBeacon){navigator.sendBeacon(D.ingest,new Blob([env],{type:"application/x-sentry-envelope"}))}else{fetch(D.ingest,{method:"POST",body:env,keepalive:true,mode:"no-cors"})}
  }catch(e){}}
  // Only monitor the real content images (hero/artist-portrait) passed in via D.bg — never
  // site chrome (logo, app-store badges), which fired false "image failed to load" errors.
  // And retry once before reporting: transient load failures (aborted navigation, ad/tracker
  // blockers, flaky networks) clear on a second attempt, so we beacon only a genuinely dead
  // image, at most once per URL per page load.
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

// ─── Styles (design: Pencil "Full-Screen Stage (Option 1)" + "Mobile Web 390", T1-879) ──
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
body[data-shape="landscape"] .notice{grid-template-columns:minmax(0,1fr) 464px;grid-template-areas:"head head" "img cards";column-gap:56px}
body[data-shape="landscape"] .notice__head{padding-top:0;margin-bottom:28px}
body[data-shape="landscape"] .notice__head h2{margin-top:12px}
body[data-shape="landscape"] .notice__intro{margin-top:4px}
body[data-shape="landscape"] .notice__img{padding-top:16px}
body[data-shape="landscape"] .ncards{grid-template-columns:1fr;gap:12px;margin-top:16px}
body[data-shape="landscape"] .ncard{min-height:0;padding:18px 22px;gap:6px}
body[data-shape="landscape"] .ncard__num{font-size:22px}

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
/* More works to explore (T1-847) */
.explore__sub{margin:14px 0 0;font-size:17px;line-height:1.6;color:var(--sub)}
.xchips{display:flex;flex-wrap:wrap;gap:10px;flex:none}
.xchip{padding:10px 16px;border-radius:20px;border:1px solid #D6CFBF;background:var(--card);color:#3A352E;font:400 13px var(--sans);cursor:pointer;transition:background .15s,border-color .15s}
.xchip:hover{border-color:var(--gold)}
.xchip[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
.xgrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
.xgrid .wcard{flex:none}
.xgrid .wcard[hidden]{display:none}
.xgrid .wcard__img{height:280px}
.xcard__why{margin-bottom:6px;font-size:10px;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:var(--brown)}
.xmore{display:flex;justify-content:center;margin-top:28px}
.xmore[hidden]{display:none}
.xmore__btn{padding:14px 26px;border-radius:24px;border:1px solid #C3BBAA;background:none;color:#3A352E;font:600 11px var(--sans);letter-spacing:1.4px;text-transform:uppercase;cursor:pointer}
.xmore__btn:hover{background:var(--card)}
.xchip:focus-visible,.xmore__btn:focus-visible{outline:2px solid var(--gold);outline-offset:2px}

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
  body[data-shape="landscape"] .notice{grid-template-columns:minmax(0,1fr) 380px}
}
@media (max-width:1100px){
  :root{--pad:40px}
  .about{grid-template-columns:minmax(0,1fr);gap:48px}
  .notice,body[data-shape="landscape"] .notice{grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "img" "cards"}
  .notice__head,body[data-shape="landscape"] .notice__head{padding-top:0;margin-bottom:24px}
  .notice__img img{max-height:640px;margin:0 auto}
  .wcard{flex-basis:calc((100% - 40px) / 3)}
  .xgrid{grid-template-columns:repeat(3,minmax(0,1fr))}
  .explore .works__head{flex-direction:column;align-items:flex-start}
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
  .notice__head h2,body[data-shape="landscape"] .notice__head h2{font-size:30px;margin-top:14px}
  .notice__intro{font-size:15px;margin-top:10px}
  .notice__img img{max-height:420px}
  .ncards,body[data-shape="landscape"] .ncards{grid-template-columns:1fr;gap:10px;margin-top:16px}
  .ncard,body[data-shape="landscape"] .ncard{flex-direction:row;align-items:center;gap:16px;padding:16px 18px;min-height:0}
  .ncard__num,body[data-shape="landscape"] .ncard__num{font-size:24px;flex:none;width:30px}
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
  .explore__sub{font-size:15px;margin-top:10px}
  .xchips{flex-wrap:nowrap;overflow-x:auto;max-width:100%;scrollbar-width:none}
  .xchips::-webkit-scrollbar{display:none}
  .xchip{flex:none;padding:8px 14px}
  .xgrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 12px}
  .xgrid .wcard__img{height:200px;justify-content:center}
  .xcard__why{font-size:9px;letter-spacing:1.1px}
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

/* ── What to Notice "show me where" (T1-857) ── */
.nt .ncards{grid-template-columns:repeat(2,minmax(0,1fr))}
.nt-figure{position:relative}
.nt-stage{position:relative;display:inline-block;max-width:100%;vertical-align:top}
.nt-img{position:relative;overflow:hidden;border-radius:4px;transition:transform .45s ease;cursor:default}
.nt-img img{display:block;width:auto;height:auto;max-width:100%;max-height:760px;border-radius:0;user-select:none;-webkit-user-drag:none}
.nt-img.is-zoom{transform:scale(2.25);cursor:zoom-out}
.nt-img.is-zoom .nt-marker{display:none}
.nt-stage:has(.is-zoom){overflow:hidden;border-radius:4px}
/* Spotlight: the region stays bright, everything else dims to ~35% (box-shadow is clipped by .nt-img). */
.nt-spot{position:absolute;display:none;border-radius:6px;pointer-events:none;box-shadow:0 0 0 9999px rgba(12,10,8,.65),0 0 0 2px #E7B468,0 0 16px 2px rgba(224,160,80,.55);transition:left .35s ease,top .35s ease,width .35s ease,height .35s ease}
.nt-spot.on{display:block}
.nt-spot.preview:not(.on){display:block;box-shadow:0 0 0 2px rgba(231,180,104,.95),0 0 12px rgba(224,160,80,.5)}
.nt-spot.on.preview{box-shadow:0 0 0 9999px rgba(12,10,8,.65),0 0 0 2px rgba(231,180,104,.6),0 0 0 2px #E7B468}
.nt-marker{position:absolute;z-index:2;transform:translate(-50%,-50%);min-width:26px;height:26px;padding:0 6px;border-radius:13px;
  border:1px solid #CDBB94;background:rgba(251,246,236,.92);color:#5C4620;font:600 10.5px/24px var(--sans);letter-spacing:.2px;cursor:pointer;
  box-shadow:0 2px 6px rgba(0,0,0,.35);transition:transform .15s,background .15s}
.nt-marker:hover{transform:translate(-50%,-50%) scale(1.08)}
.nt-marker.is-sel{min-width:32px;height:32px;border-radius:16px;line-height:30px;font-size:12px;background:var(--gold);border:2px solid #FBF6EC;color:#1A1510;z-index:3}
.nt-marker.pulse{animation:ntpulse 1.1s ease-out 1}
@keyframes ntpulse{0%{box-shadow:0 0 0 0 rgba(212,136,44,.6)}100%{box-shadow:0 0 0 16px rgba(212,136,44,0)}}
.nt.nt-nomarkers .nt-marker:not(.is-sel){display:none}
.nt-arrow{position:absolute;left:0;top:0;pointer-events:none;overflow:visible;display:none;z-index:3}
.nt-arrow line{stroke:#E7B468;stroke-width:2;stroke-linecap:round}
.nt-cap{position:absolute;z-index:4;width:300px;display:none;padding:14px 16px;border-radius:10px;background:rgba(21,18,14,.92);border:1px solid rgba(231,180,104,.35);
  color:var(--cream);box-shadow:0 10px 30px rgba(0,0,0,.35);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.nt-cap.on{display:block}
.nt-cap strong{display:block;font-size:15px;font-weight:600}
.nt-cap__n{font-family:var(--serif);font-weight:400;color:#E7B468;margin-right:4px}
.nt-cap__x{margin:6px 0 0;font-size:13.5px;line-height:1.5;color:rgba(245,239,227,.88)}
.nt-cap__hint{display:block;margin-top:8px;font-size:11px;color:rgba(245,239,227,.5)}
.nt-hint{position:absolute;left:0;right:0;bottom:12px;z-index:2;display:flex;justify-content:center;pointer-events:none}
.nt-hint span{padding:7px 13px;border-radius:99px;background:rgba(21,18,14,.8);color:var(--cream);font-size:12.5px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.nt.is-open .nt-hint{display:none}
.nt-zoom{position:absolute;right:12px;top:12px;z-index:5;display:none;align-items:center;gap:7px;padding:8px 13px;border:0;border-radius:99px;
  background:rgba(21,18,14,.8);color:var(--cream);font:500 12.5px var(--sans);cursor:pointer;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.nt.is-open .nt-zoom{display:inline-flex}
.nt-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:12px;padding:6px 8px;border-radius:99px;border:1px solid var(--line);background:var(--card);width:max-content;max-width:100%}
.nt-bar i{width:1px;height:20px;background:var(--line)}
.nt-bar button{display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--ink);font:500 13px var(--sans);padding:6px 10px;border-radius:99px;cursor:pointer}
.nt-bar button:hover{background:#F1ECE2}
.nt-tour{color:var(--brown)!important}
.nt-tour[aria-pressed="true"]{background:var(--gold-soft,#F3E4C8)!important}
.nt-bar__count{font-size:12.5px;color:var(--muted);font-variant-numeric:tabular-nums;min-width:96px;text-align:center}
.nt-bar__step{font-size:18px!important;padding:2px 10px!important}
.nt-sticky{display:none}
/* Cards */
.nt-card{cursor:pointer;transition:border-color .15s,box-shadow .15s}
.nt-card__top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.nt-card__title{margin:0;font-family:var(--sans);font-size:15px;font-weight:600;color:var(--ink)}
.nt-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:99px;border:1px solid #CDBB94;background:#FFFDF8;color:var(--brown);
  font:600 10px/1 var(--sans);letter-spacing:1.2px;text-transform:uppercase;cursor:pointer;white-space:nowrap}
.nt-chip--whole{border-color:var(--rule);background:#EFEBE3;color:#8A8172;cursor:default}
.nt-chip svg{width:12px;height:12px}
.nt-card.is-sel{border-color:var(--gold);background:#FFFDF8;box-shadow:0 4px 18px rgba(212,136,44,.18)}
.nt-card.is-sel .nt-chip:not(.nt-chip--whole){background:var(--gold);border-color:var(--gold);color:#1A1510}
.nt-chip__b{display:none}
.nt-card.is-sel .nt-chip__a{display:none}
.nt-card.is-sel .nt-chip__b{display:inline}
.nt-card__step{display:none;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.nt-card.is-sel .nt-card__step{display:flex}
.nt-step{border:0;background:none;color:var(--brown);font:600 11px var(--sans);letter-spacing:1px;text-transform:uppercase;cursor:pointer;padding:4px 2px}
.nt-card:focus-within,.nt-marker:focus-visible,.nt-bar button:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
@media (prefers-reduced-motion: reduce){.nt-img,.nt-spot,.nt-marker{transition:none}.nt-marker.pulse{animation:none}}
@media (max-width:1439px){ .nt .ncards{grid-template-columns:minmax(0,1fr)} }
/* v1.2 (T1-847): heading across the top; the points become a compact list exactly as
   tall as the painting (contain:size → the grid row takes the figure's height, the list
   stretches to it, rows share it). Notes clamp to 2 lines — the full text is in the
   caption on the painting. Too short for the list (panoramas) → .nt-flow stacks. */
@media (min-width:1101px){
  .nt.notice{grid-template-areas:"head head" "img cards";grid-template-rows:auto auto}
  .nt .notice__head{padding-top:0;margin-bottom:28px}
  .nt .notice__head h2{margin-top:12px}
  .nt .notice__intro{margin-top:4px}
  .nt .ncards.nt-cards{display:flex;flex-direction:column;gap:10px;margin-top:0;align-self:stretch;contain:size}
  .nt .ncard.nt-card{flex:1 1 0;min-height:0;overflow:hidden;display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-rows:auto auto;
    align-content:center;column-gap:20px;row-gap:2px;padding:10px 22px}
  .nt .nt-card__top{display:contents}
  .nt .nt-card .ncard__num{grid-column:1;grid-row:1 / span 2;align-self:center;min-width:32px;font-size:24px}
  .nt .nt-card .nt-chip{grid-column:3;grid-row:1 / span 2;align-self:center}
  .nt .nt-card__title{grid-column:2;grid-row:1}
  .nt .nt-card p{grid-column:2;grid-row:2;font-size:14px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .nt .nt-card .nt-card__step{display:none}
  .nt .nt-card.is-sel{background:#F5EEDF}
  .nt.nt-flow.notice{grid-template-columns:minmax(0,1fr);grid-template-areas:"head" "img" "cards"}
  .nt.nt-flow .ncards.nt-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));contain:none;margin-top:20px}
  .nt.nt-flow .ncard.nt-card{min-height:88px}
}
@media (max-width:768px){
  .nt-figure{display:flex;flex-direction:column}
  .nt-stage{display:block}
  .nt-img img{max-height:none;width:100%}
  .nt-marker{min-width:24px;height:24px;font-size:10px;line-height:22px}
  .nt-hint span{font-size:12px}
  .nt-cap{position:static;width:auto;margin-top:12px;background:var(--ink);border-color:transparent;transform:none}
  .nt-cap__hint{display:none}
  .nt-bar{border-radius:12px;width:100%;justify-content:space-between}
  .nt-bar .nt-bar__step,.nt-bar .nt-bar__count,.nt-bar i{display:none}
  .nt.is-open .nt-bar .nt-bar__step,.nt.is-open .nt-bar .nt-bar__count{display:inline-flex}
  /* Open: the painting pins under a slim bar while the cards scroll beneath. */
  .nt.is-open .nt-figure{position:sticky;top:0;z-index:20;background:var(--bg);margin:0 calc(var(--pad) * -1);padding:0 var(--pad) 10px;box-shadow:0 8px 16px -12px rgba(0,0,0,.35)}
  .nt.is-open .nt-sticky{display:flex;align-items:center;justify-content:space-between;gap:10px;height:48px;font-family:var(--serif);font-size:16px;color:var(--ink)}
  .nt-sticky__count{margin-left:auto;font-family:var(--sans);font-size:12px;color:var(--muted)}
  .nt-close{width:32px;height:32px;border-radius:16px;border:0;background:#E9E3D6;color:var(--ink);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
  .nt .ncard.nt-card{flex-direction:column;align-items:stretch;gap:10px}
  .nt.is-open .nt-img img{max-height:38vh;width:auto;margin:0 auto}
  .nt.is-open .nt-cap{margin-top:10px;padding:12px 14px}
  .nt.is-open .nt-bar{flex-wrap:nowrap;margin-top:8px;padding:2px 6px}
  .nt.is-open .nt-markers{display:none}
  .nt.is-open .nt-stage{display:flex;flex-direction:column;align-items:center}
  .nt.is-open .nt-cap{align-self:stretch}
  .nt.is-open .nt-img{display:inline-block}
}
`;

