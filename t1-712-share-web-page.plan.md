# T1-712 — Share scanned artwork, Phase 3: web preview page (`/a/{slug}`)

**TL;DR:** Build the public web preview page at `artwhisper.app/a/{slug}` (Linear **T1-712**, Phase 3 of T1-328). Shared links currently 404 and show a generic preview icon; this page unblocks promoting the in-app Share button (T1-711) to the Play **production** track. Server-rendered, on-brand immersive page that unfurls with the per-artwork share card, plus a "Get the app" CTA and a graceful 404.

## Architecture decision
- The landing site is a **static Astro build** on Cloudflare Pages, with dynamic bits as **Pages Functions** (`functions/api/subscribe.js`). `/a/{slug}` is dynamic and needs **server-rendered OG tags** (link crawlers don't run JS) → implement as a **Pages Function** `functions/a/[slug].js`. No Astro SSR adapter (that would emit `_worker.js` and disable the existing `functions/` dir). Coexists cleanly with the static site + subscribe function.
- Data source: `GET https://api.artwhisper.app/v1/artworks/{slug}` (public, accepts slug; shape confirmed against live "The Bedroom").
- OG image: `https://api.artwhisper.app/v1/artworks/{id}/share-card.png` (Phase 1, 1200×630).
- CTA convention (matches existing site): **Google Play = live link**, **iOS = "Coming soon" badge (no dead App Store link)**.
- Design: Pencil "Share Web" lane — `Share Web — Desktop` / `Share Web — Mobile` (V2), tokens `$share-*` (cream/light, Lora + DM Sans).

## Phases

### Phase 1 — Pages Function scaffold + data fetch 🟢
- [x] `functions/a/[slug].js` with `onRequestGet`, slug validation, timed `fetch` to backend, error/404 branching.

### Phase 2 — Render the immersive page 🟢
- [x] Hero (artwork image + gradient + title/subtitle), Metadata bar (medium/dimensions/location), Pull quote (quick_context), CTA band, About (about paragraphs), Art Movements pills, What to Notice cards (+lock CTA for extras), Audio Deep Dive teaser, Artist card, Report/footer.
- [x] Full OG/Twitter meta (title, description=curiosity hook, image=share-card, url).
- [x] Responsive: desktop nav link + mobile sticky bottom bar; section padding + hero height + card grid adapt.
- [x] HTML-escape all dynamic content.

### Phase 3 — Graceful 404 / not-found 🟢
- [x] Branded not-found page (app icon, on-brand copy, Get-the-app CTA), HTTP 404, short cache.

### Phase 4 — Verify 🟢
- [x] `wrangler pages dev dist` (after build) → load `/a/the-bedroom-vincent-van-gogh` (real) and a bogus slug (404); check OG tags + no layout break.

### Phase 5 — Docs 🟢
- [x] Obsidian KB issue note `T1-712-share-web-page.md` + MOC pointer.

## Out of scope
Phase 4 deep linking (App Links / Universal Links); v2 referral loop, A/B cards, sitemap for `/a/*`.
