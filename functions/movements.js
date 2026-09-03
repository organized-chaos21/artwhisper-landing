// Cloudflare Pages Function: GET /movements
//
// Public "Art Movements" index — an SEO hub that links every /movement/{slug}
// page (T1-834). Fixes the /movements 404 and strengthens internal linking so
// the individual movement pages index faster. Edge-rendered from the list
// endpoint GET /v1/movements. Mirrors the movement/artist page design system.

const API_BASE = "https://api.artwhisper.app";
const PLAY_URL =
  "https://play.google.com/store/apps/details?id=app.artwhisper&utm_source=movements&utm_medium=web&utm_campaign=movements_index";
const APP_STORE_URL =
  "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=movements-web";
const FETCH_TIMEOUT_MS = 5000;
const POSTHOG_KEY = "phc_d9QDyua38ePkoqG4KtR2Wa9XUasTPuvfVMJBJInE7eS";
const POSTHOG_HOST = "https://us.i.posthog.com";
const PAGE_URL = "https://artwhisper.app/movements";

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function cssUrl(u) {
  if (!u) return null;
  try { const p = new URL(u); if (p.protocol !== "https:" && p.protocol !== "http:") return null; } catch { return null; }
  return u.replace(/[\s"'()<>\\]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

export async function onRequestGet() {
  let movements = [];
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${API_BASE}/v1/movements`, { signal: controller.signal, headers: { accept: "application/json" } });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      movements = Array.isArray(data.movements) ? data.movements : [];
    }
  } catch {
    // Fall through to render whatever we have (possibly empty) — never hard-fail
    // the hub page; an empty grid still serves the nav + CTA.
  }

  // Cache 6h at the edge (the movement set changes rarely); no-store if the API
  // hiccuped and we got nothing, so a retry can repopulate.
  const maxAge = movements.length ? 21600 : 0;
  return html(renderPage(movements), 200, maxAge);
}

function html(body, status, maxAge) {
  const cache = maxAge > 0 ? `public, max-age=${Math.min(maxAge, 300)}, s-maxage=${maxAge}` : "no-store";
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" } });
}

const ARROW = `<svg class="arr" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
const CHEV_R = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;

function renderCard(m) {
  const c = cssUrl(m.image_url);
  const initials = String(m.name || "?").split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  const period = m.time_period ? `<span class="mcard__period">${esc(m.time_period)}</span>` : "";
  const pic = c
    ? `<span class="mcard__img" style="background-image:url('${c}')"></span>`
    : `<span class="mcard__img mcard__img--ph">${esc(initials)}</span>`;
  return `<a class="mcard" href="/movement/${esc(m.slug)}">
    ${pic}
    <span class="mcard__body">
      <span class="mcard__name">${esc(m.name || "Movement")}</span>
      ${period}
    </span>
    <span class="mcard__go">${CHEV_R}</span>
  </a>`;
}

function schema(movements) {
  const o = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Art Movements",
    description: "An illustrated index of art movements across history — explore each with Art Whisper.",
    url: PAGE_URL,
    isPartOf: { "@type": "WebSite", name: "Art Whisper", url: "https://artwhisper.app" },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: movements.length,
      itemListElement: movements.slice(0, 100).map((m, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: m.name,
        url: `https://artwhisper.app/movement/${m.slug}`,
      })),
    },
  };
  return `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
}

function renderPage(movements) {
  const count = movements.length;
  const metaDesc = `Explore ${count} art movements across history — from their origins and key characteristics to the works that define them. A visual index from Art Whisper.`;
  const cards = movements.map(renderCard).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Art Movements${count ? ` — ${count} Movements Across History` : ""} · Art Whisper</title>
  <meta name="description" content="${esc(metaDesc)}" />
  <link rel="canonical" href="${PAGE_URL}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Art Whisper" />
  <meta property="og:title" content="Art Movements · Art Whisper" />
  <meta property="og:description" content="${esc(metaDesc)}" />
  <meta property="og:url" content="${PAGE_URL}" />
  <meta name="twitter:card" content="summary" />
  ${schema(movements)}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="alternate icon" href="/favicon.ico" type="image/png" />
  <link rel="apple-touch-icon" href="/favicon.ico" />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap" rel="stylesheet" />
  <style>${STYLES}</style>
</head>
<body>
  <header class="nav">
    <a class="nav__brand" href="https://artwhisper.app"><img class="nav__logo" src="/logo.png" alt="Art Whisper" width="30" height="30" /><span>Art Whisper</span></a>
    <a class="nav__open" href="${PLAY_URL}" target="_blank" rel="noopener"><span class="nav__open-lg">Open in Art Whisper</span><span class="nav__open-sm">Open the App</span> ${ARROW}</a>
  </header>

  <section class="mhero">
    <span class="eyebrow eyebrow--gold">EXPLORE</span>
    <h1>Art Movements</h1>
    <p class="mhero__line">${count ? `${count} movements across history — from Gothic altarpieces to Abstract Expressionism. Tap any to explore its story, key characteristics, and defining works.` : "Explore the movements that shaped art history."}</p>
  </section>

  ${cards ? `<section class="mgrid-wrap"><div class="mgrid">${cards}</div></section>` : `<section class="mempty"><p>Movements are loading — please refresh in a moment.</p></section>`}

  <section class="band cta">
    <div class="cta__left"><img class="cta__mark" src="/logo.png" alt="" width="26" height="26" /><span>Point your camera at any artwork and Art Whisper tells you its story</span></div>
    <div class="badges">
      <a class="badge" href="${PLAY_URL}" target="_blank" rel="noopener" aria-label="Get Art Whisper on Google Play"><img src="/badges/google-play.svg" alt="Get it on Google Play" height="44" /></a>
      <a class="badge" href="${APP_STORE_URL}" target="_blank" rel="noopener" aria-label="Download Art Whisper on the App Store"><img src="/badges/app-store.svg" alt="Download on the App Store" height="44" /></a>
    </div>
  </section>

  <footer class="foot"><span>© ${new Date().getFullYear()} Bright Star. All rights reserved.</span></footer>

  <a class="stickybar" href="${PLAY_URL}" target="_blank" rel="noopener">
    <span class="stickybar__left"><img class="stickybar__logo" src="/logo.png" alt="" width="32" height="32" /><strong>Open the App</strong></span>${ARROW}
  </a>

  ${analyticsScript(count)}
</body>
</html>`;
}

function analyticsScript(count) {
  const cfg = JSON.stringify({ key: POSTHOG_KEY, host: POSTHOG_HOST, count });
  return `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags identify setPersonProperties group resetGroups reset get_distinct_id getGroups get_session_id captureException opt_in_capturing opt_out_capturing".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  var D=${cfg};
  try{ posthog.init(D.key,{api_host:D.host,capture_pageview:true});
    posthog.capture("movements_index_view",{count:D.count}); }catch(e){}
</script>`;
}

const STYLES = `
:root{--bg:#FAF8F5;--surface:#FFFFFF;--band-light:#F5F3F0;--card:#F8F7F5;--border:#E8E4DF;--line:#F0F0F0;--gold:#D4882C;--cta:#EF9F27;--t-primary:#1A1A1A;--t-body:#3D3D3D;--t-secondary:#6B6B6B;--t-label:#999999;--t-sub:#8A8175;--serif:'Lora',Georgia,serif;--sans:'DM Sans',system-ui,-apple-system,sans-serif;--pad:80px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--t-body);font-family:var(--sans);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}a{color:inherit;text-decoration:none}h1{margin:0}
.eyebrow{font-weight:600;font-size:11px;letter-spacing:2px;display:block}.eyebrow--gold{color:var(--gold)}
.nav{display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 var(--pad);background:var(--surface);border-bottom:1px solid var(--border)}
.nav__brand{display:flex;align-items:center;gap:10px;color:var(--t-secondary);font-size:14px}.nav__logo{border-radius:50%;display:block}.nav__brand span{color:var(--t-primary);font-weight:600;font-size:15px}
.nav__open{display:inline-flex;align-items:center;gap:6px;color:var(--gold);font-size:14px;font-weight:500}.nav__open-sm{display:none}
.mhero{padding:56px var(--pad) 40px;background:var(--band-light);border-bottom:1px solid var(--border)}
.mhero .eyebrow{margin-bottom:12px}
.mhero h1{font-family:var(--serif);font-weight:700;font-size:46px;line-height:1.05;color:var(--t-primary)}
.mhero__line{margin:14px 0 0;max-width:680px;color:var(--t-secondary);font-size:17px;line-height:1.6}
.mgrid-wrap{padding:44px var(--pad) 52px}
.mgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.mcard{display:flex;flex-direction:column;position:relative;background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;transition:box-shadow .2s,transform .2s}
.mcard:hover{box-shadow:0 10px 28px rgba(26,20,13,.10);transform:translateY(-2px)}
.mcard__img{height:190px;background:#E8E4DF center/cover no-repeat;display:flex;align-items:center;justify-content:center}
.mcard__img--ph{background:linear-gradient(135deg,#EDE7DF,#E2D8C9);color:var(--t-sub);font-family:var(--serif);font-weight:600;font-size:40px}
.mcard__body{display:flex;flex-direction:column;gap:4px;padding:16px 18px 18px}
.mcard__name{font-family:var(--serif);font-weight:600;font-size:19px;line-height:1.25;color:var(--t-primary)}
.mcard__period{font-size:13px;color:var(--t-secondary)}
.mcard__go{position:absolute;top:14px;right:14px;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.92);color:var(--gold);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(26,20,13,.14);opacity:0;transition:opacity .2s}
.mcard:hover .mcard__go{opacity:1}
.mempty{padding:80px var(--pad);text-align:center;color:var(--t-secondary)}
.band{padding:0 var(--pad)}
.cta{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;background:var(--band-light);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:18px var(--pad)}
.cta__left{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:500;color:var(--t-body)}.cta__mark{width:26px;height:26px;border-radius:50%;flex:none;display:block}
.badges{display:flex;align-items:center;gap:12px}.badge{display:inline-flex;transition:opacity .15s ease}.badge:hover{opacity:.85}.badge img{height:44px;width:auto;display:block}
.foot{display:flex;align-items:center;padding:20px var(--pad);background:var(--band-light);border-top:1px solid var(--border);color:var(--t-label);font-size:13px}
.stickybar{display:none}
@media (max-width:900px){.mgrid{grid-template-columns:repeat(2,1fr)}}
@media (max-width:768px){:root{--pad:20px}
  .nav__open-lg{display:none}.nav__open-sm{display:inline}
  .mhero{padding:36px 20px 28px}.mhero h1{font-size:34px}.mhero__line{font-size:15.5px}
  .mgrid-wrap{padding:28px 20px 36px}.mgrid{grid-template-columns:1fr;gap:16px}
  .mcard__img{height:200px}
  .cta{padding:20px}.badges{width:100%;justify-content:center;flex-wrap:wrap}.badge img{height:48px}
  .foot{padding:20px}body{padding-bottom:56px}
  .stickybar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:20;align-items:center;justify-content:space-between;height:56px;padding:0 16px;background:var(--surface);border-top:1px solid var(--border);box-shadow:0 -2px 12px rgba(0,0,0,.08);color:var(--t-primary)}
  .stickybar__left{display:flex;align-items:center;gap:10px;font-size:14px}.stickybar__left strong{font-weight:600}.stickybar__logo{border-radius:50%}.stickybar .arr{color:var(--gold)}
}
`;
