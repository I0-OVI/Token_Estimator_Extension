import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { countCharTokenHeuristic } from "./charTokenHeuristic";
import {
  appendInteractionLog,
  EditSessionTracker,
  getDefaultLogPath,
  type LoggedInteractionV1,
  resolveLogFilePath,
} from "./interactionLog";

function html(statsJson: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <style>
    body { font-family: system-ui, sans-serif; padding: 12px; max-width: 720px; }
    label { display: block; margin-top: 10px; font-weight: 600; }
    textarea { width: 100%; min-height: 90px; box-sizing: border-box; }
    input[type="number"] { width: 200px; }
    textarea.optional-paths { min-height: 56px; }
    .stats { background: var(--vscode-editor-inactiveSelectionBackground); padding: 8px; margin: 8px 0; font-size: 12px; white-space: pre-wrap; }
    button { margin-top: 12px; padding: 8px 16px; cursor: pointer; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 4px; }
  </style>
</head>
<body>
  <h3>Log interaction (reference for token prediction)</h3>
  <p class="hint">Fill after each Agent/Chat turn. Cursor token count is optional (from account usage / model line if available).</p>
  <div class="stats" id="stats">${escapeHtml(statsJson)}</div>
  <label>User prompt</label>
  <textarea id="prompt"></textarea>
  <label>Assistant answer (markdown)</label>
  <textarea id="answer"></textarea>
  <label>Thought / reasoning (optional)</label>
  <textarea id="thought" placeholder="Paste model thinking / reasoning text if the UI shows it (same idea as prompt vs answer)."></textarea>
  <p class="hint">Large cost when models “think” before answering — paste the visible thought block here; leave empty if none.</p>
  <label>Grep / search — file count (optional)</label>
  <input type="number" id="grepFiles" min="0" step="1" placeholder="0" />
  <label>Read file — file count (optional)</label>
  <input type="number" id="readFiles" min="0" step="1" placeholder="0" />
  <p class="hint">Fill counts from the chat tool list (e.g. how many files showed up in grep vs read_file). Paths below are optional — counts alone are enough for logging.</p>
  <label>Context file paths (optional, one per line)</label>
  <textarea id="filesReadPaths" class="optional-paths" placeholder="Only if you want paths; relative names are fine — full paths not required"></textarea>
  <p class="hint">Not auto-tracked. Edits are tracked separately when you use “Start tracking edits”.</p>
  <label>Cursor-reported token usage (optional)</label>
  <input type="number" id="tokens" min="0" step="1" placeholder="e.g. 67000" />
  <p class="hint">Leave empty if unknown. This is the closest to “billing truth” you can paste manually.</p>
  <p class="hint">Char heuristic and graph node count are filled automatically when possible.</p>
  <button id="save">Append to JSONL log</button>
  <script>
    const vscode = acquireVsCodeApi();
    function linesToPaths(text) {
      return text.split(/\\r?\\n/).map((s) => s.trim()).filter(Boolean);
    }
    function nonNegInt(id) {
      const raw = document.getElementById(id).value.trim();
      if (raw === '') return 0;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    }
    document.getElementById('save').addEventListener('click', () => {
      const userPrompt = document.getElementById('prompt').value;
      const assistantMarkdown = document.getElementById('answer').value;
      const raw = document.getElementById('tokens').value.trim();
      const cursorReportedTokens = raw === '' ? null : Number(raw);
      const grepContextFileCount = nonNegInt('grepFiles');
      const readContextFileCount = nonNegInt('readFiles');
      const filesRead = linesToPaths(document.getElementById('filesReadPaths').value);
      const thoughtMarkdown = document.getElementById('thought').value;
      let filesReadCount = grepContextFileCount + readContextFileCount;
      if (filesReadCount === 0 && filesRead.length > 0) {
        filesReadCount = filesRead.length;
      }
      vscode.postMessage({
        type: 'save',
        userPrompt,
        assistantMarkdown,
        cursorReportedTokens,
        grepContextFileCount,
        readContextFileCount,
        filesRead,
        filesReadCount,
        thoughtMarkdown,
      });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function openInteractionLogPanel(
  context: vscode.ExtensionContext,
  tracker: EditSessionTracker | undefined,
  onLogged?: () => void
): void {
  const cfg = vscode.workspace.getConfiguration("tokenPrediction");
  const logPath =
    resolveLogFilePath(cfg.get<string>("logFilePath")) ?? getDefaultLogPath();

  const wf = vscode.workspace.workspaceFolders?.[0];
  const root = wf?.uri.fsPath;
  const stats = tracker?.getStats(root) ?? {
    linesAdded: 0,
    linesRemoved: 0,
    linesTotalAbs: 0,
    filesChangedCount: 0,
    filesTouched: [] as string[],
  };
  const statsText = [
    `Tracked edits (since last "Start tracking edits"): `,
    `  lines + (inserted line fragments): ${stats.linesAdded}`,
    `  lines − (removed line fragments): ${stats.linesRemoved}`,
    `  total (sum +/− activity): ${stats.linesTotalAbs}`,
    `  files edited (write): ${stats.filesChangedCount}`,
    stats.filesTouched.length ? `  paths: ${stats.filesTouched.slice(0, 12).join(", ")}${stats.filesTouched.length > 12 ? "…" : ""}` : "",
    `Context reads: not auto-tracked — fill grep/read counts (or optional paths) in the form.`,
    ``,
    `Log file: ${logPath ?? "(no workspace — set tokenPrediction.logFilePath)"}`,
  ].join("\n");

  const panel = vscode.window.createWebviewPanel(
    "tokenPrediction.logInteraction",
    "Token Prediction: Log interaction",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = html(statsText);

  panel.webview.onDidReceiveMessage(
    (msg: {
      type: string;
      userPrompt: string;
      assistantMarkdown: string;
      cursorReportedTokens: number | null;
      grepContextFileCount?: number;
      readContextFileCount?: number;
      filesRead?: string[];
      filesReadCount?: number;
      thoughtMarkdown?: string;
    }) => {
      if (msg.type !== "save") return;
      if (!logPath) {
        vscode.window.showErrorMessage("Token Prediction: open a folder or set tokenPrediction.logFilePath.");
        return;
      }
      const filesRead = Array.isArray(msg.filesRead) ? msg.filesRead : [];
      const grepContextFileCount =
        typeof msg.grepContextFileCount === "number" && !Number.isNaN(msg.grepContextFileCount)
          ? Math.max(0, Math.floor(msg.grepContextFileCount))
          : 0;
      const readContextFileCount =
        typeof msg.readContextFileCount === "number" && !Number.isNaN(msg.readContextFileCount)
          ? Math.max(0, Math.floor(msg.readContextFileCount))
          : 0;
      let filesReadCount =
        typeof msg.filesReadCount === "number" && !Number.isNaN(msg.filesReadCount)
          ? Math.max(0, Math.floor(msg.filesReadCount))
          : grepContextFileCount + readContextFileCount;
      if (filesReadCount === 0 && filesRead.length > 0) {
        filesReadCount = filesRead.length;
      }
      const thoughtMarkdown = msg.thoughtMarkdown ?? "";
      const userPrompt = msg.userPrompt ?? "";
      const charHeuristicInputTokens = countCharTokenHeuristic(userPrompt).inputTokensApprox;
      const cfgGraph = vscode.workspace.getConfiguration("tokenPrediction");
      const graphRel = cfgGraph.get<string>(
        "importGraph.graphOutputRelativePath",
        ".cursor/token_prediction_import_graph.json"
      );
      let graphNodeCountAtLogTime: number | undefined;
      if (root) {
        const fp = path.join(root, ...graphRel.split(/[/\\]/).filter(Boolean));
        try {
          const raw = fs.readFileSync(fp, "utf8");
          const g = JSON.parse(raw) as {
            stats?: { nodeCount?: number };
            nodes?: unknown[];
          };
          graphNodeCountAtLogTime =
            typeof g.stats?.nodeCount === "number"
              ? g.stats.nodeCount
              : Array.isArray(g.nodes)
                ? g.nodes.length
                : undefined;
        } catch {
          graphNodeCountAtLogTime = undefined;
        }
      }
      const entry: LoggedInteractionV1 = {
        schemaVersion: 1,
        timestampIso: new Date().toISOString(),
        userPrompt,
        assistantMarkdown: msg.assistantMarkdown ?? "",
        cursorReportedTokens:
          msg.cursorReportedTokens != null && !Number.isNaN(msg.cursorReportedTokens)
            ? msg.cursorReportedTokens
            : null,
        linesAdded: stats.linesAdded,
        linesRemoved: stats.linesRemoved,
        linesTotalAbs: stats.linesTotalAbs,
        filesChangedCount: stats.filesChangedCount,
        filesTouched: stats.filesTouched,
        grepContextFileCount,
        readContextFileCount,
        filesRead,
        filesReadCount,
        thoughtMarkdown,
        charHeuristicInputTokens,
        graphNodeCountAtLogTime,
      };
      try {
        appendInteractionLog(entry, logPath);
        vscode.window.showInformationMessage(`Logged to ${logPath}`);
        onLogged?.();
        panel.dispose();
      } catch (e) {
        vscode.window.showErrorMessage(`Token Prediction: failed to write log: ${e}`);
      }
    },
    undefined,
    context.subscriptions
  );
}
