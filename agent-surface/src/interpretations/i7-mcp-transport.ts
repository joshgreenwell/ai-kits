/**
 * I7 — MCP transport (proven / unresolved).
 *
 * A literal `http://` URL to a non-loopback host is plaintext transport
 * (proven, flagged). Loopback hosts (`localhost`, `127.0.0.1`, `[::1]`)
 * are proven and not flagged. `https://` is proven. A URL or command that
 * contains `${VAR}` / `$VAR` is unresolved: agent-surface never expands
 * variables. An unknown transport or scheme is unresolved.
 */

import type { Entry } from "../types.js";
import { INTERPRETATION_DATE, stringField } from "./shared.js";
import type { Classification, InterpretationMeta } from "./types.js";

export const META: InterpretationMeta = {
  id: "I7",
  title: "MCP transport: literal http:// to a non-loopback host is plaintext",
  tier: "proven / unresolved",
  doc_section: "MCP > Project-scope servers (.mcp.json) and remote HTTP/SSE servers",
  semantics_doc_date: INTERPRETATION_DATE,
  summary: "Literal http:// to a non-loopback host is proven plaintext (flag plaintext); loopback and https:// are proven and unflagged; ${VAR} in a URL or command is unresolved.",
  explain: [
    ".mcp.json declares stdio servers (command + args) and remote servers (type http or sse with a url). Claude Code expands ${VAR} references in .mcp.json at run time; agent-surface never does, so any URL or command containing a variable reference has an unknown target and is reported unresolved with flag variable_reference.",
    "A literal http:// URL whose host is not loopback (localhost, 127.0.0.0/8, [::1]) sends the MCP session in plaintext: proven, flagged plaintext. Loopback http:// is proven and not flagged; https:// is proven and not flagged.",
    "A stdio command is recorded and never executed. A transport other than stdio, http or sse, or a scheme other than http(s), is outside the documented set and unresolved.",
  ].join(" "),
};

const VARIABLE = /\$\{?[A-Za-z_][A-Za-z0-9_]*/;

/** True when `host` (without brackets) is a loopback address. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

/** Host part of an http(s) URL as written (no expansion, no DNS), or `null`. */
export function urlHost(url: string): string | null {
  const match = /^https?:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url);
  const host = match?.[1];
  return host === undefined || host === "" ? null : host;
}

export function classify(entry: Entry): Classification | null {
  if (entry.kind !== "mcp") {
    return null;
  }
  const transport = stringField(entry, "transport");
  const typeRaw = stringField(entry, "type_raw");
  const url = stringField(entry, "url");
  const command = stringField(entry, "command");
  if (transport === null) {
    return { tier: "unresolved", flags: [], notes: [`I7: transport ${typeRaw === null ? "is not declared" : `"${typeRaw}" is not stdio, http or sse`}; not interpreted`] };
  }
  if (transport === "stdio") {
    if (command === null) {
      return { tier: "unresolved", flags: [], notes: ["I7: stdio server without a command string; not interpreted"] };
    }
    if (VARIABLE.test(command)) {
      return { tier: "unresolved", flags: ["variable_reference"], notes: [`I7: stdio command contains a variable reference; never expanded, target unresolved`] };
    }
    return { tier: "proven", flags: [], notes: [`I7: stdio server; command "${command}" recorded, never executed`] };
  }
  if (url === null) {
    return { tier: "unresolved", flags: [], notes: [`I7: ${transport} server without a url string; not interpreted`] };
  }
  if (VARIABLE.test(url)) {
    return { tier: "unresolved", flags: ["variable_reference"], notes: [`I7: ${transport} url contains a variable reference; never expanded, target unresolved`] };
  }
  const host = urlHost(url);
  if (/^https:\/\//i.test(url)) {
    return { tier: "proven", flags: [], notes: [`I7: ${transport} over https to ${host ?? "an unparseable host"}`] };
  }
  if (/^http:\/\//i.test(url)) {
    if (host !== null && isLoopbackHost(host)) {
      return { tier: "proven", flags: [], notes: [`I7: ${transport} over plaintext http to loopback host ${host}; not flagged`] };
    }
    return { tier: "proven", flags: ["plaintext"], notes: [`I7: ${transport} over plaintext http to non-loopback host ${host ?? "(unparseable)"}`] };
  }
  return { tier: "unresolved", flags: [], notes: [`I7: url scheme of "${url}" is not http or https; not interpreted`] };
}
