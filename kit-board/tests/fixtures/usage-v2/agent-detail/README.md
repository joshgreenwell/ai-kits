# Agent detail fixture

- Origin: hand-written synthetic examples based only on the field names and value types observed in Claude Code 2.1.266 and Codex local histories on September 13, 2026.
- Reference: USG-005 and `docs/usage-coverage.md` Table 4.
- Completeness: focused examples for parent and child identities, nested and inline sidechains, resumed children, duplicate notifications, failed spawns, missing parents, role classification, requested and actual models, depth, privacy settings, and explicit unknown attribution. They are not complete provider transcripts.
- Form: synthetic raw JSONL and Claude sidecar JSON shaped like each provider's local history. Identifiers, paths, timestamps, models, roles, and counts are invented; no private trace content or credentials are included. `PRIVATE SENTINEL` values prove prompt-like fields never enter emitted records.
