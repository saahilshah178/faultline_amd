"""The generated blocks in README.md and docs/submission.md match results/."""

from __future__ import annotations

import pytest

from faultline import report
from faultline.evaluate import BENCH_JSON

needs_results = pytest.mark.skipif(not BENCH_JSON.exists(), reason="no results/bench.json")


@needs_results
def test_documents_are_in_step_with_results():
    assert report.main(["--check"]) == 0, "run: python -m faultline.report"


@needs_results
def test_render_only_touches_marked_blocks_and_is_idempotent():
    bench = report._bench()
    text = "intro 12.5\n<!-- headline:start -->\nSTALE_PLACEHOLDER\n<!-- headline:end -->\noutro 99\n"
    once = report.render(text, bench)
    assert once.startswith("intro 12.5\n") and once.endswith("outro 99\n")
    assert "STALE_PLACEHOLDER" not in once and "Failures detected" in once
    assert report.render(once, bench) == once


@needs_results
def test_status_block_never_claims_the_mi300x_for_a_local_run():
    bench = report._bench()
    status = report.block_status(bench)
    training = report.block_training(bench)
    if bench["training"]["trained_on_mi300x"]:
        assert "MI300X" in training
    else:
        assert "not yet the MI300X" in status and "not yet the MI300X" in training
