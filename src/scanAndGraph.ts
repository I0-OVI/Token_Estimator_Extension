/**
 * One-shot: workspace structure JSON + import graph JSON for offline training features.
 * Optionally writes tiktoken sum over graph node files for live estimate boost.
 */
import * as vscode from "vscode";
import { tpGet } from "./configRead";
import { computeGraphTokenBudget, writeGraphTokenBudgetJson } from "./graphTokenBudget";
import { buildImportGraphAtRoot } from "./importGraphCore";
import type { TokenizerId } from "./types";
import { runWorkspaceStructureScan } from "./workspaceScan";

export async function runWorkspaceScanAndImportGraph(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showWarningMessage("Token Prediction: open a workspace folder first.");
    return;
  }

  const cfg = vscode.workspace.getConfiguration("tokenPrediction");
  const maxFilesRead = cfg.get<number>("importGraph.maxFilesRead", 100_000);
  const maxBytesPerFile = cfg.get<number>("importGraph.maxBytesPerFile", 512_000);
  const edgesCap = cfg.get<number>("importGraph.edgesCap", 500_000);
  const outRel = cfg.get<string>(
    "importGraph.graphOutputRelativePath",
    ".cursor/token_prediction_import_graph.json"
  );

  let scanResult;
  try {
    scanResult = await runWorkspaceStructureScan({ quiet: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`Token Prediction: workspace scan failed: ${msg}`);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Token Prediction: building import graph…",
      cancellable: true,
    },
    async (progress, token) => {
      const graphParts: string[] = [];
      for (let i = 0; i < folders.length; i++) {
        if (token.isCancellationRequested) {
          void vscode.window.showInformationMessage("Token Prediction: import graph cancelled.");
          return;
        }
        const folder = folders[i];
        progress.report({ message: `${folder.name} (${i + 1}/${folders.length})` });
        try {
          const r = buildImportGraphAtRoot(folder.uri.fsPath, {
            maxFilesRead,
            maxBytesPerFile,
            edgesCap,
            outRelativePath: outRel,
          });
          graphParts.push(`${r.nodeCount} nodes / ${r.edgeCount} edges`);

          if (tpGet<boolean>("tokenPrediction.importGraph.tokenizeNodesOnScan", true)) {
            progress.report({ message: `${folder.name}: tiktoken of graph node file contents…` });
            const tokRaw = tpGet<string>("tokenPrediction.tokenizer", "cl100k_base");
            const tok: TokenizerId = tokRaw === "o200k_base" ? "o200k_base" : "cl100k_base";
            const maxTokNodes = tpGet<number>("tokenPrediction.importGraph.tokenizeMaxNodes", 200);
            const maxTokBytes = tpGet<number>("tokenPrediction.importGraph.tokenizeMaxBytesPerNode", 512000);
            const budgetRel = tpGet<string>(
              "tokenPrediction.importGraph.graphTokenBudgetRelativePath",
              ".cursor/token_prediction_graph_token_budget.json"
            );
            const budgetOpts = {
              tokenizerId: tok,
              maxNodes: maxTokNodes,
              maxBytesPerFile: maxTokBytes,
            };
            const budgetRes = computeGraphTokenBudget(folder.uri.fsPath, r.outPath, budgetOpts);
            writeGraphTokenBudgetJson(
              folder.uri.fsPath,
              budgetRel,
              r.outPath,
              budgetOpts,
              budgetRes
            );
            graphParts[graphParts.length - 1] += `; graph tok sum ${budgetRes.totalTokens} (${budgetRes.filesTokenized} files)`;
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          void vscode.window.showErrorMessage(`Token Prediction: import graph failed: ${msg}`);
          return;
        }
      }

      const scanHint =
        scanResult.writtenPaths.length === 1
          ? "workspace scan saved"
          : `${scanResult.writtenPaths.length} workspace scans saved`;
      void vscode.window.showInformationMessage(
        `Token Prediction: ${scanHint}; import graph: ${graphParts.join(" | ")}. ` +
          `Token budget JSON (if enabled) feeds workspace boost in estimates. Offline: npm run build-feature-table.`
      );
    }
  );
}
