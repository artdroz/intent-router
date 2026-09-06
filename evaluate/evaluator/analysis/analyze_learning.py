#!/usr/bin/env python3
"""
Learning evaluation analysis — compute metrics and plots for the online-learning
section, from the runs produced by router-with-learning.ts.

Reads:
  evaluate/runs/{dataset}/{gate}/learning/s{seed}.eval.jsonl   (learned vs disabled pairs)
  evaluate/runs/{dataset}/{gate}/learning/s{seed}.train.jsonl  (rolling ramp-up)

Emits:
  analysis/learning_summary.json / .csv   — per (gate, dataset, seed, stage, model)
  resources/evaluation-learning-curve-{gate}.png   — rolling accuracy + cascade rate
  resources/evaluation-learning-pareto-{gate}.png  — accuracy vs cascade rate

Run:
  .venv-analysis/bin/python evaluate/evaluator/analysis/analyze_learning.py
"""

import csv
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
RUNS_DIR = ROOT / "evaluate" / "runs"
ANALYSIS_DIR = Path(__file__).resolve().parent
RESOURCES_DIR = Path("/Users/liyulin/Repositories/dev/msc-dissertation/resources")

GATES = ["request_type", "complexity_tier"]
DATASETS = ["k8", "cpython", "vscode"]


# ── Loading ──
def read_jsonl(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def discover_seeds(ds, gate):
    d = RUNS_DIR / ds / gate / "learning"
    if not d.exists():
        return []
    seeds = []
    for p in sorted(d.glob("s*.eval.jsonl")):
        seeds.append(p.stem.split(".")[0].lstrip("s"))
    return seeds


# ── Metrics ──
def safe_mean(vals):
    return float(np.mean(vals)) if len(vals) else None


def class_accs(rows):
    per = {}
    for r in rows:
        t = r["truth"]
        per.setdefault(t, {"total": 0, "correct": 0})
        per[t]["total"] += 1
        if r["correct"]:
            per[t]["correct"] += 1
    return per


def macro_acc(rows):
    per = class_accs(rows)
    accs = [c["correct"] / c["total"] for c in per.values() if c["total"] > 0]
    return safe_mean(accs)


def stage_metrics(rows, stage):
    """rows: list of {correct, cascade?, totalLatencyMs?, truth}."""
    if not rows:
        return None
    n = len(rows)
    m = {
        "n": n,
        "accuracy": safe_mean([1.0 if r["correct"] else 0.0 for r in rows]),
        "macro_accuracy": macro_acc(rows),
    }
    if stage in ("pre", "router"):
        cascaded = [r for r in rows if r["cascade"]]
        m["cascade_rate"] = len(cascaded) / n
    if stage == "pre":
        silent = [r for r in rows if (not r["correct"]) and (not r["cascade"])]
        m["silent_error_rate"] = len(silent) / n
        wrong_casc = [r for r in cascaded if not r["correct"]]
        m["cascade_precision"] = len(wrong_casc) / len(cascaded) if cascaded else None
        m["regret_cascade_rate"] = sum(1 for r in rows if r["correct"] and r["cascade"]) / n
    if stage == "router":
        llm_correct = [r for r in cascaded if r["correct"]]
        m["llm_cond_accuracy"] = len(llm_correct) / len(cascaded) if cascaded else None
        m["avg_latency_ms"] = safe_mean([r["totalLatencyMs"] for r in rows])
    return m


def build_all():
    """Return {gate: {dataset: {seed: {stage: {model: metrics}}}}}."""
    out = {}
    for gate in GATES:
        out[gate] = {}
        for ds in DATASETS:
            out[gate][ds] = {}
            for seed in discover_seeds(ds, gate):
                ev = read_jsonl(RUNS_DIR / ds / gate / "learning" / f"s{seed}.eval.jsonl")
                tr = read_jsonl(RUNS_DIR / ds / gate / "learning" / f"s{seed}.train.jsonl")
                per_stage = {}
                for stage in ("kw", "sem", "pre", "router"):
                    models = {}
                    for model in ("base", "learn"):
                        rows = []
                        for r in ev:
                            obj = r.get(stage, {}).get(model)
                            if obj is None:
                                continue
                            row = {"truth": r["truth"], "correct": obj.get("correct")}
                            if stage in ("pre", "router"):
                                row["cascade"] = obj.get("cascade", obj.get("cascaded"))
                            if stage == "router":
                                row["totalLatencyMs"] = obj.get("totalLatencyMs", 0)
                            rows.append(row)
                        models[model] = stage_metrics(rows, stage)
                    per_stage[stage] = models
                out[gate][ds][seed] = {"eval": per_stage, "train": tr}
    return out


# ── Aggregation across seeds ──
def aggregate(all_data):
    """Per (gate, dataset, stage, model) mean±std over seeds."""
    agg = {}
    for gate, datasets in all_data.items():
        agg[gate] = {}
        for ds, seeds in datasets.items():
            agg[gate][ds] = {}
            if not seeds:
                continue
            for stage in ("kw", "sem", "pre", "router"):
                for model in ("base", "learn"):
                    key = f"{stage}_{model}"
                    vals = {}
                    for seed, d in seeds.items():
                        m = d["eval"].get(stage, {}).get(model)
                        if m is None:
                            continue
                        for k, v in m.items():
                            if k == "n":
                                vals.setdefault(k, []).append(v)
                            elif v is not None:
                                vals.setdefault(k, []).append(v)
                    if not vals:
                        agg[gate][ds][key] = None
                        continue
                    agg[gate][ds][key] = {
                        k: (float(np.mean(v)), float(np.std(v))) for k, v in vals.items()
                    }
    return agg


# ── Output ──
def write_outputs(all_data, agg):
    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        gate: {
            ds: {seed: d["eval"] for seed, d in seeds.items()}
            for ds, seeds in datasets.items()
        }
        for gate, datasets in all_data.items()
    }
    (ANALYSIS_DIR / "learning_summary.json").write_text(json.dumps(payload, indent=2))

    csv_path = ANALYSIS_DIR / "learning_summary.csv"
    with open(csv_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["gate", "dataset", "stage", "model", "metric", "mean", "std"])
        for gate, datasets in agg.items():
            for ds, keys in datasets.items():
                for key, metrics in keys.items():
                    if metrics is None:
                        continue
                    stage, model = key.split("_", 1)
                    for metric, (mean, std) in metrics.items():
                        w.writerow([gate, ds, stage, model, metric, round(mean, 4), round(std, 4)])
    print(f"Summary -> {ANALYSIS_DIR / 'learning_summary.json'}")
    print(f"CSV -> {csv_path}")


# ── Plots ──
def setup_style():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 9,
        "axes.titlesize": 10,
        "axes.labelsize": 9,
        "axes.grid": True,
        "grid.alpha": 0.3,
        "figure.dpi": 150,
    })
    return plt


def plot_curve(plt, gate, datasets, all_data):
    """Rolling accuracy + cascade rate vs training examples; per-seed + mean."""
    fig, axes = plt.subplots(1, len(datasets), figsize=(5.4 * len(datasets), 3.6), squeeze=False)
    for ax, ds in zip(axes[0], datasets):
        ax2 = ax.twinx()
        seeds = all_data[gate].get(ds, {})
        acc_lines, cas_lines = [], []
        for seed, d in seeds.items():
            tr = d["train"]
            x = [r["iteration"] for r in tr]
            acc = [r["rollingAccuracy"] for r in tr]
            cas = [r["rollingCascadeRate"] for r in tr]
            acc_lines.append(ax.plot(x, acc, color="#1f77b4", alpha=0.25, linewidth=1)[0])
            cas_lines.append(ax2.plot(x, cas, color="#d62728", alpha=0.25, linewidth=1)[0])
        if seeds:
            maxlen = max(len(d["train"]) for d in seeds.values())
            xs = np.arange(1, maxlen + 1)
            acc_m, cas_m = [], []
            for i in xs:
                av = [d["train"][i - 1]["rollingAccuracy"] for d in seeds.values() if i - 1 < len(d["train"])]
                cv = [d["train"][i - 1]["rollingCascadeRate"] for d in seeds.values() if i - 1 < len(d["train"])]
                acc_m.append(np.mean(av) if av else np.nan)
                cas_m.append(np.mean(cv) if cv else np.nan)
            ax.plot(xs, acc_m, color="#1f77b4", linewidth=2, label="rolling accuracy")
            ax2.plot(xs, cas_m, color="#d62728", linewidth=2, label="rolling cascade rate")
        ax.set_xlabel("Training examples")
        ax.set_ylabel("Accuracy", color="#1f77b4")
        ax2.set_ylabel("Cascade rate", color="#d62728")
        ax.set_ylim(0, 1)
        ax2.set_ylim(0, 1)
        ax.set_title(ds, fontsize=9)
    fig.tight_layout()
    out = RESOURCES_DIR / f"evaluation-learning-curve-{gate}.png"
    fig.savefig(out)
    plt.close(fig)
    print(f"Figure -> {out}")


def plot_pareto(plt, gate, datasets, all_data):
    """Router accuracy vs cascade rate: disabled vs learned per dataset."""
    fig, ax = plt.subplots(figsize=(6.2, 4.2))
    for ds in datasets:
        seeds = all_data[gate].get(ds, {})
        base_acc, base_cas, learn_acc, learn_cas = [], [], [], []
        for seed, d in seeds.items():
            r = d["eval"].get("router", {})
            b, l = r.get("base"), r.get("learn")
            if b and l:
                base_acc.append(b["accuracy"])
                base_cas.append(b["cascade_rate"])
                learn_acc.append(l["accuracy"])
                learn_cas.append(l["cascade_rate"])
        if not base_acc:
            continue
        ba, bc = float(np.mean(base_acc)), float(np.mean(base_cas))
        la, lc = float(np.mean(learn_acc)), float(np.mean(learn_cas))
        ax.scatter(bc, ba, s=80, color="#95a5a6", marker="o", zorder=3)
        ax.scatter(lc, la, s=80, color="#1f77b4", marker="o", zorder=3)
        ax.annotate("", xy=(lc, la), xytext=(bc, ba),
                    arrowprops=dict(arrowstyle="->", color="#555555", lw=1))
        ax.text(bc - 0.02, ba + 0.02, ds, fontsize=8, color="#7f8c8d", ha="right")
    ax.scatter([], [], s=80, color="#95a5a6", label="Disabled")
    ax.scatter([], [], s=80, color="#1f77b4", label="Learned")
    ax.set_xlabel("Cascade rate")
    ax.set_ylabel("Accuracy")
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_title(f"Learned vs disabled router — {gate.replace('_', ' ')}")
    ax.legend(fontsize=8)
    fig.tight_layout()
    out = RESOURCES_DIR / f"evaluation-learning-pareto-{gate}.png"
    fig.savefig(out)
    plt.close(fig)
    print(f"Figure -> {out}")


def main():
    RESOURCES_DIR.mkdir(parents=True, exist_ok=True)
    all_data = build_all()
    agg = aggregate(all_data)
    write_outputs(all_data, agg)

    plt = setup_style()
    for gate in GATES:
        plot_curve(plt, gate, DATASETS, all_data)
        plot_pareto(plt, gate, DATASETS, all_data)

    # Console summary of the headline numbers.
    print("\n=== Learning summary (router stage, mean over seeds) ===")
    for gate in GATES:
        for ds in DATASETS:
            keys = agg[gate].get(ds, {})
            b = keys.get("router_base")
            l = keys.get("router_learn")
            if b and l:
                print(f"{gate:16s} {ds:8s}  disabled acc={b['accuracy'][0]:.3f} cas={b['cascade_rate'][0]:.3f}"
                      f"  |  learned acc={l['accuracy'][0]:.3f} cas={l['cascade_rate'][0]:.3f}")


if __name__ == "__main__":
    main()
