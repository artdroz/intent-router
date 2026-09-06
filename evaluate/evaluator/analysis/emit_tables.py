#!/usr/bin/env python3
"""Emit per-class accuracy tables and the disagreement summary as Markdown.

Prints (and saves) the three tables the Results section still needs:
  - per-class accuracy: cascade vs LiteLLM routers, per taxonomy (pooled test)
  - disagreement contingency: cascade vs each LiteLLM router
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUNS_DIR = ROOT / "evaluate" / "runs"
LITELLM_DIR = ROOT / "evaluate" / "litellm_baseline"
OUT = Path(__file__).resolve().parent / "tables.md"

SPLIT = "test"
DATASETS = ["k8", "cpython", "vscode"]
CLASS_ORDER = {
    "request_type": [
        "code_generation", "code_understanding", "technical_design",
        "analytical_reasoning", "writing", "factual_lookup", "general",
    ],
    "complexity_tier": ["simple", "medium", "complex", "reasoning"],
}
ROUTERS = {
    "request_type": ["adaptive_router", "auto_router"],
    "complexity_tier": ["complexity_router_heuristic", "complexity_router_llm"],
}
DISPLAY = {
    "cascade": "Cascade (ours)",
    "adaptive_router": "Adaptive router",
    "auto_router": "Auto router",
    "complexity_router_heuristic": "Complexity heuristic",
    "complexity_router_llm": "Complexity LLM",
}


def read_jsonl(path: Path):
    with path.open() as f:
        return [json.loads(l) for l in f if l.strip()]


def load_rows(system, gate):
    rows = []
    for ds in DATASETS:
        if system == "cascade":
            rows += read_jsonl(RUNS_DIR / ds / gate / "router" / f"cascade.{SPLIT}.jsonl")
        else:
            rows += read_jsonl(LITELLM_DIR / f"{ds}_{system}.{SPLIT}.jsonl")
    return rows


def per_class(system, gate):
    rows = load_rows(system, gate)
    per = {}
    for label in CLASS_ORDER[gate]:
        sub = [r for r in rows if r["truth"] == label]
        n = len(sub)
        acc = sum(1 for r in sub if r["correct"]) / n if n else None
        per[label] = (n, acc)
    return per


def fmt_acc(v):
    return "---" if v is None else f"{v:.3f}"


def main():
    lines = ["# Evaluation tables (pooled test split, 630 prompts)", ""]

    for gate in CLASS_ORDER:
        systems = ["cascade"] + ROUTERS[gate]
        header = ["Class", "n"] + [DISPLAY[s] for s in systems]
        lines.append(f"## Per-class accuracy — {gate.replace('_', ' ')}")
        lines.append("")
        lines.append("| " + " | ".join(header) + " |")
        lines.append("|" + "---|" * len(header))
        for label in CLASS_ORDER[gate]:
            per = {s: per_class(s, gate)[label] for s in systems}
            n = per["cascade"][0]
            row = [label, str(n)]
            for s in systems:
                row.append(fmt_acc(per[s][1]))
            lines.append("| " + " | ".join(row) + " |")
        lines.append("")

        lines.append(f"## Disagreement — {gate.replace('_', ' ')}")
        lines.append("")
        lines.append("| Router | Compared | Disagree | Cascade right / LiteLLM wrong | "
                     "LiteLLM right / Cascade wrong | Both wrong |")
        lines.append("|---|---|---:|---:|---:|---:|")
        for s in ROUTERS[gate]:
            dpath = Path(__file__).resolve().parent / f"disagreement_{gate}_{SPLIT}.json"
            d = json.loads(dpath.read_text())[s]
            lines.append(
                f"| {DISPLAY[s]} | {d['n']} | {d['disagree']} | "
                f"{d['cascade_right_litellm_wrong']} | {d['litellm_right_cascade_wrong']} | "
                f"{d['both_wrong']} |"
            )
        lines.append("")

    OUT.write_text("\n".join(lines))
    print("\n".join(lines))


if __name__ == "__main__":
    main()
