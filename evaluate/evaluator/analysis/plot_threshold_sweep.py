#!/usr/bin/env python3
"""
Plot the threshold-sweep surface persisted by tune-thresholds.ts.

Reads the JSON written by `npx tsx evaluate/evaluator/runner/tune-thresholds.ts`
(defaults to the most recent file in evaluate/runs/thresholds) and renders a
single figure with three panels:
  1. regret cascade rate vs margin  (one line per entropy step)
  2. silent error rate    vs margin  (one line per entropy step)
  3. cost                 vs margin  (one line per entropy step)

The star marks a chosen operating point: pass --margin/--entropy, or it falls
back to the cost-minimising combination. The figure file name carries the
weights and step (wErr/wDoubt/step) so different sweeps stay distinct, but those
values are left off the image itself.

Usage:
    .venv-analysis/bin/python evaluate/evaluator/analysis/plot_threshold_sweep.py
    .venv-analysis/bin/python evaluate/evaluator/analysis/plot_threshold_sweep.py \
        evaluate/runs/thresholds/threshold-sweep_wErr1.5_wDoubt1_step0.01.json
    .venv-analysis/bin/python evaluate/evaluator/analysis/plot_threshold_sweep.py \
        --margin 0.5 --entropy 0.75
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

# ── Paths ──
ROOT = Path(__file__).resolve().parents[3]                      # intent-router/
THRESHOLDS_DIR = ROOT / "evaluate" / "runs" / "thresholds"
RESOURCES_DIR = Path("/Users/liyulin/Repositories/dev/msc-dissertation/resources")


def load_sweep(path: Path):
    """Return (meta, results) from a tune-thresholds JSON output."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):          # bare SweepResult[] (legacy)
        return None, data
    return data.get("meta"), data.get("results", [])


def fmt_num(value):
    """Compact float formatting for file names / labels."""
    s = f"{value:g}"
    return s.replace("-", "m")


def main():
    parser = argparse.ArgumentParser(
        description="Plot a threshold-sweep surface JSON produced by "
                    "tune-thresholds.ts.")
    parser.add_argument("path", nargs="?",
                        help="sweep JSON path (default: newest in "
                             "evaluate/runs/thresholds)")
    parser.add_argument("--margin", type=float, default=None,
                        help="margin threshold to mark with the star")
    parser.add_argument("--entropy", type=float, default=None,
                        help="entropy threshold to mark with the star")
    args = parser.parse_args()

    if (args.margin is None) != (args.entropy is None):
        parser.error("--margin and --entropy must be given together")

    if args.path:
        path = Path(args.path)
    else:
        files = sorted(THRESHOLDS_DIR.glob("threshold-sweep_*.json"))
        if not files:
            print(f"No threshold-sweep JSON found in {THRESHOLDS_DIR}")
            sys.exit(1)
        path = files[-1]

    meta, results = load_sweep(path)
    if not results:
        print(f"No sweep results in {path}")
        sys.exit(1)

    # ── Grid: one line per entropy value, x = margin ──
    # Round floats so dict lookups are stable after JSON round-tripping.
    key = lambda m, h: (round(float(m), 6), round(float(h), 6))

    grid = {key(r["margin"], r["entropy"]): r for r in results}
    margins = sorted({m for m, _ in grid})
    entropies = sorted({h for _, h in grid})

    def series(metric):
        """Return a list of (label, xs, ys) — one per entropy step."""
        lines = []
        for h in entropies:
            xs = []
            ys = []
            for m in margins:
                r = grid.get(key(m, h))
                if r is None:
                    xs.append(float("nan"))
                    ys.append(float("nan"))
                else:
                    xs.append(m)
                    ys.append(float(r[metric]))
            lines.append((f"{h:g}", np.asarray(xs, dtype=float),
                          np.asarray(ys, dtype=float)))
        return lines

    # Operating point: explicit --margin/--entropy (nearest grid point), else
    # the cost-minimising combination.
    if args.margin is not None and args.entropy is not None:
        op = min(results, key=lambda r: (r["margin"] - args.margin) ** 2
                                         + (r["entropy"] - args.entropy) ** 2)
    else:
        op = min(results, key=lambda r: r["cost"])

    # ── Figure ──
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

    metrics = [
        ("regretCascadeRate", "Regret cascade rate", "regret rate (wasted LLM)"),
        ("silentErrorRate", "Silent error rate", "silent error rate"),
        ("cost", "Cost", "cost"),
    ]

    fig, axes = plt.subplots(1, 3, figsize=(14.0, 4.2), sharex=True,
                             constrained_layout=True)

    cmap = plt.cm.viridis
    norm = plt.Normalize(vmin=entropies[0], vmax=entropies[-1])

    for ax, (metric, title, ylabel) in zip(axes, metrics):
        for label, xs, ys in series(metric):
            ax.plot(xs, ys, color=cmap(norm(float(label))), lw=1.0, alpha=0.85)
        ax.axvline(op["margin"], color="#1f77b4", ls="--", lw=0.9, alpha=0.7)
        ax.axhline(op[metric], color="#1f77b4", ls=":", lw=0.9, alpha=0.7)
        ax.plot([op["margin"]], [op[metric]], marker="*", markersize=14,
                color="#d62728", zorder=5, markeredgecolor="black", markeredgewidth=0.5)
        ax.set_xlabel("Margin threshold")
        ax.set_ylabel(ylabel)
        ax.set_title(title)
        ax.set_xlim(margins[0], margins[-1])
        if metric != "cost":
            ax.set_ylim(0, None)

    sm = plt.cm.ScalarMappable(cmap=cmap, norm=norm)
    sm.set_array([])
    fig.colorbar(sm, ax=axes, fraction=0.03, pad=0.02).set_label("Entropy threshold")

    if meta:
        out_name = (f"evaluation-threshold-sweep_wErr{fmt_num(meta['wError'])}"
                    f"_wDoubt{fmt_num(meta['wDoubt'])}"
                    f"_step{fmt_num(meta['step'])}.png")
    else:
        out_name = "evaluation-threshold-sweep.png"
    out = RESOURCES_DIR / out_name
    RESOURCES_DIR.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, bbox_inches="tight")
    plt.close(fig)

    print(f"JSON source -> {path}")
    print(f"Figure      -> {out}")
    print(f"Star point  -> margin={op['margin']} entropy={op['entropy']} "
          f"cost={op['cost']:.4f} "
          f"(silentErr={op['silentErrorRate']:.1%}, "
          f"regretCas={op['regretCascadeRate']:.1%})")


if __name__ == "__main__":
    main()
