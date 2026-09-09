/**
 * Hand-written JSONC parser (plan §3.3 / §3.9, JG-147). No dependencies.
 *
 * Accepts `//` and `/* *\/` comments and trailing commas in objects and
 * arrays. Records a 1-based line/column and an RFC 6901 JSON pointer for
 * every value. Never executes, expands, or dereferences anything.
 *
 * Invariants:
 *  - `value` is defined if and only if `incomplete` is empty.
 *  - Duplicate keys at any depth are reported as `incomplete` with the
 *    pointer and both line numbers; the parser never picks last-wins.
 *  - Objects are created with `Object.create(null)`, so `__proto__`,
 *    `constructor` and `prototype` are stored as plain data.
 *  - Inputs larger than `maxBytes` (1 MiB) or nested deeper than `maxDepth`
 *    (32) are rejected as `incomplete` with the reason.
 *  - A leading BOM is skipped and CRLF / lone CR count as one newline, so
 *    line numbers match what an editor shows.
 */

import type { Incomplete, JsonObject, JsonValue } from "./types.js";

/** Default maximum input size in bytes (1 MiB). */
export const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Default maximum nesting depth of arrays/objects. */
export const DEFAULT_MAX_DEPTH = 32;

/** 1-based position of a value in the source text. */
export interface Position {
  line: number;
  column: number;
}

/** Result of parsing one document. */
export interface JsoncResult {
  /** The parsed value, or `undefined` when `incomplete` is non-empty. */
  value: JsonValue | undefined;
  /** JSON pointer (`""` for the root) → position of the value's first character. */
  pointers: Map<string, Position>;
  incomplete: Incomplete[];
}

export interface JsoncOptions {
  /** Path recorded in `incomplete[].path`; defaults to `"<input>"`. */
  path?: string;
  maxBytes?: number;
  maxDepth?: number;
}

/** Escape one reference token per RFC 6901 (`~` → `~0`, `/` → `~1`). */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

class JsoncSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
    this.name = "JsoncSyntaxError";
  }
}

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_QUOTE = 0x22;
const CH_STAR = 0x2a;
const CH_PLUS = 0x2b;
const CH_COMMA = 0x2c;
const CH_MINUS = 0x2d;
const CH_DOT = 0x2e;
const CH_SLASH = 0x2f;
const CH_0 = 0x30;
const CH_9 = 0x39;
const CH_COLON = 0x3a;
const CH_E_UPPER = 0x45;
const CH_LBRACKET = 0x5b;
const CH_BACKSLASH = 0x5c;
const CH_RBRACKET = 0x5d;
const CH_E_LOWER = 0x65;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;
const BOM = 0xfeff;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Parse JSONC text (or UTF-8 bytes) into a value with positions.
 *
 * Never throws for malformed input: every failure is returned in
 * `incomplete` with its line number so callers can exit 3 with the reason.
 */
export function parseJsonc(input: string | Uint8Array, options: JsoncOptions = {}): JsoncResult {
  const path = options.path ?? "<input>";
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const byteLength = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (byteLength > maxBytes) {
    return failure(path, `input exceeds size limit (${byteLength} bytes > ${maxBytes} bytes)`, null);
  }

  let text: string;
  if (typeof input === "string") {
    text = input;
  } else {
    try {
      text = utf8.decode(input);
    } catch {
      return failure(path, "input is not valid UTF-8", null);
    }
  }

  return new Parser(text, path, maxDepth).run();
}

function failure(path: string, reason: string, lines: number[] | null): JsoncResult {
  return { value: undefined, pointers: new Map(), incomplete: [{ path, reason, lines }] };
}

class Parser {
  private pos = 0;
  private line = 1;
  private column = 1;
  private readonly pointers = new Map<string, Position>();
  private readonly duplicates: Incomplete[] = [];

  constructor(
    private readonly text: string,
    private readonly path: string,
    private readonly maxDepth: number,
  ) {
    if (text.charCodeAt(0) === BOM) {
      // The BOM is not a character of the document: skip it without counting a column.
      this.pos = 1;
    }
  }

  run(): JsoncResult {
    try {
      this.skipTrivia();
      if (this.atEnd()) {
        throw this.error("empty document (no JSON value)");
      }
      const value = this.parseValue("", 0);
      this.skipTrivia();
      if (!this.atEnd()) {
        throw this.error(`unexpected trailing content ${this.describeCurrent()}`);
      }
      if (this.duplicates.length > 0) {
        return { value: undefined, pointers: this.pointers, incomplete: this.duplicates };
      }
      return { value, pointers: this.pointers, incomplete: [] };
    } catch (err) {
      if (err instanceof JsoncSyntaxError) {
        return {
          value: undefined,
          pointers: this.pointers,
          incomplete: [
            {
              path: this.path,
              reason: `${err.message} (line ${err.line}, column ${err.column})`,
              lines: [err.line],
            },
          ],
        };
      }
      throw err;
    }
  }

  // --- low-level cursor -----------------------------------------------------

  private atEnd(): boolean {
    return this.pos >= this.text.length;
  }

  private peek(): number {
    return this.text.charCodeAt(this.pos);
  }

  private peekAt(offset: number): number {
    return this.text.charCodeAt(this.pos + offset);
  }

  /** Consume one code unit, treating CRLF / CR / LF as a single newline. */
  private advance(): void {
    const c = this.text.charCodeAt(this.pos);
    this.pos += 1;
    if (c === CH_CR) {
      if (this.text.charCodeAt(this.pos) === CH_LF) {
        this.pos += 1;
      }
      this.line += 1;
      this.column = 1;
    } else if (c === CH_LF) {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
  }

  private here(): Position {
    return { line: this.line, column: this.column };
  }

  private error(message: string): JsoncSyntaxError {
    return new JsoncSyntaxError(message, this.line, this.column);
  }

  private describeCurrent(): string {
    if (this.atEnd()) {
      return "at end of input";
    }
    const ch = String.fromCharCode(this.peek());
    return `'${ch}'`;
  }

  // --- trivia -----------------------------------------------------------------

  private skipTrivia(): void {
    for (;;) {
      const c = this.peek();
      if (c === CH_SPACE || c === CH_TAB || c === CH_LF || c === CH_CR) {
        this.advance();
      } else if (c === CH_SLASH && this.peekAt(1) === CH_SLASH) {
        this.advance();
        this.advance();
        while (!this.atEnd() && this.peek() !== CH_LF && this.peek() !== CH_CR) {
          this.advance();
        }
      } else if (c === CH_SLASH && this.peekAt(1) === CH_STAR) {
        const start = this.here();
        this.advance();
        this.advance();
        for (;;) {
          if (this.atEnd()) {
            throw new JsoncSyntaxError("unterminated block comment", start.line, start.column);
          }
          if (this.peek() === CH_STAR && this.peekAt(1) === CH_SLASH) {
            this.advance();
            this.advance();
            break;
          }
          this.advance();
        }
      } else {
        return;
      }
    }
  }

  // --- values -----------------------------------------------------------------

  /**
   * Parse one value. `pointer` is `null` while inside a duplicated key so the
   * first occurrence's positions are never overwritten.
   */
  private parseValue(pointer: string | null, depth: number): JsonValue {
    const start = this.here();
    const c = this.peek();
    let value: JsonValue;
    if (c === CH_LBRACE) {
      value = this.parseObject(pointer, depth + 1);
    } else if (c === CH_LBRACKET) {
      value = this.parseArray(pointer, depth + 1);
    } else if (c === CH_QUOTE) {
      value = this.parseString();
    } else if (c === CH_MINUS || (c >= CH_0 && c <= CH_9)) {
      value = this.parseNumber();
    } else if (this.text.startsWith("true", this.pos)) {
      this.advanceBy(4);
      value = true;
    } else if (this.text.startsWith("false", this.pos)) {
      this.advanceBy(5);
      value = false;
    } else if (this.text.startsWith("null", this.pos)) {
      this.advanceBy(4);
      value = null;
    } else {
      throw this.error(`unexpected ${this.atEnd() ? "end of input" : `character ${this.describeCurrent()}`}, expected a JSON value`);
    }
    if (pointer !== null) {
      this.pointers.set(pointer, start);
    }
    return value;
  }

  private advanceBy(count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.advance();
    }
  }

  private checkDepth(depth: number): void {
    if (depth > this.maxDepth) {
      throw this.error(`nesting depth exceeds limit (${depth} > ${this.maxDepth})`);
    }
  }

  private parseObject(pointer: string | null, depth: number): JsonObject {
    this.checkDepth(depth);
    this.advance(); // {
    const obj = Object.create(null) as JsonObject;
    const seen = new Map<string, number>();
    for (;;) {
      this.skipTrivia();
      if (this.peek() === CH_RBRACE) {
        this.advance();
        return obj;
      }
      if (this.peek() !== CH_QUOTE) {
        throw this.error(`expected property name or '}', found ${this.describeCurrent()}`);
      }
      const keyPosition = this.here();
      const key = this.parseString();
      this.skipTrivia();
      if (this.peek() !== CH_COLON) {
        throw this.error(`expected ':' after property name, found ${this.describeCurrent()}`);
      }
      this.advance();
      this.skipTrivia();

      const childPointer = pointer === null ? null : `${pointer}/${escapePointerToken(key)}`;
      const firstLine = seen.get(key);
      if (firstLine !== undefined) {
        this.parseValue(null, depth);
        this.duplicates.push({
          path: this.path,
          reason: `duplicate key "${key}" at ${childPointer ?? "(inside a duplicated key)"}`,
          lines: [firstLine, keyPosition.line],
        });
      } else {
        const value = this.parseValue(childPointer, depth);
        seen.set(key, keyPosition.line);
        obj[key] = value;
      }

      this.skipTrivia();
      if (this.peek() === CH_COMMA) {
        this.advance();
        continue; // a trailing comma is handled by the '}' check at the top
      }
      if (this.peek() === CH_RBRACE) {
        this.advance();
        return obj;
      }
      throw this.error(`expected ',' or '}' after property value, found ${this.describeCurrent()}`);
    }
  }

  private parseArray(pointer: string | null, depth: number): JsonValue[] {
    this.checkDepth(depth);
    this.advance(); // [
    const items: JsonValue[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.peek() === CH_RBRACKET) {
        this.advance();
        return items;
      }
      if (this.peek() === CH_COMMA) {
        throw this.error("unexpected ',' (missing array element)");
      }
      const childPointer = pointer === null ? null : `${pointer}/${items.length}`;
      items.push(this.parseValue(childPointer, depth));
      this.skipTrivia();
      if (this.peek() === CH_COMMA) {
        this.advance();
        continue;
      }
      if (this.peek() === CH_RBRACKET) {
        this.advance();
        return items;
      }
      throw this.error(`expected ',' or ']' after array element, found ${this.describeCurrent()}`);
    }
  }

  private parseString(): string {
    const start = this.here();
    this.advance(); // opening quote
    let out = "";
    let runStart = this.pos;
    for (;;) {
      if (this.atEnd()) {
        throw new JsoncSyntaxError("unterminated string", start.line, start.column);
      }
      const c = this.peek();
      if (c === CH_QUOTE) {
        out += this.text.slice(runStart, this.pos);
        this.advance();
        return out;
      }
      if (c === CH_BACKSLASH) {
        out += this.text.slice(runStart, this.pos);
        this.advance();
        out += this.parseEscape();
        runStart = this.pos;
        continue;
      }
      if (c < CH_SPACE) {
        throw this.error(`control character U+${c.toString(16).padStart(4, "0").toUpperCase()} in string must be escaped`);
      }
      this.advance();
    }
  }

  private parseEscape(): string {
    if (this.atEnd()) {
      throw this.error("unterminated escape sequence");
    }
    const c = this.text[this.pos];
    switch (c) {
      case '"':
        this.advance();
        return '"';
      case "\\":
        this.advance();
        return "\\";
      case "/":
        this.advance();
        return "/";
      case "b":
        this.advance();
        return "\b";
      case "f":
        this.advance();
        return "\f";
      case "n":
        this.advance();
        return "\n";
      case "r":
        this.advance();
        return "\r";
      case "t":
        this.advance();
        return "\t";
      case "u": {
        const hex = this.text.slice(this.pos + 1, this.pos + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw this.error("invalid \\u escape (expected four hex digits)");
        }
        this.advanceBy(5);
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        throw this.error(`invalid escape sequence '\\${c ?? ""}'`);
    }
  }

  private parseNumber(): number {
    const start = this.here();
    const begin = this.pos;
    if (this.peek() === CH_MINUS) {
      this.advance();
    }
    if (this.peek() === CH_0) {
      this.advance();
    } else if (this.peek() > CH_0 && this.peek() <= CH_9) {
      while (this.isDigit()) {
        this.advance();
      }
    } else {
      throw this.error("invalid number (expected a digit)");
    }
    if (this.peek() === CH_DOT) {
      this.advance();
      if (!this.isDigit()) {
        throw this.error("invalid number (expected a digit after '.')");
      }
      while (this.isDigit()) {
        this.advance();
      }
    }
    if (this.peek() === CH_E_LOWER || this.peek() === CH_E_UPPER) {
      this.advance();
      if (this.peek() === CH_PLUS || this.peek() === CH_MINUS) {
        this.advance();
      }
      if (!this.isDigit()) {
        throw this.error("invalid number (expected a digit in exponent)");
      }
      while (this.isDigit()) {
        this.advance();
      }
    }
    if (this.isDigit() || this.peek() === CH_DOT) {
      throw new JsoncSyntaxError("invalid number (leading zeros are not allowed)", start.line, start.column);
    }
    return Number(this.text.slice(begin, this.pos));
  }

  private isDigit(): boolean {
    const c = this.peek();
    return c >= CH_0 && c <= CH_9;
  }
}
