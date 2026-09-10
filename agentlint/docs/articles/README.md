# Articles

`launch-draft.md` is the **draft** of the Kit 1 launch article ("I linted 200
of my own Claude Code sessions"). It is not published and is not final:
every `[N]`, `[DATE]`, `[VERSIONS]`, `[REASON]`, `[EXAMPLE …]` and
`[WAITLIST_URL]` is a placeholder to be filled from a real local run before
publication (the publish step is a separate story).

The draft was reviewed against the shared §1 principles:

* **Local, offline, deterministic** — the article says so and shows only
  output the tool produces without a network or a model.
* **Evidence-backed** — every example is real output (the healthy fixture and
  the aggregate-usage fixture under `tests/e2e/`, pasted verbatim); the
  session-level examples are marked as placeholders until they are pasted
  from a real run, identifiers included.
* **Tiered claims** — `proven` / `projected` / `unresolved` are named and used
  consistently; `CONTEXT_GROWTH` is described as a candidate, never a cause.
* **Coverage first** — `incomplete for rules: [...]` is presented as a
  feature and leads the article; a run with zero findings is called what it
  is (complete coverage, no findings), never "clean".
* **No overclaiming** — no counts appear until measured; the "what changed"
  sentence is to be filled with a measured statement or deleted.

Before publishing, replace every placeholder, re-run the quoted commands
against the released wheel, and paste the outputs verbatim.
