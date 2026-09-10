import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeRule, normalizeSpec } from "../src/normalize.js";

describe("normalize: rule-string canonicalization (JG-151)", () => {
  it("Bash(npm run:*) and Bash(npm run *) normalize to the same key; raw text is retained", () => {
    const colon = normalizeRule("Bash(npm run:*)");
    const space = normalizeRule("Bash(npm run *)");
    assert.equal(colon.rule, "Bash(npm run *)");
    assert.equal(space.rule, "Bash(npm run *)");
    assert.equal(colon.raw, "Bash(npm run:*)");
    assert.equal(space.raw, "Bash(npm run *)");
    assert.equal(colon.tool, "Bash");
    assert.equal(colon.spec, "npm run *");
    assert.equal(colon.wildcard, "trailing");
    assert.equal(normalizeRule("Bash(npm run test:*)").rule, "Bash(npm run test *)");
  });

  it("trims leading and trailing whitespace of the rule, the tool name and the spec", () => {
    assert.equal(normalizeRule("  Read  ").rule, "Read");
    assert.equal(normalizeRule("  Read  ").raw, "  Read  ");
    assert.equal(normalizeRule(" Bash(curl *) ").rule, "Bash(curl *)");
    assert.equal(normalizeRule("Bash( npm run  * )").rule, "Bash(npm run *)");
    assert.equal(normalizeRule("Bash ( npm test )").rule, "Bash(npm test)");
    assert.equal(normalizeRule("Bash ( npm test )").tool, "Bash");
  });

  it("preserves internal whitespace inside the prefix (documented as significant)", () => {
    assert.notEqual(normalizeRule("Bash(echo  a)").rule, normalizeRule("Bash(echo a)").rule);
    assert.equal(normalizeRule("Bash(echo  a *)").rule, "Bash(echo  a *)");
    assert.equal(normalizeRule("Bash(echo  a:*)").rule, "Bash(echo  a *)");
  });

  it("negative case: Bash(npm run *) and Bash(npm run) are different keys (prefix vs exact)", () => {
    const prefix = normalizeRule("Bash(npm run *)");
    const exact = normalizeRule("Bash(npm run)");
    assert.notEqual(prefix.rule, exact.rule);
    assert.equal(exact.rule, "Bash(npm run)");
    assert.equal(exact.wildcard, "none");
    assert.equal(prefix.wildcard, "trailing");
  });

  it("keeps Bash and Bash(*) as distinct keys and folds Bash(:*) / Bash( *) into Bash(*)", () => {
    assert.equal(normalizeRule("Bash").rule, "Bash");
    assert.equal(normalizeRule("Bash").spec, null);
    assert.equal(normalizeRule("Bash").wildcard, null);
    assert.equal(normalizeRule("Bash(*)").rule, "Bash(*)");
    assert.equal(normalizeRule("Bash(*)").wildcard, "whole");
    assert.equal(normalizeRule("Bash(:*)").rule, "Bash(*)");
    assert.equal(normalizeRule("Bash( *)").rule, "Bash(*)");
    assert.notEqual(normalizeRule("Bash").rule, normalizeRule("Bash(*)").rule);
  });

  it("leaves non-trailing wildcards, domain specs and mcp tool names untouched", () => {
    assert.equal(normalizeRule("Bash(git * main)").rule, "Bash(git * main)");
    assert.equal(normalizeRule("Bash(git * main)").wildcard, "none");
    assert.equal(normalizeRule("WebFetch(domain:example.com)").rule, "WebFetch(domain:example.com)");
    assert.equal(normalizeRule("Read(**/*)").rule, "Read(**/*)");
    assert.equal(normalizeRule("Read(**/*)").wildcard, "none");
    assert.equal(normalizeRule("mcp__docs__search").rule, "mcp__docs__search");
    assert.equal(normalizeRule("mcp__docs__search").spec, null);
    assert.equal(normalizeRule("Write(src/)").rule, "Write(src/)");
  });

  it("treats an unbalanced or leading parenthesis as a bare tool name and an empty string as an empty tool", () => {
    assert.equal(normalizeRule("Bash(npm").rule, "Bash(npm");
    assert.equal(normalizeRule("Bash(npm").spec, null);
    assert.equal(normalizeRule("(npm)").tool, "(npm)");
    assert.equal(normalizeRule("   ").tool, "");
    assert.equal(normalizeRule("").tool, "");
  });

  it("normalizeSpec is the single source of the trailing-wildcard rule", () => {
    assert.deepEqual(normalizeSpec("npm run:*"), { spec: "npm run *", wildcard: "trailing" });
    assert.deepEqual(normalizeSpec("npm run   *"), { spec: "npm run *", wildcard: "trailing" });
    assert.deepEqual(normalizeSpec(" * "), { spec: "*", wildcard: "whole" });
    assert.deepEqual(normalizeSpec("npm run"), { spec: "npm run", wildcard: "none" });
  });
});
