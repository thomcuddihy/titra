#!/usr/bin/env python3
"""Executable entry point for the Titra CLI verification suite."""

import sys
from importlib import import_module
from pathlib import Path

if sys.version_info < (3, 11):  # noqa: UP036 - wrapper may be launched by the system Python
    print(
        "Titra CLI tests require Python 3.11 or newer; activate the documented environment.",
        file=sys.stderr,
    )
    raise SystemExit(2)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
main = import_module("titra_cli.selftest").main

if __name__ == "__main__":
    raise SystemExit(main())
