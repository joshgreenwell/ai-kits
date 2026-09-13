import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(root, 'app/theme.css');
const [javascript, styles] = await Promise.all([
  build({ absWorkingDir: root, entryPoints: ['components/document-selects.tsx'], bundle: true, write: false, minify: true, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'inline' }),
  postcss([tailwind({ base: root, optimize: { minify: true } })]).process(await readFile(source, 'utf8'), { from: source }),
]);
await mkdir(resolve(root, 'lib/generated'), { recursive: true });
// A CRLF checkout (Windows) leaks a carriage return from app/theme.css into the bundle; CI compares
// against the Linux build, so line endings are normalized before the file is written.
const lf = (text) => text.replace(/\r\n?/g, '\n');
const bundle = { css: lf(styles.css), script: lf(javascript.outputFiles[0].text).replace(/<\/script/gi, '<\\/script') };
await writeFile(resolve(root, 'lib/generated/report-ui.json'), JSON.stringify(bundle));
console.log(`Built shared report UI: ${Math.round(Buffer.byteLength(bundle.css) / 1024)} KB styles, ${Math.round(Buffer.byteLength(bundle.script) / 1024)} KB controls`);
