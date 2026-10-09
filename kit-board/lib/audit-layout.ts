// An audit report drawn in the older tabbed design is laid out in the board as the Carbon audit
// template is: a frosted top bar that links to every section, a page header, the score card, and
// the sections stacked on one page, with findings as rows that open on demand. The report keeps
// its own content, anchors, search and scripts. Reports already drawn on the template are untouched.

const printIcon = 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z';
const searchIcon = 'M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z';

/** True for the tabbed audit design: a report header, a tab strip, and panels keyed by tab. */
export function isTabbedAudit(html: string) {
  return /class=["']report-header["']/.test(html) && /class=["']tabs-shell["']/.test(html) && /\bdata-main-panel=/.test(html);
}

export const auditLayoutStyle = `<style data-personal-hub-audit>
html.observatory-audit { --bar-h: 56px; scroll-padding-top: calc(var(--bar-h) + 20px); }
@media (prefers-reduced-motion: no-preference) { html.observatory-audit { scroll-behavior: smooth; } }
html.observatory-audit body { font: 400 14px/1.55 var(--body); }
html.observatory-audit [hidden]:not([data-main-panel]) { display: none !important; }
html.observatory-audit main [id] { scroll-margin-top: 0; }
html.observatory-audit .observatory-sr { position: absolute !important; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
html.observatory-audit .ico { width: 16px; height: 16px; flex-shrink: 0; }

/* Top bar */
html.observatory-audit .topbar { position: sticky; top: 0; z-index: 40; margin: 0; padding: 0; background: var(--bar-glass) !important; -webkit-backdrop-filter: blur(40px) saturate(1.3); backdrop-filter: blur(40px) saturate(1.3); border: 0; border-bottom: 1px solid var(--border-glass); box-shadow: 0 8px 24px -18px var(--shadow-flyout); }
html.observatory-audit .topbar-in { box-sizing: border-box; max-width: 1180px; height: var(--bar-h); margin: 0 auto; padding: 0 24px; display: flex; align-items: center; gap: 20px; }
html.observatory-audit .brand { display: flex; align-items: center; min-width: 0; max-width: 220px; flex-shrink: 0; color: var(--content-primary) !important; text-decoration: none !important; }
html.observatory-audit .brand-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 13px/16px var(--body); letter-spacing: -.01em; }
html.observatory-audit .section-nav { flex: 1; min-width: 0; display: flex; gap: 2px; padding: 2px; overflow-x: auto; scrollbar-width: none; border: 0; }
html.observatory-audit .section-nav::-webkit-scrollbar { display: none; }
html.observatory-audit .section-nav a { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border-radius: 8px; font: 500 12.5px/1 var(--body); color: var(--content-muted) !important; text-decoration: none !important; white-space: nowrap; transition: background-color .15s, color .15s; }
html.observatory-audit .section-nav a:hover { color: var(--content-primary) !important; background: var(--fill-control); }
html.observatory-audit .section-nav a[aria-current="true"] { color: var(--content-primary) !important; background: var(--fill-emphasis); box-shadow: inset 0 0 0 1px var(--border-glass); }
html.observatory-audit .section-nav .n { font: 400 10.5px var(--mono); color: var(--content-muted); font-variant-numeric: tabular-nums; }
html.observatory-audit .bar-tools { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
html.observatory-audit .icon-btn { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 8px; background: none; color: var(--content-muted); cursor: pointer; transition: background-color .15s, color .15s; }
html.observatory-audit .icon-btn .ico { width: 15px; height: 15px; }
html.observatory-audit .icon-btn:hover { background: var(--fill-control); color: var(--content-primary); }

/* Page and sections */
html.observatory-audit main.page { box-sizing: border-box; width: 100% !important; max-width: 1180px !important; min-height: 0 !important; margin: 0 auto !important; padding: 44px 24px 120px !important; display: grid; gap: 64px; }
html.observatory-audit [data-main-panel], html.observatory-audit [data-main-panel][hidden] { display: grid !important; gap: 16px; min-width: 0; margin: 0; padding: 0; border: 0; background: none; animation: none; }
html.observatory-audit [data-main-panel] > * { min-width: 0; margin-top: 0; margin-bottom: 0; }
html.observatory-audit .page-header { display: grid; gap: 8px; padding-bottom: 4px; }
html.observatory-audit .page-header > * { margin: 0; }
html.observatory-audit .eyebrow { font: 400 11px var(--mono); letter-spacing: 0; text-transform: none; color: var(--content-muted); }
html.observatory-audit .page-header h1 { font: 600 30px/1.15 var(--body); letter-spacing: -.03em; text-wrap: balance; color: var(--content-primary); }
html.observatory-audit .page-header .desc { max-width: 80ch; margin-top: 4px; font-size: 14.5px; line-height: 1.65; color: var(--content-secondary); }
html.observatory-audit .header-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
html.observatory-audit .header-meta span { display: inline-block; max-width: 100%; padding: 4px 10px; border: 1px solid var(--border-glass); border-radius: 13px; background: var(--panel); font: 400 11px/16px var(--mono); color: var(--content-muted); overflow-wrap: anywhere; }
html.observatory-audit .header-meta b { font-weight: 500; color: var(--content-primary); }
html.observatory-audit .section-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 16px; margin: 0; padding: 0; border: 0; }
html.observatory-audit .section-head h2 { margin: 0; font: 600 19px/1.3 var(--body); letter-spacing: -.02em; color: var(--content-primary); }
html.observatory-audit .section-head p { max-width: 80ch; margin: 6px 0 0; font-size: 14px; line-height: 1.65; color: var(--content-secondary); }
html.observatory-audit :is(.lbl, .record-label) { display: block; margin: 0; font: 500 10px/1.3 var(--body); letter-spacing: .09em; text-transform: uppercase; color: var(--content-muted); }

/* Glass panels */
html.observatory-audit :is(.card, .content-card, .score-detail, .finding-domain, .capability-panel, .rows, .table-scroll, .observatory-table-scroll, .capability-tabs) {
  box-sizing: border-box; min-width: 0; margin: 0;
  background: var(--panel) !important; border: 1px solid var(--border-glass) !important; border-radius: 14px !important;
  -webkit-backdrop-filter: blur(24px) saturate(1.2); backdrop-filter: blur(24px) saturate(1.2);
  box-shadow: inset 0 1px 0 var(--sheen), 0 18px 40px -28px var(--shadow-flyout) !important;
}
html.observatory-audit :is(.card, .content-card, .score-detail, .finding-domain, .capability-panel) { display: grid; gap: 16px; padding: 22px 24px; }
html.observatory-audit :is(.card, .content-card, .score-detail, .finding-domain, .capability-panel) > * { min-width: 0; margin-top: 0; margin-bottom: 0; }
html.observatory-audit :is(.card, .content-card, .score-detail, .finding-domain, .capability-panel, details) :is(.card, .content-card, .score-detail, .finding-domain, .capability-panel, .rows, .table-scroll, .observatory-table-scroll) {
  background: var(--fill-subtle) !important; -webkit-backdrop-filter: none; backdrop-filter: none; box-shadow: none !important; border-radius: 12px !important;
}
html.observatory-audit :is(.section-heading, .domain-heading) { display: grid !important; grid-template-columns: minmax(0, 1fr) !important; gap: 6px; align-items: start; margin: 0; padding: 0; border: 0; }
html.observatory-audit :is(.section-heading, .domain-heading) h2 { margin: 0; font: 600 16px/1.35 var(--body); letter-spacing: -.015em; color: var(--content-primary); }
html.observatory-audit :is(.section-heading, .domain-heading) :is(p, .section-note) { margin: 0; max-width: 90ch; font-size: 13px; line-height: 1.6; color: var(--content-secondary); }
html.observatory-audit :is(.content-card, .capability-panel, .finding-domain) > p { max-width: 90ch; font-size: 13.5px; line-height: 1.6; color: var(--content-secondary); }

/* Score card */
html.observatory-audit .hero { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 24px 36px; align-items: start; padding: 28px 30px; }
html.observatory-audit .hero > div > * { margin: 0; }
html.observatory-audit .score-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-top: 10px !important; }
html.observatory-audit .score-num { font: 600 72px/1 var(--body); letter-spacing: -.045em; font-variant-numeric: tabular-nums; color: var(--content-primary); }
html.observatory-audit .score-den { font: 400 20px var(--mono); color: var(--content-muted); }
html.observatory-audit .score-line .badge { align-self: center; height: 24px; padding: 0 9px; font-size: 12px; line-height: 22px; }
html.observatory-audit .hero-side { display: grid; gap: 12px; align-content: start; padding-left: 30px; border-left: 1px solid var(--border-glass); }
html.observatory-audit .hero-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 20px; margin: 0; }
html.observatory-audit .hero-facts dt { font: 500 10px/1.3 var(--body); letter-spacing: .09em; text-transform: uppercase; color: var(--content-muted); }
html.observatory-audit .hero-facts dd { display: grid; gap: 2px; margin: 4px 0 0; font: 600 17px/1.3 var(--body); letter-spacing: -.01em; font-variant-numeric: tabular-nums; color: var(--content-primary); overflow-wrap: anywhere; }
html.observatory-audit .hero-facts dd small { font: 400 12px/1.5 var(--body); letter-spacing: 0; color: var(--content-muted); }

/* Stat strip */
html.observatory-audit .finding-counts { box-sizing: border-box; display: grid !important; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0; margin: 0; padding: 0; overflow: hidden; background: var(--panel) !important; border: 1px solid var(--border-glass) !important; border-radius: 14px; -webkit-backdrop-filter: blur(24px) saturate(1.2); backdrop-filter: blur(24px) saturate(1.2); box-shadow: inset 0 1px 0 var(--sheen), 0 18px 40px -28px var(--shadow-flyout); }
html.observatory-audit .finding-count { display: grid; gap: 4px; align-content: start; margin: -1px 0 0 -1px; padding: 14px 16px; border: 0; border-left: 1px solid var(--border-glass); border-top: 1px solid var(--border-glass); border-radius: 0; background: none !important; box-shadow: none; }
html.observatory-audit .finding-count span { font: 500 10px/1.3 var(--body); letter-spacing: .09em; text-transform: uppercase; color: var(--content-muted); }
html.observatory-audit .finding-count strong { font: 600 22px/1.2 var(--body); letter-spacing: -.02em; font-variant-numeric: tabular-nums; color: var(--content-primary); }
html.observatory-audit .finding-count-critical strong { color: var(--red); }
html.observatory-audit .finding-count-high strong { color: var(--orange); }

/* Badges */
html.observatory-audit .badge { --tone: var(--content-muted); box-sizing: border-box; display: inline-block; width: auto; height: 20px; padding: 0 7px; border: 1px solid color-mix(in srgb, var(--tone) 28%, transparent); border-radius: 6px; background: color-mix(in srgb, var(--tone) 10%, transparent); color: var(--tone); font: 500 11px/18px var(--body); letter-spacing: 0; text-transform: none; white-space: nowrap; vertical-align: middle; }
html.observatory-audit .badge::first-letter { text-transform: uppercase; }
html.observatory-audit .b-destructive { --tone: var(--red); }
html.observatory-audit .b-high { --tone: var(--orange); }
html.observatory-audit .b-warning { --tone: var(--amber); }
html.observatory-audit .b-info { --tone: var(--blue); }
html.observatory-audit .b-soft { --tone: var(--green); }
html.observatory-audit .b-secondary { --tone: var(--content-muted); background: var(--fill-subtle); border-color: var(--border-interactive); }
html.observatory-audit :is(.badge-row, .score-meta, .row-aside) { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }

/* Findings and checks as rows */
html.observatory-audit .rows { display: block; padding: 0; overflow: hidden; }
html.observatory-audit .finding-card.row { box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: flex-start; gap: 6px 16px; margin: 0; padding: 13px 18px; border: 0 !important; border-bottom: 1px solid var(--border-glass) !important; border-radius: 0; background: none; box-shadow: none; transition: background-color .12s; }
html.observatory-audit .finding-card.row:last-child { border-bottom: 0 !important; }
html.observatory-audit .finding-card.row:hover { background: var(--fill-subtle); }
html.observatory-audit .row.tone-destructive { box-shadow: inset 2px 0 0 var(--red); background: color-mix(in srgb, var(--red) 4%, transparent); }
html.observatory-audit .row.tone-high { box-shadow: inset 2px 0 0 var(--orange); background: color-mix(in srgb, var(--orange) 4%, transparent); }
html.observatory-audit .row-main { flex: 1 1 360px; min-width: 0; display: grid; gap: 4px; }
html.observatory-audit .row-title { font-size: 13.5px; font-weight: 500; line-height: 1.45; color: var(--content-primary); }
html.observatory-audit .row-title .fid { display: inline; margin: 0 8px 0 0; padding: 0; border: 0; background: none; font: 400 11.5px var(--mono); letter-spacing: 0; color: var(--content-muted); }
html.observatory-audit .row-title :is(h3, h4) { display: inline; margin: 0; font: inherit !important; letter-spacing: 0; color: inherit; }
html.observatory-audit .row-detail { margin: 0; font: 400 12px/1.5 var(--body); color: var(--content-muted); }
html.observatory-audit .row-aside { margin-left: auto; }
html.observatory-audit .row > details.disc { flex: 1 0 100%; }
html.observatory-audit .row .finding-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 24px; margin: 0; padding: 0; border: 0; background: none; }
html.observatory-audit .row .finding-body > section { margin: 0; padding: 0; border: 0; background: none; }

/* Fields and disclosures */
html.observatory-audit .capability-fields { gap: 16px 24px; }
html.observatory-audit .capability-field { display: grid; gap: 4px; align-content: start; margin: 0; padding: 0; border: 0; background: none; box-shadow: none; }
html.observatory-audit :is(.capability-field, .finding-body section) h4 { margin: 0; font: 500 10px/1.3 var(--body) !important; letter-spacing: .09em; text-transform: uppercase; color: var(--content-muted); }
html.observatory-audit :is(.capability-field, .finding-body section) p { margin: 0; font-size: 13px; line-height: 1.6; color: var(--content-secondary); }
html.observatory-audit main details { margin: 0; padding: 0; background: none !important; border: 0 !important; box-shadow: none; }
html.observatory-audit main details > summary { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; margin: 0 0 0 -8px; padding: 0 8px; border: 0; border-radius: 7px; background: none; font: 500 12px/1.4 var(--body) !important; letter-spacing: 0; text-transform: none; color: var(--content-muted); cursor: pointer; list-style: none; user-select: none; transition: background-color .12s, color .12s; }
html.observatory-audit main details > summary::-webkit-details-marker { display: none; }
html.observatory-audit main details > summary::before { content: "\\203A"; display: inline-block; width: 10px; font-size: 15px; line-height: 1; text-align: center; transition: transform .15s; }
html.observatory-audit main details[open] > summary::before { transform: rotate(90deg); }
html.observatory-audit main details > summary:hover { background: var(--fill-control); color: var(--content-primary); }
html.observatory-audit main details[open] > :not(summary) { margin-top: 10px; }
html.observatory-audit .disc-body { display: grid; gap: 14px; min-width: 0; }
html.observatory-audit .disc-body > * { min-width: 0; margin-top: 0; margin-bottom: 0; }

/* Search */
html.observatory-audit .search { position: relative; display: block; width: 100%; max-width: 420px; margin: 0; }
html.observatory-audit .search .ico { position: absolute; left: 10px; top: 50%; translate: 0 -50%; width: 14px; height: 14px; color: var(--content-muted); pointer-events: none; }
html.observatory-audit .search .input { box-sizing: border-box; width: 100%; height: 34px; margin: 0; padding: 0 12px 0 32px; border: 1px solid var(--control-border); border-radius: 9px; background: var(--panel); font: 400 13px var(--body); color: var(--content-primary); }
html.observatory-audit .search .input::placeholder { color: var(--content-muted); }
html.observatory-audit .search .input:focus { outline: none; border-color: var(--focus-border); }

/* Tables */
html.observatory-audit :is(.table-scroll, .observatory-table-scroll) { overflow-x: auto; padding: 0; }
html.observatory-audit main table { width: 100%; margin: 0; border: 0; border-collapse: collapse; background: none; }
html.observatory-audit main thead th { padding: 9px 14px; border: 0; border-bottom: 1px solid var(--border-glass); background: var(--fill-subtle) !important; text-align: left; font: 500 10px/1.3 var(--body); letter-spacing: .09em; text-transform: uppercase; color: var(--content-muted); white-space: nowrap; }
html.observatory-audit main tbody :is(th, td) { padding: 11px 14px; border: 0; border-bottom: 1px solid var(--border-glass); background: none; vertical-align: top; text-align: left; font: 400 13px/1.55 var(--body); color: var(--content-secondary); overflow-wrap: anywhere; }
html.observatory-audit main tbody th { min-width: 0; font-weight: 500; color: var(--content-primary); }
html.observatory-audit main tbody tr { background: none !important; }
html.observatory-audit main tbody tr:last-child > * { border-bottom: 0; }
html.observatory-audit main tbody tr:hover > * { background: var(--fill-subtle); }

/* Capability workbench */
html.observatory-audit .capability-workbench { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 16px; align-items: start; }
html.observatory-audit .capability-tabs { position: sticky; top: calc(var(--bar-h) + 16px); overflow-y: auto; padding: 0; }
html.observatory-audit .capability-tabs button { box-sizing: border-box; width: 100%; min-height: 0; margin: 0; padding: 11px 14px; border: 0; border-bottom: 1px solid var(--border-glass); border-radius: 0; background: none; color: var(--content-muted); text-align: left; cursor: pointer; }
html.observatory-audit .capability-tabs button:last-child { border-bottom: 0; }
html.observatory-audit .capability-tabs button:hover { background: var(--fill-subtle); color: var(--content-primary); }
html.observatory-audit .capability-tabs button[aria-selected="true"] { background: var(--fill-emphasis); color: var(--content-primary); box-shadow: inset 2px 0 0 var(--content-secondary); }
html.observatory-audit .capability-tabs button strong { font: 500 13px/1.4 var(--body); }
html.observatory-audit .capability-tabs button small { font: 400 10.5px var(--mono); text-transform: none; color: var(--content-muted); }
html.observatory-audit .cap-index { font: 400 10.5px var(--mono); color: var(--content-muted); }
html.observatory-audit .capability-header { margin: 0; padding: 0 0 16px; border-bottom: 1px solid var(--border-glass); }
html.observatory-audit .capability-header h3 { margin: 0; font: 600 16px/1.35 var(--body); letter-spacing: -.015em; }

/* Footer */
html.observatory-audit .report-footer { margin: 0; background: none !important; border: 0; border-top: 1px solid var(--border-glass); }
html.observatory-audit .report-footer-inner { box-sizing: border-box; display: flex !important; flex-wrap: wrap; justify-content: space-between; gap: 6px 24px; width: 100% !important; max-width: 1180px !important; margin: 0 auto; padding: 20px 24px 40px !important; font: 400 11.5px/1.6 var(--mono); color: var(--content-muted); }
html.observatory-audit .report-footer-inner p { margin: 0; }

@media (max-width: 1060px) and (min-width: 761px) { html.observatory-audit .brand { display: none; } html.observatory-audit .topbar-in { gap: 14px; } }
@media (max-width: 899px) {
  html.observatory-audit .hero { grid-template-columns: 1fr; }
  html.observatory-audit .hero-side { padding: 18px 0 0; border-left: 0; border-top: 1px solid var(--border-glass); }
  html.observatory-audit .capability-workbench { grid-template-columns: 1fr; }
  html.observatory-audit .capability-tabs { position: static; max-height: 300px; }
}
@media (max-width: 767px) {
  html.observatory-audit .hero { padding: 22px 20px; }
  html.observatory-audit .score-num { font-size: 60px; }
  html.observatory-audit .row .finding-body { grid-template-columns: 1fr; }
}
@media (max-width: 760px) {
  html.observatory-audit { --bar-h: 96px; }
  html.observatory-audit .topbar-in { height: auto; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 10px; padding: 10px 16px 8px; }
  html.observatory-audit .brand { grid-column: 1; grid-row: 1; max-width: none; }
  html.observatory-audit .bar-tools { grid-column: 2; grid-row: 1; }
  html.observatory-audit .section-nav { grid-column: 1 / -1; grid-row: 2; margin: 0 -16px; padding: 2px 16px; }
  html.observatory-audit .section-nav a { border: 1px solid var(--border-glass); border-radius: 999px; background: var(--fill-subtle); }
  html.observatory-audit main.page { padding: 28px 16px 96px !important; gap: 52px; }
  html.observatory-audit .page-header h1 { font-size: 25px; }
  html.observatory-audit :is(.card, .content-card, .score-detail, .finding-domain, .capability-panel) { padding: 18px 16px; }
  html.observatory-audit .finding-card.row { padding: 12px 14px; }
  html.observatory-audit .report-footer-inner { padding: 20px 16px 32px !important; }
}
@media (max-width: 639px) {
  html.observatory-audit .hero-facts { grid-template-columns: 1fr; }
  html.observatory-audit .finding-counts { grid-template-columns: 1fr 1fr; }
}
@media print {
  html.observatory-audit .topbar { display: none !important; }
  html.observatory-audit main.page { padding: 0 !important; gap: 28px; }
}
</style>`;

export const auditLayoutScript = String.raw`
(() => {
  const header = document.querySelector('header.report-header');
  const strip = document.querySelector('.tabs-shell');
  const main = document.querySelector('main');
  const panels = [...document.querySelectorAll('[data-main-panel]')];
  if (!header || !strip || !main || !panels.length) return;
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const icon = (d) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 256 256');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'ico');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  };
  const words = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const utc = (value) => value.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]00:?00)$/, '$1 $2 UTC');

  // The top bar takes the tab strip's place. It keeps the strip's class, which the report's own
  // script measures to keep a linked section clear of the pinned bar.
  const bar = make('header', 'topbar tabs-shell');
  const barInner = make('div', 'topbar-in');
  const title = header.querySelector('h1');
  if (!main.id) main.id = 'report-content';
  const brand = make('a', 'brand');
  brand.href = '#' + main.id;
  brand.setAttribute('aria-label', 'Back to the top');
  brand.append(make('span', 'brand-t', words(title).split(' · ')[0] || 'Audit report'));
  const nav = make('nav', 'section-nav');
  nav.setAttribute('aria-label', 'Report sections');
  const tools = make('div', 'bar-tools');
  let print = document.getElementById('print-report');
  if (!print) { print = make('button'); print.addEventListener('click', () => window.print()); }
  print.type = 'button';
  print.className = 'icon-btn';
  print.title = 'Print';
  print.setAttribute('aria-label', 'Print the report');
  print.replaceChildren(icon(${JSON.stringify(printIcon)}));
  tools.append(print);
  barInner.append(brand, nav, tools);
  bar.append(barInner);

  // The page header gathers the report's title, summary and metadata.
  const page = make('header', 'page-header');
  const kicker = header.querySelector('.report-kicker');
  if (kicker) { kicker.className = 'eyebrow'; page.append(kicker); }
  if (title) page.append(title);
  const subtitle = header.querySelector('.report-subtitle');
  if (subtitle) { subtitle.className = 'desc'; page.append(subtitle); }
  const ledger = [...header.querySelectorAll('.header-ledger > div')];
  if (ledger.length) {
    const meta = make('div', 'header-meta');
    ledger.forEach((item) => {
      const pill = make('span', null, words(item.querySelector('span')) + ' ');
      pill.append(make('b', null, utc(words(item.querySelector('strong')))));
      meta.append(pill);
    });
    page.append(meta);
  }
  header.replaceWith(bar);
  strip.remove();
  main.classList.add('page');
  main.prepend(page);

  // Every panel is shown, one after another, with a section heading and a link in the top bar.
  const tabs = new Map([...strip.querySelectorAll('[data-main-tab]')].map((tab) => [tab.dataset.mainTab, tab]));
  panels.forEach((panel) => {
    const key = panel.dataset.mainPanel;
    const tab = tabs.get(key);
    let label = key;
    let count = '';
    if (tab) {
      const copy = tab.cloneNode(true);
      copy.querySelectorAll('.tab-count, small').forEach((node) => { count = words(node); node.remove(); });
      label = words(copy) || key;
    }
    if (!panel.id) panel.id = 'panel-' + key;
    panel.hidden = false;
    panel.removeAttribute('role');
    const link = make('a', null, label);
    link.href = '#' + panel.id;
    if (/^[1-9]\d*$/.test(count)) link.append(make('span', 'n', count));
    nav.append(link);
    const old = panel.querySelector(':scope > .panel-heading');
    const head = make('div', 'section-head');
    const headText = make('div');
    head.append(headText);
    const heading = old?.querySelector('h2') ?? make('h2', null, label);
    if (!heading.id) heading.id = panel.id + '-title';
    headText.append(heading);
    if (old) { [...old.children].forEach((node) => { if (node !== heading) headText.append(node); }); old.replaceWith(head); }
    else panel.prepend(head);
    panel.setAttribute('aria-labelledby', heading.id);
  });

  // The capability workbench opens on its selected capability, as it did behind its tab.
  const capTabs = [...document.querySelectorAll('[data-cap-tab]')];
  const selected = (capTabs.find((tab) => tab.getAttribute('aria-selected') === 'true') ?? capTabs[0])?.dataset.capTab;
  if (selected) document.querySelectorAll('[data-cap-panel]').forEach((panel) => { panel.hidden = panel.dataset.capPanel !== selected; });

  // The weighted score becomes the score card, with the report's headline facts beside it.
  const score = document.querySelector('.score-summary');
  if (score) {
    const holder = score.parentElement;
    const hero = make('div', 'card hero');
    const lead = make('div');
    const label = score.querySelector('.record-label');
    if (label) { label.className = 'lbl'; lead.append(label); }
    const number = score.querySelector('.score-number');
    if (number) {
      const den = number.querySelector('small');
      const denText = words(den).replace(/^\/\s*/, '/ ');
      den?.remove();
      const line = make('div', 'score-line');
      line.append(make('span', 'score-num', words(number)));
      if (denText) line.append(make('span', 'score-den', denText));
      score.querySelectorAll('.badge').forEach((badge) => line.append(badge));
      number.remove();
      score.querySelector('.score-meta')?.remove();
      lead.append(line);
    }
    lead.append(...score.childNodes);
    hero.append(lead);
    const facts = make('dl', 'hero-facts');
    if (holder && !holder.matches('[data-main-panel]')) {
      [...holder.children].filter((node) => node !== score).forEach((group) => {
        [...group.children].forEach((item) => {
          const [name, value] = item.children;
          if (!name || !value) return;
          const [main, ...rest] = words(value).split(' · ');
          const row = make('div');
          const dd = make('dd', null, main);
          if (rest.length) dd.append(make('small', null, rest.join(' · ')));
          row.append(make('dt', null, words(name)), dd);
          facts.append(row);
        });
      });
    }
    if (facts.children.length) {
      const side = make('aside', 'hero-side');
      side.setAttribute('aria-label', 'Headline facts');
      side.append(facts);
      hero.append(side);
    }
    if (holder && !holder.matches('[data-main-panel]')) holder.replaceWith(hero); else score.replaceWith(hero);
    const counts = hero.parentElement?.querySelector(':scope > .finding-counts');
    if (counts) hero.after(counts);
    // The score card opens the page, as on the template, so the first section's heading is
    // kept for assistive technology only.
    const first = hero.closest('[data-main-panel]');
    if (first === panels[0]) first.querySelector(':scope > .section-head')?.classList.add('observatory-sr');
  }

  // Badges take the template's tones: severity by name, otherwise by the report's own tone.
  const severity = { critical: 'b-destructive', high: 'b-high', medium: 'b-warning', low: 'b-info', informational: 'b-secondary', info: 'b-secondary', 'not assessed': 'b-secondary' };
  const tones = { 'badge-bad': 'b-destructive', 'badge-warn': 'b-warning', 'badge-good': 'b-soft', 'badge-neutral': 'b-info' };
  document.querySelectorAll('.badge').forEach((badge) => {
    const tone = severity[words(badge).toLowerCase()] ?? Object.entries(tones).find(([name]) => badge.classList.contains(name))?.[1] ?? 'b-secondary';
    badge.classList.add(tone);
  });

  // Findings and checks become rows: the code, title and badges stay in view and the rest opens below.
  const rowTones = { 'finding-critical': 'tone-destructive', 'finding-high': 'tone-high' };
  const rows = [...document.querySelectorAll('article.finding-card')].filter((card) => {
    const head = card.querySelector(':scope > header');
    if (!head) return false;
    const rowMain = make('div', 'row-main');
    const rowTitle = make('div', 'row-title');
    const code = head.querySelector('.finding-code');
    if (code) { code.classList.add('fid'); rowTitle.append(code); }
    const box = head.querySelector('.finding-title');
    const name = box?.querySelector('h3, h4');
    if (name) rowTitle.append(name);
    rowMain.append(rowTitle);
    if (box) [...box.children].forEach((node) => { node.classList.add('row-detail'); rowMain.append(node); });
    const aside = make('div', 'row-aside');
    const badges = head.querySelector('.badge-row');
    if (badges) aside.append(...badges.children);
    const rest = [...card.children].filter((node) => node !== head);
    head.replaceWith(rowMain, aside);
    if (rest.length) {
      const disc = make('details', 'disc');
      const body = make('div', 'disc-body');
      body.append(...rest);
      disc.append(make('summary', null, 'Details'), body);
      card.append(disc);
    }
    card.classList.add('row');
    Object.entries(rowTones).forEach(([name, tone]) => { if (card.classList.contains(name)) card.classList.add(tone); });
    return true;
  });
  // Consecutive rows share one glass panel.
  rows.forEach((row) => {
    if (row.previousElementSibling?.matches('.finding-card.row') || row.parentElement?.matches('.rows')) return;
    const group = make('div', 'rows');
    row.before(group);
    let node = row;
    while (node?.matches('.finding-card.row')) { const next = node.nextElementSibling; group.append(node); node = next; }
  });

  // The finding search takes the template's search field.
  const query = document.getElementById('finding-search');
  if (query) {
    const label = query.closest('label') ?? document.querySelector('label[for="finding-search"]');
    const field = make('label', 'search');
    (label ?? query).after(field);
    if (!query.getAttribute('aria-label')) query.setAttribute('aria-label', words(label) || 'Search findings');
    field.append(icon(${JSON.stringify(searchIcon)}), query);
    query.classList.add('input');
    label?.remove();
  }

  // A link to a row opens it.
  const openTarget = () => {
    const id = decodeURIComponent(location.hash.slice(1)).split('/').pop();
    const target = id ? document.getElementById(id) : null;
    const disc = target?.matches('.row') ? target.querySelector(':scope > details.disc') : null;
    if (disc) disc.open = true;
  };
  window.addEventListener('hashchange', openTarget);
  openTarget();

  // The top bar marks the section in view. Inside the observatory the page scrolls in the portal,
  // which reports the visible band; opened directly, the document scrolls itself.
  const links = [...nav.querySelectorAll('a')];
  const embedded = window.parent !== window;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let viewportTop = 0;
  let viewportHeight = innerHeight;
  let current = -1;
  let queued = false;
  const spy = () => {
    queued = false;
    const top = embedded ? viewportTop : scrollY;
    const height = embedded ? viewportHeight : innerHeight;
    const line = top + bar.offsetHeight + 40;
    let index = 0;
    panels.forEach((panel, i) => { if (panel.getBoundingClientRect().top + scrollY <= line) index = i; });
    if (top > 0 && top + height >= document.documentElement.scrollHeight - 4) index = panels.length - 1;
    if (index === current) return;
    current = index;
    links.forEach((link, i) => link.setAttribute('aria-current', String(i === index)));
    nav.scrollTo({ left: nav.scrollLeft + links[index].getBoundingClientRect().left - nav.getBoundingClientRect().left - 16, behavior: reduce ? 'auto' : 'smooth' });
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(spy); } };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.data?.type !== 'observatory:viewport') return;
    const { top, height } = event.data;
    if (!Number.isFinite(top)) return;
    viewportTop = Math.max(0, top);
    if (Number.isFinite(height)) viewportHeight = height;
    queue();
  });
  spy();
})();
`;
