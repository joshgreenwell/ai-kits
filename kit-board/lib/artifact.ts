import { createHash } from 'node:crypto';
import fonts from './report-fonts.json';
import { artifactRuntime } from './artifact-runtime';
import reportUi from './generated/report-ui.json';

// Original report scripts are content, never trusted members of the portal origin.
// The HTTP sandbox remains enforced when someone opens an artifact directly.
const observatoryTheme = `<style data-personal-hub-theme>
@font-face { font-family: Manrope; font-style: normal; font-weight: 200 800; font-display: swap; src: url(data:font/woff2;base64,${fonts.manrope}) format('woff2'); }
@font-face { font-family: 'DM Mono'; font-style: normal; font-weight: 400; font-display: swap; src: url(data:font/woff2;base64,${fonts.mono}) format('woff2'); }
:root {
  color-scheme: dark;
  --paper: #07100b !important;
  --deep: #040906 !important;
  --panel: #0e1913 !important;
  --ink: #edf7ef !important;
  --muted: #91a099 !important;
  --line: #26362d !important;
  --mint: #a8f3c2 !important;
  --green: #63df95 !important;
  --violet: #9b82ff !important;
  --lilac: #211b38 !important;
  --orange: #ff9a6c !important;
  --white: #0e1913 !important;
  --notice: #211b38 !important;
  --gold: #ffcf70 !important;
  --red: #ff9a6c !important;
  --paper-raised: #0e1913 !important;
  --paper-inset: #0a140e !important;
  --paper-soft: #15261b !important;
  --line-strong: #3b5244 !important;
  --faint: #91a099 !important;
  --navy: #a8f3c2 !important;
  --teal: #63df95 !important;
  --good: #63df95 !important;
  --warn: #ffcf70 !important;
  --bad: #ff9a6c !important;
  --info: #b8a7ff !important;
  --body: Manrope, ui-sans-serif, system-ui, sans-serif !important;
  --heading: Manrope, ui-sans-serif, system-ui, sans-serif !important;
  --mono: 'DM Mono', ui-monospace, monospace !important;
  --hub-gutter: clamp(20px, 3.5vw, 72px);
}
html { background: var(--paper); height: auto !important; min-height: 0 !important; }
body {
  display: flow-root;
  height: auto !important;
  min-height: 0 !important;
  width: 100%;
  margin: 0;
  overflow-wrap: anywhere;
  background: var(--paper) !important;
  color: var(--ink) !important;
  font-family: Manrope, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
}
h1, h2, h3, h4, h5, h6 { color: var(--ink); font-family: Manrope, Inter, ui-sans-serif, system-ui, sans-serif !important; }
a { color: var(--mint) !important; }
a:hover { color: var(--green) !important; }
a:focus-visible, summary:focus-visible, button:focus-visible { outline: 2px solid var(--mint) !important; outline-offset: 4px; }
main, .shell, .report-main, .report-header-inner, .main-tabs, .report-footer-inner {
  width: 100% !important;
  max-width: none !important;
  min-width: 0;
  min-height: 0 !important;
  padding-left: var(--hub-gutter) !important;
  padding-right: var(--hub-gutter) !important;
}
main > article { max-width: none !important; }
main *, .report-header-inner > * { min-width: 0; }
p, li, dd, h1, h2, h3, h4, a, strong, small { overflow-wrap: anywhere; }
img, video, svg { max-width: 100%; }
pre { max-width: 100%; overflow: auto; }
.table-scroll, .observatory-table-scroll { width: 100%; max-width: 100%; overflow: auto; }
.observatory-embedded .tabs-shell { position: relative; top: auto; transform: translateY(var(--hub-nav-shift, 0px)); background: #07100bf5; }
.capability-tabs { max-height: calc(var(--hub-viewport-height, 800px) - 100px); }
.header-ledger { max-width: none !important; }
.footer-actions { flex-wrap: wrap; }
.footer-actions button, .footer-actions a { max-width: 100%; white-space: normal; }
.report-header-inner { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.section-heading { grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); }
.overview-ledger { grid-template-columns: minmax(0, .55fr) minmax(0, 1.45fr); }
.report-header h1 { font-size: clamp(28px, 3vw, 48px); line-height: 1.12; letter-spacing: -.045em; }
.score-summary .score-number { font-family: Manrope, sans-serif; }
thead th { background: var(--paper-soft) !important; }
@media (max-width: 1080px) { .report-header-inner { grid-template-columns: 1fr; } }
@media (max-width: 780px) {
  .section-heading, .overview-ledger { grid-template-columns: 1fr; }
  .content-card, .capability-panel, .finding-domain { padding: 18px; }
  .header-ledger { grid-template-columns: 1fr; }
  .value-object > div, .value-object-depth-2 > div, .value-object-depth-3 > div { grid-template-columns: 1fr; }
  .capability-tabs { max-height: none; }
  .masthead { flex-wrap: wrap; }
}
@media (max-width: 700px) { :root { --hub-gutter: 20px; } }
nav { border-color: var(--line); }
details { background: var(--panel) !important; border-color: var(--line) !important; }
summary { color: var(--ink); }
table { border-color: var(--line); }
th, td { border-color: var(--line); }
code, pre, kbd, samp, .meta, .edition, .small, time {
  font-family: "DM Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
}
pre, code { background: var(--deep); color: var(--ink); }
button, input, select, textarea { color: var(--ink); background: var(--panel); border-color: var(--line); }
</style>`;

function injectTheme(html: string) {
  if (/\bdata-personal-hub-theme\b/i.test(html)) return html;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, `${observatoryTheme}</head>`);
  return `${observatoryTheme}${html}`;
}

export function prepareArtifact(html: string) {
  html = injectTheme(html);
  html = html.replace(/<html\b([^>]*)>/i, (tag, attrs: string) => /\bclass\s*=/i.test(attrs)
    ? tag.replace(/(\bclass\s*=\s*["'])/i, '$1observatory-document dark ')
    : `<html${attrs} class="observatory-document dark">`);
  html = html.replace(/<\/head\s*>/i, `<style data-personal-hub-components>${reportUi.css}</style></head>`);
  const selects = /<select\b/i.test(html) ? `<script data-personal-hub-controls>${reportUi.script}</script>` : '';
  const bridge = `${selects}<script data-personal-hub-layout>${artifactRuntime}</script>`;
  html = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${bridge}</body>`) : html + bridge;
  const scripts = Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi))
    .filter(match => !/\bsrc\s*=/i.test(match[1]) && !/\btype\s*=\s*["']application\/(?:ld\+)?json/i.test(match[1]))
    .map(match => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`);
  const csp = `sandbox allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox allow-modals; default-src 'none'; script-src ${scripts.length ? scripts.join(' ') : "'none'"}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
  return { html, csp };
}
