# T1-706 — Finalize iOS store presence (landing site)

**TL;DR:** iOS app is live on the App Store (`id6785215327`). Update the landing site to treat iPhone as shipped: remove the "coming soon" waitlist feature entirely, point CTAs at the right store per device, drop stale "coming soon" copy, and add an App Store link at the bottom. Linear: T1-706.

**App Store URL:** `https://apps.apple.com/us/app/art-whisper/id6785215327`
**Play URL (existing):** `https://play.google.com/store/apps/details?id=app.artwhisper`

**Decisions (confirmed with Ziv):**
- Waitlist: remove **everything** in-repo (modal, Pages Function, D1 binding, migration). Live D1 data persists in Cloudflare until manually dropped — Ziv exports/emails signups separately.
- CTAs: **smart single button** (App Store on iOS, Play otherwise) on Header + Hero; **both badges** in the bottom Download section; App Store link added to Footer.

---

## Phase 1 — Remove the waitlist feature ✅
- [ ] Delete `src/components/sections/IosWaitlistModal.astro`
- [ ] Delete `src/lib/iosWaitlist.js`
- [ ] Delete `functions/api/subscribe.js`
- [ ] Delete `migrations/0001_signups.sql` (and the `migrations/` dir if now empty)
- [ ] `BaseLayout.astro`: remove modal import, `<IosWaitlistModal />`, and `initIosWaitlist()` wiring
- [ ] `wrangler.toml`: remove the `[[d1_databases]]` binding + its explanatory comments
- [ ] Remove the stale `ios-waitlist-modal.plan.md` at repo root

## Phase 2 — Smart store link by user-agent ✅
- [ ] Add a tiny client-side helper that, on iOS, rewrites the "Get the App" CTA hrefs (Header + Hero) to the App Store URL; leaves Play on other devices
- [ ] Reuse the existing iOS detection logic (incl. iPadOS-as-desktop) that lived in the deleted `iosWaitlist.js`
- [ ] Header + Hero CTAs: default href = Play (works for non-JS / non-iOS), keep UTM params; drop `data-ios-modal` / `data-source` attributes
- [ ] Wire the helper in `BaseLayout.astro` (replacing the removed waitlist init)

## Phase 3 — Remove "Coming soon to iPhone" copy ✅
- [ ] Hero: remove `Coming soon to iPhone` tagline line
- [ ] DownloadCTA: update subhead ("On Android now. iPhone coming soon." → live-on-both copy)
- [ ] DownloadCTA: replace the disabled "COMING SOON / iPhone" badge with a real App Store link badge

## Phase 4 — Remove iPhone FAQ entry ✅
- [ ] `src/data/faqs.js`: remove the "When will it be on iPhone?" question/answer

## Phase 5 — iOS store link at the bottom ✅
- [ ] DownloadCTA (bottom section): both store badges (App Store + Google Play), styled consistently
- [ ] Footer: add an "App Store" link alongside existing footer links/social

## Phase 6 — Verify ✅
- [ ] `npm run build` (Astro) succeeds, no broken imports
- [ ] Grep for residual `waitlist` / `ios-modal` / `coming soon` references — none remain
- [ ] Spot-check rendered `dist/` for the App Store URL in Header/Hero fallback, bottom section, footer
- [ ] Update docs if the repo tracks any; note removed endpoint (`/api/subscribe`)
