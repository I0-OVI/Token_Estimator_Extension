import * as vscode from "vscode";
import { predictionOptionsFromVsConfig } from "./config";
import { buildEstimateRuntimeContext } from "./estimateRuntime";
import { parseKeywordTaskKindMode, runEstimateWithKeywords } from "./keywordIntent";
import type { TokenEstimate } from "./types";
import { enrichEstimateFromWorkspaceSettings } from "./workspaceContextBoost";

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

/** e.g. 12345 → "1.23万", 800 → "0.08万" */
export function formatTokensAsWan(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const w = n / 10000;
  const s = w >= 10 ? w.toFixed(1) : w.toFixed(2);
  return `${s.replace(/\.?0+$/, "")}万`;
}

async function estimateFromEditor(
  editor: vscode.TextEditor,
  extUri: vscode.Uri
): Promise<{ est: TokenEstimate; extraNotes: string[] } | null> {
  const cfg = vscode.workspace.getConfiguration("tokenPrediction");
  const baseOpts = predictionOptionsFromVsConfig({
    tokenizer: cfg.get<string>("tokenizer", "cl100k_base"),
    taskKind: cfg.get<string>("taskKind", "general"),
    includeHistoryTurns: cfg.get<number>("includeHistoryTurns", 0),
    inputLengthModel: cfg.get<string>("inputLengthModel", "tiktoken"),
  });
  const keywordMode = parseKeywordTaskKindMode(cfg.get<string>("keywordTaskKindMode"));

  const sel = editor.selection;
  const text =
    sel && !sel.isEmpty ? editor.document.getText(sel) : editor.document.getText();
  if (!text.trim()) return null;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const ctx = buildEstimateRuntimeContext(extUri, root);
  const pair = await runEstimateWithKeywords(text, baseOpts, keywordMode, ctx);
  pair.est = enrichEstimateFromWorkspaceSettings(pair.est, root);
  return pair;
}

function tooltipFor(est: TokenEstimate, extraNotes: string[]): string {
  const charLine =
    est.inputTokensCharHeuristic !== undefined
      ? `Char heuristic (0.3/0.6): ${est.inputTokensCharHeuristic} tok`
      : null;
  return [
    "Token Prediction (heuristic)",
    `Input: ${est.inputTokens} tok (see settings: inputLengthModel)`,
    ...(charLine ? [charLine] : []),
    `Est. output: ${est.outputTokensExpected} tok`,
    `Est. total: ${est.totalTokensExpected} tok (range ${est.totalTokensLow ?? "—"}–${est.totalTokensHigh ?? "—"})`,
    ...est.notes.filter(
      (n) => n.startsWith("Task profile:") || n.startsWith("Workspace context")
    ),
    ...extraNotes,
    "",
    "Based on current file or selection — not Composer text (API limit).",
    "Click for full breakdown.",
  ].join("\n");
}

export function registerStatusBar(context: vscode.ExtensionContext, extensionUri: vscode.Uri): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = "Token Prediction";
  item.command = {
    command: "tokenPrediction.estimate",
    title: "Token Prediction: estimate (editor)",
    arguments: ["editor"],
  };
  context.subscriptions.push(item);

  const refresh = () => {
    void (async () => {
      const cfg = vscode.workspace.getConfiguration("tokenPrediction");
      if (!cfg.get<boolean>("showStatusBar", true)) {
        item.hide();
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        item.text = "$(graph) Token Prediction: —";
        item.tooltip =
          "No active editor. Open a file or draft your prompt in a file to see an estimate.\nComposer input is not visible to extensions.";
        item.show();
        return;
      }

      const pair = await estimateFromEditor(editor, extensionUri);
      if (!pair) {
        item.text = "$(graph) Token Prediction: —";
        item.tooltip = "No text in this file (or empty selection).";
        item.show();
        return;
      }

      const { est, extraNotes } = pair;
      const wan = formatTokensAsWan(est.totalTokensExpected);
      item.text = `$(graph) Token Prediction: ~${wan}`;
      item.tooltip = tooltipFor(est, extraNotes);
      item.show();
    })();
  };

  const debounced = () => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 250);
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => refresh()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.window.activeTextEditor?.document === e.document) {
        debounced();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tokenPrediction")) {
        refresh();
      }
    })
  );

  refresh();
}
