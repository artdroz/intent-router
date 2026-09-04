#!/usr/bin/env bash
#
# Full evaluation pipeline.
#
# Produces:
#   evaluate/runs/    — raw per-prompt JSONL (classifier / pre-cascade / router)
#   evaluate/metrics/ — per-dataset metrics JSON + overall aggregates
#
# Prerequisites:
#   - Postgres running, migrations applied (npm run db:migrate), DATABASE_URL set
#     (auto-loaded from .env if present)
#   - Embedding API (default http://localhost:11434, model nomic-embed-text)
#   - LLM API (default http://localhost:11434, model qwen2.5:7b)
#
# Usage:
#   bash evaluate/evaluator/run-all.sh
#   DATASETS=k8,cpython MARGIN=0.2 ENTROPY=0.8 bash evaluate/evaluator/run-all.sh
#   LABEL_FIELD=complexity_label bash evaluate/evaluator/run-all.sh
#   LABEL_FIELD=adaptive_label,complexity_label bash evaluate/evaluator/run-all.sh
#
# Datasets live flat in evaluate/dataset/ as
#   {dataset}-fnl-company-opus.{val,test}.jsonl   (dataset: k8, cpython, vscode)
# with the ground-truth label in `adaptive_label` or `complexity_label`.
# Gate configs are the shared taxonomy files request_type.config.json and
# complexity_tier.config.json in the same directory.  The pipeline runs once per
# LABEL_FIELD (comma-separated), and outputs are namespaced by gate name
# (runs/{dataset}/{gate}/..., metrics/{stage}/{dataset}/{gate}/...).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Load .env if present (DATABASE_URL, EMBED_*, LLM_*, API keys).
if [[ -f .env && -z "${DATABASE_URL:-}" ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set. Create a .env or export DATABASE_URL." >&2
  exit 1
fi

# Config (overridable via env).
DATASETS="${DATASETS:-k8,cpython,vscode}"
SPLITS="${SPLITS:-val,test}"
LABEL_FIELD="${LABEL_FIELD:-adaptive_label,complexity_label}"
# Cascade defaults mirror src/routing/config.ts (CAS_MARGIN_THRESHOLD / CAS_ENTROPY_THRESHOLD).
MARGIN="${MARGIN:-0.54}"
ENTROPY="${ENTROPY:-0.78}"
KW_WEIGHT="${KW_WEIGHT:-0.3}"
SEM_WEIGHT="${SEM_WEIGHT:-0.7}"
EMBED_URL="${EMBED_URL:-${EMBED_BASE_URL:-http://localhost:11434}}"
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
LLM_URL="${LLM_URL:-${LLM_BASE_URL:-http://localhost:11434}}"
LLM_MODEL="${LLM_MODEL:-qwen2.5:7b}"
CLEAN="${CLEAN:-1}"

RUNNER="evaluate/evaluator/runner"

echo "=============================================================="
echo " Evaluation pipeline"
echo "   datasets:   ${DATASETS}"
echo "   splits:     ${SPLITS}"
echo "   label fields: ${LABEL_FIELD}"
echo "   thresholds: margin=${MARGIN} entropy=${ENTROPY} kw=${KW_WEIGHT} sem=${SEM_WEIGHT}"
echo "   embed:      ${EMBED_URL} (${EMBED_MODEL})"
echo "   llm:        ${LLM_URL} (${LLM_MODEL})"
echo "=============================================================="

step() { echo; echo "==> $1"; }

if [[ "$CLEAN" == "1" ]]; then
  step "0/5 — clean eval data from DB"
  npx tsx evaluate/evaluator/eval-cleanup.ts
fi

IFS=',' read -r -a LABEL_FIELDS <<< "$LABEL_FIELD"
for LF in "${LABEL_FIELDS[@]}"; do
  echo
  echo "##############################################################"
  echo "# label field: ${LF}"
  echo "##############################################################"

  step "1/5 — classifiers (keyword, semantic, llm)"
  npx tsx "$RUNNER/classifier.ts" --classifier all --dataset "$DATASETS" --split "$SPLITS" \
    --label-field "$LF" \
    --embedding-url "$EMBED_URL" --embedding-model "$EMBED_MODEL" \
    --llm-url "$LLM_URL" --llm-model "$LLM_MODEL"

  step "2/5 — pre-cascade (keyword + semantic gatekeeper)"
  npx tsx "$RUNNER/pre-cascade.ts" --dataset "$DATASETS" --split "$SPLITS" \
    --label-field "$LF" \
    --margin "$MARGIN" --entropy-threshold "$ENTROPY" \
    --kw-weight "$KW_WEIGHT" --sem-weight "$SEM_WEIGHT" \
    --embedding-url "$EMBED_URL" --embedding-model "$EMBED_MODEL"

  step "2.5 — classifier threshold tuning (informational, on val split)"
  npx tsx "$RUNNER/tune-classifier-thresholds.ts" --classifier all --dataset "$DATASETS" --label-field "$LF"

  step "3/5 — router (cascade with LLM fallback)"
  npx tsx "$RUNNER/router.ts" --dataset "$DATASETS" --split "$SPLITS" \
    --label-field "$LF" \
    --margin "$MARGIN" --entropy "$ENTROPY" \
    --kw-weight "$KW_WEIGHT" --sem-weight "$SEM_WEIGHT" \
    --embedding-url "$EMBED_URL" --embedding-model "$EMBED_MODEL" \
    --llm-url "$LLM_URL" --llm-model "$LLM_MODEL"

  step "4/5 — compute per-dataset metrics"
  npx tsx evaluate/evaluator/compute-metrics.ts --stage all --dataset "$DATASETS" --split "$SPLITS" --label-field "$LF"

  step "5/5 — combine overall metrics"
  npx tsx evaluate/evaluator/combine-metrics.ts --stage all --dataset "$DATASETS" --split "$SPLITS" --label-field "$LF"
done

if [[ "$CLEAN" == "1" ]]; then
  step "cleanup — remove eval data from DB"
  npx tsx evaluate/evaluator/eval-cleanup.ts
fi

echo
echo "Done."
echo "  Raw runs → evaluate/runs/"
echo "  Metrics  → evaluate/metrics/ (overall: evaluate/metrics/overall/)"
