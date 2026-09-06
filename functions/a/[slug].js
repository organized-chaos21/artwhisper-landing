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

// Build the store-install links, carrying inbound attribution through to the app.
// - Android: Google Play reads the `referrer` param via the Install Referrer API,
//   so we pass utm_source + the pin's slug (utm_content) for per-pin attribution.
// - iOS: Apple only exposes a campaign-level token (`ct`), never per-pin, so we set
//   ct to the source (e.g. "pinterest") for a coarse App Store Connect campaign count.
// Falls back to the original share-page tags when there's no inbound utm_source.
function buildStoreLinks(src, content) {
  const source = src && /^[a-z0-9_-]{1,40}$/i.test(src) ? src.toLowerCase() : null;
  const slug = content && /^[a-z0-9-]{1,140}$/i.test(content) ? content : null;
  if (!source) {
    return {
      play: "https://play.google.com/store/apps/details?id=app.artwhisper&utm_source=share&utm_medium=web_preview&utm_campaign=share_page",
      appstore: "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=share-web_preview",
    };
  }
  const ref = new URLSearchParams({ utm_source: source, utm_medium: "web", utm_campaign: source });
  if (slug) ref.set("utm_content", slug);
  return {
    play: "https://play.google.com/store/apps/details?id=app.artwhisper&referrer=" + encodeURIComponent(ref.toString()),
    appstore: "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=" + encodeURIComponent(source.slice(0, 40)),
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
  return html(renderPage(data, canonical || slug, context.request.url), 200, 3600);
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
function renderPage(data, slug, reqUrl) {
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
  );

  const title = art.title || "Untitled";
  const artistName = artist?.name || null;
  const year = art.year || null;

  // Subtitle: "Vincent van Gogh, 1889" — omit missing parts gracefully.
  const subtitleParts = [artistName, year].filter(Boolean);
  const subtitle = subtitleParts.join(", ");

  // Hero image: prefer a self-hosted/proxied full image; fall back to the
  // artwork's source image_url. All URLs from the API are absolute.
  const heroImg =
    art.images?.[0]?.full_url ||
    art.images?.[0]?.medium_url ||
    art.image_url ||
    null;
  const heroCss = cssUrl(heroImg);

  // OG image is the Phase 1 share card (1200×630), keyed by artwork id.
  const shareCard = `${API_BASE}/v1/artworks/${art.id}/share-card.png`;
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
  const metaBar = renderMetaBar(art);
  const structuredData = renderStructuredData(art, artist, pageUrl, heroImg);
  const pullQuote = art.quick_context
    ? `<section class="band quote">
         <span class="quote__rule"></span>
         <p class="quote__text">${esc(art.quick_context)}</p>
         <span class="quote__rule"></span>
       </section>`
    : "";

  const about = art.about ? renderAbout(art.about) : "";
  const movements = renderMovements(art.movement_tags);
  const notice = renderNotice(art.what_to_notice, PLAY_LINK);
  const audio = renderAudio(hookRaw, PLAY_LINK);
  const artistSection = renderArtist(artist, PLAY_LINK);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(ogTitle)} · Art Whisper</title>
  <meta name="description" content="${esc(ogDesc)}" />
  <link rel="canonical" href="${pageUrl}" />
  ${structuredData}

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
    <a class="nav__open" href="${PLAY_LINK}" target="_blank" rel="noopener">
      <span class="nav__open-lg">Open in Art Whisper</span><span class="nav__open-sm">Open the App</span> ${ARROW}
    </a>
  </header>

  <section class="hero"${heroCss ? ` style="background-image:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,.28) 44%,rgba(0,0,0,.68) 72%,rgba(0,0,0,.94) 100%),url('${heroCss}')"` : ""}>
    <div class="hero__title">
      <h1>${esc(title)}</h1>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
    </div>
  </section>

  ${metaBar}
  ${pullQuote}

  <section class="band cta">
    <div class="cta__left">
      <img class="cta__mark" src="/logo.png" alt="" width="26" height="26" />
      <span>Get the full experience in Art Whisper</span>
    </div>
    <div class="badges">
      <a class="badge" href="${PLAY_LINK}" target="_blank" rel="noopener" aria-label="Get Art Whisper on Google Play">
        <img src="/badges/google-play.svg" alt="Get it on Google Play" height="44" />
      </a>
      <a class="badge" href="${APP_STORE_LINK}" target="_blank" rel="noopener" aria-label="Download Art Whisper on the App Store">
        <img src="/badges/app-store.svg" alt="Download on the App Store" height="44" />
      </a>
    </div>
  </section>

  ${about}
  ${movements}
  ${notice}
  ${audio}
  ${artistSection}

  <section class="report">
    <a href="https://artwhisper.app/#support">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>
      See something wrong?
    </a>
  </section>

  <footer class="foot">
    <span>© ${new Date().getFullYear()} Bright Star. All rights reserved.</span>
  </footer>

  <a class="stickybar" href="${PLAY_LINK}" target="_blank" rel="noopener">
    <span class="stickybar__left"><img class="stickybar__logo" src="/logo.png" alt="" width="32" height="32" /><strong>Open the App</strong></span>
    ${ARROW}
  </a>
  ${analyticsScript(slug, title)}
  ${monitorScript(slug, [
    { kind: "hero", url: heroImg },
    { kind: "artist-portrait", url: artist?.image_url || null },
  ])}
</body>
</html>`;
}

// Append our attribution tag to a museum object-page URL. The museum's own analytics
// then show artwhisper.app as the referring source (T1-730, Ziv's call). museum_url is
// a bare canonical URL from our API, so a simple ?/& join is safe.
function withUtm(url) {
  const u = String(url);
  return u + (u.includes("?") ? "&" : "?") + "utm_source=artwhisper.app";
}

// Small diagonal "opens in a new tab" glyph for the outbound museum link.
const EXT_ARROW = `<svg class="meta__ext" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>`;

// The meta bar carries the "object label" facts, each shown only when present — coverage
// varies a lot by source, so a blank label is never rendered (T1-730). The museum name
// doubles as the outbound "view on museum website" link when we can build one.
function renderMetaBar(art) {
  const cell = (l, vHtml) =>
    `<div class="meta__cell"><span class="meta__label">${l}</span><span class="meta__val">${vHtml}</span></div>`;
  const cells = [];
  if (art.medium) cells.push(cell("MEDIUM", esc(art.medium)));
  if (art.dimensions) cells.push(cell("DIMENSIONS", esc(art.dimensions)));
  if (art.museum_name) {
    const label = esc(art.museum_name);
    const val = art.museum_url
      ? `<a class="meta__link" href="${esc(withUtm(art.museum_url))}" target="_blank" rel="noopener noreferrer"
            onclick="window.__awTrack&&window.__awTrack('museum_link_clicked')">${label}${EXT_ARROW}</a>`
      : label;
    cells.push(cell("LOCATION", val));
  }
  if (art.department) cells.push(cell("COLLECTION", esc(art.department)));
  if (art.culture) cells.push(cell("CULTURE", esc(art.culture)));
  if (art.credit_line) cells.push(cell("CREDIT LINE", esc(art.credit_line)));
  if (!cells.length) return "";
  return `<section class="meta">
    ${cells.join("")}
  </section>`;
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

function renderAbout(about) {
  const paras = String(about)
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const body = (paras.length ? paras : [about])
    .map((p) => `<p>${esc(p)}</p>`)
    .join("");
  return `<section class="about">
    <span class="eyebrow eyebrow--muted">ABOUT THIS WORK</span>
    <div class="about__body">${body}</div>
  </section>`;
}

function renderMovements(tags) {
  if (!Array.isArray(tags) || !tags.length) return "";
  // Gold right-chevron — mirrors the mobile app's movement chip, signalling the
  // pill is tappable/clickable. Shown only on linked chips.
  const chev =
    `<svg class="pill__chev" width="14" height="14" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;
  const pills = tags
    .filter((t) => t?.name)
    .map((t) => {
      // Link the chip to the public movement page when we have a valid slug
      // (interlinks share pages into the /movement/{slug} SEO hub). Fall back to
      // a plain pill if a tag somehow lacks a well-formed slug.
      const slug = typeof t.slug === "string" && SLUG_RE.test(t.slug) ? t.slug : null;
      return slug
        ? `<a class="pill" href="/movement/${slug}">${esc(t.name)}${chev}</a>`
        : `<span class="pill">${esc(t.name)}</span>`;
    })
    .join("");
  if (!pills) return "";
  return `<section class="movements">
    <span class="eyebrow eyebrow--muted">ART MOVEMENTS</span>
    <div class="pills">${pills}</div>
  </section>`;
}

function renderNotice(items, playUrl) {
  if (!Array.isArray(items) || !items.length) return "";
  const shown = items.slice(0, 3);
  const remaining = items.length - shown.length;
  const cards = shown
    .map(
      (t, i) =>
        `<div class="ncard"><span class="ncard__num">${i + 1}</span><p class="ncard__text">${esc(t)}</p></div>`,
    )
    .join("");
  const lock =
    remaining > 0
      ? `<a class="lockcta" href="${playUrl}" target="_blank" rel="noopener">${LOCK}<span>${remaining} more detail${remaining === 1 ? "" : "s"} waiting — unlock in Art Whisper</span>${ARROW}</a>`
      : "";
  return `<section class="notice">
    <div class="notice__head">
      <span class="eyebrow eyebrow--gold">LOOK CLOSER</span>
      <h2>What to Notice</h2>
    </div>
    <div class="ncards">${cards}</div>
    ${lock}
  </section>`;
}

function renderAudio(preview, playUrl) {
  const bars = [10, 16, 22, 14, 8, 20, 26, 18, 12, 24, 16, 10, 20, 14, 22, 8, 18, 26, 12, 16, 20, 10, 14, 22]
    .map((h) => `<span style="height:${h}px"></span>`)
    .join("");
  return `<section class="band audio">
    <div class="audio__hdr">${HEADPHONES}<span class="audio__title">Audio Deep Dive</span>${LOCK_SM}</div>
    <p class="audio__preview">${esc(clip(preview, 160))}</p>
    <div class="audio__player">
      <span class="audio__play">${PLAY_TRI}</span>
      <div class="audio__wave" aria-hidden="true">${bars}</div>
    </div>
    <a class="audio__cta" href="${playUrl}" target="_blank" rel="noopener">Hear the full story in the app ${ARROW}</a>
  </section>`;
}

function renderArtist(artist, playUrl) {
  if (!artist || !artist.name) return "";
  const name = artist.name;
  const firstName = name.split(/\s+/)[0];
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
  return `<section class="artist">
    <span class="eyebrow eyebrow--muted">THE ARTIST</span>
    <div class="artist__card">
      <div class="artist__row">
        ${portrait}
        <div class="artist__id">
          <strong>${esc(name)}</strong>
          ${line ? `<span>${esc(line)}</span>` : ""}
        </div>
      </div>
      ${bio ? `<p class="artist__bio">${esc(bio)}</p>` : ""}
      <a class="linkcta" href="${playUrl}" target="_blank" rel="noopener">Read ${esc(firstName)}'s full story in Art Whisper ${ARROW}</a>
    </div>
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
const LOCK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const LOCK_SM = `<svg class="audio__lock" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const HEADPHONES = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;
const PLAY_TRI = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;

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
  var D=${cfg};
  function eid(){var a=new Uint8Array(16);if(self.crypto&&crypto.getRandomValues){crypto.getRandomValues(a)}return Array.prototype.map.call(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}
  function report(kind,url){try{
    var id=eid();
    var env=JSON.stringify({event_id:id,sent_at:new Date().toISOString()})+"\\n"+JSON.stringify({type:"event"})+"\\n"+JSON.stringify({event_id:id,level:"error",platform:"javascript",logger:"share-web",message:"Share page image failed to load ("+kind+")",tags:{surface:"share-web",slug:D.slug,image:kind},request:{url:location.href},extra:{image_url:url||null}});
    if(navigator.sendBeacon){navigator.sendBeacon(D.ingest,new Blob([env],{type:"application/x-sentry-envelope"}))}else{fetch(D.ingest,{method:"POST",body:env,keepalive:true,mode:"no-cors"})}
  }catch(e){}}
  Array.prototype.forEach.call(document.images||[],function(img){img.addEventListener("error",function(){report("img:"+(img.getAttribute("alt")||"")||img.src,img.currentSrc||img.src)})});
  D.bg.forEach(function(o){var im=new Image();im.onerror=function(){report(o.kind,o.url)};im.src=o.url})
})();</script>`;
}

// ─── Styles (design: Pencil "Share Web" lane, tokens $share-*) ───────
const STYLES = `
:root{
  --bg:#FAF8F5;--surface:#FFFFFF;--band-light:#F5F3F0;--band-warm:#FFF8F0;
  --border:#E8E4DF;--gold:#D4882C;--cta:#EF9F27;
  --t-primary:#1A1A1A;--t-body:#3D3D3D;--t-secondary:#6B6B6B;--t-label:#999999;
  --serif:'Lora',Georgia,serif;--sans:'DM Sans',system-ui,-apple-system,sans-serif;
  --pad:80px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--t-body);font-family:var(--sans);
  font-size:16px;line-height:1.5;-webkit-font-smoothing:antialiased;}
img{max-width:100%;display:block}
a{color:inherit}
h1,h2{margin:0}
.eyebrow{font-family:var(--sans);font-weight:600;font-size:11px;letter-spacing:2px;display:block}
.eyebrow--muted{color:var(--t-label)}
.eyebrow--gold{color:var(--gold)}

/* Nav */
.nav{display:flex;align-items:center;justify-content:space-between;height:56px;
  padding:0 var(--pad);background:var(--surface);border-bottom:1px solid var(--border);}
.nav__brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--t-secondary);font-size:14px}
.nav__logo{border-radius:50%;display:block}
.nav__open{display:inline-flex;align-items:center;gap:6px;color:var(--gold);
  font-size:14px;font-weight:500;text-decoration:none}
.nav__open-sm{display:none}

/* Hero */
.hero{position:relative;height:min(700px,72vh);background:#141428 center/cover no-repeat;
  display:flex;align-items:flex-end;}
.hero__title{padding:0 var(--pad) 48px;max-width:1100px}
.hero__title h1{font-family:var(--serif);font-weight:700;font-size:64px;line-height:1.05;color:#fff;
  text-shadow:0 2px 24px rgba(0,0,0,.85)}
.hero__title p{margin:12px 0 0;color:rgba(255,255,255,.9);font-size:20px;letter-spacing:.5px;
  text-shadow:0 1px 16px rgba(0,0,0,.7)}

/* Metadata bar */
.meta{display:flex;flex-wrap:wrap;gap:48px;padding:32px var(--pad);
  background:var(--surface);border-bottom:1px solid var(--border);}
.meta__cell{display:flex;flex-direction:column;gap:6px}
.meta__label{font-size:10px;font-weight:600;letter-spacing:1.5px;color:var(--t-label)}
.meta__val{font-size:15px;color:var(--t-body)}
.meta__link{color:var(--gold);text-decoration:none;font-weight:500;display:inline-flex;align-items:center;gap:5px}
.meta__link:hover{text-decoration:underline}
.meta__ext{flex:none;opacity:.85;position:relative;top:.5px}

/* Pull quote */
.band{padding:0 var(--pad)}
.quote{display:flex;flex-direction:column;align-items:center;gap:40px;
  background:var(--bg);padding:64px max(var(--pad),200px);text-align:center}
.quote__rule{width:48px;height:2px;border-radius:1px;background:var(--gold)}
.quote__text{margin:0;font-family:var(--serif);font-style:italic;font-size:28px;
  line-height:1.6;color:var(--t-primary);max-width:900px}

/* CTA band */
.cta{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;
  background:var(--band-light);border-top:1px solid var(--border);border-bottom:1px solid var(--border);
  padding:18px var(--pad)}
.cta__left{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:500;color:var(--t-body)}
.cta__mark{width:26px;height:26px;border-radius:50%;flex:none;display:block}
.badges{display:flex;align-items:center;gap:12px}
.badge{display:inline-flex;text-decoration:none;transition:opacity .15s ease}
.badge:hover{opacity:.85}
.badge img{height:44px;width:auto;display:block}

/* About */
.about{padding:56px var(--pad) 48px;background:var(--bg)}
.about .eyebrow{margin-bottom:20px}
.about__body{max-width:760px;display:flex;flex-direction:column;gap:16px}
.about__body p{margin:0;font-size:17px;line-height:1.7;color:var(--t-body)}

/* Movements */
.movements{padding:0 var(--pad) 48px;background:var(--bg)}
.movements .eyebrow{margin-bottom:16px}
.pills{display:flex;flex-wrap:wrap;gap:10px}
.pill{display:inline-flex;align-items:center;gap:4px;padding:8px 16px;border-radius:16px;
  color:var(--t-primary);font-size:14px;font-weight:500;background:#F0EDE8;text-decoration:none}
.pill__chev{color:var(--gold);flex-shrink:0}
a.pill{transition:background .15s ease}
a.pill:hover{background:#E8E2D8}

/* What to Notice */
.notice{padding:8px var(--pad) 56px;background:var(--bg)}
.notice__head{display:flex;flex-direction:column;gap:8px;margin-bottom:28px}
.notice__head h2{font-family:var(--serif);font-weight:600;font-size:28px;color:var(--t-primary)}
.ncards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.ncard{background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:24px;display:flex;flex-direction:column;gap:14px;
  box-shadow:0 2px 10px rgba(26,20,13,.06)}
.ncard__num{width:28px;height:28px;border-radius:14px;background:var(--gold);color:#fff;
  font-weight:700;font-size:14px;display:flex;align-items:center;justify-content:center;flex:none}
.ncard__text{margin:0;font-family:var(--serif);font-weight:600;font-size:18px;
  line-height:1.4;color:var(--t-primary)}
.lockcta{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:20px;
  color:var(--gold);font-size:14px;font-weight:500;text-decoration:none}
.lockcta:hover{text-decoration:underline}

/* Audio deep dive */
.audio{background:var(--band-warm);padding:56px var(--pad);display:flex;flex-direction:column;gap:16px}
.audio__hdr{display:flex;align-items:center;gap:10px;color:var(--gold)}
.audio__title{color:var(--t-primary);font-size:16px;font-weight:600}
.audio__lock{color:var(--gold);opacity:.6;margin-left:auto}
.audio__preview{margin:0;font-family:var(--serif);font-style:italic;font-size:17px;
  line-height:1.6;color:#555;max-width:720px}
.audio__player{display:flex;align-items:center;gap:16px;padding:8px 0}
.audio__play{width:44px;height:44px;border-radius:22px;background:var(--gold);color:#fff;
  display:flex;align-items:center;justify-content:center;flex:none;padding-left:2px}
.audio__wave{display:flex;align-items:center;gap:2px;height:30px;overflow:hidden}
.audio__wave span{width:3px;border-radius:1.5px;background:#E0D5C8;flex:none}
.audio__cta{display:inline-flex;align-items:center;gap:6px;color:var(--gold);
  font-size:14px;font-weight:500;text-decoration:none}

/* Artist */
.artist{padding:48px var(--pad);background:var(--bg)}
.artist .eyebrow{margin-bottom:16px}
.artist__card{max-width:520px;background:var(--band-light);border:1px solid var(--border);
  border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:14px}
.artist__row{display:flex;align-items:center;gap:14px}
.artist__portrait{width:52px;height:52px;border-radius:26px;flex:none;
  background:#E8E4DF center/cover no-repeat;display:flex;align-items:center;justify-content:center}
.artist__portrait--initials{color:var(--t-secondary);font-weight:600;font-size:16px}
.artist__id{display:flex;flex-direction:column;gap:3px}
.artist__id strong{font-size:17px;font-weight:600;color:var(--t-primary)}
.artist__id span{font-size:14px;color:var(--t-secondary)}
.artist__bio{margin:0;font-size:15px;line-height:1.55;color:var(--t-body)}
.linkcta{display:inline-flex;align-items:center;gap:6px;color:var(--gold);
  font-size:14px;font-weight:500;text-decoration:none}

/* Report + footer */
.report{display:flex;justify-content:flex-end;padding:8px var(--pad) 40px;background:var(--bg)}
.report a{display:inline-flex;align-items:center;gap:8px;color:var(--t-label);
  font-size:13px;text-decoration:none}
.foot{display:flex;align-items:center;justify-content:flex-start;flex-wrap:wrap;gap:8px;
  padding:20px var(--pad);background:var(--band-light);border-top:1px solid var(--border);
  color:var(--t-label);font-size:13px}
.foot a{color:var(--t-label);text-decoration:none}
.foot a:hover{color:var(--gold)}

/* Mobile sticky bar (hidden on desktop) */
.stickybar{display:none}

/* Empty / not-found */
.empty{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:16px;text-align:center;padding:40px;max-width:520px;margin:0 auto}
.empty__logo{margin-bottom:8px;border-radius:50%}
.empty h1{font-family:var(--serif);font-weight:600;font-size:26px;color:var(--t-primary)}
.empty p{margin:0;color:var(--t-secondary);font-size:16px;line-height:1.5;max-width:420px}
.empty__cta{display:inline-flex;align-items:center;gap:8px;margin-top:8px;
  background:var(--cta);color:#fff;font-weight:600;font-size:16px;text-decoration:none;
  padding:14px 28px;border-radius:8px}
.empty__home{color:var(--t-label);font-size:14px;text-decoration:none}

/* ── Responsive ── */
@media (max-width:768px){
  :root{--pad:20px}
  .nav__open-lg{display:none}
  .nav__open-sm{display:inline}
  .hero{height:min(360px,50vh)}
  .hero__title{padding:0 20px 28px}
  .hero__title h1{font-size:34px}
  .hero__title p{font-size:16px}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:16px 20px;padding:24px 20px}
  .meta__cell:last-child{grid-column:1 / -1}
  .quote{padding:36px 24px;gap:24px}
  .quote__text{font-size:21px}
  .cta{padding:20px}
  .badges{width:100%;justify-content:center;flex-wrap:wrap}
  .badge img{height:48px}
  .about{padding:32px 20px 24px}
  .about__body p{font-size:16px}
  .movements{padding:0 20px 24px}
  .notice{padding:4px 20px 28px}
  .ncards{grid-template-columns:1fr}
  .audio{padding:28px 20px}
  .artist{padding:24px 20px}
  .foot{padding:20px}
  /* Room for the sticky bar + surface it */
  body{padding-bottom:56px}
  .stickybar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:20;
    align-items:center;justify-content:space-between;height:56px;padding:0 16px;
    background:var(--surface);border-top:1px solid var(--border);
    box-shadow:0 -2px 12px rgba(0,0,0,.08);text-decoration:none;color:var(--t-primary)}
  .stickybar__left{display:flex;align-items:center;gap:10px;font-size:14px}
  .stickybar__left strong{font-weight:600}
  .stickybar__logo{border-radius:50%}
  .stickybar .arr{color:var(--gold)}
  .report{justify-content:flex-start;padding:8px 20px 32px}
}
`;
