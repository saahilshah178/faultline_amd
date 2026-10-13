#!/usr/bin/env bash
# Check that a clean training run reproduces results/bench.json.
#
#   scripts/reproduce.sh
#
# Retrains the detector from scratch into a temporary directory (same code, same
# seeds, same pre-failure data), evaluates it, and compares every number in the
# benchmark except timings with the committed results/bench.json. Run it on the
# same kind of hardware that produced the committed results; floating point
# differs across devices.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

uv run python -m faultline.data --summary >/dev/null 2>&1 || uv run python -m faultline.data
uv run python -m faultline.train --out "$WORK"
uv run python -m faultline.evaluate --check --from "$WORK"
