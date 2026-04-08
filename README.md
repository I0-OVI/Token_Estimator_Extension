# Token Prediction (VS Code extension)

**Token Prediction** is a VS Code extension that gives **rough, local estimates** of how many tokens a task might use. The **primary** path is an **offline-learned model** shipped as **`token_prediction.onnx`** (under `media/models/` in this repo, or via **`tokenPrediction.learnedModelPath`**). Training uses **LightGBM** when the `lightgbm` Python package is available; otherwise a sklearn gradient-boosting model is fitted and exported to the same ONNX format.

**Heuristics** (tiktoken + task-kind rules) are the **fallback and comparison baseline** when ONNX is off or missing. **`predictionBackend: auto`** (default) prefers the bundled ONNX; use **`heuristic`** only if you want the classic heuristic without the learned model. Everything runs **locally**—no API keys or network calls.

This is a **standard VS Code extension** (see `engines.vscode` in `package.json`). Install the **`.vsix`** in **VS Code**, **Cursor**, or any editor that supports VS Code-compatible extensions—the same package; you do not need a separate “Cursor build.”

---

## Disclaimer

**This extension cannot and does not promise to match any provider’s billed token usage exactly.** Real billing depends on the model and tokenizer the service actually uses, hidden system prompts, tools, multi-turn context, streaming, cache hits, and each vendor’s own metering. The extension only sees **text you can expose locally** (editor, clipboard, scans); the output side is a **heuristic band** or a **learned point estimate**, not a forecast.

Treat numbers as a **reference range**, not as an audit or billing guarantee. Discrepancies with invoices are expected.

---

## What you need vs what is optional

| | Required for basic use | Optional |
|---|------------------------|----------|
| **Editor / clipboard estimate, status bar** | Install the extension; open a file or paste text | — |
| **Learned base (`ONNX`, LightGBM-trained when possible)** | Nothing extra if you use the **bundled** `media/models/token_prediction.onnx` and default **`predictionBackend: auto`** | Custom model: set **`tokenPrediction.learnedModelPath`** or replace the file under `media/models/` |
| **Import graph / workspace scan** | **Not** required | When present, they **can change the final total** (see below). |

### Import graph, scan, and the **total**

**After you run Scan workspace**, JSON is written under the workspace (default paths in `.cursor/`, configurable in Settings). **That output is not only for offline training** — it can affect **live** estimates in two ways: (1) with **`predictionBackend: auto`**, an **import-graph** file (from **Structure + import graph**) feeds **graph features into the ONNX model**; (2) with **`tokenPrediction.workspaceContextInEstimates`** **on** (default), the extension adds a **workspace boost** on top of the base total using the scan and/or graph JSON — so the **shown total** can go up after a scan even if your prompt text is unchanged. Turn **`workspaceContextInEstimates`** **off** to disable that boost only (ONNX can still use the graph file for model inputs if present).

- **Structure-only scan** → produces **`token_prediction_workspace_scan.json`**. Used for the boost (e.g. scanned file count), **not** as direct inputs inside the ONNX feature vector.
- **Structure + import graph** → also writes the **import graph** JSON (and may write a **graph token budget** JSON). Those feed **graph statistics into the ONNX model** (when using **`predictionBackend: auto`**) **and** can increase the workspace boost (graph token sum or heuristics from node counts).
- **You can estimate without running Scan** — base totals use only **editor/clipboard text** (plus settings). With no graph file, **ONNX graph features** are **zeros**; with no scan JSON, the **scan-based** part of the boost is absent.
- **If `workspaceContextInEstimates` is off**: the **workspace boost** step is skipped (scan/scan+graph JSON are not used to add tokens on top of the base). The ONNX path can **still** read the import-graph JSON for **model features** when a graph file exists — that is separate from the boost.

Turn off **`workspaceContextInEstimates`** if you want totals **without** workspace-derived bumps. Pure **`heuristic`** mode ignores ONNX but can still apply workspace boost when that setting is enabled.

---

## What it does

- **Estimate tokens** — Full file or selection in the active editor, or clipboard text: tiktoken on the input side, plus output/total bands (heuristic) or a learned total (ONNX) merged with the same range machinery.
- **Status bar (optional)** — Coarse live hint from the active editor. **Composer / chat input is not visible to extensions**; draft in a file or paste into an editor tab to preview.
- **Interaction log (JSONL)** — Optional logging for local analysis (path configurable); used when building training data offline.
- **Workspace scan / import graph** — Optional JSON artifacts for **workspace boosts** and (with ONNX) **richer model inputs**—not mandatory for a first estimate.

---

## Usage

### Install

- **From source**: `npm install`, `npm run compile`, then **Run Extension** in VS Code or Cursor; or `npm run package:vsix` and install the `.vsix` via **Extensions: Install from VSIX…**.
- **`.vsix` files are not committed** to this repository (`*.vsix` is gitignored). To obtain a packaged build, run **`npm run package:vsix`** locally (version follows `package.json`).

### Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)

| Command | Description |
|--------|-------------|
| **Token Prediction: Estimate tokens…** | **Editor/selection** or **clipboard** — local only. |
| **Token Prediction: Interaction log…** | Start edit tracking or open the log panel (JSONL). |
| **Token Prediction: Scan workspace…** | Structure scan and/or import graph (optional, for boosts / offline training features). |

### Common settings

In **Settings**, search **`tokenPrediction`**. The important ones: **`tokenizer`** (`cl100k_base` / `o200k_base`), **`taskKind`**, **`predictionBackend`** (`auto` = bundled ONNX when present, **`heuristic`** = rules only), **`learnedModelPath`** (override ONNX file), **`showStatusBar`**, **`workspaceContextInEstimates`**. Full keys and defaults are in **`package.json`** → `contributes.configuration`.

---

## Development

```bash
npm install
npm run compile
npm test                 # compile + smoke tests
npm run package:vsix     # compile + build .vsix (uses @vscode/vsce)
```

Note: **`npm run compile`** only runs TypeScript; **`npm run package:vsix`** produces the installable `.vsix`.

The `scripts/` and `tools/` folders contain offline analysis, feature tables, JSONL validation, and related utilities for research and local data workflows.

### Learned base model (train your own ONNX)

Used when you want to replace or refresh the bundled `media/models/token_prediction.onnx`.

1. **Feature table** (labeled JSONL + heuristics): `npm run build-feature-table` (reads `.cursor/token_prediction_log.jsonl` by default; requires prior `npm run compile`).
2. **Python deps** (venv recommended): `python3 -m pip install -r requirements.txt`  
   (same packages are listed under `scripts/ml/requirements.txt`; use `.venv/bin/python -m pip` if you use a venv).
3. **Train + export**: `npm run train-offline` — writes `scripts/ml/output/token_prediction.onnx` and `feature_order.json` (gitignored; feature order is mirrored in `src/learnedFeatures.ts`).
4. **Ship it**: copy the ONNX to **`media/models/token_prediction.onnx`** or point **`tokenPrediction.learnedModelPath`** at your file, then rebuild the extension / VSIX.

Inference uses **`onnxruntime-node`**. If the model is missing or inference fails, estimates fall back to the built-in heuristic.

### Desktop JSONL sample logger (optional)

[`tools/token_sample_logger.py`](tools/token_sample_logger.py) is a small **Tk** GUI that appends **one JSON object per line** to a log file, using the same **schema v1** as the extension’s interaction log (e.g. `userPrompt`, `assistantMarkdown`, token/line/file fields). Use it when you want to record samples **outside** VS Code.

```bash
npm run sample-logger
# or
python3 tools/token_sample_logger.py
```

- **Default output path**: `<cwd>/.cursor/token_prediction_log.jsonl` (the working directory is wherever you run the command from).
- **Override path**: `TOKEN_PREDICTION_LOG=/path/to/log.jsonl python3 tools/token_sample_logger.py`
- **macOS**: Tk **8.6+** is required; the system Python often ships an older Tk and the window may be blank. Prefer a Homebrew Python with Tk (e.g. `brew install python-tk`) or [python.org](https://www.python.org/downloads/) builds, then run that interpreter explicitly.

---

## License

[MIT](LICENSE)
