# iOS "Coming Soon" Waitlist Modal — Implementation Plan

**Overall Progress:** `100%`

> Linear: **T1-616** (this feature) · **T1-627** (Privacy Policy follow-up, out of scope here)

## TLDR
On the static Astro landing site, detect iOS visitors by user-agent. For them, the three existing "Get the App" CTAs (Header, Hero, DownloadCTA) open an accessible modal instead of redirecting to Google Play. The modal collects an email + required consent and stores it in a Cloudflare D1 table via a same-origin Pages Function, so we can notify those users when the iPhone app ships. Non-iOS behavior is unchanged.

## Critical Decisions
- **iOS gating, behavior-only:** CTAs keep their wording and their Google-Play `href` (no-JS fallback); on iOS, JS intercepts the click. — minimal markup change, zero regression for Android/desktop.
- **Modal lives once in `BaseLayout`:** rendered globally, wired via `src/lib/iosWaitlist.js` (mirrors the existing `motion.js` pattern). — single source, no per-section duplication.
- **Storage = Cloudflare D1 + Pages Function (`functions/api/subscribe.js`):** same-origin POST, no API key in browser, no third-party account. — simplest "just store it" that stays on the existing Cloudflare stack.
- **`UNIQUE(email)` + duplicate-as-success:** re-submits return success ("already on the list"). — clean idempotency, no error noise.
- **D1 binding declared in `wrangler.toml`:** in-repo, reproducible. — avoids dashboard-only config drift.
- **Styling from landing tokens** (`tokens.css`: Playfair/Inter, accent `#EF9F27`), matching the approved Pencil frames (default + success). — visual consistency with the site, not the app.

## Dependencies
- [ ] **Working tree restored** — `src/`, `public/`, `package.json` are deleted on disk (present in git `HEAD`). Run `git restore .` before anything else.
- [ ] **Cloudflare D1 database** created on the account (`wrangler d1 create`) and its `database_id` pasted into `wrangler.toml` — requires Cloudflare auth (user-run).
- [ ] **Wrangler CLI** available for local Functions testing (`wrangler pages dev`) — `astro dev` alone does NOT run Pages Functions.
- [ ] No new npm packages (vanilla JS + Pages Functions runtime).

## Implementation Steps

### Phase 0: Prep
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 0.1 | `git restore .` to bring back deleted working-tree files | 🟩 | Restored; on branch `feat/ios-waitlist-modal` |
| 0.2 | Baseline `npm ci && npm run build` succeeds | 🟩 | `node_modules` was incomplete → `npm ci` reinstalled; build green (3 pages) |

### Phase 1: Backend — D1 + Pages Function
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 1.1 | Add `wrangler.toml` — `pages_build_output_dir = "dist"`, `[[d1_databases]]` binding `DB`, `migrations_dir` | 🟩 | `database_id` placeholder pending 1.4 |
| 1.2 | Add D1 migration `migrations/0001_signups.sql` — `signups(id INTEGER PK, email TEXT UNIQUE NOT NULL, consent INTEGER, source TEXT, created_at TEXT)` | 🟩 | |
| 1.3 | Create `functions/api/subscribe.js` — POST-only; honeypot reject; validate email + consent required; `INSERT OR IGNORE` into D1; JSON `{ok:true}` / `{ok:false,error}`; 405 on other methods | 🟩 | Single `onRequest` w/ method check |
| 1.4 | `wrangler d1 create artwhisper-signups` + apply migration; paste `database_id` into `wrangler.toml` | 🟩 | id `d1d2295…`; local migration applied. **Remote apply pending pre-deploy:** `wrangler d1 migrations apply artwhisper-signups --remote` |
| 1.5 | Update `.github/workflows/deploy.yml` for `wrangler.toml` (reconcile positional `dist`/`--project-name`/`--branch` with `pages_build_output_dir`) | 🟩 | Now `pages deploy --branch=master` |

### Phase 2: Frontend — Modal + iOS wiring
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 2.1 | Create `src/components/sections/IosWaitlistModal.astro` — backdrop + `role="dialog"` card; eyebrow/headline/body, email input, honeypot field, required consent checkbox + `/privacy` link, submit; default + success + inline error regions; token-based scoped styles per Pencil | 🟩 | |
| 2.2 | Render `<IosWaitlistModal />` once in `BaseLayout.astro`; import + call `initIosWaitlist()` in the layout `<script>` next to motion init | 🟩 | |
| 2.3 | Add `data-ios-modal` + `data-source` to the 3 CTAs: `Header.astro`, `Hero.astro` (via Button passthrough), `DownloadCTA.astro` badge | 🟩 | Verified all 3 in built HTML |
| 2.4 | Create `src/lib/iosWaitlist.js` — iOS UA detect (iPhone/iPad/iPod + iPadOS touch-Mac); if iOS, intercept tagged CTA clicks (`preventDefault` → open w/ source); open/close with focus trap, Esc, backdrop click, scroll-lock, focus restore, reduced-motion; submit → `fetch('/api/subscribe')` → success/error states | 🟩 | |

### Phase 3: Integration & Verification
| Step | Description | Status | Notes |
|------|-------------|--------|-------|
| 3.1 | Local test via `wrangler pages dev`: iOS UA → modal opens (all 3 CTAs); submit → row in D1; duplicate email → success; desktop/Android → Google Play unchanged | 🟩 | **Endpoint** verified: valid→200, dup→200 (1 row), bad email→400, no consent→400, GET→405, honeypot→200 no-store. **Browser/iOS-UA click path → `/test-feature`** |
| 3.2 | Accessibility pass — focus trap, Esc/backdrop close, scroll lock, `aria-modal`/labelledby, `prefers-reduced-motion`, honeypot hidden from AT | 🟩 | Built-in; honeypot excluded from focus trap; motion zeroed via tokens |
| 3.3 | `npm run build` clean; final self-review of diff | 🟩 | Build green (3 pages) |

## Rollback Plan
If something goes wrong:
1. Revert the feature commit/branch (all changes are additive: new `functions/`, new modal component, new `lib/iosWaitlist.js`, `wrangler.toml`, plus 3 small CTA edits + BaseLayout include).
2. Remove `data-ios-modal` hooks → CTAs immediately revert to plain Google-Play links.
3. The D1 database is independent; deleting it or removing the binding disables the endpoint without affecting the static site.

## Success Criteria
- [ ] iOS visitors: every "Get the App" CTA opens the modal instead of going to Google Play.
- [ ] Non-iOS visitors: all CTAs behave exactly as before (Google Play).
- [ ] Valid email + checked consent → stored in D1; success state shown; duplicate submit → success, single row.
- [ ] Invalid email / unchecked consent → inline error, no submission; honeypot blocks bots.
- [ ] Modal is keyboard-accessible (trap, Esc) and respects reduced motion.
- [ ] `npm run build` passes; no regressions to existing sections.
- [ ] Privacy Policy update handled separately in T1-627 (not in this PR).
