/**
 * Side spec syntax for `--base`, `--head` and the `snapshot` positional.
 *
 *   ref:<git ref>          a commit, resolved with `git rev-parse`
 *   dir:<directory>        a worktree, read from the filesystem
 *   snapshot:<file>        a saved `snapshot.json`
 *   <git ref>              a bare spec is always a git ref
 *   .                      the current worktree (the one bare path)
 *
 * The kind is decided from the spelling alone; a spec is never stat'ed to
 * find out what it is. That closes the gap where a change under review
 * could add a file named `HEAD` or a directory named `main` and have the
 * comparison read content it supplied instead of the ref (SRF-1). No valid
 * git ref contains a colon, so the prefixes cannot collide with a ref.
 *
 * Pure: no filesystem, no git.
 */

export type SideSpecKind = "ref" | "dir" | "snapshot";

export interface SideSpec {
  kind: SideSpecKind;
  /** The ref, directory or file the spec names, without the prefix. */
  target: string;
  /** True when the spec carried a `ref:` / `dir:` / `snapshot:` prefix. */
  explicit: boolean;
}

/** The prefixes, in the order they are tried. */
export const SIDE_SPEC_PREFIXES: readonly SideSpecKind[] = ["ref", "dir", "snapshot"];

/** The one bare spec that is not a ref. */
export const CURRENT_WORKTREE_SPEC = ".";

/** Hint appended when a bare spec does not resolve to a commit. */
export const PATH_SPEC_HINT = "a directory or snapshot file must be written dir:<path> or snapshot:<path>";

/** A full commit object id (SHA-1 or SHA-256), lower-case hex. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/** True when `value` is a full commit object id. */
export function isCommitSha(value: unknown): value is string {
  return typeof value === "string" && COMMIT_SHA_PATTERN.test(value);
}

/**
 * Parse a side spec. Never consults the filesystem or git. An empty
 * target after a prefix is an error.
 */
export function parseSideSpec(spec: string): SideSpec | { error: string } {
  for (const kind of SIDE_SPEC_PREFIXES) {
    const prefix = `${kind}:`;
    if (spec.startsWith(prefix)) {
      const target = spec.slice(prefix.length);
      if (target === "") {
        return { error: `empty ${kind} spec: '${spec}' names nothing after '${prefix}'` };
      }
      return { kind, target, explicit: true };
    }
  }
  if (spec === CURRENT_WORKTREE_SPEC) {
    return { kind: "dir", target: spec, explicit: false };
  }
  return { kind: "ref", target: spec, explicit: false };
}

/** The target of a spec for display (`dir:x` → `x`); the spec itself when it does not parse. */
export function sideSpecTarget(spec: string): string {
  const parsed = parseSideSpec(spec);
  return "error" in parsed ? spec : parsed.target;
}
