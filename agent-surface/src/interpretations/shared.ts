/** Small pure helpers shared by the interpretation modules. */

import { SEMANTICS_DOC_DATE, type Entry, type JsonObject } from "../types.js";

/** Date every META cites (§3.6 closed list). */
export const INTERPRETATION_DATE = SEMANTICS_DOC_DATE;

/** The value of a `perm` entry as written by `entries.ts`. */
export interface PermValue {
  raw: string;
  rule: string;
  tool: string;
  spec: string | null;
  wildcard: "whole" | "trailing" | "none" | null;
}

export type PermList = "allow" | "ask" | "deny";

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The typed value of a perm entry, or `null` when the entry is not a usable perm entry. */
export function permValue(entry: Entry): PermValue | null {
  if (entry.kind !== "perm" || !isObject(entry.value)) {
    return null;
  }
  const { raw, rule, tool, spec, wildcard } = entry.value;
  if (typeof raw !== "string" || typeof rule !== "string" || typeof tool !== "string") {
    return null;
  }
  const specValue = typeof spec === "string" ? spec : null;
  const wildcardValue = wildcard === "whole" || wildcard === "trailing" || wildcard === "none" ? wildcard : null;
  return { raw, rule, tool, spec: specValue, wildcard: wildcardValue };
}

/** Which permission list a perm entry belongs to, from its key. */
export function permList(entry: Entry): PermList | null {
  const match = /^perm:(allow|ask|deny):/.exec(entry.key);
  return match === null ? null : (match[1] as PermList);
}

/** `file:line` (or just `file`) for notes. */
export function where(entry: Entry): string {
  return entry.line === null ? entry.file : `${entry.file}:${entry.line}`;
}

/** A string property of an object entry value, or `null`. */
export function stringField(entry: Entry, name: string): string | null {
  if (!isObject(entry.value)) {
    return null;
  }
  const value = entry.value[name];
  return typeof value === "string" ? value : null;
}
