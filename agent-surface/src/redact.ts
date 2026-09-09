/**
 * Credential-like literal detection and redaction (JG-150, JG-145).
 *
 * Shared by the entry extractor and every renderer so the same literal is
 * treated the same way everywhere: the literal is replaced by `<redacted>`
 * in every value that carried it, and the place it was found is reported as
 * a `credential:<json_pointer>` entry whose value is
 * "credential-like value present".
 *
 * This module never hashes, never logs, and never keeps the matched text:
 * a finding records only the JSON pointer and the pattern name.
 *
 * Detection is heuristic by design. Patterns (dated 2026-09-07):
 *  - `sk-…` API keys (16+ key characters after the prefix)
 *  - AWS access key ids (`AKIA` + 16 upper-case alphanumerics)
 *  - GitHub tokens (`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` + 20+, `github_pat_` + 20+)
 *  - Slack tokens (`xox[baprs]-…`)
 *  - `Bearer <token>` (the token is redacted, the word `Bearer` is kept);
 *    `Bearer ${VAR}` is a variable reference, not a literal, and is left alone
 *  - PEM private key blocks (`-----BEGIN … PRIVATE KEY-----` through the END line)
 *  - inline `token=…` / `secret=…` / `password=…` / `api_key=…` assignments (16+ chars)
 *  - generic: a whole string value of 32+ hex or base64 characters that sits
 *    under a key whose name contains token / secret / key / password /
 *    passwd / credential, unless the string looks like a filesystem path
 *
 * Shorter values are never treated as credentials (and never hashed, per
 * the project rule against hashing values shorter than 16 bytes).
 */

import type { JsonValue } from "./types.js";

/** Replacement text for a redacted literal or a hidden `env` value. */
export const REDACTED = "<redacted>";

/** Value of every `credential:` entry. The literal itself is never carried. */
export const CREDENTIAL_PRESENT = "credential-like value present";

/** Key names under which a long opaque string is treated as a credential. */
export const SENSITIVE_KEY = /token|secret|key|password|passwd|credential/i;

interface LiteralPattern {
  name: string;
  /** Global regex. Group 1, when `keepPrefix`, is the prefix to keep. */
  re: RegExp;
  keepPrefix: boolean;
}

const LITERAL_PATTERNS: readonly LiteralPattern[] = [
  {
    name: "private-key-block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    keepPrefix: false,
  },
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g, keepPrefix: false },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, keepPrefix: false },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, keepPrefix: false },
  { name: "sk-prefixed-key", re: /\bsk-[A-Za-z0-9_-]{16,}/g, keepPrefix: false },
  { name: "bearer-token", re: /(\bBearer\s+)(?!\$)[A-Za-z0-9._~+/=-]{8,}/g, keepPrefix: true },
  {
    name: "inline-assignment",
    re: /(\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd)\s*[=:]\s*["']?)(?!\$)[A-Za-z0-9+/_.-]{16,}={0,2}/gi,
    keepPrefix: true,
  },
];

const GENERIC_HEX = /^[A-Fa-f0-9]{32,}$/;
const GENERIC_BASE64 = /^[A-Za-z0-9+/_-]{32,}={0,2}$/;
const PATH_LIKE = /^(?:\/|\.\.?\/|~\/?|[A-Za-z]:\\)/;

/** Result of redacting one string. */
export interface RedactedString {
  text: string;
  /** Names of the patterns that matched, in detection order; empty when nothing matched. */
  patterns: string[];
}

/**
 * Redact credential-like literals inside `text`. `key` is the name of the
 * property that holds the string (or `null` when unknown) and drives the
 * generic "long opaque value under a sensitive key" rule.
 *
 * Pure: never throws, never reads the environment, never keeps the match.
 */
export function redactString(text: string, key: string | null = null): RedactedString {
  const patterns: string[] = [];
  let out = text;
  for (const pattern of LITERAL_PATTERNS) {
    pattern.re.lastIndex = 0;
    if (!pattern.re.test(out)) {
      continue;
    }
    patterns.push(pattern.name);
    pattern.re.lastIndex = 0;
    out = pattern.keepPrefix ? out.replace(pattern.re, `$1${REDACTED}`) : out.replace(pattern.re, REDACTED);
  }
  if (key !== null && SENSITIVE_KEY.test(key)) {
    const trimmed = out.trim();
    if (trimmed !== REDACTED && !PATH_LIKE.test(trimmed) && (GENERIC_HEX.test(trimmed) || GENERIC_BASE64.test(trimmed))) {
      patterns.push("opaque-value-under-sensitive-key");
      out = REDACTED;
    }
  }
  return { text: out, patterns };
}

/** True when `text` carries at least one credential-like literal. */
export function looksLikeCredential(text: string, key: string | null = null): boolean {
  return redactString(text, key).patterns.length > 0;
}

/** One redacted literal: where it was and which pattern matched. Never the text. */
export interface CredentialFinding {
  /** RFC 6901 pointer of the string value that carried the literal. */
  pointer: string;
  /** Pattern names, in detection order. */
  patterns: string[];
}

export interface RedactedTree {
  value: JsonValue;
  /** In document order (depth-first, keys as written). */
  findings: CredentialFinding[];
}

function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Deep-copy `value` with every credential-like string literal redacted.
 * `pointer` is the RFC 6901 pointer of `value` (`""` for the root) and
 * `key` the property name holding it, both used for reporting only.
 *
 * Objects in the copy have a `null` prototype like the parser's output.
 * Never mutates its input.
 */
export function redactTree(value: JsonValue, pointer = "", key: string | null = null): RedactedTree {
  const findings: CredentialFinding[] = [];
  const copy = walk(value, pointer, key, findings);
  return { value: copy, findings };
}

function walk(value: JsonValue, pointer: string, key: string | null, findings: CredentialFinding[]): JsonValue {
  if (typeof value === "string") {
    const redacted = redactString(value, key);
    if (redacted.patterns.length > 0) {
      findings.push({ pointer, patterns: redacted.patterns });
    }
    return redacted.text;
  }
  if (Array.isArray(value)) {
    // Array elements inherit the enclosing property name for the sensitive-key rule.
    return value.map((item, index) => walk(item, `${pointer}/${index}`, key, findings));
  }
  if (value !== null && typeof value === "object") {
    const out = Object.create(null) as Record<string, JsonValue>;
    for (const name of Object.keys(value)) {
      const child = value[name];
      if (child !== undefined) {
        out[name] = walk(child, `${pointer}/${escapeToken(name)}`, name, findings);
      }
    }
    return out;
  }
  return value;
}
