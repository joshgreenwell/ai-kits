import { createHash } from 'node:crypto';
import { RequestError } from './contracts';

const mediaTypes = {
  json: 'application/json',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
} as const;

export type AssetMediaType = (typeof mediaTypes)[keyof typeof mediaTypes];
export type AssetDescriptor = { path: string; assetKey: string; filename: string; mediaType: AssetMediaType };
export const maximumAssetBytes = 4_000_000;

function decodeHtmlEntities(value: string) {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|amp|apos|quot|lt|gt);/gi, (entity, hex, decimal) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    return ({ '&amp;': '&', '&apos;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' } as Record<string, string>)[entity.toLowerCase()] ?? entity;
  });
}

export function assetPathFromHref(href: string) {
  const path = decodeHtmlEntities(href).trim();
  if (!path || path.startsWith('#') || path.startsWith('/') || path.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return;
  if (path.includes('\0') || path.includes('?') || path.includes('#')) return;
  return path;
}

export function mediaTypeForPath(path: string): AssetMediaType | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() as keyof typeof mediaTypes | undefined;
  return extension ? mediaTypes[extension] : undefined;
}

export function assetKeyForHref(path: string) {
  return createHash('sha256').update(path).digest('hex');
}

export function assetDescriptor(path: string): AssetDescriptor {
  const relativePath = assetPathFromHref(path);
  const mediaType = relativePath && mediaTypeForPath(relativePath);
  if (!relativePath || !mediaType) throw new RequestError('Unsupported asset path', 400);
  const filename = relativePath.split('/').at(-1) ?? '';
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(filename)) throw new RequestError('Invalid asset filename', 400);
  return { path: relativePath, assetKey: assetKeyForHref(relativePath), filename, mediaType };
}

export async function readTextAsset(request: Request) {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > maximumAssetBytes) throw new RequestError('Asset is too large', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError('An asset body is required');
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumAssetBytes) { await reader.cancel(); throw new RequestError('Asset is too large', 413); }
    chunks.push(value);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw new RequestError('Asset content must be UTF-8 text', 415); }
}

export function rewriteAssetLinks(html: string, reportId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) return html;
  return html.replace(/<a\b[^>]*>/gi, tag => {
    try {
      const href = /\bhref\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag);
      if (!href) return tag;
      const descriptor = assetDescriptor(href[2]);
      const rewritten = tag.replace(href[0], `href="/api/artifacts/${reportId}/files/${descriptor.assetKey}"`)
        .replace(/\s+(?:target|rel)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
      // Top-level downloads send the Lax session cookie even when initiated by
      // an opaque-origin report, while leaving its selected tab and scroll intact.
      return rewritten.replace(/>$/, ' target="_blank" rel="noopener noreferrer">');
    } catch { return tag; }
  });
}
