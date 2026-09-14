# Tool detail fixture

- Origin: hand-written synthetic examples based on the field names and value types observed in Claude Code 2.1.266 and Codex local histories on September 13, 2026.
- Reference: USG-006 and `docs/usage-coverage.md` process P4.
- Completeness: focused examples for multiple calls per request, built-in, MCP, function and custom call forms, wrapper arguments, duplicate records, explicit success/failure/denial, missing results, tool-only turns, caller joins, an unmapped future form, and an overlong custom name. They are not complete provider transcripts.
- Form: synthetic raw JSONL shaped like each provider's local history. Identifiers, content, timestamps, models, and counts are invented; no private trace content or credentials are included.
