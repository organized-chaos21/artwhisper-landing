// Cloudflare Pages Function: GET /artworks-sitemap.xml
//
// Serves the artwork-pages sitemap under artwhisper.app (same host as the URLs it
// lists — Google requires that). The document itself is query-driven off the live
// DB by the backend; we just proxy it here so the sitemap lives on the marketing
// host alongside the hand-committed movements-sitemap.xml. See Linear T1-817.

const API_BASE = "https://api.artwhisper.app";
const FETCH_TIMEOUT_MS = 5000;

export async function onRequestGet() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(`${API_BASE}/v1/sitemap/artworks.xml`, {
      signal: controller.signal,
      headers: { accept: "application/xml" },
    });
    clearTimeout(timer);
    if (!res.ok) return new Response("", { status: 502 });
    const body = await res.text();
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        // Short browser cache, long edge cache — the source refreshes daily.
        "cache-control": "public, max-age=300, s-maxage=86400",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new Response("", { status: 502 });
  }
}
