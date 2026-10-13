"""Paths, signal definitions and environment settings shared across the pipeline."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
MODELS_DIR = REPO_ROOT / "models"
PROMPTS_DIR = REPO_ROOT / "prompts"

# The product runs on MetroPT-3. MetroPT-2 is a second recording from the same
# operator (2022, another failure history) used only as a held-out test of the
# detector and baselines: FAULTLINE_DATASET=metropt2 points the same training and
# evaluation code at it, with its results kept apart under results/metropt2/.
DATASETS = {
    "metropt3": {
        "name": "MetroPT-3",
        "source": "https://archive.ics.uci.edu/dataset/791/metropt+3+dataset",
        "license": "CC BY 4.0",
        "parquet": "metropt3.parquet",
        "failures": "failures.csv",
        "results": "results",
        "tag": "",
    },
    "metropt2": {
        "name": "MetroPT-2",
        "source": "https://zenodo.org/records/7766691",
        "license": "CC BY 4.0",
        "parquet": "metropt2.parquet",
        "failures": "failures_metropt2.csv",
        "results": "results/metropt2",
        "tag": "_metropt2",
    },
}
DATASET = os.getenv("FAULTLINE_DATASET", "metropt3")
if DATASET not in DATASETS:
    raise ValueError(f"FAULTLINE_DATASET must be one of {sorted(DATASETS)}, got {DATASET!r}")
DATASET_INFO = DATASETS[DATASET]

RESULTS_DIR = REPO_ROOT / DATASET_INFO["results"]
PARQUET_PATH = DATA_DIR / DATASET_INFO["parquet"]
FAILURES_CSV = DATA_DIR / DATASET_INFO["failures"]
SCORES_PATH = DATA_DIR / f"scores{DATASET_INFO['tag']}.parquet"
MODEL_PATH = MODELS_DIR / f"detector{DATASET_INFO['tag']}.pt"
TRAIN_REPORT = RESULTS_DIR / "train.json"

load_dotenv(REPO_ROOT / ".env")


def _server_url(name: str, port: int) -> str:
    """LLM_URL / EMBED_URL, or the standard port on the droplet if only DROPLET_HOST is set."""
    host = os.getenv("DROPLET_HOST", "")
    return os.getenv(name, "") or (f"http://{host}:{port}/v1" if host else "")


@dataclass(frozen=True)
class Settings:
    droplet_host: str = os.getenv("DROPLET_HOST", "")
    vllm_api_key: str = os.getenv("VLLM_API_KEY", "")
    llm_url: str = _server_url("LLM_URL", 8000)
    embed_url: str = _server_url("EMBED_URL", 8001)
    llm_model: str = os.getenv("LLM_MODEL", "openai/gpt-oss-120b")
    # gpt-oss always reasons before answering; "low" keeps that short. Leave empty
    # for models that do not take the parameter.
    llm_reasoning_effort: str = os.getenv("LLM_REASONING_EFFORT", "low")
    embed_model: str = os.getenv("EMBED_MODEL", "Qwen/Qwen3-Embedding-0.6B")


settings = Settings()


def gpu_pricing() -> dict:
    """Rental price of the GPU droplet, for cost-per-alert figures.

    An input, not a measurement: set GPU_USD_PER_HOUR to what the droplet actually
    costs. The default is the on-demand price of the 1x MI300X droplet on the AMD
    Developer Cloud (see GPU_PRICE_SOURCE).
    """
    return {
        "usd_per_hour": float(os.getenv("GPU_USD_PER_HOUR", GPU_USD_PER_HOUR_DEFAULT)),
        "instance": "AMD Developer Cloud GPU droplet, 1x AMD Instinct MI300X (192 GB)",
        "source": GPU_PRICE_SOURCE,
    }


GPU_USD_PER_HOUR_DEFAULT = "2.59"
GPU_PRICE_SOURCE = "https://docs.digitalocean.com/products/amd/details/pricing/"
