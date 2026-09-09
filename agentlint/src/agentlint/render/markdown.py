"""Markdown renderer: a shareable report in the same order as the text form.

Meant to be pasted into an issue or a chat: incomplete inputs first, then
per run the coverage block, the findings table (one row per pattern, evidence
collapsed to a count and the first citations, thresholds and tier /
confidence shown) and the stats. It contains identifiers, hashes, counts and
sizes only — and redacted, truncated snippets when the document carries them.

What this renderer never does: never says "clean", never prints content,
never renders an incomplete run as "no findings" without its coverage state.
"""

from __future__ import annotations

from typing import Any

from agentlint.render.text import EVIDENCE_SHOWN, HASH_EXCERPT, _evidence_line, _fmt, _thresholds


def _cell(text: Any) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def _incomplete(document: dict[str, Any]) -> list[str]:
    items = document.get("incomplete") or []
    if not items:
        return []
    lines = [f"## Incomplete input ({len(items)})", "", "These files were **not analysed**:", ""]
    for item in items:
        loader = f" (`{item['loader']}`)" if item.get("loader") else ""
        lines.append(f"- `{_cell(item['path'])}`{loader}: {_cell(item['reason'])}")
    lines.append("")
    return lines


def _inputs(document: dict[str, Any]) -> list[str]:
    lines = ["## Inputs", "", "| File | Loader | Status | Runs |", "| -- | -- | -- | -- |"]
    for entry in document.get("inputs") or []:
        for f in entry.get("files") or []:
            lines.append(
                f"| `{_cell(f['path'])}` | {f.get('loader') or '-'} | {f['status']} | "
                f"{', '.join(f.get('run_ids') or []) or '-'} |"
            )
    lines.append("")
    return lines


def _coverage(run_doc: dict[str, Any]) -> list[str]:
    cov = run_doc["coverage"]
    state = "**INCOMPLETE**" if cov["completeness"] == "incomplete" else "complete"
    lines = ["### Coverage", "", f"Completeness: {state}", ""]
    for reason in cov.get("reasons") or []:
        lines.append(f"- reason: {_cell(reason)}")
    for note in cov.get("truncation_notes") or []:
        lines.append(f"- truncation: {_cell(note)}")
    lines.append(
        f"- events: {_fmt(cov.get('events_total'))} "
        f"(dropped as duplicates: {_fmt(cov.get('events_dropped_dedup'))})"
    )
    fields = cov.get("fields") or {}
    for status in ("present", "partial", "absent"):
        names = sorted(k for k, v in fields.items() if v == status)
        if names:
            lines.append(f"- {status}: " + ", ".join(f"`{n}`" for n in names))
    for note in cov.get("notes") or []:
        lines.append(f"- note `{note['code']}`: {_cell(note['message'])}")
    if run_doc.get("summary"):
        lines.append(f"- **{run_doc['summary']}**")
        for note in run_doc.get("abstentions") or []:
            lines.append(f"  - {_cell(note['message'])}")
    lines.append("")
    return lines


def _findings(run_doc: dict[str, Any]) -> list[str]:
    findings = run_doc.get("findings") or []
    incomplete = run_doc["coverage"]["completeness"] == "incomplete" or bool(run_doc.get("summary"))
    lines = ["### Findings", ""]
    if not findings:
        if incomplete:
            lines.append(
                "None reported — coverage is **INCOMPLETE**, so this is not a clean result."
            )
        else:
            lines.append("None (coverage complete).")
        lines.append("")
        return lines
    lines.extend(
        [
            "| # | Rule | Tier / Confidence | Pattern | Thresholds | Evidence |",
            "| -- | -- | -- | -- | -- | -- |",
        ]
    )
    for index, f in enumerate(findings, start=1):
        lines.append(
            f"| {index} | `{f['rule_id']}` | {f['tier']} / {f['confidence']} | "
            f"{_cell(f['observed_pattern'])} | {_cell(_thresholds(f.get('thresholds') or {}))} | "
            f"{len(f.get('evidence') or [])} citation(s) |"
        )
    lines.append("")
    snippets = run_doc.get("snippets")
    for index, f in enumerate(findings, start=1):
        lines.append(f"#### {index}. {f['rule_id']} — {_cell(f['title'])}")
        lines.append("")
        if f.get("impact"):
            lines.append(f"Impact: {_cell(f['impact'])}")
            lines.append("")
        evidence = f.get("evidence") or []
        for item in evidence[:EVIDENCE_SHOWN]:
            lines.append(f"- `{_cell(_evidence_line(item))}`")
            if snippets is not None:
                key = f"{item['event_id']}@{item['source_locator']}"
                if key in snippets:
                    lines.append(f"  - snippet: `{_cell(snippets[key])}`")
        if len(evidence) > EVIDENCE_SHOWN:
            lines.append(f"- … +{len(evidence) - EVIDENCE_SHOWN} more citation(s)")
        for text in f.get("limitations") or []:
            lines.append(f"- limitation: {_cell(text)}")
        lines.append(f"- fingerprint: `{f['fingerprint'][:HASH_EXCERPT]}…`")
        lines.append("")
    return lines


def _errors(run_doc: dict[str, Any]) -> list[str]:
    errors = run_doc.get("errors") or []
    if not errors:
        return []
    lines = ["### Rule errors (reported, not findings)", ""]
    lines.extend(f"- `{e['rule_id']}` ({e['stage']}): {_cell(e['message'])}" for e in errors)
    lines.append("")
    return lines


def _stats(run_doc: dict[str, Any]) -> list[str]:
    stats = run_doc.get("stats") or {}
    lines = ["### Stats", ""]
    by_kind = ", ".join(f"{k}={v}" for k, v in sorted((stats.get("by_kind") or {}).items()))
    by_status = ", ".join(f"{k}={v}" for k, v in sorted((stats.get("by_status") or {}).items()))
    lines.append(f"- events by kind: {by_kind or '-'}")
    lines.append(f"- events by status: {by_status or '-'}")
    lines.append(f"- run span: {_fmt(stats.get('span_ms'))} ms")
    lines.append("")
    lines.append("| Kind | Events | Measured | min ms | p50 ms | p90 ms | max ms | Slowest |")
    lines.append("| -- | -- | -- | -- | -- | -- | -- | -- |")
    for row in stats.get("latency") or []:
        lines.append(
            f"| {row['kind']} | {row['events']} | {row['measured']} | {_fmt(row['min_ms'])} | "
            f"{_fmt(row['p50_ms'])} | {_fmt(row['p90_ms'])} | {_fmt(row['max_ms'])} | "
            f"{_fmt(row['slowest_event_id'])} |"
        )
    lines.append("")
    lines.append("Token totals per basis (never summed across bases):")
    lines.append("")
    totals = stats.get("tokens_by_basis") or []
    if not totals:
        lines.append("- none (no model call with a known token basis)")
    for row in totals:
        aggregate = " (aggregate usage)" if row.get("is_aggregate") else ""
        lines.append(
            f"- `{row['token_basis']}`: calls={row['calls']} in={_fmt(row['tokens_in'])} "
            f"out={_fmt(row['tokens_out'])} cache_read={_fmt(row['cache_read_tokens'])} "
            f"cache_write={_fmt(row['cache_write_tokens'])}{aggregate}"
        )
    if stats.get("calls_without_token_basis"):
        lines.append(f"- model calls without a token basis: {stats['calls_without_token_basis']}")
    lines.append("")
    return lines


def render_markdown(document: dict[str, Any]) -> str:
    """The whole document as Markdown (incomplete → per run coverage → findings → stats)."""
    summary = document["summary"]
    lines = [f"# agentlint {document['agentlint_version']} report", ""]
    lines.extend(_incomplete(document))
    lines.extend(_inputs(document))
    if summary.get("unknown_run_id") is not None:
        lines.append(f"Run `{_cell(summary['unknown_run_id'])}` not found among the loaded runs.")
        lines.append("")
    if not document["runs"] and summary.get("unknown_run_id") is None:
        lines.append("No run could be loaded from the inputs.")
        lines.append("")
    for run_doc in document["runs"]:
        run = run_doc["run"]
        lines.append(f"## Run `{_cell(run['id'])}` (`{run['source_format']}`)")
        lines.append("")
        if run.get("source_refs"):
            lines.append("Sources: " + ", ".join(f"`{_cell(s)}`" for s in run["source_refs"]))
            lines.append("")
        lines.extend(_coverage(run_doc))
        lines.extend(_findings(run_doc))
        lines.extend(_errors(run_doc))
        lines.extend(_stats(run_doc))
    state = "**INCOMPLETE**" if summary["incomplete"] else "complete"
    lines.append(
        f"Summary: {summary['runs']} run(s) analysed, {summary['findings']} finding(s), "
        f"coverage {state}; exit code {summary['exit_code']} ({summary['exit_meaning']})."
    )
    return "\n".join(lines) + "\n"
