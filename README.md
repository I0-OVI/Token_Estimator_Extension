# Token Prediction (VS Code extension)

**Token Prediction** is a VS Code extension that gives **rough, local estimates** of how many tokens a task might use. The **primary** path is an **offline-learned model** shipped as **`token_prediction.onnx`** (under `media/models/` in this repo, or via **`tokenPrediction.learnedModelPath`**). Training uses **LightGBM** when the `lightgbm` Python package is available; otherwise a sklearn gradient-boosting model is fitted and exported to the same ONNX format.

**Heuristics** (tiktoken + task-kind rules) and **LLM API** calls are **secondary**: useful as a **baseline for comparison** or for optional “clipboard + LLM” experiments. **You do not need an API key** for normal **Estimate** or the **status bar**—those run locally. **`predictionBackend: auto`** (default) prefers the bundled ONNX; use **`heuristic`** only if you want to compare against the classic heuristic without the learned model.

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
| **API keys / network** | **Not** required for estimates or ONNX inference | **Optional / comparison:** only **Token Prediction: LLM…** and **Estimate (clipboard + LLM)** call an OpenAI-compatible API |
| **Import graph / workspace scan** | **Not** required for ONNX or heuristics | Improves **workspace context boosts** and can enrich graph-related **features** when those JSON files exist |

So: **after you ship a trained ONNX inside the extension, day-to-day use does not depend on calling an LLM or generating a graph.** Graph and LLM remain **optional layers** on top of the base estimate.

---

## What it does

- **Estimate tokens** — Full file or selection in the active editor, or clipboard text: tiktoken on the input side, plus output/total bands (heuristic) or a learned total (ONNX) merged with the same range machinery.
- **Status bar (optional)** — Coarse live hint from the active editor. **Composer / chat input is not visible to extensions**; draft in a file or paste into an editor tab to preview.
- **Interaction log (JSONL)** — Optional logging for local analysis (path configurable); used when building training data offline.
- **Workspace scan / import graph** — Optional structure summary and graph JSON for **context boosts** and richer offline features—not mandatory for inference.
- **LLM (optional)** — OpenAI-compatible endpoint for scope and **clipboard + LLM** flows only. Keys live in VS Code **Secret Storage**.

---

## Usage

### Install

- **From source**: `npm install`, `npm run compile`, then **Run Extension** in VS Code; or `npm run package:vsix` and install the `.vsix` via **Extensions: Install from VSIX…**.
- **`.vsix` files are not committed** to this repository (`*.vsix` is gitignored). To obtain a file such as `token-prediction-0.2.2.vsix`, run **`npm run package:vsix`** locally (version follows `package.json`), or use a **release attachment** if the maintainer uploads one.

### Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)

| Command | Description |
|--------|-------------|
| **Token Prediction: Estimate tokens…** | **Editor/selection** or **clipboard** — local only; no API. |
| **Token Prediction: Estimate (clipboard + LLM)…** | One LLM call; merges extras into totals (needs API key). |
| **Token Prediction: Interaction log…** | Start edit tracking or open the log panel (JSONL). |
| **Token Prediction: Scan workspace…** | Structure scan and/or import graph (optional, for boosts / offline features). |
| **Token Prediction: LLM…** | API key and LLM scope flows. |

### Common settings (search `tokenPrediction` in Settings)

- **`tokenPrediction.tokenizer`** — `cl100k_base` or `o200k_base`; pick what matches your billing model best.
- **`tokenPrediction.taskKind`** — Task profile (`general`, `code`, `refactor`, …) for output-side heuristics when merging ranges.
- **`tokenPrediction.includeHistoryTurns`** — Rough allowance for assumed extra dialogue turns.
- **`tokenPrediction.showStatusBar`** — Toggle status bar estimate.
- **`tokenPrediction.predictionBackend`** — **`heuristic`**: always the original tiktoken + task-kind heuristic (no ONNX). **`auto`**: use **`token_prediction.onnx`** when present (bundled or via path below); otherwise heuristic. **`lightgbm`**: require ONNX; if missing or inference fails, fall back to heuristic with a note.
- **`tokenPrediction.learnedModelPath`** — Optional absolute or workspace-relative path to `token_prediction.onnx`. If set and the file exists, it **overrides** the bundled `media/models/token_prediction.onnx`.

Workspace and LLM boosts (when enabled) apply **after** the base estimate, same order as before.

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
