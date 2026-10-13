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
RESULTS_DIR = REPO_ROOT / "results"
PROMPTS_DIR = REPO_ROOT / "prompts"

PARQUET_PATH = DATA_DIR / "metropt3.parquet"
FAILURES_CSV = DATA_DIR / "failures.csv"

load_dotenv(REPO_ROOT / ".env")


@dataclass(frozen=True)
class Settings:
    droplet_host: str = os.getenv("DROPLET_HOST", "")
    vllm_api_key: str = os.getenv("VLLM_API_KEY", "")
    llm_url: str = os.getenv("LLM_URL", "")
    embed_url: str = os.getenv("EMBED_URL", "")
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
