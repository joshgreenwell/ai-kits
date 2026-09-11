// Only layout coordinates cross the sandbox boundary. Report code still has no
// access to the portal DOM, cookies, storage, APIs, or other reports.
export const artifactRuntime = String.raw`
(() => {
  const embedded = window.parent !== window;
  if (!embedded) return;
  document.documentElement.classList.add('observatory-embedded');
  let pending = 0;
  let lastHeight = 0;
  let viewportTop = 0;
  let connected = false;
  const send = (message) => window.parent.postMessage(message, '*');
  const measure = () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const height = Math.ceil(document.body.getBoundingClientRect().height) + 2;
      if (height !== lastHeight) { lastHeight = height; send({type:'observatory:height', height}); }
    });
  };
  // Unwrapped evidence tables need a local horizontal scroller, rather than
  // increasing the width of the entire report. Preserve the table semantics.
  document.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.matches('.table-scroll, .observatory-table-scroll')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'observatory-table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Scrollable report table');
    table.before(wrapper);
    wrapper.append(table);
  });
  const nav = document.querySelector('.tabs-shell');
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'observatory:viewport') return;
    const {top, height} = event.data;
    if (!Number.isFinite(top) || !Number.isFinite(height)) return;
    if (!connected) { connected = true; lastHeight = 0; measure(); }
    viewportTop = Math.max(0, top);
    document.documentElement.style.setProperty('--hub-viewport-height', Math.max(200, height) + 'px');
    if (nav) {
      const shift = Math.max(0, Math.min(viewportTop - nav.offsetTop, document.body.offsetHeight - nav.offsetTop - nav.offsetHeight));
      nav.style.setProperty('--hub-nav-shift', shift + 'px');
    }
  });
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-main-tab], [data-cap-tab]');
    if (tab) requestAnimationFrame(() => {
      measure();
      // Keep the selected report section in view when a shorter tab replaces a
      // long one, including when its navigation was pinned during page scroll.
      if (nav && viewportTop > nav.offsetTop) send({type:'observatory:scroll', top:nav.offsetTop});
    });
    const link = event.target.closest('a[href^="#"]');
    if (link) requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (!target) return;
      for (let node = target.parentElement; node; node = node.parentElement) {
        if (node.tagName === 'DETAILS') node.open = true;
      }
      measure();
      send({type:'observatory:scroll', top:Math.max(0, target.getBoundingClientRect().top + window.scrollY - (nav?.offsetHeight ?? 0) - 16)});
    }));
  });
  new ResizeObserver(measure).observe(document.body);
  document.fonts.ready.then(measure);
  window.addEventListener('load', measure);
  measure();
})();
`;
