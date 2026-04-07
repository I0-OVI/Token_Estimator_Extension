# Token Prediction (VS Code extension)

**Token Prediction** is a VS Code extension that gives **rough, local estimates** of how many tokens a task might use. The **primary** path is an **offline-learned model** shipped as **`token_prediction.onnx`** (under `media/models/` in this repo, or via **`tokenPrediction.learnedModelPath`**). Training uses **LightGBM** when the `lightgbm` Python package is available; otherwise a sklearn gradient-boosting model is fitted and exported to the same ONNX format.

**Heuristics** (tiktoken + task-kind rules) are the **fallback and comparison baseline** when ONNX is off or missing. **`predictionBackend: auto`** (default) prefers the bundled ONNX; use **`heuristic`** only if you want the classic heuristic without the learned model. Everything runs **locally**—no API keys or network calls.

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
| **Import graph / workspace scan** | **Not** required for ONNX or heuristics | Improves **workspace context boosts** and enriches graph-related **features** when those JSON files exist |

---

## What it does

- **Estimate tokens** — Full file or selection in the active editor, or clipboard text: tiktoken on the input side, plus output/total bands (heuristic) or a learned total (ONNX) merged with the same range machinery.
- **Status bar (optional)** — Coarse live hint from the active editor. **Composer / chat input is not visible to extensions**; draft in a file or paste into an editor tab to preview.
- **Interaction log (JSONL)** — Optional logging for local analysis (path configurable); used when building training data offline.
- **Workspace scan / import graph** — Optional structure summary and graph JSON for **context boosts** and richer offline features—not mandatory for inference.

---

## Usage

### Install

- **From source**: `npm install`, `npm run compile`, then **Run Extension** in VS Code; or `npm run package:vsix` and install the `.vsix` via **Extensions: Install from VSIX…**.
- **`.vsix` files are not committed** to this repository (`*.vsix` is gitignored). To obtain a packaged build, run **`npm run package:vsix`** locally (version follows `package.json`).

### Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)

| Command | Description |
|--------|-------------|
| **Token Prediction: Estimate tokens…** | **Editor/selection** or **clipboard** — local only. |
| **Token Prediction: Interaction log…** | Start edit tracking or open the log panel (JSONL). |
| **Token Prediction: Scan workspace…** | Structure scan and/or import graph (optional, for boosts / offline training features). |

### Common settings (search `tokenPrediction` in Settings)

- **`tokenPrediction.tokenizer`** — `cl100k_base` or `o200k_base`; pick what matches your billing model best.
- **`tokenPrediction.taskKind`** — Task profile (`general`, `code`, `refactor`, …) for output-side heuristics when merging ranges.
- **`tokenPrediction.includeHistoryTurns`** — Rough allowance for assumed extra dialogue turns.
- **`tokenPrediction.showStatusBar`** — Toggle status bar estimate.
- **`tokenPrediction.predictionBackend`** — **`heuristic`**: always the original tiktoken + task-kind heuristic (no ONNX). **`auto`**: use **`token_prediction.onnx`** when present (bundled or via path below); otherwise heuristic. **`lightgbm`**: require ONNX; if missing or inference fails, fall back to heuristic with a note.
- **`tokenPrediction.learnedModelPath`** — Optional absolute or workspace-relative path to `token_prediction.onnx`. If set and the file exists, it **overrides** the bundled `media/models/token_prediction.onnx`.

Workspace context boosts (when enabled) apply **after** the base estimate.

Full option descriptions are in `package.json` under `contributes.configuration`.

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
2. **Python deps** (use a venv if you like):  
   `python3 -m pip install -r scripts/ml/requirements.txt`  
   (or `.venv/bin/python -m pip install -r scripts/ml/requirements.txt` if the repo has `.venv`).
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
