#!/usr/bin/env bash
# Stop both vLLM servers on the droplet and show that the GPU memory was released.
#
#   scripts/remote_teardown.sh           # stop the containers, keep the downloaded models
#   scripts/remote_teardown.sh --purge   # also delete the model cache and the synced repo
#
# This does NOT stop billing. A powered-off droplet still bills; destroy it in the
# AMD Developer Cloud console once the results are pulled back.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_env DROPLET_HOST

PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

remote "PURGE=$PURGE REMOTE_DIR=$REMOTE_DIR bash -s" <<'REMOTE'
set -euo pipefail
docker rm -f faultline-llm faultline-embed 2>/dev/null || true
if [[ "$PURGE" == "1" ]]; then
  docker volume rm -f faultline-vllm-cache-llm faultline-vllm-cache-embed 2>/dev/null || true
  rm -rf /root/.cache/huggingface/hub "$REMOTE_DIR"
  echo "purged the model cache and $REMOTE_DIR"
fi
for card in /sys/class/drm/card*/device; do
  [[ -r "$card/mem_info_vram_used" ]] || continue
  awk -v u="$(cat "$card/mem_info_vram_used")" 'BEGIN { printf "VRAM in use now: %.1f GB\n", u/2^30 }'
done
docker ps --format '{{.Names}}\t{{.Status}}'
REMOTE

echo
echo "Servers stopped. Billing continues until the droplet is destroyed:"
echo "  AMD Developer Cloud console -> Droplets -> (droplet) -> Destroy"
