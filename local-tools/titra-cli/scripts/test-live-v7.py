#!/usr/bin/env python3
"""Source-checkout entry point for the Titra CLI v7 post-deployment suite."""

import sys
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
main = import_module("titra_cli.v7_harness").main


if __name__ == "__main__":
    raise SystemExit(main())
