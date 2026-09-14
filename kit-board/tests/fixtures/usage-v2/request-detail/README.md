# Request detail fixture

- Origin: hand-written synthetic examples based on the field names and value types observed in Claude Code 2.1.266 and Codex local histories on September 13, 2026.
- Reference: USG-004 and `docs/usage-coverage.md` process P1.
- Completeness: focused examples for request tokens, nullable fields, explicit zero usage, cumulative Codex deltas, absent cumulative fields, declining reasoning counters, reasoning effort, service tier, speed, context window, and cache-write TTL. They are not complete provider transcripts.
- Form: synthetic raw JSONL shaped like each provider's local history. Identifiers, paths, timestamps, versions, models, and counts are invented; no private trace content or credentials are included.
