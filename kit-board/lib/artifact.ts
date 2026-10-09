import { createHash } from 'node:crypto';
import fonts from './report-fonts.json';
import { artifactRuntime } from './artifact-runtime';
import { auditLayoutScript, auditLayoutStyle, isTabbedAudit } from './audit-layout';
import reportUi from './generated/report-ui.json';

// Original report scripts are content, never trusted members of the portal origin.
// The HTTP sandbox remains enforced when someone opens an artifact directly.
const observatoryTheme = `<style data-personal-hub-theme>
@font-face { font-family: Geist; font-style: normal; font-weight: 100 900; font-display: swap; src: url(data:font/woff2;base64,${fonts.geist}) format('woff2'); }
@font-face { font-family: 'Geist Mono'; font-style: normal; font-weight: 100 900; font-display: swap; src: url(data:font/woff2;base64,${fonts.geistMono}) format('woff2'); }
/* Every report is shown in Carbon, dark, on the observatory's ground. A Carbon report's own
   light tokens are written at a higher specificity than :root, so these win by importance. */
:root {
  color-scheme: dark !important;
  --surface-canvas: #0e0e11 !important;
  --surface-panel: #0e0e11 !important;
  --surface-floating: #161619 !important;
  --surface-raised: #1f1f23 !important;
  --surface-muted: #1c1c21 !important;
  --surface-inset: #080809 !important;
  --content-primary: #ededef !important;
  --content-secondary: #d4d4d8 !important;
  --content-muted: #8b8b96 !important;
  --border-default: #1f1f23 !important;
  --border-strong: #2a2a31 !important;
  --border-glass: rgba(237, 237, 239, .08) !important;
  --border-interactive: rgba(139, 139, 150, .24) !important;
  --fill-subtle: rgba(237, 237, 239, .025) !important;
  --fill-control: rgba(237, 237, 239, .045) !important;
  --fill-emphasis: rgba(237, 237, 239, .08) !important;
  --control-fill: rgba(237, 237, 239, .04) !important;
  --control-border: rgba(139, 139, 150, .24) !important;
  --control-track: rgba(237, 237, 239, .04) !important;
  --selection-raised: rgba(237, 237, 239, .09) !important;
  --focus-border: #8b8b96 !important;
  --scrollbar-thumb: rgba(255, 255, 255, .14) !important;
  --indicator-muted: rgba(237, 237, 239, .3) !important;
  --shadow-ink: rgba(0, 0, 0, .4) !important;
  --shadow-flyout: rgba(0, 0, 0, .5) !important;
  --sheen: rgba(255, 255, 255, .05) !important;
  --panel: color-mix(in srgb, #0e0e11 74%, transparent) !important;
  --bar-glass: color-mix(in srgb, #0e0e11 62%, transparent) !important;
  --brand: #fecc34 !important;
  --link: #8ec5ff !important;
  --green: #5ee9b5 !important;
  --amber: #ffba00 !important;
  --red: #ff8a8d !important;
  --orange: #ff8904 !important;
  --blue: #8ec5ff !important;
  --violet: #c6d2ff !important;
  --accent: #ededef !important;
  --body-bg: #070807 !important;
  --wall: none !important;
  --wall-shade: none !important;
  /* the names older reports use, mapped onto the same Carbon roles */
  --paper: #070807 !important;
  --deep: #080809 !important;
  --ink: #ededef !important;
  --muted: #8b8b96 !important;
  --faint: #8b8b96 !important;
  --line: rgba(237, 237, 239, .08) !important;
  --line-strong: #2a2a31 !important;
  --mint: #8ec5ff !important;
  --navy: #8ec5ff !important;
  --info: #8ec5ff !important;
  --teal: #5ee9b5 !important;
  --good: #5ee9b5 !important;
  --lilac: #1e2027 !important;
  --white: #0c0c0e !important;
  --notice: #191e26 !important;
  --gold: #ffba00 !important;
  --warn: #ffba00 !important;
  --bad: #ff8a8d !important;
  --paper-raised: #0c0c0e !important;
  --paper-inset: #080809 !important;
  --paper-soft: #131316 !important;
  --body: Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif !important;
  --heading: Geist, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif !important;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace !important;
  --hub-gutter: clamp(20px, 3.5vw, 72px);
}
html { background: #070807 !important; height: auto !important; min-height: 0 !important; }
body {
  display: flow-root;
  height: auto !important;
  min-height: 0 !important;
  width: 100%;
  margin: 0;
  background: #070807 !important;
  color: var(--content-primary) !important;
  font-family: Geist, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
::selection { background: rgba(254, 204, 52, .28); }
* { scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) transparent; }
img, video, svg { max-width: 100%; }
pre { max-width: 100%; overflow: auto; }
.table-scroll, .observatory-table-scroll { width: 100%; max-width: 100%; overflow: auto; }

/* A Carbon report keeps its own layout and components. Its wallpaper gives way to the ground, and
   its theme switch is hidden, since the observatory always shows it dark. */
.observatory-carbon .wall, .observatory-carbon .theme-seg { display: none !important; }
.observatory-embedded.observatory-carbon .topbar { position: relative; top: auto; transform: translateY(var(--hub-nav-shift, 0px)); }

/* Older reports take Carbon's type, links and lines, and stretch to the observatory's gutter. */
.observatory-legacy body { overflow-wrap: anywhere; }
.observatory-legacy :is(h1, h2, h3, h4, h5, h6) { color: var(--content-primary); font-family: Geist, ui-sans-serif, system-ui, sans-serif !important; font-weight: 600; letter-spacing: -.02em; }
.observatory-legacy a { color: var(--link) !important; }
.observatory-legacy a:hover { text-decoration: underline; text-underline-offset: 3px; }
.observatory-legacy :is(a, summary, button):focus-visible { outline: 2px solid var(--focus-border) !important; outline-offset: 2px; }
.observatory-legacy :is(main, .shell, .report-main, .report-header-inner, .main-tabs, .report-footer-inner) {
  width: 100% !important;
  max-width: none !important;
  min-width: 0;
  min-height: 0 !important;
  padding-left: var(--hub-gutter) !important;
  padding-right: var(--hub-gutter) !important;
}
.observatory-legacy main > article { max-width: none !important; }
.observatory-legacy :is(main *, .report-header-inner > *) { min-width: 0; }
.observatory-legacy :is(p, li, dd, h1, h2, h3, h4, a, strong, small) { overflow-wrap: anywhere; }
.observatory-embedded.observatory-legacy .tabs-shell {
  position: relative; top: auto; transform: translateY(var(--hub-nav-shift, 0px));
  background: var(--bar-glass); -webkit-backdrop-filter: blur(40px) saturate(1.3); backdrop-filter: blur(40px) saturate(1.3);
  border-bottom: 1px solid var(--border-glass); box-shadow: 0 8px 24px -18px var(--shadow-flyout);
}
.observatory-legacy .capability-tabs { max-height: calc(var(--hub-viewport-height, 800px) - 100px); }
.observatory-legacy .header-ledger { max-width: none !important; }
.observatory-legacy .footer-actions { flex-wrap: wrap; }
.observatory-legacy .footer-actions :is(button, a) { max-width: 100%; white-space: normal; }
.observatory-legacy .report-header-inner { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.observatory-legacy .section-heading { grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); }
.observatory-legacy .overview-ledger { grid-template-columns: minmax(0, .55fr) minmax(0, 1.45fr); }
.observatory-legacy .report-header h1 { font-size: clamp(26px, 2.4vw, 32px); line-height: 1.15; letter-spacing: -.03em; }
.observatory-legacy .score-summary .score-number { font-family: Geist, sans-serif !important; font-weight: 600; letter-spacing: -.045em; font-variant-numeric: tabular-nums; }
.observatory-legacy thead th { background: var(--fill-subtle) !important; color: var(--content-muted); font: 500 10px/1.3 Geist, sans-serif; letter-spacing: .09em; text-transform: uppercase; }
@media (max-width: 1080px) { .observatory-legacy .report-header-inner { grid-template-columns: 1fr; } }
@media (max-width: 780px) {
  .observatory-legacy :is(.section-heading, .overview-ledger) { grid-template-columns: 1fr; }
  .observatory-legacy :is(.content-card, .capability-panel, .finding-domain) { padding: 18px; }
  .observatory-legacy .header-ledger { grid-template-columns: 1fr; }
  .observatory-legacy :is(.value-object, .value-object-depth-2, .value-object-depth-3) > div { grid-template-columns: 1fr; }
  .observatory-legacy .capability-tabs { max-height: none; }
  .observatory-legacy .masthead { flex-wrap: wrap; }
}
@media (max-width: 700px) { :root { --hub-gutter: 20px; } }
.observatory-legacy nav { border-color: var(--border-glass); }
.observatory-legacy details { background: var(--fill-subtle) !important; border-color: var(--border-glass) !important; }
.observatory-legacy summary { color: var(--content-secondary); }
.observatory-legacy table { border-color: var(--border-glass); }
.observatory-legacy :is(th, td) { border-color: var(--border-glass); }
.observatory-legacy :is(code, pre, kbd, samp, .meta, .edition, .small, time) {
  font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
}
.observatory-legacy :is(pre, code) { background: var(--surface-inset); color: var(--content-secondary); }
.observatory-legacy :is(button, input, select, textarea) { color: var(--content-primary); background: var(--control-fill); border-color: var(--control-border); }
</style>`;

function injectTheme(html: string) {
  if (/\bdata-personal-hub-theme\b/i.test(html)) return html;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${observatoryTheme}</head>`);
  return `${observatoryTheme}${html}`;
}

export function prepareArtifact(html: string) {
  // A report drawn with the Carbon tokens keeps its own components; older reports are restyled,
  // and an older audit report is also laid out as the Carbon audit template is.
  // Read before the theme is injected, since the theme itself names the token.
  const carbon = /--border-glass\s*:/.test(html);
  const audit = !carbon && isTabbedAudit(html);
  const classes = `observatory-document ${carbon ? 'observatory-carbon' : 'observatory-legacy'}${audit ? ' observatory-audit' : ''} dark`;
  html = injectTheme(html);
  html = html.replace(/<html\b([^>]*)>/i, (tag, attrs: string) => /\bclass\s*=/i.test(attrs)
    ? tag.replace(/(\bclass\s*=\s*["'])/i, `$1${classes} `)
    : `<html${attrs} class="${classes}">`);
  html = html.replace(/<\/head\s*>/i, `<style data-personal-hub-components>${reportUi.css}</style>${audit ? auditLayoutStyle : ''}</head>`);
  const selects = /<select\b/i.test(html) ? `<script data-personal-hub-controls>${reportUi.script}</script>` : '';
  // The audit layout runs before the runtime, which looks for the pinned bar the layout builds.
  const layout = audit ? `<script data-personal-hub-audit>${auditLayoutScript}</script>` : '';
  const bridge = `${selects}${layout}<script data-personal-hub-layout>${artifactRuntime}</script>`;
  html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${bridge}</body>`) : html + bridge;
  const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi))
    .filter(match => !/\bsrc\s*=/i.test(match[1]) && !/\btype\s*=\s*["']application\/(?:ld\+)?json/i.test(match[1]))
    .map(match => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
  const csp = `sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals; default-src 'none'; script-src ${scripts.length ? scripts.join(' ') : "'none'"}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
  return { html, csp };
}
