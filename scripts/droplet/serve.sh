#!/usr/bin/env bash
# Runs ON THE DROPLET (sent over SSH by scripts/remote_setup.sh).
# Starts two vLLM servers on the one MI300X and waits until both are healthy:
#   :8000  the LLM (explanations, work orders, chat)   --gpu-memory-utilization 0.75
#   :8001  the embedding model (retrieval)             --gpu-memory-utilization 0.10
#
# Flags follow the vLLM recipe for gpt-oss on MI300X (recipes.vllm.ai/openai/gpt-oss-120b)
# and AMD's ROCm vLLM optimisation guide. AMD's original day-0 blog post used
# VLLM_USE_AITER_UNIFIED_ATTENTION / VLLM_ROCM_USE_AITER_MHA; current vLLM replaced
# those with --attention-backend ROCM_AITER_UNIFIED_ATTN.
set -euo pipefail

: "${VLLM_API_KEY:?VLLM_API_KEY must be set}"
VLLM_IMAGE="${VLLM_IMAGE:-vllm/vllm-openai-rocm:v0.31.0}"
LLM_MODEL="${LLM_MODEL:-openai/gpt-oss-120b}"
EMBED_MODEL="${EMBED_MODEL:-Qwen/Qwen3-Embedding-0.6B}"
LLM_GPU_FRACTION="${LLM_GPU_FRACTION:-0.75}"
EMBED_GPU_FRACTION="${EMBED_GPU_FRACTION:-0.10}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-3000}"
export HF_TOKEN="${HF_TOKEN:-}"

vram() {
  # Tool-independent: bytes used / total straight from the driver.
  for card in /sys/class/drm/card*/device; do
    [[ -r "$card/mem_info_vram_total" ]] || continue
    awk -v u="$(cat "$card/mem_info_vram_used")" -v t="$(cat "$card/mem_info_vram_total")" \
      -v c="$(basename "$(dirname "$card")")" \
      'BEGIN { printf "%s: %.1f GB used of %.1f GB VRAM\n", c, u/2^30, t/2^30 }'
  done
}

gpu_report() {
  echo "--- GPU memory ($1)"
  vram
  rocm-smi --showmeminfo vram 2>/dev/null || amd-smi monitor -v 2>/dev/null | head -5 || true
}

COMMON=(
  --device /dev/kfd --device /dev/dri --group-add video
  --cap-add SYS_PTRACE --security-opt seccomp=unconfined --ipc=host
  -v /root/.cache/huggingface:/root/.cache/huggingface
  -e HF_TOKEN -e VLLM_API_KEY
)

wait_healthy() {
  local name="$1" port="$2" waited=0
  echo "waiting for $name on :$port (first start downloads the model; this can take a while)"
  until curl -fsS -o /dev/null "http://127.0.0.1:$port/health"; do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]]; then
      echo "error: container $name exited. Last log lines:" >&2
      docker logs --tail 80 "$name" >&2 || true
      return 1
    fi
    if (( waited >= HEALTH_TIMEOUT_S )); then
      echo "error: $name not healthy after ${HEALTH_TIMEOUT_S}s. Last log lines:" >&2
      docker logs --tail 40 "$name" >&2 || true
      return 1
    fi
    sleep 10; waited=$((waited + 10))
    (( waited % 120 == 0 )) && echo "  ...${waited}s, $(du -sh /root/.cache/huggingface 2>/dev/null | cut -f1) in the model cache"
  done
  echo "$name healthy after ${waited}s"
}

mkdir -p /root/.cache/huggingface /root/faultline/results/gpu
echo "== host"
echo "amdgpu driver: $(cat /sys/module/amdgpu/version 2>/dev/null || echo unknown)"
df -h / | tail -1
gpu_report "before"

echo "== pulling $VLLM_IMAGE"
docker pull -q "$VLLM_IMAGE"

echo "== checking the image can see the GPU"
docker run --rm --device /dev/kfd --device /dev/dri --group-add video \
  --security-opt seccomp=unconfined --ipc=host --entrypoint python3 "$VLLM_IMAGE" -c \
  "import torch, vllm; assert torch.cuda.is_available(), 'no ROCm GPU visible in the container'; print('vllm', vllm.__version__, '| hip', torch.version.hip, '|', torch.cuda.get_device_name(0))"

docker rm -f faultline-llm faultline-embed >/dev/null 2>&1 || true

# The two servers are started one after the other: vLLM sizes its memory pool by
# profiling free VRAM at startup and assumes nobody else changes theirs meanwhile.
echo "== starting the LLM: $LLM_MODEL"
LLM_ARGS=(--host 0.0.0.0 --port 8000 --gpu-memory-utilization "$LLM_GPU_FRACTION")
LLM_ENV=(-e VLLM_ENGINE_READY_TIMEOUT_S=3600)
case "$LLM_MODEL" in
  openai/gpt-oss-*)
    LLM_ENV+=(-e VLLM_ROCM_USE_AITER=1)
    LLM_ARGS+=(--attention-backend ROCM_AITER_UNIFIED_ATTN --reasoning-parser openai_gptoss
               --tool-call-parser openai --enable-auto-tool-choice)
    ;;
  Qwen/Qwen3-*)
    LLM_ARGS+=(--reasoning-parser qwen3 --default-chat-template-kwargs '{"enable_thinking": false}')
    ;;
esac
docker run -d --name faultline-llm "${COMMON[@]}" "${LLM_ENV[@]}" -p 8000:8000 \
  -v faultline-vllm-cache-llm:/root/.cache/vllm \
  "$VLLM_IMAGE" "$LLM_MODEL" "${LLM_ARGS[@]}" >/dev/null
wait_healthy faultline-llm 8000

echo "== starting the embedder: $EMBED_MODEL"
docker run -d --name faultline-embed "${COMMON[@]}" -p 8001:8001 \
  -v faultline-vllm-cache-embed:/root/.cache/vllm \
  "$VLLM_IMAGE" "$EMBED_MODEL" \
  --host 0.0.0.0 --port 8001 --runner pooling --gpu-memory-utilization "$EMBED_GPU_FRACTION" >/dev/null
wait_healthy faultline-embed 8001

gpu_report "both servers up" | tee /root/faultline/results/gpu/serving_vram.txt
docker ps --filter name=faultline- --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
