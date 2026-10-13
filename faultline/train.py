"""Train the detector and score the full timeline.

    python -m faultline.train              # full run, writes results/train.json
    python -m faultline.train --smoke DIR  # 1-epoch, 2-fold run into DIR (pipeline check only)
    python -m faultline.train --out DIR    # full run into DIR, for the reproducibility check

On the droplet this runs inside the rocm/pytorch container (scripts/remote_train.sh).
Outputs:
    data/scores.parquet   per-signal reconstruction error per window (not committed)
    models/detector.pt    final model weights, scaler and config (not committed)
    results/train.json    hardware, config and timings (committed)
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import platform
import subprocess
from datetime import UTC, datetime
from pathlib import Path

import torch

from faultline.config import DATA_DIR, MODELS_DIR, REPO_ROOT, RESULTS_DIR
from faultline.data import load
from faultline.detector import DetectorConfig, pick_device, run_training

SCORES_PATH = DATA_DIR / "scores.parquet"
MODEL_PATH = MODELS_DIR / "detector.pt"
TRAIN_REPORT = RESULTS_DIR / "train.json"


def git_commit() -> str | None:
    # The droplet gets the code by rsync, without .git; the laptop passes the commit along.
    if os.getenv("FAULTLINE_GIT_COMMIT"):
        return os.environ["FAULTLINE_GIT_COMMIT"]
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO_ROOT, capture_output=True, text=True, check=True,
        )
        return out.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--smoke", metavar="DIR", help="quick pipeline check, outputs into DIR")
    parser.add_argument("--out", metavar="DIR", help="full run, but write every output into DIR")
    parser.add_argument("--device", help="override device (cuda, mps, cpu)")
    parser.add_argument("--epochs", type=int, help="override the configured epochs (experiments only)")
    parser.add_argument("--folds", type=int, help="override the configured folds (experiments only)")
    args = parser.parse_args(argv)

    cfg = DetectorConfig()
    scores_path, model_path, report_path = SCORES_PATH, MODEL_PATH, TRAIN_REPORT
    if args.smoke:
        out = Path(args.smoke)
        out.mkdir(parents=True, exist_ok=True)
        cfg = dataclasses.replace(cfg, epochs=1, folds=2, trim_warmup_epochs=0)
        scores_path, model_path, report_path = out / "scores.parquet", out / "detector.pt", out / "train.json"

    elif args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        scores_path, model_path, report_path = out / "scores.parquet", out / "detector.pt", out / "train.json"

    if args.epochs or args.folds:
        cfg = dataclasses.replace(cfg, epochs=args.epochs or cfg.epochs, folds=args.folds or cfg.folds)

    device = torch.device(args.device) if args.device else pick_device()
    print(f"device: {device}  torch {torch.__version__}  hip {getattr(torch.version, 'hip', None)}")
    df = load()
    result = run_training(df, cfg, device)

    report = result["report"]
    report["run"] = {
        "finished_utc": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "host": platform.node(),
        "platform": platform.platform(),
        "git_commit": git_commit(),
        "smoke": bool(args.smoke),
    }

    scores_path.parent.mkdir(parents=True, exist_ok=True)
    model_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    result["scores"].to_parquet(scores_path, compression="zstd")
    torch.save(result["state"], model_path)
    report_path.write_text(json.dumps(report, indent=2) + "\n")

    hw = report["hardware"]
    print(f"trained on {hw['gpu_name'] or hw['device']} in {report['train_seconds_total']:.1f}s "
          f"({cfg.folds} folds + final), scored {report['windows_scored']:,} windows")
    print(f"wrote {scores_path}, {model_path}, {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
