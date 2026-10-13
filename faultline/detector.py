"""1D-convolutional autoencoder over sliding windows of the seven analog signals.

Trained on pre-failure data only (before 2020-04-18). The anomaly score for a
window is the reconstruction error on its most recent samples, so the score at
time t uses data up to t and nothing later.

Device-agnostic: CUDA means ROCm on the MI300X (PyTorch exposes ROCm through the
CUDA API), with MPS/CPU fallbacks for local development.
"""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd
import torch
from torch import nn

from faultline.data import ANALOG_SIGNALS
from faultline.failures import FIRST_FAILURE_START, GAP_S, assert_pre_failure

@dataclass(frozen=True)
class DetectorConfig:
    # 192 samples at 10 s = 32 min: at least one full compressor cycle in three
    # quarters of pre-failure cycles (median period 24 min, 75th percentile 31 min).
    window: int = 192
    # The score is the error on the last `tail` samples (8 min) of each window. The
    # earlier 24 min are context; scoring only the newest samples keeps latency low.
    tail: int = 48
    latent: int = 16
    channels: tuple[int, ...] = (32, 64, 64, 32)
    epochs: int = 20
    batch_size: int = 1024
    lr: float = 1e-3
    weight_decay: float = 1e-5
    # "Normal operation only": pre-failure data is not perfectly clean. About 4% of
    # it is spent in sustained-load episodes that were never reported as failures
    # (see faultline.alarms.sustained_load_episodes). Windows that touch one are
    # left out of training.
    exclude_sustained_load: bool = True
    # Guard against whatever else is odd in the training data: each batch drops its
    # highest-loss windows.
    trim_fraction: float = 0.10
    trim_warmup_epochs: int = 1
    folds: int = 5
    seed: int = 7
    score_batch: int = 8192


def segment_ids(index: pd.DatetimeIndex) -> np.ndarray:
    """Label contiguous runs of the record; a new segment starts after every gap."""
    seconds = index.values.astype("datetime64[s]").astype(np.int64)
    breaks = np.diff(seconds, prepend=seconds[0]) > GAP_S
    return np.cumsum(breaks)


def valid_window_ends(seg: np.ndarray, window: int) -> np.ndarray:
    """Positions e such that rows [e - window + 1, e] all lie in one segment."""
    n = len(seg)
    starts = np.flatnonzero(np.diff(seg, prepend=seg[0] - 1) != 0)
    seg_start = np.repeat(starts, np.diff(np.append(starts, n)))
    pos_in_seg = np.arange(n) - seg_start
    return np.flatnonzero(pos_in_seg >= window - 1)


class ConvAutoencoder(nn.Module):
    def __init__(self, n_signals: int, window: int, channels: tuple[int, ...], latent: int):
        super().__init__()
        kernels = [7, 5, 5, 3][: len(channels)]
        reduced = window // (2 ** len(channels))
        if reduced * 2 ** len(channels) != window:
            raise ValueError("window must be divisible by 2**len(channels)")

        enc: list[nn.Module] = []
        prev = n_signals
        for ch, k in zip(channels, kernels):
            enc += [nn.Conv1d(prev, ch, k, stride=2, padding=k // 2), nn.GELU()]
            prev = ch
        self.encoder = nn.Sequential(*enc)
        self.to_latent = nn.Linear(prev * reduced, latent)
        self.from_latent = nn.Linear(latent, prev * reduced)
        self._reduced_shape = (prev, reduced)

        dec: list[nn.Module] = []
        rev = list(channels[::-1])
        for ch_in, ch_out in zip(rev, [*rev[1:], rev[-1]]):
            dec += [nn.ConvTranspose1d(ch_in, ch_out, 4, stride=2, padding=1), nn.GELU()]
        dec += [nn.Conv1d(rev[-1], n_signals, 3, padding=1)]
        self.decoder = nn.Sequential(*dec)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.to_latent(self.encoder(x).flatten(1))
        h = self.from_latent(z).view(-1, *self._reduced_shape)
        return self.decoder(h)


def pick_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def hardware_info(device: torch.device) -> dict:
    info: dict = {
        "device": device.type,
        "torch": torch.__version__,
        # Set on ROCm builds of PyTorch, None elsewhere.
        "hip": getattr(torch.version, "hip", None),
        "cuda": torch.version.cuda,
        "gpu_name": None,
        "gpu_memory_gb": None,
    }
    if device.type == "cuda":
        info["gpu_name"] = torch.cuda.get_device_name(0)
        info["gpu_memory_gb"] = round(torch.cuda.get_device_properties(0).total_memory / 2**30, 1)
    return info


def _sync(device: torch.device) -> None:
    if device.type == "cuda":
        torch.cuda.synchronize()
    elif device.type == "mps":
        torch.mps.synchronize()


def _gather(x: torch.Tensor, ends: torch.Tensor, window: int) -> torch.Tensor:
    """x: [N, C] series on device; ends: [B] window-end row positions -> [B, C, window]."""
    offsets = torch.arange(-window + 1, 1, device=x.device)
    return x[ends[:, None] + offsets].transpose(1, 2)


def fit_scaler(pre: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    assert_pre_failure(pre.index, "fit_scaler")
    values = pre[ANALOG_SIGNALS].to_numpy(dtype=np.float32)
    return values.mean(axis=0), values.std(axis=0)


def train_autoencoder(
    x: torch.Tensor,
    train_ends: np.ndarray,
    cfg: DetectorConfig,
    seed: int,
) -> tuple[ConvAutoencoder, dict]:
    """Train on the windows ending at `train_ends` (row positions into x)."""
    device = x.device
    torch.manual_seed(seed)
    model = ConvAutoencoder(x.shape[1], cfg.window, cfg.channels, cfg.latent).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
    steps_per_epoch = max(1, len(train_ends) // cfg.batch_size)
    sched = torch.optim.lr_scheduler.OneCycleLR(
        opt, max_lr=cfg.lr, total_steps=cfg.epochs * steps_per_epoch, pct_start=0.1
    )
    ends = torch.from_numpy(train_ends).to(device)
    shuffle = torch.Generator().manual_seed(seed)

    history = []
    _sync(device)
    t0 = time.perf_counter()
    for epoch in range(cfg.epochs):
        model.train()
        perm = torch.randperm(len(ends), generator=shuffle).to(device)
        keep = cfg.batch_size
        if epoch >= cfg.trim_warmup_epochs:
            keep = int(round(cfg.batch_size * (1 - cfg.trim_fraction)))
        total = torch.zeros((), device=device)
        for step in range(steps_per_epoch):
            batch = ends[perm[step * cfg.batch_size : (step + 1) * cfg.batch_size]]
            windows = _gather(x, batch, cfg.window)
            per_window = ((model(windows) - windows) ** 2).mean(dim=(1, 2))
            kept = per_window if keep >= len(per_window) else per_window.topk(keep, largest=False).values
            loss = kept.mean()
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            total += loss.detach()
        history.append(float(total / steps_per_epoch))
    _sync(device)
    seconds = time.perf_counter() - t0
    return model, {
        "seconds": round(seconds, 2),
        "windows": len(train_ends),
        "steps": int(cfg.epochs * steps_per_epoch),
        "first_epoch_loss": round(history[0], 5),
        "last_epoch_loss": round(history[-1], 5),
    }


@torch.no_grad()
def score_windows(
    model: ConvAutoencoder, x: torch.Tensor, ends: np.ndarray, cfg: DetectorConfig
) -> np.ndarray:
    """Per-signal squared error on the last `tail` samples of each window: [len(ends), C]."""
    model.eval()
    device = x.device
    out = np.empty((len(ends), x.shape[1]), dtype=np.float32)
    ends_t = torch.from_numpy(ends).to(device)
    for i in range(0, len(ends), cfg.score_batch):
        windows = _gather(x, ends_t[i : i + cfg.score_batch], cfg.window)
        err = (model(windows) - windows)[:, :, -cfg.tail :] ** 2
        out[i : i + cfg.score_batch] = err.mean(dim=2).cpu().numpy()
    return out


def fold_of(index: pd.DatetimeIndex, start: pd.Timestamp, stop: pd.Timestamp, folds: int) -> np.ndarray:
    """Assign each timestamp in [start, stop) to one of `folds` equal calendar blocks."""
    span = (stop - start).total_seconds()
    frac = (index - start).total_seconds() / span
    return np.clip((np.asarray(frac) * folds).astype(int), 0, folds - 1)


def run_training(df: pd.DataFrame, cfg: DetectorConfig, device: torch.device | None = None) -> dict:
    """Cross-fitted training on pre-failure data, then one final model.

    Pre-failure scores come from models that never saw the block being scored
    (blocked K-fold), so the threshold tuned on them is not flattered by
    in-sample fit. Scores from the first failure onward come from the final
    model, trained on all pre-failure data.

    Returns the score frame (per-signal error per window end), the final model
    and a report with timings and hardware.
    """
    device = device or pick_device()
    index = df.index
    seg = segment_ids(index)
    ends = valid_window_ends(seg, cfg.window)

    is_pre = np.asarray(index < FIRST_FAILURE_START)
    pre = df.loc[is_pre]
    mean, std = fit_scaler(pre)

    values = (df[ANALOG_SIGNALS].to_numpy(dtype=np.float32) - mean) / std
    x = torch.from_numpy(values).to(device)

    # A window is pre-failure only if its newest row is; its oldest row then is too.
    pre_ends = ends[is_pre[ends]]
    assert_pre_failure(index[pre_ends], "training windows")
    post_ends = ends[~is_pre[ends]]

    fold = fold_of(index, index[0], FIRST_FAILURE_START, cfg.folds)
    end_fold = fold[pre_ends]
    start_fold = fold[pre_ends - cfg.window + 1]

    # Windows that overlap a pre-failure sustained-load episode are scored like any
    # other, but never trained on.
    trainable = np.ones(len(pre_ends), dtype=bool)
    if cfg.exclude_sustained_load:
        from faultline.alarms import sustained_load_episodes, to_seconds

        pre_ts = to_seconds(pre.index)
        in_episode = np.zeros(len(index), dtype=np.int64)
        for start, end in sustained_load_episodes(pre.index, pre["Motor_current"].to_numpy()):
            in_episode[: len(pre_ts)] |= (pre_ts >= start) & (pre_ts <= end)
        touched = np.concatenate([[0], np.cumsum(in_episode)])
        trainable = (touched[pre_ends + 1] - touched[pre_ends - cfg.window + 1]) == 0

    errors = np.empty((len(ends), len(ANALOG_SIGNALS)), dtype=np.float32)
    pre_slots = np.flatnonzero(is_pre[ends])
    post_slots = np.flatnonzero(~is_pre[ends])

    fold_reports = []
    for k in range(cfg.folds):
        held_out = end_fold == k
        # Train only on windows that do not touch the held-out block at either end.
        train_mask = (end_fold != k) & (start_fold != k) & trainable
        model, rep = train_autoencoder(x, pre_ends[train_mask], cfg, seed=cfg.seed + k)
        errors[pre_slots[held_out]] = score_windows(model, x, pre_ends[held_out], cfg)
        rep["fold"] = k
        rep["held_out_windows"] = int(held_out.sum())
        fold_reports.append(rep)
        print(f"  fold {k}: {rep['seconds']:.1f}s, loss {rep['first_epoch_loss']} -> {rep['last_epoch_loss']}")

    final_model, final_rep = train_autoencoder(x, pre_ends[trainable], cfg, seed=cfg.seed + cfg.folds)
    print(f"  final: {final_rep['seconds']:.1f}s, loss {final_rep['first_epoch_loss']} -> {final_rep['last_epoch_loss']}")

    _sync(device)
    t0 = time.perf_counter()
    errors[post_slots] = score_windows(final_model, x, post_ends, cfg)
    _sync(device)
    score_seconds = time.perf_counter() - t0

    scores = pd.DataFrame(errors, index=index[ends], columns=[f"err_{s}" for s in ANALOG_SIGNALS])
    scores["out_of_fold"] = is_pre[ends]

    train_seconds = sum(r["seconds"] for r in fold_reports) + final_rep["seconds"]
    report = {
        "hardware": hardware_info(device),
        "config": asdict(cfg),
        "signals": ANALOG_SIGNALS,
        "training_cutoff": str(FIRST_FAILURE_START),
        "training_data_end": str(index[pre_ends].max()),
        "parameters": int(sum(p.numel() for p in final_model.parameters())),
        "rows_total": len(df),
        "rows_pre_failure": int(is_pre.sum()),
        "pre_failure_windows": len(pre_ends),
        "pre_failure_windows_excluded_from_training": int((~trainable).sum()),
        "windows_scored": len(ends),
        "share_of_rows_scored": round(len(ends) / len(df), 4),
        "train_seconds_total": round(train_seconds, 2),
        "train_seconds_final_model": final_rep["seconds"],
        "score_seconds_post_failure": round(score_seconds, 2),
        "score_windows_per_second": round(len(post_ends) / score_seconds, 0),
        "folds": fold_reports,
        "final": final_rep,
    }
    state = {
        "state_dict": {k: v.cpu() for k, v in final_model.state_dict().items()},
        "config": asdict(cfg),
        "mean": mean,
        "std": std,
        "signals": ANALOG_SIGNALS,
    }
    return {"scores": scores, "report": report, "state": state}
