#!/usr/bin/env bash
# Train the detector on the MI300X and bring the results back.
#
#   scripts/remote_train.sh
#
# Pushes the code and the parquet to the droplet, runs faultline.train in the
# rocm/pytorch container, pulls back results/train.json, data/scores.parquet and
# models/detector.pt, then runs the evaluation locally.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_env DROPLET_HOST

[[ -f "$REPO_ROOT/data/metropt3.parquet" ]] || {
  echo "error: data/metropt3.parquet missing. Run: uv run python -m faultline.data" >&2
  exit 1
}

# MetroPT-3 always. MetroPT-2 too, if its parquet has been built locally
# (FAULTLINE_DATASET=metropt2 uv run python -m faultline.data).
DATASETS=(metropt3)
[[ -f "$REPO_ROOT/data/metropt2.parquet" ]] && DATASETS+=(metropt2)

echo "== pushing code and data to $DROPLET_HOST:$REMOTE_DIR (datasets: ${DATASETS[*]})"
remote "mkdir -p $REMOTE_DIR/data $REMOTE_DIR/results/metropt2 $REMOTE_DIR/models"
push_repo
SYNC=("$REPO_ROOT/data/metropt3.parquet" "$REPO_ROOT/data/failures.csv")
[[ " ${DATASETS[*]} " == *" metropt2 "* ]] && SYNC+=("$REPO_ROOT/data/metropt2.parquet" "$REPO_ROOT/data/failures_metropt2.csv")
rsync -az -e "ssh ${SSH_OPTS[*]}" "${SYNC[@]}" "$DROPLET_USER@$DROPLET_HOST:$REMOTE_DIR/data/"

echo "== training on the droplet"
{
  echo "export REMOTE_DIR='$REMOTE_DIR' PYTORCH_IMAGE='${PYTORCH_IMAGE:-}'"
  echo "export FAULTLINE_DATASETS='${DATASETS[*]}'"
  echo "export FAULTLINE_GIT_COMMIT='$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || true)'"
  cat "$REPO_ROOT/scripts/droplet/train.sh"
} | remote 'bash -s'

echo "== pulling results"
mkdir -p "$REPO_ROOT/models" "$REPO_ROOT/results/gpu" "$REPO_ROOT/results/metropt2"
FROM="$DROPLET_USER@$DROPLET_HOST:$REMOTE_DIR"
rsync -az -e "ssh ${SSH_OPTS[*]}" "$FROM/results/gpu/" "$REPO_ROOT/results/gpu/"
rsync -az -e "ssh ${SSH_OPTS[*]}" "$FROM/results/train.json" "$REPO_ROOT/results/"
rsync -az -e "ssh ${SSH_OPTS[*]}" "$FROM/data/scores.parquet" "$REPO_ROOT/data/"
rsync -az -e "ssh ${SSH_OPTS[*]}" "$FROM/models/detector.pt" "$REPO_ROOT/models/"
if [[ " ${DATASETS[*]} " == *" metropt2 "* ]]; then
  rsync -az -e "ssh ${SSH_OPTS[*]}" "$FROM/results/metropt2/train.json" "$REPO_ROOT/results/metropt2/"
  rsync -az -e "ssh ${SSH_OPTS[*]}" "$FROM/data/scores_metropt2.parquet" "$REPO_ROOT/data/"
  rsync -az -e "ssh ${SSH_OPTS[*]}" "$FROM/models/detector_metropt2.pt" "$REPO_ROOT/models/"
fi

echo "== evaluating locally"
for dataset in "${DATASETS[@]}"; do
  (cd "$REPO_ROOT" && FAULTLINE_DATASET="$dataset" uv run python -m faultline.evaluate)
done

echo
echo "Done. The droplet bills by the hour even when powered off."
echo "If no more GPU work is planned, destroy it in the AMD Developer Cloud console."
