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

  // Success — cache at the edge for an hour; the underlying artwork is stable.
  return html(renderPage(data, slug), 200, 3600);
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
function renderPage(data, slug) {
  const art = data.artwork;
  const artist = data.artist || null;

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
  const pullQuote = art.quick_context
    ? `<section class="band quote">
         <span class="quote__rule"></span>
         <p class="quote__text">${esc(art.quick_context)}</p>
         <span class="quote__rule"></span>
       </section>`
    : "";

  const about = art.about ? renderAbout(art.about) : "";
  const movements = renderMovements(art.movement_tags);
  const notice = renderNotice(art.what_to_notice);
  const audio = renderAudio(hookRaw);
  const artistSection = renderArtist(artist);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(ogTitle)} · Art Whisper</title>
  <meta name="description" content="${esc(ogDesc)}" />
  <link rel="canonical" href="${pageUrl}" />

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
      ${LOGO(28, "#1A1A1A")}
      <span>Art Whisper</span>
    </a>
    <a class="nav__open" href="${PLAY_URL}" target="_blank" rel="noopener">
      Open in Art Whisper ${ARROW}
    </a>
  </header>

  <section class="hero"${heroCss ? ` style="background-image:linear-gradient(180deg,rgba(20,20,40,.15) 30%,rgba(0,0,0,.8) 100%),url('${heroCss}')"` : ""}>
    <div class="hero__title">
      <h1>${esc(title)}</h1>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ""}
    </div>
  </section>

  ${metaBar}
  ${pullQuote}

  <section class="band cta">
    <div class="cta__left">
      <span class="cta__mark">${LOGO(15, "#FFFFFF")}</span>
      <span>Get the full experience in Art Whisper</span>
    </div>
    <div class="badges">
      <a class="badge" href="${PLAY_URL}" target="_blank" rel="noopener" aria-label="Get Art Whisper on Google Play">
        <img src="/badges/google-play.svg" alt="Get it on Google Play" height="44" />
      </a>
      <a class="badge" href="${APP_STORE_URL}" target="_blank" rel="noopener" aria-label="Download Art Whisper on the App Store">
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
    <span><a href="https://artwhisper.app">Art Whisper</a> · <a href="https://artwhisper.app/terms">Terms</a> · <a href="https://artwhisper.app/privacy">Privacy</a></span>
    <span>© ${new Date().getFullYear()}</span>
  </footer>

  <a class="stickybar" href="${PLAY_URL}" target="_blank" rel="noopener">
    <span class="stickybar__left">${LOGO(30, "#1A1A1A")}<strong>Open in Art Whisper</strong></span>
    ${ARROW}
  </a>
  ${monitorScript(slug, [
    { kind: "hero", url: heroImg },
    { kind: "artist-portrait", url: artist?.image_url || null },
  ])}
</body>
</html>`;
}

function renderMetaBar(art) {
  const cells = [
    ["MEDIUM", art.medium],
    ["DIMENSIONS", art.dimensions],
    ["LOCATION", art.museum_name],
  ].filter(([, v]) => v);
  if (!cells.length) return "";
  return `<section class="meta">
    ${cells
      .map(
        ([l, v]) =>
          `<div class="meta__cell"><span class="meta__label">${l}</span><span class="meta__val">${esc(v)}</span></div>`,
      )
      .join("")}
  </section>`;
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
  const pills = tags
    .filter((t) => t?.name)
    .map((t) => `<span class="pill">${esc(t.name)}</span>`)
    .join("");
  if (!pills) return "";
  return `<section class="movements">
    <span class="eyebrow eyebrow--muted">ART MOVEMENTS</span>
    <div class="pills">${pills}</div>
  </section>`;
}

function renderNotice(items) {
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
      ? `<a class="lockcta" href="${PLAY_URL}" target="_blank" rel="noopener">${LOCK}<span>${remaining} more detail${remaining === 1 ? "" : "s"} waiting — unlock in Art Whisper</span>${ARROW}</a>`
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

function renderAudio(preview) {
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
    <a class="audio__cta" href="${PLAY_URL}" target="_blank" rel="noopener">Hear the full story in the app ${ARROW}</a>
  </section>`;
}

function renderArtist(artist) {
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
      <a class="linkcta" href="${PLAY_URL}" target="_blank" rel="noopener">Read ${esc(firstName)}'s full story in Art Whisper ${ARROW}</a>
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
    <span class="empty__logo">${LOGO(56, "#1A1A1A")}</span>
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

// Art Whisper brandmark, inlined with an EXPLICIT fill. The shared /favicon.svg
// swaps to white under `prefers-color-scheme: dark` — great for a browser tab,
// but as an <img> on our always-light surfaces it painted white-on-white and
// vanished (T1-729 bug 1). Inlining with a fixed fill pins the colour.
const LOGO = (size, fill) =>
  `<svg class="awmark" width="${size}" height="${size}" viewBox="0 0 128 128" fill="${fill}" aria-hidden="true"><path d="M50.4 78.5a75.1 75.1 0 0 0-28.5 6.9l24.2-65.7c.7-2 1.9-3.2 3.4-3.2h29c1.5 0 2.7 1.2 3.4 3.2l24.2 65.7s-11.6-7-28.5-7L67 45.5c-.4-1.7-1.6-2.8-2.9-2.8-1.3 0-2.5 1.1-2.9 2.7L50.4 78.5Zm-1.1 28.2Zm-4.2-20.2c-2 6.6-.6 15.8 4.2 20.2a17.5 17.5 0 0 1 .2-.7 5.5 5.5 0 0 1 5.7-4.5c2.8.1 4.3 1.5 4.7 4.7.2 1.1.2 2.3.2 3.5v.4c0 2.7.7 5.2 2.2 7.4a13 13 0 0 0 5.7 4.9v-.3l-.2-.3c-1.8-5.6-.5-9.5 4.4-12.8l1.5-1a73 73 0 0 0 3.2-2.2 16 16 0 0 0 6.8-11.4c.3-2 .1-4-.6-6l-.8.6-1.6 1a37 37 0 0 1-22.4 2.7c-5-.7-9.7-2-13.2-6.2Z"/></svg>`;

// ─── Error monitoring ───────────────────────────────────────────────
// The page is served from the edge as static HTML; the hero and artist portrait
// are CSS background-images (no `error` event), so a broken image would fail
// silently. This tiny client watches every <img> plus the background-image URLs
// and posts a Sentry event when one fails to load (T1-729 bug 3). It reuses the
// Art Whisper Sentry project via its public DSN (safe to embed — it's the same
// key shipped in the mobile app).
const SENTRY_INGEST =
  "https://o4510820807671808.ingest.us.sentry.io/api/4510900475592704/envelope/?sentry_key=e6024fe36e2671d1048f9c3b1c683f21&sentry_version=7";

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
.awmark{display:block;flex:none}
.eyebrow{font-family:var(--sans);font-weight:600;font-size:11px;letter-spacing:2px;display:block}
.eyebrow--muted{color:var(--t-label)}
.eyebrow--gold{color:var(--gold)}

/* Nav */
.nav{display:flex;align-items:center;justify-content:space-between;height:56px;
  padding:0 var(--pad);background:var(--surface);border-bottom:1px solid var(--border);}
.nav__brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--t-secondary);font-size:14px}
.nav__logo{border-radius:6px}
.nav__open{display:inline-flex;align-items:center;gap:6px;color:var(--gold);
  font-size:14px;font-weight:500;text-decoration:none}

/* Hero */
.hero{position:relative;height:min(700px,72vh);background:#141428 center/cover no-repeat;
  display:flex;align-items:flex-end;}
.hero__title{padding:0 var(--pad) 48px;max-width:1100px}
.hero__title h1{font-family:var(--serif);font-weight:700;font-size:64px;line-height:1.05;color:#fff;
  text-shadow:0 2px 24px rgba(0,0,0,.4)}
.hero__title p{margin:12px 0 0;color:rgba(255,255,255,.85);font-size:20px;letter-spacing:.5px}

/* Metadata bar */
.meta{display:flex;flex-wrap:wrap;gap:48px;padding:32px var(--pad);
  background:var(--surface);border-bottom:1px solid var(--border);}
.meta__cell{display:flex;flex-direction:column;gap:6px}
.meta__label{font-size:10px;font-weight:600;letter-spacing:1.5px;color:var(--t-label)}
.meta__val{font-size:15px;color:var(--t-body)}

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
.cta__mark{width:24px;height:24px;border-radius:6px;background:var(--gold);flex:none;
  display:flex;align-items:center;justify-content:center}
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
.pill{padding:8px 18px;border:1px solid var(--border);border-radius:20px;
  color:var(--gold);font-size:14px;font-weight:500;background:var(--surface)}

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
.foot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;
  padding:20px var(--pad);background:var(--band-light);border-top:1px solid var(--border);
  color:var(--t-label);font-size:13px}
.foot a{color:var(--t-label);text-decoration:none}
.foot a:hover{color:var(--gold)}

/* Mobile sticky bar (hidden on desktop) */
.stickybar{display:none}

/* Empty / not-found */
.empty{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:16px;text-align:center;padding:40px;max-width:520px;margin:0 auto}
.empty__logo{margin-bottom:8px}
.empty h1{font-family:var(--serif);font-weight:600;font-size:26px;color:var(--t-primary)}
.empty p{margin:0;color:var(--t-secondary);font-size:16px;line-height:1.5;max-width:420px}
.empty__cta{display:inline-flex;align-items:center;gap:8px;margin-top:8px;
  background:var(--cta);color:#fff;font-weight:600;font-size:16px;text-decoration:none;
  padding:14px 28px;border-radius:8px}
.empty__home{color:var(--t-label);font-size:14px;text-decoration:none}

/* ── Responsive ── */
@media (max-width:768px){
  :root{--pad:20px}
  .nav__open{display:none}
  .hero{height:min(360px,50vh)}
  .hero__title{padding:0 20px 28px}
  .hero__title h1{font-size:34px}
  .hero__title p{font-size:16px}
  .meta{gap:20px 40px;padding:24px 20px}
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
  .stickybar__logo{border-radius:8px}
  .stickybar .arr{color:var(--gold)}
}
`;
