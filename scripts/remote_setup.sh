#!/usr/bin/env bash
# Bring the droplet up: pull the vLLM image, start the LLM and the embedding
# server on the MI300X, wait until both are healthy, print GPU memory.
#
#   scripts/remote_setup.sh
#
# Needs DROPLET_HOST and VLLM_API_KEY in .env. Safe to re-run: it replaces the
# two containers. Fallback LLM if gpt-oss-120b will not load:
#   LLM_MODEL=Qwen/Qwen3-32B scripts/remote_setup.sh
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_env DROPLET_HOST VLLM_API_KEY

echo "== connecting to $DROPLET_USER@$DROPLET_HOST"
remote 'echo connected: $(hostname), $(. /etc/os-release && echo "$PRETTY_NAME")'

# Secrets travel on stdin, not on the remote command line.
{
  printf 'export VLLM_API_KEY=%q HF_TOKEN=%q\n' "$VLLM_API_KEY" "${HF_TOKEN:-}"
  printf 'export LLM_MODEL=%q EMBED_MODEL=%q\n' "${LLM_MODEL:-openai/gpt-oss-120b}" "${EMBED_MODEL:-Qwen/Qwen3-Embedding-0.6B}"
  [[ -n "${VLLM_IMAGE:-}" ]] && printf 'export VLLM_IMAGE=%q\n' "$VLLM_IMAGE"
  cat "$REPO_ROOT/scripts/droplet/serve.sh"
} | remote 'bash -s'

mkdir -p "$REPO_ROOT/results/gpu"
rsync -az -e "ssh ${SSH_OPTS[*]}" \
  "$DROPLET_USER@$DROPLET_HOST:/root/faultline/results/gpu/" "$REPO_ROOT/results/gpu/" || true

cat <<MSG

Both servers are up. Put these in .env if they are not there already:

  LLM_URL=http://$DROPLET_HOST:8000/v1
  EMBED_URL=http://$DROPLET_HOST:8001/v1

Then check from this machine:  uv run python scripts/smoke.py
The droplet bills by the hour even when powered off. Destroy it when the GPU work is done.
MSG
