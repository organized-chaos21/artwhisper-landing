// Points the single "Get the App" CTAs at the right store per device.
//
// The server-rendered href is Google Play, which is correct for Android and
// desktop and still works with JavaScript disabled. On iOS/iPadOS we rewrite
// any CTA tagged with `data-store-cta` to the App Store listing. The bottom
// Download section shows both store badges explicitly and is left untouched.

const APP_STORE_URL = 'https://apps.apple.com/us/app/art-whisper/id6785215327';

/** Detect iOS, including iPadOS which reports as a desktop Mac with touch. */
function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iPhoneish = /iPad|iPhone|iPod/.test(ua);
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iPhoneish || iPadOS;
}

export function initAppLinks() {
  if (typeof document === 'undefined' || !isIOS()) return;

  document.querySelectorAll('[data-store-cta]').forEach((el) => {
    // `ct` is Apple's campaign-token param, surfaced in App Store Analytics.
    const campaign = el.dataset.storeCta || 'landing';
    el.href = `${APP_STORE_URL}?ct=${encodeURIComponent('landing-' + campaign)}`;
    el.setAttribute('aria-label', 'Get Art Whisper on the App Store');
  });
}
