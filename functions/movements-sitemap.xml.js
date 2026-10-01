// Cloudflare Pages Function: GET /movements-sitemap.xml
//
// The art-movement pages sitemap, built from the live public movement list
// (GET /v1/movements) so a newly added movement is listed automatically. It used
// to be a hand-committed static file, which silently missed new movements (T1-909).
// Same host as the URLs it lists (Google requires that), like the artist and
// artwork sitemaps (T1-817).

const API_BASE = "https://api.artwhisper.app";
const FETCH_TIMEOUT_MS = 5000;
const SITE = "https://artwhisper.app";
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function onRequestGet() {
  try {
    const res = await fetch(`${API_BASE}/v1/movements`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return new Response("", { status: 502 });
    const data = await res.json();
    const slugs = (Array.isArray(data?.movements) ? data.movements : [])
      .map((m) => m && m.slug)
      .filter((s) => typeof s === "string" && SLUG_RE.test(s))
      .sort();
    if (!slugs.length) return new Response("", { status: 502 });
    const urls = [
      `  <url><loc>${SITE}/movements</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`,
      ...slugs.map((s) => `  <url><loc>${SITE}/movement/${s}</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>`),
    ];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "public, max-age=300, s-maxage=86400",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("", { status: 502 });
  }
}
