// Routes the single "Get the App" CTAs to the right destination per device.
//
// The server-rendered href is Google Play, which is correct for Android and
// works with JavaScript disabled. At runtime we refine it:
//   - Apple platforms (iPhone, iPad, iPadOS, macOS desktop) → the App Store.
//   - Android → left as Google Play.
//   - Other desktop (Windows, Linux, ChromeOS) → we can't tell which phone the
//     visitor owns, so instead of guessing a store we send them to the bottom
//     Download section, which shows both App Store + Google Play badges.

const APP_STORE_URL = 'https://apps.apple.com/us/app/art-whisper/id6785215327';

/**
 * Detect Apple platforms: iPhone/iPad/iPod, iPadOS (a desktop-Mac UA with
 * touch), and macOS desktop. Mac visitors are in the Apple ecosystem, so the
 * single "Get the App" CTA should send them to the App Store, not Google Play.
 */
function isApplePlatform() {
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const mac = /Mac/.test(platform) || /Mac OS X/.test(ua); // covers macOS + iPadOS
  return iOS || mac;
}

export function initAppLinks() {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return;

  const ctas = document.querySelectorAll('[data-store-cta]');
  if (!ctas.length) return;

  // Apple → App Store.
  if (isApplePlatform()) {
    ctas.forEach((el) => {
      // `ct` is Apple's campaign-token param, surfaced in App Store Analytics.
      const campaign = el.dataset.storeCta || 'landing';
      el.href = `${APP_STORE_URL}?ct=${encodeURIComponent('landing-' + campaign)}`;
      el.setAttribute('aria-label', 'Get Art Whisper on the App Store');
    });
    return;
  }

  // Android → keep the server-rendered Google Play href.
  if (/Android/i.test(navigator.userAgent || '')) return;

  // Other desktop (Windows/Linux/ChromeOS) → don't guess a store; point at the
  // both-badges Download section instead. `/#download` also works cross-page
  // (privacy/terms) and as a no-JS fallback; on the home page we smooth-scroll.
  const target = document.getElementById('download');
  ctas.forEach((el) => {
    el.setAttribute('href', '/#download');
    el.removeAttribute('target');
    el.removeAttribute('rel');
    if (target) {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  });
}
