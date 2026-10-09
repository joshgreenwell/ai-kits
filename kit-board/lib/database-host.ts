// Supabase hosted this database until the September 30, 2026 move to Aurora, and was then retired
// (docs/aurora-cutover.md). The site and the scripts refuse its hosts, so no environment, local
// runs included, can write there again.
export function isRetiredDatabaseHost(url: string) {
  let host: string;
  try { host = new URL(url).hostname; } catch { return /supabase\.co/i.test(url); }
  return /(^|\.)supabase\.com?$/i.test(host);
}
