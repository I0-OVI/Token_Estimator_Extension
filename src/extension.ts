import * as vscode from "vscode";
import {
  runEstimateCommand,
  runInteractionLogCommand,
  runScanWorkspaceCommand,
} from "./commandHandlers";
import { predictionOptionsFromVsConfig } from "./config";
import type { TaskContextFeatures } from "./features";
import { EditSessionTracker } from "./interactionLog";
import { openInteractionLogPanel } from "./interactionLogPanel";
import { parseKeywordTaskKindMode, runEstimateWithKeywords } from "./keywordIntent";
import { registerStatusBar } from "./statusBar";
import { countTokens, freeAllEncodings } from "./tokenizer";
import { enrichEstimateFromWorkspaceSettings } from "./workspaceContextBoost";
import { buildEstimateRuntimeContext } from "./estimateRuntime";

let editTracker: EditSessionTracker | undefined;

async function estimateFromActiveEditor(extUri: vscode.Uri): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage(
      "Token Prediction: open a file first (Composer text is not visible to extensions)."
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration("tokenPrediction");
  const baseOpts = predictionOptionsFromVsConfig({
    tokenizer: cfg.get<string>("tokenizer", "cl100k_base"),
    taskKind: cfg.get<string>("taskKind", "general"),
    includeHistoryTurns: cfg.get<number>("includeHistoryTurns", 0),
    inputLengthModel: cfg.get<string>("inputLengthModel", "tiktoken"),
  });
  const keywordMode = parseKeywordTaskKindMode(cfg.get<string>("keywordTaskKindMode"));

  const selection = editor.selection;
  const text =
    selection && !selection.isEmpty
      ? editor.document.getText(selection)
      : editor.document.getText();

  if (!text.trim()) {
    vscode.window.showInformationMessage("Token Prediction: no text in scope (empty selection or file).");
    return;
  }

  const inputTokens = countTokens(text, baseOpts.tokenizerId);
  const features: TaskContextFeatures = {
    charLength: text.length,
    inputTokensExact: inputTokens,
    fileExtension: editor.document.fileName.includes(".")
      ? editor.document.fileName.split(".").pop()
      : undefined,
    hasSelection: Boolean(selection && !selection.isEmpty),
  };

  const ctx = buildEstimateRuntimeContext(extUri, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  let { est, extraNotes } = await runEstimateWithKeywords(text, baseOpts, keywordMode, ctx);
  est = enrichEstimateFromWorkspaceSettings(est, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

  const msg = [
    `Tokenizer: ${est.tokenizerId}`,
    `Task profile (heuristic): ${est.notes.find((n) => n.startsWith("Task profile:")) ?? `taskKind=${baseOpts.taskKind}`}`,
    `Input tokens: ${est.inputTokens}`,
    `Output (heuristic): ${est.outputTokensExpected} (range ${est.outputTokensLow}–${est.outputTokensHigh})`,
    `Total (est.): ${est.totalTokensExpected} (range ${est.totalTokensLow}–${est.totalTokensHigh})`,
    `Features: chars=${features.charLength}, selection=${features.hasSelection}`,
    ...extraNotes,
  ].join("\n");

  vscode.window.showInformationMessage(msg, { modal: true });
}

async function estimateFromClipboard(extUri: vscode.Uri): Promise<void> {
  const text = (await vscode.env.clipboard.readText()).replace(/\r\n/g, "\n");
  if (!text.trim()) {
    vscode.window.showWarningMessage(
      "Token Prediction: clipboard is empty. Copy your Composer prompt (e.g. Cmd+C) first."
    );
    return;
  }

  const cfg = vscode.workspace.getConfiguration("tokenPrediction");
  const baseOpts = predictionOptionsFromVsConfig({
    tokenizer: cfg.get<string>("tokenizer", "cl100k_base"),
    taskKind: cfg.get<string>("taskKind", "general"),
    includeHistoryTurns: cfg.get<number>("includeHistoryTurns", 0),
    inputLengthModel: cfg.get<string>("inputLengthModel", "tiktoken"),
  });
  const keywordMode = parseKeywordTaskKindMode(cfg.get<string>("keywordTaskKindMode"));

  const inputTokens = countTokens(text, baseOpts.tokenizerId);
  const features: TaskContextFeatures = {
    charLength: text.length,
    inputTokensExact: inputTokens,
    fileExtension: undefined,
    hasSelection: true,
  };

  const ctx = buildEstimateRuntimeContext(extUri, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  let { est, extraNotes } = await runEstimateWithKeywords(text, baseOpts, keywordMode, ctx);
  est = enrichEstimateFromWorkspaceSettings(est, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

  const msg = [
    "Source: clipboard (includes visible text only; @ context may add more tokens).",
    `Tokenizer: ${est.tokenizerId}`,
    `Task profile (heuristic): ${est.notes.find((n) => n.startsWith("Task profile:")) ?? `taskKind=${baseOpts.taskKind}`}`,
    `Input tokens: ${est.inputTokens}`,
    `Output (heuristic): ${est.outputTokensExpected} (range ${est.outputTokensLow}–${est.outputTokensHigh})`,
    `Total (est.): ${est.totalTokensExpected} (range ${est.totalTokensLow}–${est.totalTokensHigh})`,
    `Features: chars=${features.charLength}`,
    ...extraNotes,
  ].join("\n");

  vscode.window.showInformationMessage(msg, { modal: true });
}

export function activate(context: vscode.ExtensionContext): void {
  const extUri = context.extensionUri;
  registerStatusBar(context, extUri);

  const onStartTrackingEdits = (): void => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    editTracker?.dispose();
    editTracker = new EditSessionTracker(root);
    void vscode.window.showInformationMessage(
      "Token Prediction: edit tracking started (line +/− counts are approximate). Use Interaction log again when done."
    );
  };

  const onOpenLogInteraction = (): void => {
    openInteractionLogPanel(context, editTracker, () => {
      editTracker?.dispose();
      editTracker = undefined;
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("tokenPrediction.estimate", (...args: unknown[]) =>
      runEstimateCommand(args, () => estimateFromActiveEditor(extUri), () => estimateFromClipboard(extUri))
    ),
    vscode.commands.registerCommand("tokenPrediction.interactionLog", (...args: unknown[]) =>
      runInteractionLogCommand(args, {
        onStartTracking: onStartTrackingEdits,
        onOpenLog: onOpenLogInteraction,
      })
    ),
    vscode.commands.registerCommand("tokenPrediction.scanWorkspace", (...args: unknown[]) =>
      runScanWorkspaceCommand(args)
    )
  );

  /** @deprecated Prefer palette commands above; kept for keybindings / muscle memory */
  const legacy: [string, (...args: unknown[]) => void | Promise<void>][] = [
    ["tokenPrediction.showEstimateDetail", () => estimateFromActiveEditor(extUri)],
    ["tokenPrediction.estimateFromClipboard", () => estimateFromClipboard(extUri)],
    ["tokenPrediction.startTrackingEdits", () => onStartTrackingEdits()],
    ["tokenPrediction.logInteraction", () => onOpenLogInteraction()],
    [
      "tokenPrediction.scanWorkspaceStructure",
      async () => {
        await runScanWorkspaceCommand(["structure"]);
      },
    ],
    [
      "tokenPrediction.scanWorkspaceAndImportGraph",
      async () => {
        await runScanWorkspaceCommand(["graph"]);
      },
    ],
  ];
  for (const [id, fn] of legacy) {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  }
}

export function deactivate(): void {
  editTracker?.dispose();
  editTracker = undefined;
  freeAllEncodings();
}
