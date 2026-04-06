import type * as vscode from "vscode";
import { tpGet } from "./configRead";
import type { EstimateRuntimeContext } from "./keywordIntent";

export function buildEstimateRuntimeContext(
  extensionUri: vscode.Uri | undefined,
  workspaceRoot: string | undefined
): EstimateRuntimeContext {
  const backend = tpGet<string>("tokenPrediction.predictionBackend", "auto");
  const predictionBackend =
    backend === "heuristic" || backend === "lightgbm" || backend === "auto" ? backend : "auto";
  return {
    workspaceRoot,
    extensionUri,
    predictionBackend,
    learnedModelPath: tpGet<string>("tokenPrediction.learnedModelPath", ""),
    graphRelativePath: tpGet<string>(
      "tokenPrediction.importGraph.graphOutputRelativePath",
      ".cursor/token_prediction_import_graph.json"
    ),
  };
}
