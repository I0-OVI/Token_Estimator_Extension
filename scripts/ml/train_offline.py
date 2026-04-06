#!/usr/bin/env python3
"""
Offline model: time-ordered hold-out on feature_table.csv vs cursorReportedTokens.
Compares training-mean baseline, baseline_heuristic_total (baselines.ts / predict.ts), and tree model.

Dependencies: pip install numpy scikit-learn
Optional: pip install lightgbm  (used when available for small tabular data)
"""
from __future__ import annotations

import csv
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

try:
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.metrics import mean_absolute_error
except ImportError:
    print("Install: pip install numpy scikit-learn", file=sys.stderr)
    raise

try:
    import lightgbm as lgb

    HAS_LGB = True
except (ImportError, OSError):
    # OSError: missing libomp (LightGBM native lib) on some macOS installs
    HAS_LGB = False
    lgb = None  # type: ignore[misc, assignment]

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CSV = ROOT / "scripts/ml/output/feature_table.csv"

FEATURE_COLS = [
    "user_char_len",
    "assistant_char_len",
    "tiktoken_user",
    "tiktoken_assistant",
    "tiktoken_sum",
    "thought_char_len",
    "tiktoken_thought",
    "thought_tokens_legacy",
    "tiktoken_sum_incl_thought",
    "naive_char_baseline_tokens",
    "baseline_heuristic_total",
    "linesAdded",
    "linesRemoved",
    "linesTotalAbs",
    "filesChangedCount",
    "grepContextFileCount",
    "readContextFileCount",
    "filesReadCount",
    "filesTouched_count",
    "log1p_tiktoken_sum",
    "log1p_tiktoken_incl_thought",
    "graph_node_count",
    "graph_edge_count",
    "graph_avg_out_degree",
    "graph_reachable_2hop",
    "char_heuristic_user_tokens",
    "graph_node_count_at_log_time",
    "llm_likely_files_count",
]


def parse_ts(s: str) -> datetime:
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


def load_rows(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out = []
    for r in rows:
        ct = (r.get("cursorReportedTokens") or "").strip()
        if not ct:
            continue
        r["_y"] = float(ct)
        r["_ts"] = parse_ts(r["timestampIso"])
        out.append(r)
    out.sort(key=lambda x: x["_ts"])
    return out


def _cell_float(r: dict, c: str) -> float:
    v = r.get(c)
    if v is None or v == "":
        return 0.0
    return float(v)


def to_X(rows: list[dict]) -> np.ndarray:
    return np.array([[_cell_float(r, c) for c in FEATURE_COLS] for r in rows], dtype=np.float64)


def main() -> None:
    csv_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CSV
    if not csv_path.is_file():
        print(f"Missing {csv_path}; run: npm run build-feature-table", file=sys.stderr)
        sys.exit(1)

    rows = load_rows(csv_path)
    n = len(rows)
    if n < 4:
        print(f"Need >= 4 labeled rows; got {n}. Add more JSONL samples.")
        sys.exit(0)

    # Time split: first ~80% train, last ~20% test (chronological)
    split = max(1, int(n * 0.8))
    if split >= n:
        split = n - 1
    train, test = rows[:split], rows[split:]

    y_train = np.array([r["_y"] for r in train])
    y_test = np.array([r["_y"] for r in test])
    X_train = to_X(train)
    X_test = to_X(test)

    mean_pred = np.full_like(y_test, fill_value=y_train.mean(), dtype=np.float64)
    baseline_pred = np.array([float(r["baseline_heuristic_total"]) for r in test])

    mae_mean = mean_absolute_error(y_test, mean_pred)
    mae_base = mean_absolute_error(y_test, baseline_pred)

    if HAS_LGB and len(train) >= 5:
        model = lgb.LGBMRegressor(
            n_estimators=80,
            learning_rate=0.05,
            num_leaves=15,
            min_child_samples=2,
            random_state=42,
            verbose=-1,
        )
        model.fit(X_train, y_train)
        pred = model.predict(X_test)
        mae_model = mean_absolute_error(y_test, pred)
        model_name = "LightGBM"
        importances = dict(zip(FEATURE_COLS, model.feature_importances_, strict=False))
        top = sorted(importances.items(), key=lambda x: -x[1])[:8]
    else:
        model = HistGradientBoostingRegressor(
            max_depth=4,
            max_iter=100,
            random_state=42,
        )
        model.fit(X_train, y_train)
        pred = model.predict(X_test)
        mae_model = mean_absolute_error(y_test, pred)
        model_name = "HistGradientBoostingRegressor (sklearn)"
        top = []

    print(f"Data: {csv_path}")
    print(f"Labeled rows: {n} | train: {len(train)} | test: {len(test)} (time-ordered hold-out)")
    print(f"Test window: {test[0]['timestampIso']} … {test[-1]['timestampIso']}")
    print()
    print("MAE on test (lower is better):")
    print(f"  train-mean predictor:     {mae_mean:,.2f}")
    print(f"  baseline_heuristic_total:   {mae_base:,.2f}  (src/predict.ts + baselines.ts, userPrompt-only)")
    print(f"  {model_name:26} {mae_model:,.2f}")
    if top:
        print()
        print("LightGBM feature importances (top):")
        for name, imp in top:
            print(f"  {name}: {imp:.4f}")
    if not HAS_LGB:
        print()
        print("(LightGBM unavailable — install `lightgbm` pip package; on macOS you may need `brew install libomp`.)")


if __name__ == "__main__":
    main()
