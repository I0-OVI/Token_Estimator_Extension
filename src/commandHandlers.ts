/**
 * Consolidated command palette flows (QuickPick) + argument dispatch for status bar / legacy IDs.
 */
import * as vscode from "vscode";
import { runEstimateScopeWithLlm, setLlmApiKey } from "./llmScope";
import { runWorkspaceScanAndImportGraph } from "./scanAndGraph";
import { runWorkspaceStructureScan } from "./workspaceScan";

type Arg = string | undefined;

export async function runEstimateCommand(
  args: unknown[],
  estimateFromActiveEditor: () => Promise<void>,
  estimateFromClipboard: () => Promise<void>
): Promise<void> {
  const mode = args[0] as Arg;
  if (mode === "editor") {
    await estimateFromActiveEditor();
    return;
  }
  if (mode === "clipboard") {
    await estimateFromClipboard();
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "$(file) Editor or selection",
        description: "Current file, or selected text",
        picked: true,
        value: "editor" as const,
      },
      {
        label: "$(clippy) Clipboard",
        description: "Text you copied (e.g. Composer prompt)",
        value: "clipboard" as const,
      },
    ],
    { title: "Token Prediction: estimate from…", placeHolder: "Choose source" }
  );
  if (!pick) {
    return;
  }
  if (pick.value === "editor") {
    await estimateFromActiveEditor();
  } else {
    await estimateFromClipboard();
  }
}

export function runInteractionLogCommand(
  args: unknown[],
  opts: { onStartTracking: () => void; onOpenLog: () => void }
): void {
  const mode = args[0] as Arg;
  if (mode === "track") {
    opts.onStartTracking();
    return;
  }
  if (mode === "log") {
    opts.onOpenLog();
    return;
  }

  void vscode.window
    .showQuickPick(
      [
        {
          label: "$(record) Start tracking edits",
          description: "Count lines ± and files touched for JSONL",
          value: "track" as const,
        },
        {
          label: "$(notebook) Log interaction",
          description: "Append prompt, answer, tokens to JSONL",
          value: "log" as const,
        },
      ],
      { title: "Token Prediction: interaction log…", placeHolder: "Choose action" }
    )
    .then((p) => {
      if (!p) {
        return;
      }
      if (p.value === "track") {
        opts.onStartTracking();
      } else {
        opts.onOpenLog();
      }
    });
}

export async function runScanWorkspaceCommand(args: unknown[]): Promise<void> {
  const mode = args[0] as Arg;
  if (mode === "structure") {
    try {
      await runWorkspaceStructureScan();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Token Prediction: workspace scan failed: ${msg}`);
    }
    return;
  }
  if (mode === "graph") {
    try {
      await runWorkspaceScanAndImportGraph();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Token Prediction: scan + graph failed: ${msg}`);
    }
    return;
  }

  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "$(folder) Structure only",
        description: "Save workspace summary JSON (file counts, extensions)",
        value: "structure" as const,
      },
      {
        label: "$(git-branch) Structure + import graph",
        description: "Summary + dependency graph (recommended for LLM / training)",
        value: "graph" as const,
      },
    ],
    { title: "Token Prediction: scan workspace…", placeHolder: "Choose scan type" }
  );
  if (!pick) {
    return;
  }
  if (pick.value === "structure") {
    try {
      await runWorkspaceStructureScan();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Token Prediction: workspace scan failed: ${msg}`);
    }
  } else {
    try {
      await runWorkspaceScanAndImportGraph();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Token Prediction: scan + graph failed: ${msg}`);
    }
  }
}

export function runLlmCommand(args: unknown[], context: vscode.ExtensionContext): void | Promise<void> {
  const mode = args[0] as Arg;
  if (mode === "key") {
    return setLlmApiKey(context);
  }
  if (mode === "scope") {
    return runEstimateScopeWithLlm(context);
  }

  void vscode.window
    .showQuickPick(
      [
        {
          label: "$(key) Set API key",
          description: "Stored in Secret Storage (not settings.json)",
          value: "key" as const,
        },
        {
          label: "$(hubot) Estimate scope with LLM",
          description: "Import graph + prompt → likely files (requires API)",
          value: "scope" as const,
        },
      ],
      { title: "Token Prediction: LLM…", placeHolder: "Choose action" }
    )
    .then((p) => {
      if (!p) {
        return;
      }
      if (p.value === "key") {
        return setLlmApiKey(context);
      }
      return runEstimateScopeWithLlm(context);
    });
}
