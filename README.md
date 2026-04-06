# Token Prediction (VS Code extension)

**Token Prediction** is a VS Code extension that gives **rough, local estimates** of how many tokens a task might use. It combines **tiktoken** (aligned with common billing encodings like `cl100k_base` / `o200k_base`) with **heuristic** rules for output-side ranges.

---

## Important disclaimer (please read)

**This extension cannot and does not promise to match any provider’s billed token usage exactly.** Real billing depends on the model and tokenizer the service actually uses, hidden system prompts, tools, multi-turn context, streaming, cache hits, and each vendor’s own metering. The extension only sees **text you can expose locally** (editor, clipboard, scans); the output side is a **heuristic band**, not a forecast.

Treat numbers as a **reference range**, not as an audit or billing guarantee. Discrepancies with invoices are expected.

---

## What it does

- **Estimate tokens** — Full file or selection in the active editor, or clipboard text: tiktoken count on the input side, plus heuristic output and total **ranges**.
- **Status bar (optional)** — Coarse live hint from the active editor. **Composer / chat input is not visible to extensions**; draft in a file or paste into an editor tab to preview.
- **Interaction log (JSONL)** — Optional logging for local analysis (path configurable).
- **Workspace scan** — Structure summary; optional import graph and per-node source tiktoken stats for extra context budget (still heuristic).
- **LLM scope (optional)** — OpenAI-compatible endpoint: one LLM call can guess “extra context” magnitude, cached locally for optional boosts. API keys are set via command and stored in VS Code **Secret Storage**.

---

## Usage

### Install

- **From source**: `npm install`, `npm run compile`, then **Run Extension** in VS Code; or `npm run package:vsix` and install the `.vsix` via **Extensions: Install from VSIX…**.

### Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)

| Command | Description |
|--------|-------------|
| **Token Prediction: Estimate tokens…** | Choose **editor/selection** or **clipboard**; shows input count, output band, total band. |
| **Token Prediction: Interaction log…** | Start edit tracking or open the log panel (JSONL). |
| **Token Prediction: Scan workspace…** | Structure-only scan, or scan + import graph (and optional token-budget JSON). |
| **Token Prediction: LLM…** | API key and LLM scope flows. |

### Common settings (search `tokenPrediction` in Settings)

- **`tokenPrediction.tokenizer`** — `cl100k_base` or `o200k_base`; pick what matches your billing model best.
- **`tokenPrediction.taskKind`** — Task profile (`general`, `code`, `refactor`, …) for output heuristics.
- **`tokenPrediction.includeHistoryTurns`** — Rough allowance for assumed extra dialogue turns.
- **`tokenPrediction.showStatusBar`** — Toggle status bar estimate.

Full option descriptions are in `package.json` under `contributes.configuration`.

---

## Development

```bash
npm install
npm run compile
npm test                 # compile + smoke tests
npm run package:vsix     # build a .vsix (requires @vscode/vsce)
```

The `scripts/` and `tools/` folders contain offline analysis, feature tables, JSONL validation, and related utilities for research and local data workflows.

---

## License

[MIT](LICENSE)
