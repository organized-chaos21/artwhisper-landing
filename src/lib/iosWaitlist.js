// iOS waitlist modal controller (Linear T1-616).
//
// On iOS only, intercepts the "Get the App" CTAs (tagged with
// `data-ios-modal`) and opens the waitlist modal instead of letting them
// redirect to Google Play. Handles open/close accessibility (focus trap,
// Esc, backdrop, scroll lock, focus restore) and the email submission to
// the same-origin /api/subscribe Pages Function.
//
// Non-iOS visitors: this does nothing — the CTAs stay plain Play links.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';
// Matches the modal's CSS transition so we hide it only after the fade-out.
const CLOSE_MS = 220;

/** Detect iOS, including iPadOS which reports as a desktop Mac with touch. */
function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iPhoneish = /iPad|iPhone|iPod/.test(ua);
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iPhoneish || iPadOS;
}

export function initIosWaitlist() {
  if (typeof document === 'undefined' || !isIOS()) return;

  const root = document.querySelector('[data-ios-modal-root]');
  if (!root) return;

  const dialog = root.querySelector('.ios-modal__dialog');
  const form = root.querySelector('[data-ios-modal-form]');
  const errorEl = root.querySelector('[data-ios-modal-error]');
  const submitBtn = root.querySelector('[data-ios-modal-submit]');
  const formView = root.querySelector('[data-ios-modal-view="form"]');
  const successView = root.querySelector('[data-ios-modal-view="success"]');
  const emailInput = form.querySelector('input[name="email"]');

  let lastFocused = null;
  let prevOverflow = '';

  const showError = (msg) => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    emailInput.setAttribute('aria-invalid', 'true');
  };

  const clearError = () => {
    errorEl.hidden = true;
    emailInput.removeAttribute('aria-invalid');
  };

  function open(source) {
    // Reset to a clean form every time the modal is opened.
    form.reset();
    clearError();
    formView.hidden = false;
    successView.hidden = true;
    root.dataset.source = source || '';

    lastFocused = document.activeElement;
    root.hidden = false;
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => root.classList.add('is-open'));
    emailInput.focus();
  }

  function close() {
    root.classList.remove('is-open');
    document.body.style.overflow = prevOverflow;
    window.setTimeout(() => {
      root.hidden = true;
    }, CLOSE_MS);
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  }

  /** Keep Tab focus cycling inside the dialog while it's open. */
  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null
    );
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Wire the CTAs: on iOS, open the modal instead of navigating.
  document.querySelectorAll('[data-ios-modal]').forEach((trigger) => {
    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      open(trigger.dataset.source);
    });
  });

  // Close affordances: any [data-ios-modal-close] element, backdrop, Esc.
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target.closest('[data-ios-modal-close]')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    if (e.key === 'Escape') close();
    else trapFocus(e);
  });

  // Submit the email to the Pages Function.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const email = emailInput.value.trim();
    const consent = form.querySelector('input[name="consent"]').checked;
    const company = form.querySelector('input[name="company"]').value; // honeypot

    if (!EMAIL_RE.test(email)) {
      showError('Please enter a valid email address.');
      emailInput.focus();
      return;
    }
    if (!consent) {
      showError('Please tick the box so we can let you know.');
      return;
    }

    submitBtn.disabled = true;
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, consent, company, source: root.dataset.source }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        formView.hidden = true;
        successView.hidden = false;
        successView.querySelector('[data-ios-modal-close]').focus();
      } else {
        showError(data.error || 'Something went wrong. Please try again.');
      }
    } catch {
      showError('Network error. Please check your connection and try again.');
    } finally {
      submitBtn.disabled = false;
    }
  });
}
