"""Plain-text renderer: incomplete inputs → per run coverage → findings → stats.

The text form is for a terminal. It shows identifiers, hashes (excerpted),
counts and sizes; snippets appear only when the document carries them
(``--include-snippets``), already redacted and truncated.

What this renderer never does:

* never says "clean" — a run without findings is reported as "no findings"
  together with its coverage state, and an incomplete run is labelled
  ``INCOMPLETE`` before its findings are listed;
* never reorders the document's findings or evidence;
* never prints content from ``raw_records``.
"""

from __future__ import annotations

from typing import Any

EVIDENCE_SHOWN = 3
"""Evidence citations printed per finding before ``... +N more``."""

HASH_EXCERPT = 12


def _fmt(value: Any) -> str:
    """Numbers and identifiers as text; ``None`` is shown as ``-`` (absent, never zero)."""
    if value is None:
        return "-"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, dict) and "hash" in value:
        return f"{value['hash'][:HASH_EXCERPT]}… ({value.get('representation')})"
    return str(value)


def _thresholds(thresholds: dict[str, Any]) -> str:
    if not thresholds:
        return "none"
    return ", ".join(f"{k}={_fmt(thresholds[k])}" for k in sorted(thresholds))


def _evidence_line(item: dict[str, Any]) -> str:
    text = f"{item['event_id']} @ {item['source_locator']}"
    if item.get("field"):
        text += f" {item['field']}={_fmt(item.get('value'))}"
    if item.get("note"):
        text += f" ({item['note']})"
    return text


def render_incomplete(document: dict[str, Any]) -> list[str]:
    """The block printed first: every input that could not be loaded."""
    items = document.get("incomplete") or []
    if not items:
        return []
    lines = [f"INCOMPLETE INPUT ({len(items)}) — these files were not analysed:"]
    for item in items:
        loader = f" [{item['loader']}]" if item.get("loader") else ""
        locator = f" at {item['locator']}" if item.get("locator") else ""
        lines.append(f"  - {item['path']}{loader}{locator}: {item['reason']}")
    lines.append("")
    return lines


def render_inputs(document: dict[str, Any]) -> list[str]:
    """One line per input file with its loader and status."""
    lines = ["Inputs:"]
    for entry in document.get("inputs") or []:
        for f in entry.get("files") or []:
            loader = f.get("loader") or "-"
            runs = f"runs: {', '.join(f['run_ids'])}" if f.get("run_ids") else f["status"]
            lines.append(f"  - {f['path']} [{loader}] {runs}")
    lines.append("")
    return lines


def render_coverage(run_doc: dict[str, Any]) -> list[str]:
    """Coverage block: completeness, reasons, counts, per-field state, rule abstentions."""
    cov = run_doc["coverage"]
    state = "INCOMPLETE" if cov["completeness"] == "incomplete" else "complete"
    lines = [f"Coverage: {state}"]
    for reason in cov.get("reasons") or []:
        lines.append(f"  reason: {reason}")
    for note in cov.get("truncation_notes") or []:
        lines.append(f"  truncation: {note}")
    lines.append(
        f"  events: {_fmt(cov.get('events_total'))} "
        f"(dropped as duplicates: {_fmt(cov.get('events_dropped_dedup'))})"
    )
    fields = cov.get("fields") or {}
    for status in ("present", "partial", "absent"):
        names = sorted(k for k, v in fields.items() if v == status)
        if names:
            lines.append(f"  {status}: {', '.join(names)}")
    for note in cov.get("notes") or []:
        lines.append(f"  note [{note['code']}]: {note['message']}")
    summary = run_doc.get("summary")
    if summary:
        lines.append(f"  {summary}")
    for note in run_doc.get("abstentions") or []:
        lines.append(f"    - {note['message']}")
    return lines


def render_findings(run_doc: dict[str, Any]) -> list[str]:
    """Findings block: one entry per collapsed pattern, evidence excerpted."""
    findings = run_doc.get("findings") or []
    incomplete = run_doc["coverage"]["completeness"] == "incomplete" or bool(run_doc.get("summary"))
    if not findings:
        if incomplete:
            return ["Findings: none reported (coverage INCOMPLETE — this is not a clean result)"]
        return ["Findings: none (coverage complete)"]
    lines = [f"Findings ({len(findings)}):"]
    snippets = run_doc.get("snippets")
    for index, f in enumerate(findings, start=1):
        lines.append(f"  {index}. {f['rule_id']} [{f['tier']}/{f['confidence']}] {f['title']}")
        lines.append(f"     pattern: {f['observed_pattern']}")
        if f.get("impact"):
            lines.append(f"     impact: {f['impact']}")
        lines.append(f"     thresholds: {_thresholds(f.get('thresholds') or {})}")
        evidence = f.get("evidence") or []
        lines.append(f"     evidence ({len(evidence)} citation(s)):")
        for item in evidence[:EVIDENCE_SHOWN]:
            lines.append(f"       - {_evidence_line(item)}")
            if snippets is not None:
                key = f"{item['event_id']}@{item['source_locator']}"
                if key in snippets:
                    lines.append(f"         snippet: {snippets[key]}")
        if len(evidence) > EVIDENCE_SHOWN:
            lines.append(f"       ... +{len(evidence) - EVIDENCE_SHOWN} more")
        for text in f.get("limitations") or []:
            lines.append(f"     limitation: {text}")
        lines.append(f"     fingerprint: {f['fingerprint'][:HASH_EXCERPT]}…")
    return lines


def render_errors(run_doc: dict[str, Any]) -> list[str]:
    errors = run_doc.get("errors") or []
    if not errors:
        return []
    lines = [f"Rule errors ({len(errors)}) — reported, not findings:"]
    lines.extend(f"  - {e['rule_id']} ({e['stage']}): {e['message']}" for e in errors)
    return lines


def render_stats(run_doc: dict[str, Any]) -> list[str]:
    """Stats block: counts, latency distribution per kind, token totals per basis."""
    stats = run_doc.get("stats") or {}
    lines = ["Stats:"]
    by_kind = ", ".join(f"{k}={v}" for k, v in sorted((stats.get("by_kind") or {}).items()))
    by_status = ", ".join(f"{k}={v}" for k, v in sorted((stats.get("by_status") or {}).items()))
    lines.append(f"  events by kind: {by_kind or '-'}")
    lines.append(f"  events by status: {by_status or '-'}")
    lines.append(f"  run span: {_fmt(stats.get('span_ms'))} ms")
    lines.append("  latency (ms, min/p50/p90/max):")
    for row in stats.get("latency") or []:
        lines.append(
            f"    {row['kind']}: {_fmt(row['min_ms'])}/{_fmt(row['p50_ms'])}/"
            f"{_fmt(row['p90_ms'])}/{_fmt(row['max_ms'])} "
            f"({row['measured']} of {row['events']} measured; "
            f"slowest {_fmt(row['slowest_event_id'])})"
        )
    lines.append("  tokens by basis (never summed across bases):")
    totals = stats.get("tokens_by_basis") or []
    if not totals:
        lines.append("    none (no model call with a known token basis)")
    for row in totals:
        aggregate = " [aggregate usage]" if row.get("is_aggregate") else ""
        lines.append(
            f"    {row['token_basis']}: calls={row['calls']} in={_fmt(row['tokens_in'])} "
            f"out={_fmt(row['tokens_out'])} cache_read={_fmt(row['cache_read_tokens'])} "
            f"cache_write={_fmt(row['cache_write_tokens'])}{aggregate}"
        )
    without = stats.get("calls_without_token_basis")
    if without:
        lines.append(f"    model calls without a token basis: {without}")
    return lines


def render_run(run_doc: dict[str, Any]) -> list[str]:
    run = run_doc["run"]
    lines = [f"== run {run['id']} ({run['source_format']}) =="]
    if run.get("conversation_id"):
        lines.append(f"conversation: {run['conversation_id']}")
    if run.get("source_refs"):
        lines.append("sources: " + ", ".join(run["source_refs"]))
    lines.extend(render_coverage(run_doc))
    lines.extend(render_findings(run_doc))
    lines.extend(render_errors(run_doc))
    lines.extend(render_stats(run_doc))
    lines.append("")
    return lines


def render_text(document: dict[str, Any]) -> str:
    """The whole document as terminal text (see the module docstring for the order)."""
    summary = document["summary"]
    lines = [f"agentlint {document['agentlint_version']}", ""]
    lines.extend(render_incomplete(document))
    lines.extend(render_inputs(document))
    if summary.get("unknown_run_id") is not None:
        loaded = sorted(
            {rid for e in document["inputs"] for f in e["files"] for rid in f["run_ids"]}
        )
        lines.append(
            f"run {summary['unknown_run_id']!r} not found; loaded runs: "
            + (", ".join(loaded) or "none")
        )
        lines.append("")
    if not document["runs"] and summary.get("unknown_run_id") is None:
        lines.append("No run could be loaded from the inputs.")
        lines.append("")
    for run_doc in document["runs"]:
        lines.extend(render_run(run_doc))
    state = "INCOMPLETE" if summary["incomplete"] else "complete"
    lines.append(
        f"Summary: {summary['runs']} run(s) analysed, {summary['findings']} finding(s), "
        f"coverage {state}; exit code {summary['exit_code']} ({summary['exit_meaning']})"
    )
    return "\n".join(lines) + "\n"
