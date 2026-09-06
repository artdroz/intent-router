#!/usr/bin/env python3
"""
Evaluation analysis — steps 1–3 and 5.

Reads the router's raw runs (evaluate/runs) and the LiteLLM baselines
(evaluate/litellm_baseline), computes the metrics used in the Evaluation
chapter, writes a raw comparison table (JSON + CSV + LaTeX), and renders the
figures referenced by the Results section into the dissertation resources dir.

Usage:
    .venv-analysis/bin/python evaluate/evaluator/analysis/analyze.py

Handling of degenerate averages:
  - macro accuracy averages only classes that appear in the evaluation split
    (a class with zero examples would otherwise produce a 0/0);
  - avg confidence correct/incorrect is None when there are no correct/incorrect
    predictions;
  - LLM conditional accuracy, cascade precision and avg LLM latency are None
    when nothing cascaded (avoiding a misleading 0);
  - avg LLM latency is averaged over cascaded prompts only, so the zero
    llmLatencyMs of non-cascaded prompts never dilutes the mean;
  - latency is reported as mean, p50 and p90 so one cold-start outlier cannot
    stand in for the whole distribution.
"""

import csv
import json
import statistics
from pathlib import Path

import numpy as np

# ── Paths ──
ROOT = Path(__file__).resolve().parents[3]                      # intent-router/
RUNS_DIR = ROOT / "evaluate" / "runs"
LITELLM_DIR = ROOT / "evaluate" / "litellm_baseline"
ANALYSIS_DIR = Path(__file__).resolve().parent
RESOURCES_DIR = Path("/Users/liyulin/Repositories/dev/msc-dissertation/resources")

SPLIT = "test"
PRECASCADE_FILE = "m0.54_H0.78_kw0.3_sem0.7"

GATES = ["request_type", "complexity_tier"]
DATASETS = ["k8", "cpython", "vscode"]

# Canonical class order (matches the dataset taxonomy, used for confusion plots).
CLASS_ORDER = {
    "request_type": [
        "code_generation", "code_understanding", "technical_design",
        "analytical_reasoning", "writing", "factual_lookup", "general",
    ],
    "complexity_tier": ["simple", "medium", "complex", "reasoning"],
}

# LiteLLM baseline files per gate, and their display names.
LITELLM_ROUTERS = {
    "request_type": [
        ("adaptive_router", "Adaptive router (regex)"),
        ("auto_router", "Auto router (semantic)"),
    ],
    "complexity_tier": [
        ("complexity_router_heuristic", "Complexity router (heuristic)"),
        ("complexity_router_llm", "Complexity router (LLM)"),
    ],
}

SYSTEM_COLORS = {
    "keyword": "#f39c12",            # amber
    "semantic": "#2ecc71",           # green
    "llm": "#9b59b6",                # purple
    "cascade": "#1f77b4",            # blue (the operating point)
    "adaptive_router": "#95a5a6",    # grey
    "auto_router": "#c0392b",          # red
    "complexity_router_heuristic": "#95a5a6",
    "complexity_router_llm": "#16a085",
}

SYSTEM_MARKERS = {
    "keyword": "o",
    "semantic": "o",
    "llm": "o",
    "cascade": "*",
    "adaptive_router": "s",
    "auto_router": "D",
    "complexity_router_heuristic": "s",
    "complexity_router_llm": "D",
}

SYSTEM_NAMES = {
    "keyword": "Keyword",
    "semantic": "Semantic",
    "llm": "LLM-only",
    "cascade": "Cascade (ours)",
    "adaptive_router": "Adaptive router (LiteLLM)",
    "auto_router": "Auto router (LiteLLM)",
    "complexity_router_heuristic": "Complexity heuristic (LiteLLM)",
    "complexity_router_llm": "Complexity LLM (LiteLLM)",
}


# ── Loading ──
def read_jsonl(path: Path):
    if not path.exists():
        raise FileNotFoundError(str(path))
    rows = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_router_rows(dataset: str, gate: str):
    """Return dict of raw row lists for the router's own stages."""
    base = RUNS_DIR / dataset / gate
    out = {
        "keyword": read_jsonl(base / "classifier" / f"keyword.{SPLIT}.jsonl"),
        "semantic": read_jsonl(base / "classifier" / f"semantic.{SPLIT}.jsonl"),
        "llm": read_jsonl(base / "classifier" / f"llm.{SPLIT}.jsonl"),
        "precascade": read_jsonl(base / "pre-cascade" / f"{PRECASCADE_FILE}.{SPLIT}.jsonl"),
        "cascade": read_jsonl(base / "router" / f"cascade.{SPLIT}.jsonl"),
    }
    return out


def load_litellm_rows(dataset: str, router_key: str):
    return read_jsonl(LITELLM_DIR / f"{dataset}_{router_key}.{SPLIT}.jsonl")


# ── Metrics helpers ──
def safe_mean(values):
    return float(np.mean(values)) if len(values) else None


def percentile(values, q):
    return float(np.percentile(values, q)) if len(values) else None


def top1(scores):
    vals = [v for v in scores.values() if isinstance(v, (int, float))]
    return max(vals) if vals else 0.0


def compute_ece(rows, bins=10):
    """Equal-mass binning of top-1 confidence (mirrors compute-metrics.ts)."""
    if not rows:
        return None
    ordered = sorted(rows, key=lambda r: top1(r["scores"]))
    bin_size = int(np.ceil(len(ordered) / bins))
    ece = 0.0
    for i in range(0, len(ordered), bin_size):
        chunk = ordered[i:i + bin_size]
        if not chunk:
            continue
        avg_conf = safe_mean([top1(r["scores"]) for r in chunk])
        acc = safe_mean([1.0 if r["correct"] else 0.0 for r in chunk])
        ece += (len(chunk) / len(ordered)) * abs(avg_conf - acc)
    return ece


def class_accuracy(rows):
    per = {}
    for r in rows:
        label = r["truth"]
        per.setdefault(label, {"total": 0, "correct": 0})
        per[label]["total"] += 1
        if r["correct"]:
            per[label]["correct"] += 1
    return per


def macro_accuracy(rows):
    per = class_accuracy(rows)
    accs = [c["correct"] / c["total"] for c in per.values() if c["total"] > 0]
    return float(np.mean(accs)) if accs else None


def compute_metrics(rows, kind):
    """kind: 'classifier' | 'precascade' | 'cascade' | 'litellm'."""
    n = len(rows)
    if n == 0:
        return None

    correct = sum(1 for r in rows if r["correct"])

    m = {
        "n": n,
        "accuracy": correct / n,
        "macro_accuracy": macro_accuracy(rows),
        "latency_mean": safe_mean([r["latency"] for r in rows]),
        "latency_p50": percentile([r["latency"] for r in rows], 50),
        "latency_p90": percentile([r["latency"] for r in rows], 90),
        "per_class": class_accuracy(rows),
    }

    if kind in ("classifier", "precascade"):
        correct_rows = [r for r in rows if r["correct"]]
        incorrect_rows = [r for r in rows if not r["correct"]]
        m["ece"] = compute_ece(rows)
        m["avg_conf_correct"] = (
            safe_mean([top1(r["scores"]) for r in correct_rows]) if correct_rows else None
        )
        m["avg_conf_incorrect"] = (
            safe_mean([top1(r["scores"]) for r in incorrect_rows]) if incorrect_rows else None
        )

    if kind == "precascade":
        cascaded = [r for r in rows if r["cascade"]]
        silent = [r for r in rows if (not r["correct"]) and (not r["cascade"])]
        m["cascade_rate"] = len(cascaded) / n
        m["silent_error_rate"] = len(silent) / n
        m["cascade_precision"] = (
            sum(1 for r in cascaded if not r["correct"]) / len(cascaded) if cascaded else None
        )
        m["regret_cascade_rate"] = sum(1 for r in rows if r["correct"] and r["cascade"]) / n

    if kind == "cascade":
        cascaded = [r for r in rows if r["cascaded"]]
        m["cascade_rate"] = len(cascaded) / n
        m["llm_cond_accuracy"] = (
            sum(1 for r in cascaded if r["correct"]) / len(cascaded) if cascaded else None
        )
        llm_lats = [r["llmLatencyMs"] for r in cascaded if r.get("llmLatencyMs", 0) > 0]
        m["avg_llm_latency"] = safe_mean(llm_lats) if llm_lats else None
        m["avg_pre_latency"] = safe_mean([r["preLatencyMs"] for r in rows])

    return m


def norm_row(row, latency_key="latencyMs", keep_scores=False):
    """Normalise a raw row into {truth, predicted, correct, latency[, scores]}."""
    out = {
        "truth": row["truth"],
        "predicted": row["predicted"],
        "correct": bool(row["correct"]),
        "latency": float(row[latency_key]),
    }
    if keep_scores and "scores" in row:
        out["scores"] = row["scores"]
    return out


# ── Build all system metrics ──
def build_all_metrics():
    """Return {gate: {system: {'by_dataset': {ds: metrics}, 'pooled': metrics}}}."""
    all_m = {}
    for gate in GATES:
        systems = {}
        for ds in DATASETS:
            r = load_router_rows(ds, gate)
            by_sys = {
                "keyword": ([norm_row(x, keep_scores=True) for x in r["keyword"]], "classifier"),
                "semantic": ([norm_row(x, keep_scores=True) for x in r["semantic"]], "classifier"),
                "llm": ([norm_row(x, keep_scores=True) for x in r["llm"]], "classifier"),
                "precascade": (
                    [dict(norm_row(x), cascade=bool(x["cascade"]), scores=x["scores"])
                     for x in r["precascade"]],
                    "precascade",
                ),
                "cascade": (
                    [dict(norm_row(x, "totalLatencyMs"),
                          cascaded=bool(x["cascaded"]),
                          preLatencyMs=x["preLatencyMs"],
                          llmLatencyMs=x["llmLatencyMs"])
                     for x in r["cascade"]],
                    "cascade",
                ),
            }
            for sys_name, (rows, kind) in by_sys.items():
                systems.setdefault(sys_name, {"kind": kind, "by_dataset": {}})
                systems[sys_name]["by_dataset"][ds] = compute_metrics(rows, kind)

        for router_key, display in LITELLM_ROUTERS[gate]:
            systems[router_key] = {"kind": "litellm", "display": display, "by_dataset": {}}
            for ds in DATASETS:
                raw = load_litellm_rows(ds, router_key)
                rows = [norm_row(x, "totalLatencyMs") for x in raw]
                systems[router_key]["by_dataset"][ds] = compute_metrics(rows, "litellm")

        # Pooled across datasets (concatenate, then recompute).
        for sys_name, info in systems.items():
            pooled_rows = []
            for ds in DATASETS:
                if sys_name in ("keyword", "semantic", "llm"):
                    pooled_rows += [norm_row(x, keep_scores=True)
                                    for x in load_router_rows(ds, gate)[sys_name]]
                elif sys_name == "precascade":
                    for x in load_router_rows(ds, gate)["precascade"]:
                        pooled_rows.append(dict(norm_row(x), cascade=bool(x["cascade"]),
                                                scores=x["scores"]))
                elif sys_name == "cascade":
                    for x in load_router_rows(ds, gate)["cascade"]:
                        pooled_rows.append(dict(
                            norm_row(x, "totalLatencyMs"), cascaded=bool(x["cascaded"]),
                            preLatencyMs=x["preLatencyMs"], llmLatencyMs=x["llmLatencyMs"]))
                else:  # litellm router
                    for x in load_litellm_rows(ds, sys_name):
                        pooled_rows.append(norm_row(x, "totalLatencyMs"))
            systems[sys_name]["pooled"] = compute_metrics(pooled_rows, info["kind"])

        all_m[gate] = systems
    return all_m


def fmt(v, nd=3):
    return None if v is None else round(v, nd)


# ── Serialisation (drop per_class dicts for compact output) ──
def serializable(m):
    if m is None:
        return None
    out = {k: (None if v is None else round(v, 6)) for k, v in m.items() if k != "per_class"}
    return out


# ── LaTeX / CSV / JSON output ──
def write_comparison(all_m):
    ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)

    # Flat CSV.
    csv_path = ANALYSIS_DIR / f"comparison_{SPLIT}.csv"
    with csv_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["gate", "system", "dataset", "n", "accuracy", "macro_accuracy",
                    "latency_mean_ms", "latency_p50_ms", "latency_p90_ms",
                    "cascade_rate", "llm_cond_accuracy", "silent_error_rate",
                    "cascade_precision", "regret_cascade_rate", "ece",
                    "avg_conf_correct", "avg_conf_incorrect"])
        for gate, systems in all_m.items():
            for sys_name, info in systems.items():
                for ds in DATASETS + ["pooled"]:
                    m = info["by_dataset"].get(ds) if ds != "pooled" else info["pooled"]
                    if m is None:
                        continue
                    w.writerow([gate, sys_name, ds, m["n"],
                                fmt(m["accuracy"]), fmt(m["macro_accuracy"]),
                                fmt(m["latency_mean"], 1), fmt(m["latency_p50"], 1),
                                fmt(m["latency_p90"], 1),
                                fmt(m.get("cascade_rate")), fmt(m.get("llm_cond_accuracy")),
                                fmt(m.get("silent_error_rate")),
                                fmt(m.get("cascade_precision")),
                                fmt(m.get("regret_cascade_rate")),
                                fmt(m.get("ece")), fmt(m.get("avg_conf_correct")),
                                fmt(m.get("avg_conf_incorrect"))])

    # JSON.
    json_path = ANALYSIS_DIR / f"comparison_{SPLIT}.json"
    payload = {
        gate: {sys_name: {
            "kind": info["kind"],
            "by_dataset": {ds: serializable(m) for ds, m in info["by_dataset"].items()},
            "pooled": serializable(info["pooled"]),
        } for sys_name, info in systems.items()}
        for gate, systems in all_m.items()
    }
    json_path.write_text(json.dumps(payload, indent=2), "utf-8")

    # LaTeX table fragment (pooled, test split).
    tex_path = ANALYSIS_DIR / f"comparison_{SPLIT}.tex"

    def fnum(v, spec):
        return "---" if v is None else f"{v:{spec}}"

    lines = []
    for gate in GATES:
        sys_list = ["keyword", "semantic", "llm", "cascade"] + \
                   [k for k, _ in LITELLM_ROUTERS[gate]]
        lines.append(f"% {gate} — pooled test split")
        lines.append("\\begin{tabular}{l r r r r r r}")
        lines.append("  \\toprule")
        lines.append("  System & Accuracy & Macro acc. & Avg lat. (ms) & p90 lat. (ms) & Cascade rate & LLM cond. acc. \\\\")
        lines.append("  \\midrule")
        for sys_name in sys_list:
            m = all_m[gate][sys_name]["pooled"]
            name = SYSTEM_NAMES.get(sys_name, sys_name)
            lines.append(
                f"  {name} & {fnum(m['accuracy'], '.3f')} & {fnum(m['macro_accuracy'], '.3f')} & "
                f"{fnum(m['latency_mean'], '.0f')} & {fnum(m['latency_p90'], '.0f')} & "
                f"{fnum(m.get('cascade_rate'), '.3f')} & {fnum(m.get('llm_cond_accuracy'), '.3f')} \\\\"
            )
        lines.append("  \\bottomrule")
        lines.append("\\end{tabular}")
        lines.append("")
    tex_path.write_text("\n".join(lines), "utf-8")

    print(f"CSV -> {csv_path}")
    print(f"JSON -> {json_path}")
    print(f"LaTeX -> {tex_path}")
    return payload


# ── Figures ──
def setup_style():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({
        "font.family": "DejaVu Sans",
        "font.size": 10,
        "axes.titlesize": 11,
        "axes.labelsize": 10,
        "axes.grid": True,
        "grid.alpha": 0.3,
        "figure.dpi": 150,
    })
    return plt


def figure_pareto(plt, gate, systems):
    sys_list = ["keyword", "semantic", "llm", "cascade"] + [k for k, _ in LITELLM_ROUTERS[gate]]
    fig, ax = plt.subplots(figsize=(6.6, 4.4))
    llm_acc = systems["llm"]["pooled"]["accuracy"]
    for sys_name in sys_list:
        m = systems[sys_name]["pooled"]
        x, y = m["latency_mean"], m["accuracy"]
        color = SYSTEM_COLORS[sys_name]
        name = SYSTEM_NAMES[sys_name]
        is_cascade = sys_name == "cascade"
        ax.scatter(x, y, s=70, marker="o", color=color,
                   zorder=5 if is_cascade else 3,
                   edgecolors="black" if is_cascade else "none",
                   linewidths=1.0 if is_cascade else 0, label=name)
    # Annotate cascade below its point and LLM-only above, so the two do not overlap.
    cas_m = systems["cascade"]["pooled"]
    llm_m = systems["llm"]["pooled"]
    ax.annotate(f"cascade rate {cas_m['cascade_rate']:.0%}\n({cas_m['latency_mean']:.0f} ms, {cas_m['accuracy']:.3f})",
                (cas_m["latency_mean"], cas_m["accuracy"]),
                textcoords="offset points", xytext=(-8, -34),
                fontsize=7.5, color=SYSTEM_COLORS["cascade"], fontweight="bold")
    ax.annotate(f"({llm_m['latency_mean']:.0f} ms, {llm_m['accuracy']:.3f})",
                (llm_m["latency_mean"], llm_m["accuracy"]),
                textcoords="offset points", xytext=(6, 12),
                fontsize=7.5, color=SYSTEM_COLORS["llm"])
    # Dashed reference at LLM-only accuracy: shows the cascade matches it at lower latency.
    ax.axhline(llm_acc, color=SYSTEM_COLORS["llm"], linestyle="--", linewidth=1, alpha=0.55)
    ax.annotate("LLM-only accuracy", xy=(0.985, llm_acc), xycoords=("axes fraction", "data"),
                ha="right", va="bottom", fontsize=7.5, color=SYSTEM_COLORS["llm"])
    ax.set_xscale("log")
    ax.set_xlabel("Average latency (ms, log scale)")
    ax.set_ylabel("Accuracy")
    ax.set_ylim(0, 1)
    ax.legend(fontsize=8, loc="upper left", framealpha=0.9)
    fig.tight_layout()
    out = RESOURCES_DIR / f"evaluation-pareto-{gate}.png"
    fig.savefig(out)
    plt.close(fig)
    print(f"Figure -> {out}")


def figure_confusion(plt, gate, systems, router_keys):
    """Confusion matrices: cascade vs the LiteLLM routers for the gate (pooled test)."""
    order = CLASS_ORDER[gate]
    n_panels = 1 + len(router_keys)
    fig, axes = plt.subplots(1, n_panels, figsize=(4.4 * n_panels, 4.0), squeeze=False,
                             constrained_layout=True)
    sys_list = ["cascade"] + router_keys

    vmax = 0
    matrices = []
    for sys_name in sys_list:
        rows = []
        for ds in DATASETS:
            if sys_name == "cascade":
                for x in load_router_rows(ds, gate)["cascade"]:
                    rows.append(norm_row(x, "totalLatencyMs"))
            else:
                for x in load_litellm_rows(ds, sys_name):
                    rows.append(norm_row(x, "totalLatencyMs"))
        idx = {l: i for i, l in enumerate(order)}
        mat = np.zeros((len(order), len(order)), dtype=int)
        for r in rows:
            i, j = idx.get(r["truth"]), idx.get(r["predicted"])
            if i is not None and j is not None:
                mat[i, j] += 1
        matrices.append(mat)
        vmax = max(vmax, int(mat.max()))

    cmap = plt.cm.Blues
    for ax, sys_name, mat in zip(axes[0], sys_list, matrices):
        im = ax.imshow(mat, cmap=cmap, vmin=0, vmax=vmax, aspect="auto")
        ax.set_xticks(range(len(order)))
        ax.set_yticks(range(len(order)))
        ax.set_xticklabels(order, rotation=45, ha="right", fontsize=7)
        ax.set_yticklabels(order, fontsize=7)
        ax.set_xlabel("Predicted")
        ax.set_ylabel("Truth")
        ax.set_title(SYSTEM_NAMES[sys_name], fontsize=9)
        for i in range(len(order)):
            for j in range(len(order)):
                v = mat[i, j]
                if v > 0:
                    color = "white" if v > 0.6 * vmax else "black"
                    ax.text(j, i, str(v), ha="center", va="center", fontsize=6, color=color)
        ax.grid(False)

    fig.colorbar(axes[0][0].images[0], ax=axes[0], fraction=0.046, pad=0.04, label="count")
    out = RESOURCES_DIR / f"evaluation-confusion-{gate}.png"
    fig.savefig(out, bbox_inches="tight")
    plt.close(fig)
    print(f"Figure -> {out}")


def figure_silent_errors(plt, gate, systems):
    """Per-class error rates: keyword (all wrong), semantic (all wrong),
    pre-cascade silent errors (wrong and not cascaded)."""
    order = CLASS_ORDER[gate]

    def collect(sys_name):
        rows = []
        for ds in DATASETS:
            if sys_name in ("keyword", "semantic"):
                rows += [norm_row(x) for x in load_router_rows(ds, gate)[sys_name]]
            elif sys_name == "precascade":
                for x in load_router_rows(ds, gate)["precascade"]:
                    rows.append(dict(norm_row(x), cascade=bool(x["cascade"])))
        return rows

    kw = collect("keyword")
    sem = collect("semantic")
    pc = collect("precascade")

    def rate_by_class(rows, silent_only=False):
        per = class_accuracy(rows)
        rates = []
        for label in order:
            total = per[label]["total"] if label in per else 0
            if total == 0:
                rates.append(0.0)
                continue
            if silent_only:
                wrong = sum(1 for r in rows if r["truth"] == label
                            and (not r["correct"]) and (not r["cascade"]))
            else:
                wrong = total - per[label]["correct"]
            rates.append(wrong / total)
        return rates

    kw_rate = rate_by_class(kw, False)
    sem_rate = rate_by_class(sem, False)
    pc_rate = rate_by_class(pc, True)

    # Muted, publication-friendly blue-grey ramp.
    colors = {"keyword": "#b8c4cf", "semantic": "#7f97a9", "precascade": "#40586b"}

    x = np.arange(len(order))
    width = 0.27
    fig, ax = plt.subplots(figsize=(6.8, 4.0))
    bars_kw = ax.bar(x - width, kw_rate, width, color=colors["keyword"], label="Keyword (all errors)")
    bars_sem = ax.bar(x, sem_rate, width, color=colors["semantic"], label="Semantic (all errors)")
    bars_pc = ax.bar(x + width, pc_rate, width, color=colors["precascade"],
                     label="Pre-cascade (silent errors)")
    for bars in (bars_kw, bars_sem, bars_pc):
        for b in bars:
            h = b.get_height()
            if h > 0:
                ax.text(b.get_x() + b.get_width() / 2, h + 0.012, f"{h:.2f}",
                        ha="center", va="bottom", fontsize=6.5, color="#3a3a3a")
    ax.set_xticks(x)
    ax.set_xticklabels(order, rotation=30, ha="right", fontsize=8)
    ax.set_ylabel("Error rate")
    ax.set_ylim(0, 1.08)
    ax.legend(fontsize=8, frameon=False)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    fig.tight_layout()
    out = RESOURCES_DIR / f"evaluation-silent-errors-{gate}.png"
    fig.savefig(out, bbox_inches="tight")
    plt.close(fig)
    print(f"Figure -> {out}")


# ── Disagreement table (saved for the analysis step, not written into the .tex yet) ──
def compute_disagreement(gate, systems):
    """Join cascade vs each LiteLLM router on (dataset, id); count agreements."""
    out = {}
    for router_key, _ in LITELLM_ROUTERS[gate]:
        rows = []
        for ds in DATASETS:
            cas = {r["id"]: r for r in load_router_rows(ds, gate)["cascade"]}
            lit = {r["id"]: r for r in load_litellm_rows(ds, router_key)}
            common = set(cas) & set(lit)
            if common != set(cas):
                print(f"  WARNING {gate}/{router_key}/{ds}: id mismatch "
                      f"(cascade {len(cas)}, litellm {len(lit)}, common {len(common)})")
            for cid in common:
                c, l = cas[cid], lit[cid]
                rows.append({
                    "truth": c["truth"],
                    "cascade_pred": c["predicted"],
                    "cascade_correct": bool(c["correct"]),
                    "litellm_pred": l["predicted"],
                    "litellm_correct": bool(l["correct"]),
                })
        disagree = [r for r in rows if r["cascade_pred"] != r["litellm_pred"]]
        out[router_key] = {
            "n": len(rows),
            "disagree": len(disagree),
            "cascade_right_litellm_wrong": sum(
                1 for r in disagree if r["cascade_correct"] and not r["litellm_correct"]),
            "litellm_right_cascade_wrong": sum(
                1 for r in disagree if r["litellm_correct"] and not r["cascade_correct"]),
            "both_wrong": sum(
                1 for r in disagree if (not r["cascade_correct"]) and (not r["litellm_correct"])),
        }
    path = ANALYSIS_DIR / f"disagreement_{gate}_{SPLIT}.json"
    path.write_text(json.dumps(out, indent=2), "utf-8")
    print(f"Disagreement -> {path}")
    for k, v in out.items():
        print(f"  {gate}/{k}: n={v['n']} disagree={v['disagree']} "
              f"cascade_right={v['cascade_right_litellm_wrong']} "
              f"litellm_right={v['litellm_right_cascade_wrong']} both_wrong={v['both_wrong']}")
    return out


# ── Main ──
def main():
    RESOURCES_DIR.mkdir(parents=True, exist_ok=True)
    all_m = build_all_metrics()
    payload = write_comparison(all_m)

    plt = setup_style()

    # Pareto (both gates).
    figure_pareto(plt, "request_type", all_m["request_type"])
    figure_pareto(plt, "complexity_tier", all_m["complexity_tier"])

    # Confusion matrices (both gates).
    figure_confusion(plt, "request_type", all_m["request_type"],
                     ["adaptive_router", "auto_router"])
    figure_confusion(plt, "complexity_tier", all_m["complexity_tier"],
                     ["complexity_router_heuristic", "complexity_router_llm"])

    # Silent errors (both gates).
    figure_silent_errors(plt, "request_type", all_m["request_type"])
    figure_silent_errors(plt, "complexity_tier", all_m["complexity_tier"])

    # Disagreement (both gates).
    for gate in GATES:
        compute_disagreement(gate, all_m[gate])

    # Console summary of pooled accuracy + latency for quick reading.
    print("\n=== Pooled test split summary ===")
    for gate in GATES:
        print(f"\n[{gate}]")
        for sys_name, info in all_m[gate].items():
            m = info["pooled"]
            print(f"  {SYSTEM_NAMES.get(sys_name, sys_name):32s} "
                  f"acc={m['accuracy']:.3f} macro={m['macro_accuracy']:.3f} "
                  f"lat={m['latency_mean']:.0f}ms p90={m['latency_p90']:.0f}ms "
                  f"cas={m.get('cascade_rate')} llmAcc={m.get('llm_cond_accuracy')}")


if __name__ == "__main__":
    main()
