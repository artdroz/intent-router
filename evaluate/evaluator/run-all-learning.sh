#!/usr/bin/env bash
#
# Online-learning evaluation — full run.
#
# Trains the cascade on the validation split (oracle feedback + keyword
# promotion) and evaluates the learned model against the disabled model on the
# test split. Outputs per-seed learned-vs-disabled pairs to:
#   evaluate/runs/{dataset}/{gate}/learning/s{seed}.{train,eval}.jsonl
#
# Prerequisites:
#   - Postgres running, migrations applied, DATABASE_URL set (.env)
#   - Embedding + LLM endpoints reachable (EMBED_*, LLM_*)
#   - The disabled baselines must already exist in evaluate/runs/ (run the
#     plain classifier / pre-cascade / router pipeline first).
#
# Usage:
#   bash evaluate/evaluator/run-all-learning.sh
#   DATASETS=k8,cpython,vscode LABEL_FIELDS=adaptive_label,complexity_label bash ...
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# Load .env if present.
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

# ── Config ──
DATASETS="${DATASETS:-k8,cpython,vscode}"
LABEL_FIELDS="${LABEL_FIELDS:-adaptive_label,complexity_label}"
# Three seeds; recorded in the output file names (s{seed}.{train,eval}.jsonl).
SEEDS="${SEEDS:-20260901,20260902,20260903}"

TRAIN_SPLIT="${TRAIN_SPLIT:-val}"
EVAL_SPLIT="${EVAL_SPLIT:-test}"
TRAIN_RATIO="${TRAIN_RATIO:-1.0}"          # all of the val split is fed back (1.0)
FEEDBACK_EVERY="${FEEDBACK_EVERY:-1}"       # oracle feedback every N prompts
PROMOTE_EVERY="${PROMOTE_EVERY:-10}"        # keyword promotion every N prompts
FEEDBACK_MODE="${FEEDBACK_MODE:-oracle}"

# Cascade thresholds — must match the disabled baseline runs in evaluate/runs/.
MARGIN="${MARGIN:-0.54}"
ENTROPY="${ENTROPY:-0.78}"
KW_WEIGHT="${KW_WEIGHT:-0.3}"
SEM_WEIGHT="${SEM_WEIGHT:-0.7}"

EMBED_URL="${EMBED_URL:-${EMBED_BASE_URL:-http://localhost:11434}}"
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
LLM_URL="${LLM_URL:-${LLM_BASE_URL:-http://localhost:11434}}"
LLM_MODEL="${LLM_MODEL:-qwen2.5:7b}"

echo "=============================================================="
echo " Online-learning evaluation"
echo "   datasets:    ${DATASETS}"
echo "   label fields: ${LABEL_FIELDS}"
echo "   seeds:       ${SEEDS}"
echo "   train/eval:  ${TRAIN_SPLIT} (${TRAIN_RATIO}) / ${EVAL_SPLIT}"
echo "   feedback:    every ${FEEDBACK_EVERY}, promote every ${PROMOTE_EVERY} (${FEEDBACK_MODE})"
echo "   thresholds:  margin=${MARGIN} entropy=${ENTROPY} kw=${KW_WEIGHT} sem=${SEM_WEIGHT}"
echo "=============================================================="

IFS=',' read -r -a LABEL_ARRAY <<< "$LABEL_FIELDS"
IFS=',' read -r -a SEED_ARRAY <<< "$SEEDS"
IFS=',' read -r -a DATASET_ARRAY <<< "$DATASETS"

# Map a label field to its gate (directory) name.
gate_name() {
  case "$1" in
    adaptive_label)   echo "request_type" ;;
    complexity_label) echo "complexity_tier" ;;
    *) echo "$1" ;;
  esac
}

# Resume: a combo is complete when its eval output exists with the full
# eval-split line count. Completed combos are skipped; interrupted ones are
# re-run from scratch (their partial DB learned state is cleared first).
for LF in "${LABEL_ARRAY[@]}"; do
  GATE="$(gate_name "$LF")"
  for SEED in "${SEED_ARRAY[@]}"; do
    for DS in "${DATASET_ARRAY[@]}"; do
      EVAL_FILE="evaluate/runs/${DS}/${GATE}/learning/s${SEED}.eval.jsonl"
      EVAL_SRC="evaluate/dataset/${DS}-fnl-company-opus.${EVAL_SPLIT}.jsonl"
      EVAL_EXPECTED="$(wc -l < "$EVAL_SRC" 2>/dev/null || echo 0)"

      if [[ -f "$EVAL_FILE" ]] && [[ "$(wc -l < "$EVAL_FILE")" -eq "$EVAL_EXPECTED" ]]; then
        echo
        echo "SKIP  ${DS}/${GATE}  seed=${SEED}  (complete: $(wc -l < "$EVAL_FILE") eval rows)"
        continue
      fi

      echo
      echo "##############################################################"
      echo "# RUN  ${DS}/${GATE}  |  seed: ${SEED}"
      echo "##############################################################"
      npx tsx evaluate/evaluator/runner/router-with-learning.ts \
        --dataset "$DS" \
        --label-field "$LF" \
        --continuous-learning true \
        --train-split "$TRAIN_SPLIT" \
        --eval-split "$EVAL_SPLIT" \
        --train-split-ratio "$TRAIN_RATIO" \
        --feedback-every "$FEEDBACK_EVERY" \
        --promote-every "$PROMOTE_EVERY" \
        --feedback-mode "$FEEDBACK_MODE" \
        --shuffle-seed "$SEED" \
        --margin "$MARGIN" --entropy "$ENTROPY" \
        --kw-weight "$KW_WEIGHT" --sem-weight "$SEM_WEIGHT" \
        --embedding-url "$EMBED_URL" --embedding-model "$EMBED_MODEL" \
        --llm-url "$LLM_URL" --llm-model "$LLM_MODEL"
    done
  done
done

echo
echo "Done. Compute metrics and plots with:"
echo "  .venv-analysis/bin/python evaluate/evaluator/analysis/analyze_learning.py"
