#!/usr/bin/env bash
# Runs ON THE DROPLET (sent over SSH by scripts/remote_train.sh).
# Trains the detector in PyTorch on ROCm inside the rocm/pytorch container.
set -euo pipefail

REMOTE_DIR="${REMOTE_DIR:-/root/faultline}"
export FAULTLINE_GIT_COMMIT="${FAULTLINE_GIT_COMMIT:-}"
# rocm/pytorch:latest has moved to ROCm 10.1, whose user space no longer lists the
# 6.x kernel driver that the Developer Cloud images ship. Try the ROCm 7.2 build
# first and fall back to latest; use the first image that can see the GPU.
CANDIDATES=(${PYTORCH_IMAGE:-rocm/pytorch:rocm7.2.4_ubuntu24.04_py3.12_pytorch_release_2.10.0 rocm/pytorch:latest})

cd "$REMOTE_DIR"
mkdir -p results/gpu models

# Report GPU memory. Purely informational: it must never fail the run.
vram() {
  for f in /sys/class/drm/card*/device/mem_info_vram_used; do
    [[ -r "$f" ]] && awk '{ printf "VRAM in use: %.1f GB\n", $1 / 2^30 }' "$f"
  done
  rocm-smi --showmeminfo vram 2>/dev/null || amd-smi monitor -v 2>/dev/null | head -5 || true
  return 0
}

echo "== GPU before training"
vram | tee results/gpu/train_before.txt

GPU_FLAGS=(--device /dev/kfd --device /dev/dri --group-add video --cap-add SYS_PTRACE
           --ipc=host --shm-size 8G --security-opt seccomp=unconfined)
PYTORCH_IMAGE=""
for image in "${CANDIDATES[@]}"; do
  docker pull -q "$image" || continue
  if docker run --rm "${GPU_FLAGS[@]}" "$image" python3 -c "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)"; then
    PYTORCH_IMAGE="$image"; break
  fi
  echo "note: $image cannot see the GPU on this host, trying the next image"
done
[[ -n "$PYTORCH_IMAGE" ]] || { echo "error: no rocm/pytorch image could see the GPU" >&2; exit 1; }
echo "using $PYTORCH_IMAGE"
echo "$PYTORCH_IMAGE" > results/gpu/pytorch_image.txt

# MetroPT-3 always; MetroPT-2 as well when its parquet was synced (held-out second test).
for dataset in ${FAULTLINE_DATASETS:-metropt3}; do
  echo "== training on $dataset"
  docker run --rm "${GPU_FLAGS[@]}" \
    -v "$REMOTE_DIR:/workspace" -w /workspace \
    -e PYTHONPATH=/workspace -e PIP_ROOT_USER_ACTION=ignore -e FAULTLINE_GIT_COMMIT \
    -e FAULTLINE_DATASET="$dataset" \
    "$PYTORCH_IMAGE" \
    bash -c '
      set -euo pipefail
      python3 -c "import torch; assert torch.cuda.is_available(), \"no ROCm GPU visible\"; print(\"torch\", torch.__version__, \"hip\", torch.version.hip, torch.cuda.get_device_name(0))"
      python3 -m pip install -q "pandas>=2.2" "pyarrow>=17" python-dotenv
      python3 -m faultline.train --device cuda
    '
done

echo "== GPU after training"
vram | tee results/gpu/train_after.txt
