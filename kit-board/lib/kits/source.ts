/*
 * Links into the public repository, pinned to the commit this deployment was built from, so a schema
 * or collector someone downloads is the one the board is enforcing. Outside Vercel they follow main.
 */
const repository = 'joshgreenwell/ai-kits';

export const sourceRef = () => process.env.VERCEL_GIT_COMMIT_SHA || 'main';

/** A download is a directory when its last segment has no extension, as every kit's are. */
export const isDirectory = (path: string) => !/\.[A-Za-z0-9]+$/.test(path.split('/').pop() ?? '');

/** The GitHub page for a repository path, and for a file its raw URL too. */
export function sourceLinks(path: string, ref = sourceRef()) {
  if (isDirectory(path)) return { view: `https://github.com/${repository}/tree/${ref}/${path}` };
  return { view: `https://github.com/${repository}/blob/${ref}/${path}`, raw: `https://raw.githubusercontent.com/${repository}/${ref}/${path}` };
}
