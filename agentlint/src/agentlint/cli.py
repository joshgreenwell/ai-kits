"""Command-line entry point placeholder.

The real CLI (loaders, rules, JSON/terminal output) arrives in a later story.
This placeholder never reads input, never writes files and never touches the
network; it only prints a message and exits with status 1.
"""

from __future__ import annotations

import sys

from agentlint import __version__


def main(argv: list[str] | None = None) -> int:
    """Print a not-implemented notice to stderr and return exit status 1."""
    del argv  # no arguments are interpreted yet
    sys.stderr.write(f"agentlint {__version__}: command-line interface not implemented yet\n")
    return 1


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main(sys.argv[1:]))
