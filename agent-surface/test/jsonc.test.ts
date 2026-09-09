import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_DEPTH, escapePointerToken, parseJsonc } from "../src/jsonc.js";
import type { JsonObject } from "../src/types.js";
import { readFixture } from "./helpers.js";

function ok(text: string | Uint8Array, options = {}) {
  const result = parseJsonc(text, options);
  assert.deepEqual(result.incomplete, [], `expected a clean parse, got ${JSON.stringify(result.incomplete)}`);
  assert.notEqual(result.value, undefined);
  return result;
}

/** Strip the null prototypes so `deepEqual` can compare against literals. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function bad(text: string | Uint8Array, options = {}) {
  const result = parseJsonc(text, options);
  assert.equal(result.value, undefined, "value must be undefined when incomplete");
  assert.ok(result.incomplete.length > 0, "expected an incomplete record");
  return result;
}

describe("JSONC parser: comments and trailing commas (JG-147)", () => {
  it("accepts // and /* */ comments and trailing commas in objects and arrays", () => {
    const result = ok(readFixture("jsonc/comments-trailing-commas.jsonc"), { path: "fixture" });
    assert.deepEqual(plain(result.value), {
      permissions: { allow: ["Bash(npm test)", "Read"], deny: ["Bash(curl *)"] },
      defaultMode: "acceptEdits",
    });
  });

  it("handles a // comment at end of input without a newline", () => {
    assert.deepEqual(plain(ok('{"a": 1} // done').value), { a: 1 });
  });

  it("does not treat comment markers inside strings as comments", () => {
    assert.deepEqual(plain(ok('{"url": "http://x/y", "c": "/* not a comment */"}').value), {
      url: "http://x/y",
      c: "/* not a comment */",
    });
  });

  it("rejects an unterminated block comment with its starting line", () => {
    const result = bad('{\n"a": 1\n}\n/* never closed');
    assert.match(result.incomplete[0]?.reason ?? "", /unterminated block comment \(line 4, column 1\)/);
    assert.deepEqual(result.incomplete[0]?.lines, [4]);
  });

  it("rejects a lone comma and a leading comma", () => {
    bad("[1,,2]");
    bad("{,}");
    bad("[,]");
  });
});

describe("JSONC parser: line numbers and JSON pointers", () => {
  it("records a position for every value, keyed by RFC 6901 pointer", () => {
    const result = ok(readFixture("jsonc/comments-trailing-commas.jsonc"));
    assert.deepEqual(result.pointers.get(""), { line: 5, column: 1 });
    assert.deepEqual(result.pointers.get("/permissions"), { line: 7, column: 18 });
    assert.deepEqual(result.pointers.get("/permissions/allow"), { line: 8, column: 14 });
    assert.deepEqual(result.pointers.get("/permissions/allow/0"), { line: 9, column: 7 });
    assert.deepEqual(result.pointers.get("/permissions/allow/1"), { line: 10, column: 7 });
    assert.deepEqual(result.pointers.get("/permissions/deny"), { line: 12, column: 13 });
    assert.deepEqual(result.pointers.get("/permissions/deny/0"), { line: 12, column: 14 });
    assert.deepEqual(result.pointers.get("/defaultMode"), { line: 14, column: 18 });
    assert.equal(result.pointers.size, 8);
  });

  it("escapes ~ and / in pointer tokens", () => {
    assert.equal(escapePointerToken("a/b~c"), "a~1b~0c");
    const result = ok('{"a/b": {"~": 1}}');
    assert.deepEqual(result.pointers.get("/a~1b/~0"), { line: 1, column: 15 });
  });

  it("keeps positions accurate across multi-line block comments", () => {
    const result = ok('/* one\ntwo\nthree */\n{\n  "a": /* inline\nbreak */ 1\n}');
    assert.deepEqual(result.pointers.get(""), { line: 4, column: 1 });
    assert.deepEqual(result.pointers.get("/a"), { line: 6, column: 10 });
  });
});

describe("JSONC parser: duplicate keys are never last-wins", () => {
  it("reports a top-level duplicate with the pointer and both line numbers", () => {
    const result = bad(readFixture("jsonc/duplicate-keys.jsonc"), { path: ".claude/settings.json" });
    assert.deepEqual(result.incomplete, [
      { path: ".claude/settings.json", reason: 'duplicate key "allow" at /permissions/allow', lines: [7, 8] },
      { path: ".claude/settings.json", reason: 'duplicate key "defaultMode" at /defaultMode', lines: [10, 11] },
    ]);
  });

  it("reports a duplicate nested inside an array of objects", () => {
    const result = bad(readFixture("jsonc/nested-duplicate.jsonc"), { path: "f" });
    assert.deepEqual(result.incomplete, [
      { path: "f", reason: 'duplicate key "matcher" at /hooks/PreToolUse/0/matcher', lines: [9, 10] },
    ]);
  });

  it("keeps the first occurrence's positions and still parses the rest", () => {
    const result = bad('{\n"a": {"x": 1},\n"a": {"x": 2},\n"b": 3\n}');
    assert.deepEqual(result.pointers.get("/a/x"), { line: 2, column: 12 });
    assert.deepEqual(result.pointers.get("/b"), { line: 4, column: 6 });
  });

  it("does not report distinct keys that differ only in escaping as duplicates of each other", () => {
    ok('{"a": 1, "\\u0062": 2}');
    bad('{"a": 1, "\\u0061": 2}');
  });
});

describe("JSONC parser: size and depth limits", () => {
  it("rejects input above the byte limit before parsing", () => {
    const big = `{"a": "${"x".repeat(DEFAULT_MAX_BYTES)}"}`;
    const result = bad(big, { path: "big" });
    assert.match(result.incomplete[0]?.reason ?? "", /exceeds size limit/);
    assert.equal(result.incomplete[0]?.lines, null);
  });

  it("measures the limit in UTF-8 bytes and honours a custom maxBytes", () => {
    bad('{"é": 1}', { maxBytes: 8 });
    ok('{"é": 1}', { maxBytes: 9 });
  });

  it("accepts nesting up to the depth limit and rejects one level deeper", () => {
    const atLimit = "[".repeat(DEFAULT_MAX_DEPTH) + "]".repeat(DEFAULT_MAX_DEPTH);
    ok(atLimit);
    const over = "[".repeat(DEFAULT_MAX_DEPTH + 1) + "]".repeat(DEFAULT_MAX_DEPTH + 1);
    const result = bad(over);
    assert.match(result.incomplete[0]?.reason ?? "", /nesting depth exceeds limit \(33 > 32\)/);
  });

  it("counts objects and arrays together toward depth", () => {
    bad('{"a": [{"b": [1]}]}', { maxDepth: 3 });
    ok('{"a": [{"b": [1]}]}', { maxDepth: 4 });
  });
});

describe("JSONC parser: prototype-pollution safety", () => {
  it("stores __proto__, constructor and prototype as plain data on a null-prototype object", () => {
    const result = ok(readFixture("jsonc/proto.json"));
    const value = result.value as JsonObject;
    assert.equal(Object.getPrototypeOf(value), null);
    assert.ok(Object.hasOwn(value, "__proto__"));
    assert.deepEqual(plain(value["__proto__"]), { polluted: true });
    assert.deepEqual(plain(value["constructor"]), { prototype: { polluted: true } });
    assert.equal(value["prototype"], "plain data");
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    assert.equal(Object.getPrototypeOf(value["__proto__"]), null);
    assert.ok(JSON.stringify(value).includes('"__proto__"'));
  });
});

describe("JSONC parser: BOM and CRLF (negative case)", () => {
  it("parses a file with a leading BOM and keeps columns unshifted", () => {
    const bytes = readFixture("jsonc/bom.json");
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    const result = ok(bytes);
    assert.deepEqual(plain(result.value), { defaultMode: "plan" });
    assert.deepEqual(result.pointers.get(""), { line: 5, column: 1 });
    assert.deepEqual(result.pointers.get("/defaultMode"), { line: 6, column: 18 });
  });

  it("parses CRLF input with accurate line numbers", () => {
    const bytes = readFixture("jsonc/crlf.json");
    assert.ok(Buffer.from(bytes).includes("\r\n"));
    const result = ok(bytes);
    assert.deepEqual(result.pointers.get(""), { line: 5, column: 1 });
    assert.deepEqual(result.pointers.get("/permissions/allow/0"), { line: 7, column: 15 });
    assert.deepEqual(result.pointers.get("/defaultMode"), { line: 9, column: 18 });
  });

  it("treats a lone CR as a newline and reports errors on the right line", () => {
    const result = bad('{\r"a": 1,\r"b": }');
    assert.match(result.incomplete[0]?.reason ?? "", /line 3, column 6/);
  });

  it("reports duplicate lines correctly in CRLF input", () => {
    const result = bad('{\r\n"a": 1,\r\n"a": 2\r\n}');
    assert.deepEqual(result.incomplete[0]?.lines, [2, 3]);
  });
});

describe("JSONC parser: malformed input yields incomplete with a reason", () => {
  it("names the line and column of the fixture's syntax error", () => {
    const result = bad(readFixture("jsonc/malformed.jsonc"), { path: "m" });
    assert.equal(result.incomplete[0]?.path, "m");
    assert.match(result.incomplete[0]?.reason ?? "", /expected ',' or '\]' after array element, found '\}' \(line 8, column 3\)/);
    assert.deepEqual(result.incomplete[0]?.lines, [8]);
  });

  const cases: Array<[string, string, RegExp]> = [
    ["empty document", "", /empty document/],
    ["comment-only document", "// nothing\n/* here */", /empty document/],
    ["unterminated string", '{"a": "oops}', /unterminated string/],
    ["missing colon", '{"a" 1}', /expected ':'/],
    ["trailing content", '{"a": 1} {"b": 2}', /unexpected trailing content/],
    ["single-quoted string", "{'a': 1}", /expected property name/],
    ["invalid escape", '{"a": "\\x"}', /invalid escape sequence/],
    ["short unicode escape", '{"a": "\\u12"}', /invalid \\u escape/],
    ["raw control character", '{"a": "tab\there"}', /control character U\+0009/],
    ["leading zero", "[01]", /leading zeros/],
    ["bare decimal", "[.5]", /expected a JSON value/],
    ["plus sign", "[+1]", /expected a JSON value/],
    ["NaN literal", "[NaN]", /expected a JSON value/],
    ["truncated literal", "[tru]", /expected a JSON value/],
    ["dangling exponent", "[1e]", /expected a digit in exponent/],
    ["unterminated object", '{"a": 1', /expected ',' or '\}'/],
    ["unterminated array", "[1, 2", /expected ',' or '\]'/],
  ];
  for (const [name, text, pattern] of cases) {
    it(`rejects ${name}`, () => {
      const result = bad(text);
      assert.equal(result.incomplete.length, 1);
      assert.match(result.incomplete[0]?.reason ?? "", pattern);
      assert.match(result.incomplete[0]?.reason ?? "", /\(line \d+, column \d+\)$/);
    });
  }

  it("rejects bytes that are not valid UTF-8", () => {
    const result = bad(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    assert.match(result.incomplete[0]?.reason ?? "", /not valid UTF-8/);
  });
});

describe("JSONC parser: strings and numbers", () => {
  it("decodes escapes including surrogate pairs", () => {
    assert.deepEqual(ok('["\\"\\\\\\/\\b\\f\\n\\r\\t", "\\u00e9", "\\ud83d\\ude00"]').value, [
      '"\\/\b\f\n\r\t',
      "é",
      "\u{1F600}",
    ]);
  });

  it("parses the JSON number grammar", () => {
    assert.deepEqual(ok("[0, -0, 1.5, -2e3, 6.02E+23, 1e-2, 10]").value, [0, -0, 1.5, -2000, 6.02e23, 0.01, 10]);
  });

  it("parses literals", () => {
    assert.deepEqual(ok("[true, false, null]").value, [true, false, null]);
  });
});
