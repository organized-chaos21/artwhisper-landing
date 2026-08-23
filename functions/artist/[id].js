// Cloudflare Pages Function: GET /artist/{id}
//
// Public, LIMITED artist page (Linear T1-813). The Key-Artist links on the
// movement pages point here. Deliberately limited (portrait, dates, short bio,
// a few works + influences) with the deep content gated to the app — the app
// pull stays at the artist level. Edge-rendered from GET /v1/artists/{id}.

const API_BASE = "https://api.artwhisper.app";
const PLAY_URL =
  "https://play.google.com/store/apps/details?id=app.artwhisper&utm_source=artist&utm_medium=web&utm_campaign=artist_page";
const APP_STORE_URL =
  "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=artist-web";
const FETCH_TIMEOUT_MS = 5000;
const POSTHOG_KEY = "phc_d9QDyua38ePkoqG4KtR2Wa9XUasTPuvfVMJBJInE7eS";
const POSTHOG_HOST = "https://us.i.posthog.com";
const SENTRY_INGEST =
  "https://o4510820807671808.ingest.us.sentry.io/api/4510900475592704/envelope/?sentry_key=e6024fe36e2671d1048f9c3b1c683f21&sentry_version=7";
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const clip = (s, n) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};
function cssUrl(u) {
  if (!u) return null;
  try { const p = new URL(u); if (p.protocol !== "https:" && p.protocol !== "http:") return null; } catch { return null; }
  return u.replace(/[\s"'()<>\\]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

export async function onRequestGet(context) {
  const id = String(context.params.id || "");
  if (!ID_RE.test(id)) return html(renderNotFound(), 404, 60);
  let data;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${API_BASE}/v1/artists/${encodeURIComponent(id)}`, { signal: controller.signal, headers: { accept: "application/json" } });
    clearTimeout(timer);
    if (res.status === 404) return html(renderNotFound(), 404, 60);
    if (!res.ok) return html(renderNotFound(), 502, 0);
    data = await res.json();
  } catch { return html(renderNotFound(), 502, 0); }
  if (!data || !data.artist) return html(renderNotFound(), 404, 60);

  // Canonicalize to the pretty slug URL (T1-818): a UUID request, or a stale
  // ref that resolved via the alias map, 301-redirects to /artist/{slug}. This
  // consolidates SEO signals on one URL and keeps old links working.
  const canonical = data.meta && data.meta.canonical_slug;
  if (canonical && canonical !== id) {
    return new Response(null, {
      status: 301,
      headers: {
        location: `https://artwhisper.app/artist/${encodeURIComponent(canonical)}`,
        "cache-control": "public, max-age=300, s-maxage=86400",
      },
    });
  }

  return html(renderPage(data, canonical || id), 200, 3600);
}

function html(body, status, maxAge) {
  const cache = maxAge > 0 ? `public, max-age=${Math.min(maxAge, 300)}, s-maxage=${maxAge}` : "no-store";
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" } });
}

const ARROW = `<svg class="arr" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
const CHEV_R = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
const LOCK = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const EXPAND = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
const CLOSE = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function renderPage(data, id) {
  const a = data.artist || {};
  const name = a.name || "Artist";
  const first = String(name).split(/\s+/)[0];
  const dates = [a.birth_year, a.death_year].filter(Boolean).join("–");
  const line = [dates, a.nationality].filter(Boolean).join(" · ");
  const portrait = a.image_url_large || a.image_url || null;
  const pc = cssUrl(portrait);
  const initials = String(name).split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  const oneLiner = a.one_liner || "";
  const bio = clip(a.bio || a.biography || "", 480);
  const works = Array.isArray(a.notable_works) ? a.notable_works : [];
  const infBy = (a.influences && Array.isArray(a.influences.influenced_by)) ? a.influences.influenced_by : [];
  const infd = (a.influences && Array.isArray(a.influences.influenced)) ? a.influences.influenced : [];
  const tags = Array.isArray(a.movement_tags) ? a.movement_tags.filter((t) => t && t.id) : [];

  const pageUrl = `https://artwhisper.app/artist/${esc(id)}`;
  const metaDesc = clip(oneLiner || bio || `${name}${line ? " (" + line + ")" : ""} — biography, notable works, and influences.`, 180);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(name)}${dates ? ` (${esc(dates)})` : ""} · Art Whisper</title>
  <meta name="description" content="${esc(metaDesc)}" />
  <link rel="canonical" href="${pageUrl}" />
  <meta property="og:type" content="profile" />
  <meta property="og:site_name" content="Art Whisper" />
  <meta property="og:title" content="${esc(name)}${dates ? ` (${esc(dates)})` : ""}" />
  <meta property="og:description" content="${esc(metaDesc)}" />
  ${portrait ? `<meta property="og:image" content="${esc(portrait)}" />` : ""}
  <meta property="og:url" content="${pageUrl}" />
  <meta name="twitter:card" content="summary" />
  ${schema(a, name, metaDesc, pageUrl, portrait)}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="alternate icon" href="/favicon.ico" type="image/png" />
  <link rel="apple-touch-icon" href="/favicon.ico" />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&display=swap" rel="stylesheet" />
  <style>${STYLES}</style>
</head>
<body>
  <header class="nav">
    <a class="nav__brand" href="https://artwhisper.app"><img class="nav__logo" src="/logo.png" alt="Art Whisper" width="30" height="30" /><span>Art Whisper</span></a>
    <a class="nav__open" href="${PLAY_URL}" target="_blank" rel="noopener"><span class="nav__open-lg">Open in Art Whisper</span><span class="nav__open-sm">Open the App</span> ${ARROW}</a>
  </header>

  <section class="ahero">
    ${pc ? `<button class="ahero__picwrap" type="button" aria-label="View full portrait" data-full="${esc(pc)}" data-title="${esc(name)}" data-by="${esc(line)}"><span class="ahero__pic" style="background-image:url('${pc}')"></span><span class="ahero__zoom">${EXPAND}</span></button>` : `<span class="ahero__pic ahero__pic--ph">${esc(initials)}</span>`}
    <div class="ahero__id">
      <span class="eyebrow eyebrow--gold">ARTIST</span>
      <h1>${esc(name)}</h1>
      ${line ? `<p class="ahero__line">${esc(line)}</p>` : ""}
      ${tags.length ? `<div class="pills">${tags.slice(0, 3).map((t) => `<a class="pill" href="/movement/${esc(t.id)}">${esc(t.name || "Movement")} ${CHEV_R}</a>`).join("")}</div>` : ""}
    </div>
  </section>

  ${oneLiner ? `<section class="sec"><p class="lead">${esc(oneLiner)}</p></section>` : ""}

  ${bio ? `<section class="sec bio">
    <span class="eyebrow eyebrow--muted">ABOUT</span>
    <p>${esc(bio)}</p>
    <a class="gatecta" href="${PLAY_URL}" target="_blank" rel="noopener">${LOCK}<span>Read ${esc(first)}'s full story in Art Whisper</span> ${ARROW}</a>
  </section>` : ""}

  ${renderWorks(works, first)}
  ${renderInfluences(infBy, infd)}

  <section class="band cta">
    <div class="cta__left"><img class="cta__mark" src="/logo.png" alt="" width="26" height="26" /><span>Explore ${esc(first)} and thousands of artists in Art Whisper</span></div>
    <div class="badges">
      <a class="badge" href="${PLAY_URL}" target="_blank" rel="noopener" aria-label="Get Art Whisper on Google Play"><img src="/badges/google-play.svg" alt="Get it on Google Play" height="44" /></a>
      <a class="badge" href="${APP_STORE_URL}" target="_blank" rel="noopener" aria-label="Download Art Whisper on the App Store"><img src="/badges/app-store.svg" alt="Download on the App Store" height="44" /></a>
    </div>
  </section>

  <footer class="foot"><span>© ${new Date().getFullYear()} Bright Star. All rights reserved.</span></footer>

  <a class="stickybar" href="${PLAY_URL}" target="_blank" rel="noopener">
    <span class="stickybar__left"><img class="stickybar__logo" src="/logo.png" alt="" width="32" height="32" /><strong>Open the App</strong></span>${ARROW}
  </a>

  <div class="lightbox" id="awlb" hidden>
    <button class="lb__close" type="button" aria-label="Close">${CLOSE}</button>
    <figure class="lb__fig">
      <img class="lb__img" alt="" />
      <figcaption class="lb__cap">
        <strong class="lb__t"></strong>
        <span class="lb__b"></span>
      </figcaption>
    </figure>
  </div>

  ${analyticsScript(id, name)}
  ${lightboxScript(id)}
  ${monitorScript(id, [{ kind: "portrait", url: portrait }])}
</body>
</html>`;
}

function renderWorks(works, first) {
  if (!works.length) return "";
  const shown = works.slice(0, 6);
  const remaining = works.length - shown.length;
  const cards = shown.map((w) => {
    const c = cssUrl(w.image_url);
    const meta = [w.year, w.museum_name].filter(Boolean).join(" · ");
    return `<a class="wcard" href="/a/${esc(w.id)}">
      <span class="wcard__img"${c ? ` style="background-image:url('${c}')"` : ""}></span>
      <span class="wcard__t">${esc(w.title || "")}</span>
      ${meta ? `<span class="wcard__m">${esc(meta)}</span>` : ""}
    </a>`;
  }).join("");
  const gate = remaining > 0
    ? `<a class="gatecta" href="${PLAY_URL}" target="_blank" rel="noopener">${LOCK}<span>See all of ${esc(first)}'s works in Art Whisper</span> ${ARROW}</a>`
    : "";
  return `<section class="sec works"><span class="eyebrow eyebrow--muted">NOTABLE WORKS</span><div class="wgrid">${cards}</div>${gate}</section>`;
}

function renderInfluences(by, infd) {
  const chip = (p) => `<a class="ichip" href="/artist/${esc(p.slug || p.artist_id)}"><strong>${esc(p.name || "")}</strong>${p.movement ? `<span>${esc(p.movement)}</span>` : ""} ${CHEV_R}</a>`;
  const cols = [];
  if (by.length) cols.push(`<div class="icol"><span class="icol__h">Influenced by</span><div class="ichips">${by.slice(0, 4).filter((p) => p.artist_id).map(chip).join("")}</div></div>`);
  if (infd.length) cols.push(`<div class="icol"><span class="icol__h">Influenced</span><div class="ichips">${infd.slice(0, 4).filter((p) => p.artist_id).map(chip).join("")}</div></div>`);
  if (!cols.length) return "";
  return `<section class="sec influences"><span class="eyebrow eyebrow--muted">INFLUENCES</span><div class="igrid">${cols.join("")}</div></section>`;
}

function schema(a, name, desc, url, img) {
  const o = {
    "@context": "https://schema.org", "@type": "Person", name, description: desc, url,
    ...(img ? { image: img } : {}),
    ...(a.birth_year ? { birthDate: String(a.birth_year) } : {}),
    ...(a.death_year ? { deathDate: String(a.death_year) } : {}),
    ...(a.nationality ? { nationality: a.nationality } : {}),
    jobTitle: "Artist",
  };
  const s = (x) => JSON.stringify(x).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${s(o)}</script>`;
}

function renderNotFound() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Artist not found · Art Whisper</title><meta name="robots" content="noindex" /><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600&family=Lora:wght@600&display=swap" rel="stylesheet" /><style>${STYLES}</style></head><body><main class="empty"><img class="empty__logo" src="/logo.png" alt="Art Whisper" width="60" height="60" /><h1>This artist isn't available</h1><p>The link may be mistyped. Explore artists, movements, and thousands of works in the app.</p><a class="empty__cta" href="${PLAY_URL}" target="_blank" rel="noopener">Get the app ${ARROW}</a><a class="empty__home" href="https://artwhisper.app">Back to artwhisper.app</a></main></body></html>`;
}

function analyticsScript(id, name) {
  const cfg = JSON.stringify({ key: POSTHOG_KEY, host: POSTHOG_HOST, id, name });
  return `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags identify setPersonProperties group resetGroups reset get_distinct_id getGroups get_session_id captureException opt_in_capturing opt_out_capturing".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  var D=${cfg};
  try{ posthog.init(D.key,{api_host:D.host,capture_pageview:true});
    posthog.capture("artist_page_view",{artist_id:D.id,artist:D.name}); }catch(e){}
  window.__awTrack=function(ev,props){try{posthog.capture(ev,Object.assign({artist_id:D.id,artist:D.name},props||{}))}catch(e){}};
</script>`;
}

function lightboxScript(id) {
  return `<script>(function(){
  var lb=document.getElementById("awlb"); if(!lb) return;
  var img=lb.querySelector(".lb__img"),t=lb.querySelector(".lb__t"),b=lb.querySelector(".lb__b");
  var btn=document.querySelector(".ahero__picwrap"); if(!btn) return;
  function open(){
    var full=btn.getAttribute("data-full")||""; if(!full) return;
    img.src=full; img.alt=btn.getAttribute("data-title")||"";
    t.textContent=btn.getAttribute("data-title")||"";
    b.textContent=btn.getAttribute("data-by")||"";
    lb.hidden=false; document.documentElement.style.overflow="hidden";
    try{ if(window.__awTrack) window.__awTrack("artist_portrait_expand",{artist_id:${JSON.stringify(id)}}); }catch(e){}
  }
  function close(){ lb.hidden=true; document.documentElement.style.overflow=""; img.removeAttribute("src"); }
  btn.addEventListener("click",open);
  lb.addEventListener("click",function(e){ if(e.target===lb || e.target.closest(".lb__close")) close(); });
  document.addEventListener("keydown",function(e){ if(e.key==="Escape" && !lb.hidden) close(); });
})();</script>`;
}

function monitorScript(id, bgImages) {
  const cfg = JSON.stringify({ id, ingest: SENTRY_INGEST, bg: bgImages.filter((b) => b && b.url) });
  return `<script>(function(){
  var D=${cfg};
  function eid(){var a=new Uint8Array(16);if(self.crypto&&crypto.getRandomValues){crypto.getRandomValues(a)}return Array.prototype.map.call(a,function(b){return("0"+b.toString(16)).slice(-2)}).join("")}
  function report(kind,url){try{
    var id=eid();
    var env=JSON.stringify({event_id:id,sent_at:new Date().toISOString()})+"\\n"+JSON.stringify({type:"event"})+"\\n"+JSON.stringify({event_id:id,level:"error",platform:"javascript",logger:"artist-web",message:"Artist page image failed to load ("+kind+")",tags:{surface:"artist-web",artist_id:D.id,image:kind},request:{url:location.href},extra:{image_url:url||null}});
    if(navigator.sendBeacon){navigator.sendBeacon(D.ingest,new Blob([env],{type:"application/x-sentry-envelope"}))}else{fetch(D.ingest,{method:"POST",body:env,keepalive:true,mode:"no-cors"})}
  }catch(e){}}
  Array.prototype.forEach.call(document.images||[],function(img){img.addEventListener("error",function(){report("img:"+(img.getAttribute("alt")||"")||img.src,img.currentSrc||img.src)})});
  D.bg.forEach(function(o){var im=new Image();im.onerror=function(){report(o.kind,o.url)};im.src=o.url})
})();</script>`;
}

const STYLES = `
:root{--bg:#FAF8F5;--surface:#FFFFFF;--band-light:#F5F3F0;--card:#F8F7F5;--border:#E8E4DF;--line:#F0F0F0;--gold:#D4882C;--cta:#EF9F27;--t-primary:#1A1A1A;--t-body:#3D3D3D;--t-secondary:#6B6B6B;--t-label:#999999;--t-sub:#8A8175;--serif:'Lora',Georgia,serif;--sans:'DM Sans',system-ui,-apple-system,sans-serif;--pad:80px}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--t-body);font-family:var(--sans);font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}
img{max-width:100%;display:block}a{color:inherit;text-decoration:none}h1,h2{margin:0}
.eyebrow{font-weight:600;font-size:11px;letter-spacing:2px;display:block}.eyebrow--muted{color:var(--t-label)}.eyebrow--gold{color:var(--gold)}
.nav{display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 var(--pad);background:var(--surface);border-bottom:1px solid var(--border)}
.nav__brand{display:flex;align-items:center;gap:10px;color:var(--t-secondary);font-size:14px}.nav__logo{border-radius:50%;display:block}.nav__brand span{color:var(--t-primary);font-weight:600;font-size:15px}
.nav__open{display:inline-flex;align-items:center;gap:6px;color:var(--gold);font-size:14px;font-weight:500}.nav__open-sm{display:none}
/* artist hero */
.ahero{display:flex;align-items:center;gap:32px;padding:52px var(--pad);background:var(--band-light);border-bottom:1px solid var(--border)}
.ahero__pic{width:132px;height:132px;border-radius:50%;flex:none;background:#E8E4DF center/cover no-repeat;display:flex;align-items:center;justify-content:center;color:var(--t-secondary);font-weight:600;font-size:40px;box-shadow:0 4px 18px rgba(26,20,13,.12)}
.ahero__picwrap{position:relative;flex:none;padding:0;border:0;background:none;cursor:zoom-in}
.ahero__zoom{position:absolute;right:-2px;bottom:-2px;width:32px;height:32px;border-radius:50%;background:var(--gold);color:#fff;display:flex;align-items:center;justify-content:center;border:2px solid var(--band-light);box-shadow:0 2px 8px rgba(26,20,13,.18);transition:transform .15s}
.ahero__picwrap:hover .ahero__zoom{transform:scale(1.08)}
.ahero__id h1{font-family:var(--serif);font-weight:700;font-size:44px;line-height:1.05;color:var(--t-primary)}
.ahero__line{margin:8px 0 0;color:var(--t-secondary);font-size:17px}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.pill{display:inline-flex;align-items:center;gap:4px;padding:6px 14px;border:1px solid var(--border);border-radius:20px;background:var(--surface);color:var(--gold);font-size:13px;font-weight:500}
.sec{padding:44px var(--pad);background:var(--bg)}.sec .eyebrow{margin-bottom:16px}
.lead{margin:0;font-family:var(--serif);font-style:italic;font-size:24px;line-height:1.5;color:var(--t-primary);max-width:900px}
.bio p{margin:0;max-width:820px;font-size:16.5px;line-height:1.75;color:var(--t-body)}
.gatecta{display:inline-flex;align-items:center;gap:8px;margin-top:18px;color:var(--gold);font-size:14px;font-weight:500}
.wgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.wcard{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:box-shadow .2s}.wcard:hover{box-shadow:0 6px 20px rgba(26,20,13,.08)}
.wcard__img{height:180px;background:#E8E4DF center/cover no-repeat}
.wcard__t{padding:14px 16px 2px;font-family:var(--serif);font-weight:600;font-size:16px;color:var(--t-primary)}
.wcard__m{padding:0 16px 16px;font-size:13px;color:var(--t-secondary)}
.igrid{display:grid;grid-template-columns:1fr 1fr;gap:32px;max-width:900px}
.icol__h{display:block;font-size:13px;font-weight:600;color:var(--t-secondary);margin-bottom:12px}
.ichips{display:flex;flex-direction:column;gap:8px}
.ichip{display:flex;align-items:center;gap:8px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:10px;transition:box-shadow .2s}.ichip:hover{box-shadow:0 3px 12px rgba(26,20,13,.07)}
.ichip strong{font-size:14.5px;color:var(--t-primary)}.ichip span{font-size:12.5px;color:var(--t-sub);margin-left:auto;margin-right:2px}.ichip svg{color:var(--gold)}
.band{padding:0 var(--pad)}
.cta{display:flex;align-items:center;justify-content:space-between;gap:24px;flex-wrap:wrap;background:var(--band-light);border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:18px var(--pad)}
.cta__left{display:flex;align-items:center;gap:12px;font-size:14px;font-weight:500;color:var(--t-body)}.cta__mark{width:26px;height:26px;border-radius:50%;flex:none;display:block}
.badges{display:flex;align-items:center;gap:12px}.badge{display:inline-flex;transition:opacity .15s ease}.badge:hover{opacity:.85}.badge img{height:44px;width:auto;display:block}
.foot{display:flex;align-items:center;padding:20px var(--pad);background:var(--band-light);border-top:1px solid var(--border);color:var(--t-label);font-size:13px}
.lightbox{position:fixed;inset:0;z-index:100;background:rgba(12,10,8,.93);display:flex;align-items:center;justify-content:center;padding:40px}
.lightbox[hidden]{display:none}
.lb__close{position:absolute;top:18px;right:20px;width:42px;height:42px;border:0;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .2s}
.lb__close:hover{background:rgba(255,255,255,.24)}
.lb__fig{margin:0;display:flex;flex-direction:column;align-items:center;gap:16px;max-width:94vw}
.lb__img{max-width:94vw;max-height:80vh;width:auto;height:auto;object-fit:contain;border-radius:4px;box-shadow:0 16px 60px rgba(0,0,0,.55);background:#1a1a1a}
.lb__cap{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;color:#fff}
.lb__t{font-family:var(--serif);font-size:18px;font-weight:600}
.lb__b{font-size:13px;color:rgba(255,255,255,.68)}
.stickybar{display:none}
.empty{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;text-align:center;padding:40px;max-width:520px;margin:0 auto}
.empty__logo{margin-bottom:8px;border-radius:50%}.empty h1{font-family:var(--serif);font-weight:600;font-size:26px;color:var(--t-primary)}
.empty p{margin:0;color:var(--t-secondary);font-size:16px;line-height:1.5;max-width:420px}
.empty__cta{display:inline-flex;align-items:center;gap:8px;margin-top:8px;background:var(--cta);color:#fff;font-weight:600;font-size:16px;padding:14px 28px;border-radius:8px}.empty__home{color:var(--t-label);font-size:14px}
@media (max-width:768px){:root{--pad:20px}
  .nav__open-lg{display:none}.nav__open-sm{display:inline}
  .ahero{flex-direction:column;text-align:center;gap:18px;padding:36px 20px}.ahero__pic{width:104px;height:104px;font-size:32px}.ahero__id h1{font-size:32px}.pills{justify-content:center}
  .sec{padding:30px 20px}.lead{font-size:20px}
  .wgrid{grid-template-columns:1fr}.igrid{grid-template-columns:1fr;gap:22px}
  .cta{padding:20px}.badges{width:100%;justify-content:center;flex-wrap:wrap}.badge img{height:48px}
  .foot{padding:20px}body{padding-bottom:56px}
  .stickybar{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:20;align-items:center;justify-content:space-between;height:56px;padding:0 16px;background:var(--surface);border-top:1px solid var(--border);box-shadow:0 -2px 12px rgba(0,0,0,.08);color:var(--t-primary)}
  .stickybar__left{display:flex;align-items:center;gap:10px;font-size:14px}.stickybar__left strong{font-weight:600}.stickybar__logo{border-radius:50%}.stickybar .arr{color:var(--gold)}
}
`;
