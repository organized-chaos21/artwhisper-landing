// Cloudflare Pages Function: GET /g/{slug}
//
// Clean, tappable "get the app" link for comment-to-DM (Linear T1-886). Like /c,
// this exists so the DM link has no query string (Instagram won't linkify those).
// Device-aware:
//   Android → Play Store with an install `referrer` carrying BOTH the deferred
//     deep-link destination (dl_type/dl_slug, per T1-877 → the app opens on that
//     artwork after install) AND comment-dm campaign attribution.
//   iOS → App Store with a campaign token (no install-referrer on iOS).
export function onRequestGet({ params, request }) {
  const slug = String(params.slug || "");
  const valid = /^[a-z0-9-]{1,140}$/i.test(slug) && slug !== "home";
  const ua = request.headers.get("user-agent") || "";

  if (/iphone|ipad|ipod/i.test(ua)) {
    return Response.redirect(
      "https://apps.apple.com/us/app/art-whisper/id6785215327?ct=comment-dm",
      302,
    );
  }

  const ref = new URLSearchParams();
  if (valid) {
    ref.set("dl_type", "artwork"); // deferred deep link → open this artwork post-install
    ref.set("dl_slug", slug);
  }
  ref.set("utm_source", "instagram");
  ref.set("utm_medium", "comment-dm");
  ref.set("utm_campaign", "comment-dm");
  if (valid) ref.set("utm_content", slug);

  return Response.redirect(
    "https://play.google.com/store/apps/details?id=app.artwhisper&referrer=" +
      encodeURIComponent(ref.toString()),
    302,
  );
}
