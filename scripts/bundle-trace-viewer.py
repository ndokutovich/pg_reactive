#!/usr/bin/env python3
"""Bundle the trace viewer into a single standalone HTML.

Reads ``docs/trace-viewer.html`` (the source viewer with empty embedded
slot) and ``docs/traceability.yaml`` (the matrix), then writes
``docs/trace-viewer.standalone.html`` with the matrix inlined between the
``PROJECT_TRACE_BUNDLE_BEGIN/END`` markers.

The output works via ``file://`` — double-click and the browser renders
it without fetch, without a local server. Use it for sharing snapshots
via e-mail, Slack, GitHub Pages, or attaching to a release.

The source viewer keeps working unchanged — fetch falls back to
``traceability.yaml`` from the same directory when the embedded slot
is empty.

No external Python deps.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_VIEWER = ROOT / "docs" / "trace-viewer.html"
DEFAULT_MATRIX = ROOT / "docs" / "traceability.yaml"
DEFAULT_OUTPUT = ROOT / "docs" / "trace-viewer.standalone.html"

BEGIN = "<!-- PROJECT_TRACE_BUNDLE_BEGIN -->"
END = "<!-- PROJECT_TRACE_BUNDLE_END -->"


def bundle(viewer_path: Path, matrix_path: Path, output_path: Path) -> int:
    if not viewer_path.exists():
        print(f"error: viewer not found at {viewer_path}", file=sys.stderr)
        return 2
    if not matrix_path.exists():
        print(f"error: matrix not found at {matrix_path}", file=sys.stderr)
        return 2

    viewer = viewer_path.read_text(encoding="utf-8")
    matrix = matrix_path.read_text(encoding="utf-8")

    begin_at = viewer.find(BEGIN)
    end_at = viewer.find(END)
    if begin_at < 0 or end_at < 0 or end_at <= begin_at:
        print(
            f"error: viewer at {viewer_path} is missing the BEGIN/END markers — "
            f"this isn't a project-trace viewer or it was edited",
            file=sys.stderr,
        )
        return 2

    # Escape any literal `</script>` in the matrix so the embedded slot can't
    # close prematurely. The viewer's readEmbeddedMatrix() reverses this.
    safe_matrix = matrix.replace("</script>", "<\\/script>")

    # Splice: everything up to and including BEGIN, then a newline, then the
    # matrix, then a newline, then everything from END onward.
    prefix = viewer[: begin_at + len(BEGIN)]
    suffix = viewer[end_at:]
    bundled = f"{prefix}\n{safe_matrix.rstrip()}\n{suffix}"

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(bundled, encoding="utf-8")
    size_kb = output_path.stat().st_size / 1024
    print(
        f"standalone viewer written: {output_path.relative_to(ROOT)} "
        f"({size_kb:.1f} KB, {len(matrix.splitlines())} matrix lines)"
    )
    print(f"open via file://  no HTTP server needed.")
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument(
        "--viewer", type=Path, default=DEFAULT_VIEWER,
        help=f"source viewer (default: {DEFAULT_VIEWER.relative_to(ROOT)})",
    )
    p.add_argument(
        "--matrix", type=Path, default=DEFAULT_MATRIX,
        help=f"matrix YAML (default: {DEFAULT_MATRIX.relative_to(ROOT)})",
    )
    p.add_argument(
        "-o", "--output", type=Path, default=DEFAULT_OUTPUT,
        help=f"standalone HTML output (default: {DEFAULT_OUTPUT.relative_to(ROOT)})",
    )
    args = p.parse_args(argv)
    return bundle(args.viewer, args.matrix, args.output)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
