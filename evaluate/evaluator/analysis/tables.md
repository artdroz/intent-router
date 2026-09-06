# Evaluation tables (pooled test split, 630 prompts)

## Per-class accuracy — request type

| Class | n | Cascade (ours) | Adaptive router | Auto router |
|---|---|---|---|---|
| code_generation | 86 | 0.453 | 0.000 | 0.000 |
| code_understanding | 268 | 0.862 | 0.007 | 0.000 |
| technical_design | 88 | 0.705 | 0.000 | 0.000 |
| analytical_reasoning | 12 | 0.667 | 0.000 | 0.000 |
| writing | 41 | 0.878 | 0.000 | 0.000 |
| factual_lookup | 16 | 0.375 | 0.000 | 0.000 |
| general | 119 | 0.244 | 0.975 | 1.000 |

## Disagreement — request type

| Router | Compared | Disagree | Cascade right / LiteLLM wrong | LiteLLM right / Cascade wrong | Both wrong |
|---|---|---:|---:|---:|---:|
| Adaptive router | 630 | 591 | 380 | 87 | 124 |
| Auto router | 630 | 594 | 382 | 90 | 122 |

## Per-class accuracy — complexity tier

| Class | n | Cascade (ours) | Complexity heuristic | Complexity LLM |
|---|---|---|---|---|
| simple | 193 | 0.554 | 0.259 | 0.254 |
| medium | 166 | 0.506 | 0.482 | 0.705 |
| complex | 46 | 0.304 | 0.304 | 0.087 |
| reasoning | 225 | 0.684 | 0.040 | 0.018 |

## Disagreement — complexity tier

| Router | Compared | Disagree | Cascade right / LiteLLM wrong | LiteLLM right / Cascade wrong | Both wrong |
|---|---|---:|---:|---:|---:|
| Complexity heuristic | 630 | 485 | 285 | 79 | 121 |
| Complexity LLM | 630 | 450 | 269 | 84 | 97 |
