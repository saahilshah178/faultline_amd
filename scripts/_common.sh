#!/usr/bin/env bash
# Shared helpers for the remote_*.sh scripts. Source this, don't run it.
# Everything the droplet does is driven from here over SSH so the droplet can be
# destroyed and rebuilt at any time.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

DROPLET_USER="${DROPLET_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/root/faultline}"

require_env() {
  local missing=0
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      echo "error: $name is not set (put it in .env, see .env.example)" >&2
      missing=1
    fi
  done
  [[ $missing -eq 0 ]] || exit 1
}

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=15)
if [[ -n "${DROPLET_SSH_KEY:-}" ]]; then
  SSH_OPTS+=(-i "$DROPLET_SSH_KEY")
fi

remote() {
  ssh "${SSH_OPTS[@]}" "$DROPLET_USER@$DROPLET_HOST" "$@"
}

# Run a local script file on the droplet with selected env vars exported.
remote_script() {
  local script="$1"
  shift
  ssh "${SSH_OPTS[@]}" "$DROPLET_USER@$DROPLET_HOST" "$@" 'bash -s' <"$script"
}

push_repo() {
  # Code only. Data and results are synced explicitly by the scripts that need them.
  rsync -az --delete \
    -e "ssh ${SSH_OPTS[*]}" \
    --exclude '.git' --exclude '.venv' --exclude 'node_modules' --exclude '.next' \
    --exclude 'apps' --exclude 'data' --exclude 'models' --exclude 'results' \
    --exclude '.env' --exclude '__pycache__' \
    "$REPO_ROOT/" "$DROPLET_USER@$DROPLET_HOST:$REMOTE_DIR/"
}
