// Points the single "Get the App" CTAs at the right store per device.
//
// The server-rendered href is Google Play, which is correct for Android and
// Windows/Linux desktop and still works with JavaScript disabled. On any
// Apple platform — iPhone, iPad, and macOS desktop — we rewrite each CTA
// tagged with `data-store-cta` to the App Store listing. The bottom Download
// section shows both store badges explicitly and is left untouched.

const APP_STORE_URL = 'https://apps.apple.com/us/app/art-whisper/id6785215327';

/**
 * Detect Apple platforms: iPhone/iPad/iPod, iPadOS (a desktop-Mac UA with
 * touch), and macOS desktop. Mac visitors are in the Apple ecosystem, so the
 * single "Get the App" CTA should send them to the App Store, not Google Play.
 */
function isApplePlatform() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const mac = /Mac/.test(platform) || /Mac OS X/.test(ua); // covers macOS + iPadOS
  return iOS || mac;
}

export function initAppLinks() {
  if (typeof document === 'undefined' || !isApplePlatform()) return;

  document.querySelectorAll('[data-store-cta]').forEach((el) => {
    // `ct` is Apple's campaign-token param, surfaced in App Store Analytics.
    const campaign = el.dataset.storeCta || 'landing';
    el.href = `${APP_STORE_URL}?ct=${encodeURIComponent('landing-' + campaign)}`;
    el.setAttribute('aria-label', 'Get Art Whisper on the App Store');
  });
}
