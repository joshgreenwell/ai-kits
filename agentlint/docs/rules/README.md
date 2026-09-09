# Generic rules

Generated from rule metadata by `scripts/render_rule_docs.py`; do not edit by hand.

| Rule | Category | Tier / Confidence | Requirements |
| -- | -- | -- | -- |
| [NO_PROGRESS_CYCLE](NO_PROGRESS_CYCLE.md) | reliability | proven / medium | `args_fingerprint(full)`, `result_fingerprint(full)`, `ordering` |
| [IDENTICAL_RETRY_AFTER_FAILURE](IDENTICAL_RETRY_AFTER_FAILURE.md) | reliability | proven / medium | `args_fingerprint(full)`, `status`, `ordering` |
| [CONTEXT_GROWTH](CONTEXT_GROWTH.md) | context | projected / medium | `model_call`, `tokens_in(model_call)`, `token_basis(model_call)`, `model(model_call)`, `ordering` |
| [OVERSIZED_TOOL_RESULT](OVERSIZED_TOOL_RESULT.md) | cost | proven / high | `result_bytes` |
| [REPEATED_TOOL_RESULT](REPEATED_TOOL_RESULT.md) | cost | proven / medium | `result_fingerprint(full)`, `result_bytes` |

Generic rules never read `Event.scope` beyond the neutral `agentlint` tag namespace; app-specific rules read their own namespace only (see `examples/rules/grouped_request_scope_loss.py`).
