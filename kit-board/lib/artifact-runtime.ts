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
    if (table.parentElement?.matches('.table-scroll, .observatory-table-scroll, .table-wrap')) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'observatory-table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Scrollable report table');
    table.before(wrapper);
    wrapper.append(table);
  });
  // Older reports pin a tab strip; Carbon reports, and older audits laid out as Carbon's, pin a top bar.
  const nav = document.querySelector('.tabs-shell, .topbar');
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
      // Capability tabs keep their own list in view, below the pinned bar.
      const list = tab.matches('[data-cap-tab]') ? tab.closest('.capability-workbench') : null;
      const top = list ? list.getBoundingClientRect().top + window.scrollY - (nav?.offsetHeight ?? 0) - 16 : nav?.offsetTop;
      if (top !== undefined && viewportTop > top) send({type:'observatory:scroll', top:Math.max(0, top)});
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
