export function initSectionAnimations() {
  if (typeof window === 'undefined') return;

  const sections = document.querySelectorAll('[data-animate="section"]');
  if (!sections.length) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    sections.forEach(s => s.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    {
      threshold: 0.15,
      rootMargin: '0px 0px -10% 0px'
    }
  );

  sections.forEach(section => observer.observe(section));
}

export function initStickyHeader() {
  if (typeof window === 'undefined') return;

  const header = document.querySelector('.site-header');
  if (!header) return;

  window.addEventListener('scroll', () => {
    header.classList.toggle('is-scrolled', window.scrollY > 100);
  }, { passive: true });
}
