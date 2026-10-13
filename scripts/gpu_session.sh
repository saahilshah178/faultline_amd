#!/usr/bin/env bash
# Everything that needs the MI300X, in order, from a freshly created droplet.
#
#   scripts/gpu_session.sh
#
# Needs DROPLET_HOST and VLLM_API_KEY in .env. Each step is also a script of its
# own, so a failed session can be resumed from the step that failed:
#
#   1. scripts/remote_train.sh       train the detector on the MI300X, evaluate locally
#   2. evidence + replay export      (local, no GPU)
#   3. scripts/remote_setup.sh       start gpt-oss-120b and the embedder under vLLM
#   4. scripts/smoke.py              check both servers from this machine
#   5. faultline.kb --embed          embed the manual with the embedding server
#   6. faultline.explain --force     explanation, work order and chat answers per alarm
#
# Afterwards results/ holds everything replay mode needs. Commit it, then destroy
# the droplet: it bills by the hour even when powered off.
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_env DROPLET_HOST VLLM_API_KEY
cd "$REPO_ROOT"

export LLM_URL="${LLM_URL:-http://$DROPLET_HOST:8000/v1}"
export EMBED_URL="${EMBED_URL:-http://$DROPLET_HOST:8001/v1}"
SESSION_START=$(date +%s)

step() { echo; echo "=================== $* ==================="; }

step "1/6 train on the MI300X"
scripts/remote_train.sh

step "2/6 evidence packs and replay export"
uv run python -m faultline.profile
uv run python -m faultline.evidence
uv run python -m faultline.export_replay

step "3/6 start the vLLM servers"
scripts/remote_setup.sh

step "4/6 smoke test"
uv run python scripts/smoke.py

step "5/6 embed the knowledge base"
uv run python -m faultline.kb --embed

step "6/6 explain every alarm"
uv run python -m faultline.explain --force --concurrency "${EXPLAIN_CONCURRENCY:-4}"

# Bring the numbers in README.md and docs/submission.md in step with the new results.
uv run python -m faultline.report

MINUTES=$(( ($(date +%s) - SESSION_START) / 60 ))
cat <<MSG

GPU session finished in ${MINUTES} minutes.

Next:
  git add -A results README.md docs && git commit -m "Results from the MI300X run" && git push
                                    # the push redeploys the app with the new results
  (cd apps/web && pnpm build && pnpm start) & (cd apps/web && pnpm cover)   # refresh docs/cover.png
  scripts/remote_teardown.sh        # stops the servers (optional; live mode needs them up)

The droplet bills by the hour even when powered off. When you no longer need
live mode, destroy it: AMD Developer Cloud console -> Droplets -> Destroy.
MSG
