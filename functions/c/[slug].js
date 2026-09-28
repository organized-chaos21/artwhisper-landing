// Cloudflare Pages Function: GET /c/{slug}
//
// Clean, tappable comment-to-DM link (Linear T1-886). Instagram does NOT linkify
// URLs that contain a query string in a DM (the `?`/`&`/`%` break its link
// detector), so the DM we send carries this bare path instead. We 302 to the
// artwork share page with the UTM attribution applied here — the reader gets a
// tappable link, and the campaign params still land on /a/{slug} for analytics.
export function onRequestGet({ params }) {
  const slug = String(params.slug || "");
  if (!/^[a-z0-9-]{1,140}$/i.test(slug)) {
    return Response.redirect("https://artwhisper.app/", 302);
  }
  const q = new URLSearchParams({
    utm_source: "instagram",
    utm_medium: "comment-dm",
    utm_campaign: "comment-dm",
    utm_content: slug,
  });
  return Response.redirect(`https://artwhisper.app/a/${slug}?${q.toString()}`, 302);
}
