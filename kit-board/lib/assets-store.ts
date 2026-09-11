import 'server-only';
import { createHash } from 'node:crypto';
import { database } from './db';
import { RequestError } from './contracts';
import type { AssetDescriptor, AssetMediaType } from './assets';

export async function storeAsset(reportId: string, descriptor: AssetDescriptor, content: string) {
  const contentHash = createHash('sha256').update(content).digest('hex');
  const sql = database();
  const rows = await sql`
    INSERT INTO personal_hub.report_assets (report_id, asset_key, filename, media_type, content, content_hash)
    VALUES (${reportId}, ${descriptor.assetKey}, ${descriptor.filename}, ${descriptor.mediaType}, ${content}, ${contentHash})
    ON CONFLICT (report_id, asset_key) DO NOTHING
    RETURNING asset_key`;
  if (rows.length) return { assetKey: descriptor.assetKey, duplicate: false };
  const existing = await sql`SELECT content_hash FROM personal_hub.report_assets WHERE report_id = ${reportId} AND asset_key = ${descriptor.assetKey}`;
  if (existing[0]?.content_hash !== contentHash) throw new RequestError('This asset path already names different content', 409);
  return { assetKey: descriptor.assetKey, duplicate: true };
}

export async function reportAsset(reportId: string, assetKey: string) {
  if (!/^[0-9a-f-]{36}$/i.test(reportId) || !/^[a-f0-9]{64}$/.test(assetKey)) return;
  const rows = await database()`SELECT filename, media_type, content FROM personal_hub.report_assets WHERE report_id = ${reportId} AND asset_key = ${assetKey}`;
  return rows[0] as { filename: string; media_type: AssetMediaType; content: string } | undefined;
}
