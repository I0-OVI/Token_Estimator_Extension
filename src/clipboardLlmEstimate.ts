/**
 * ## Estimate — Clipboard + LLM
 *
 * One network call: the model scores **thinking**, **duration**, **difficulty**, and a raw **extraContextTokensGuess**.
 * The extension merges those into `extraContextTokensCombined` (see `combineLlmScopeTokens` in `llmScopeCompute.ts`).
 *
 * ### Variables considered (end-to-end)
 *
 * **A. Baseline (local, no LLM)**
 * - `text` — clipboard string (normalized newlines).
 * - `tokenizerId` — `tokenPrediction.tokenizer` (`cl100k_base` / `o200k_base`).
 * - `taskKind`, `extraHistoryTurns`, `inputLengthModel`, output multipliers — from `predictionOptionsFromVsConfig` / `predict.ts`.
 * - `keywordTaskKindMode` — optional local keyword override (`keywordIntent.ts`).
 * - Produces `TokenEstimate` **B** (input tiktoken, output heuristic bands, totals).
 *
 * **B. Workspace context boost (local files, no LLM in this step)**
 * - Import graph token budget JSON, workspace scan JSON, graph node counts — same as `enrichEstimateFromWorkspaceSettings`,
 *   but **`skipLlmCache: true`** so we do **not** read `.cursor/token_prediction_llm_scope_last.json` (avoids mixing with a prior graph-scope run).
 * - Produces **B′** = B + graph/scan heuristic boost.
 *
 * **C. LLM response fields (single chat completion)**
 * - `extraContextTokensGuess` — model’s guess for hidden context tokens (tools, system, etc.).
 * - `needsThinking` — whether extended reasoning is likely.
 * - `thinkingDurationSeconds` — seconds of reasoning (0 if not needed); capped by `tokenPrediction.llm.maxThinkingDurationSeconds`.
 * - `questionDifficulty` — 1–5 (1 trivial, 5 very hard).
 * - `rationale` — optional text (shown in output channel).
 * - `likelyFiles` / `relatedFiles` — when an import graph JSON exists, same rules as graph LLM scope; paths filtered to graph nodes. Shown in the estimate modal and Output; optional reference tiktoken sum from `graph_token_budget.json` for those paths only (informational — not double-added to totals if workspace boost already used full graph).
 *
 * **D. Client-side merge (`combineLlmScopeTokens`)**
 * - `thinkingTokensFromDuration` = `needsThinking ? min(thinkingDurationSeconds, maxSec) × thinkingTokensPerSecond : 0`
 * - `difficultyExtraTokens` = `max(0, difficulty − 1) × difficultyExtraTokensPerStep` (0 if per-step setting is 0).
 * - `extraContextTokensCombined` = `clamp(extraContextTokensGuess + thinkingTokensFromDuration + difficultyExtraTokens, 0, 500000)`
 *
 * **E. Final modal totals**
 * - `B′.totalTokens*` += `extraContextTokensCombined` (additive, same pattern as workspace boost).
 *
 * **Note:** Import-graph LLM scope (`runEstimateScopeWithLlm`) uses a **different** prompt (files only + raw `extraContextTokensGuess`) and does **not** ask for thinking/difficulty.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { predictionOptionsFromVsConfig } from "./config";
import { tpGet } from "./configRead";
import { buildEstimateRuntimeContext } from "./estimateRuntime";
import { parseKeywordTaskKindMode, runEstimateWithKeywords } from "./keywordIntent";
import {
  applyWorkspaceContextBoost,
  enrichEstimateIfWorkspaceArtifacts,
  type WorkspaceContextPaths,
} from "./workspaceContextBoost";
import { combineLlmScopeTokens, parseLlmScopeModelFields } from "./llmScopeCompute";
import { filterToGraphPaths, LLM_SECRET_KEY, parseLlmJsonContent, resolveLlmApiUrl } from "./llmScope";

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Token Prediction");
  }
  return outputChannel;
}

/** Load import graph for LLM payload; returns null if missing or invalid. */
function loadGraphForClipboardLlm(root: string): {
  graphSummary: {
    nodeCount: number;
    truncatedSampleNodes: { id: string; roleHint: string }[];
    truncatedSampleNodeIds: string[];
    edgesSample: unknown[];
  };
  nodeSet: Set<string>;
} | null {
  const graphRel = tpGet<string>(
    "tokenPrediction.importGraph.graphOutputRelativePath",
    ".cursor/token_prediction_import_graph.json"
  );
  const fullPath = path.join(root, ...graphRel.split(/[/\\]/).filter(Boolean));
  let graphRaw: string;
  try {
    graphRaw = fs.readFileSync(fullPath, "utf8");
  } catch {
    return null;
  }
  let graph: {
    nodes?: { id: string; roleHint?: string }[];
    edges?: unknown[];
    stats?: { nodeCount?: number };
  };
  try {
    graph = JSON.parse(graphRaw) as typeof graph;
  } catch {
    return null;
  }
  const nodes = graph.nodes ?? [];
  const edges = graph.edges ?? [];
  const nodeSet = new Set(nodes.map((n) => n.id));
  const maxNodes = 80;
  const maxEdges = 160;
  const truncatedSampleNodes = nodes.slice(0, maxNodes).map((n) => ({
    id: n.id,
    roleHint: typeof n.roleHint === "string" ? n.roleHint : "",
  }));
  return {
    graphSummary: {
      nodeCount: graph.stats?.nodeCount ?? nodes.length,
      truncatedSampleNodes,
      truncatedSampleNodeIds: truncatedSampleNodes.map((n) => n.id),
      edgesSample: edges.slice(0, maxEdges),
    },
    nodeSet,
  };
}

/** Sum per-file tokens from graph token budget JSON for given graph node ids (reference only). */
function sumBudgetTokensForPaths(
  root: string,
  budgetRel: string,
  paths: string[]
): { sum: number; matched: number } {
  if (paths.length === 0) {
    return { sum: 0, matched: 0 };
  }
  const budgetPath = path.join(root, ...budgetRel.split(/[/\\]/).filter(Boolean));
  let raw: string;
  try {
    raw = fs.readFileSync(budgetPath, "utf8");
  } catch {
    return { sum: 0, matched: 0 };
  }
  let doc: { byFile?: { id: string; tokens?: number }[] };
  try {
    doc = JSON.parse(raw) as typeof doc;
  } catch {
    return { sum: 0, matched: 0 };
  }
  const byFile = doc.byFile ?? [];
  const want = new Set(paths);
  let sum = 0;
  let matched = 0;
  for (const row of byFile) {
    if (typeof row.id === "string" && want.has(row.id) && typeof row.tokens === "number") {
      sum += row.tokens;
      matched += 1;
    }
  }
  return { sum, matched };
}

export async function runClipboardLlmEstimate(context: vscode.ExtensionContext): Promise<void> {
  const { url: apiUrl, error: urlError } = resolveLlmApiUrl();
  if (urlError || !apiUrl) {
    void vscode.window.showErrorMessage(urlError ?? "Token Prediction: could not resolve LLM URL.");
    return;
  }
  const model =
    tpGet<string>("tokenPrediction.llm.model", "deepseek-chat").trim() || "deepseek-chat";

  const apiKey = await context.secrets.get(LLM_SECRET_KEY);
  if (!apiKey) {
    void vscode.window.showInformationMessage(
      "Token Prediction: set your API key first — Token Prediction: LLM… → Set API key"
    );
    return;
  }

  const text = (await vscode.env.clipboard.readText()).replace(/\r\n/g, "\n");
  if (!text.trim()) {
    void vscode.window.showWarningMessage(
      "Token Prediction: clipboard is empty. Copy your prompt (e.g. Cmd+C) first."
    );
    return;
  }

  const thinkingTokPerSec = tpGet<number>("tokenPrediction.llm.thinkingTokensPerSecond", 32);
  const maxThinkSec = tpGet<number>("tokenPrediction.llm.maxThinkingDurationSeconds", 1200);
  const diffPerStep = tpGet<number>("tokenPrediction.llm.difficultyExtraTokensPerStep", 400);

  const cfg = vscode.workspace.getConfiguration("tokenPrediction");
  const baseOpts = predictionOptionsFromVsConfig({
    tokenizer: cfg.get<string>("tokenizer", "cl100k_base"),
    taskKind: cfg.get<string>("taskKind", "general"),
    includeHistoryTurns: cfg.get<number>("includeHistoryTurns", 0),
    inputLengthModel: cfg.get<string>("inputLengthModel", "tiktoken"),
  });
  const keywordMode = parseKeywordTaskKindMode(cfg.get<string>("keywordTaskKindMode"));

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Token Prediction: clipboard + LLM…",
      cancellable: true,
    },
    async (_progress, token) => {
      const ac = new AbortController();
      const sub = token.onCancellationRequested(() => ac.abort());
      try {
        const folder = vscode.workspace.workspaceFolders?.[0];
        const graphPack = folder ? loadGraphForClipboardLlm(folder.uri.fsPath) : null;

        const systemPrompt = `You help estimate token usage for a coding assistant turn. The user message is from the clipboard. Reply with JSON only, no markdown:
{"extraContextTokensGuess":0,"needsThinking":false,"thinkingDurationSeconds":0,"questionDifficulty":3,"rationale":"","likelyFiles":[],"relatedFiles":[]}
Fields:
- extraContextTokensGuess: integer 0–500000, rough extra tokens beyond the visible user text (system prompts, tools, retrieval, hidden context).
- needsThinking: true if a good answer likely needs extended reasoning (multi-step debugging, design tradeoffs); false for trivial or one-shot replies.
- thinkingDurationSeconds: integer seconds of such reasoning (0 if needsThinking is false). Cap your estimate at 3600.
- questionDifficulty: integer 1–5 (1=trivial, 3=typical task, 5=very hard / large change).
- rationale: short English explanation (optional).
- likelyFiles: if the user message includes a JSON field "graphSummary" with import-graph nodes, list 0–12 repo-relative paths that the agent might edit; each MUST match graphSummary.truncatedSampleNodes[].id (or unambiguous basename match). Use roleHint to pick packaging, tests, config, etc. If graphSummary is null or missing, leave [].
- relatedFiles: same graph rules — neighbors that may be read; if no graph, leave [].
If unsure, use needsThinking=false, thinkingDurationSeconds=0, questionDifficulty=3, extraContextTokensGuess=0, and empty arrays for likelyFiles and relatedFiles.`;

        const userPayload = JSON.stringify({
          userText: text.slice(0, 12000),
          source: "clipboard",
          workspaceName: folder?.name ?? "",
          graphSummary: graphPack ? graphPack.graphSummary : null,
        });

        const resp = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPayload },
            ],
            temperature: 0.2,
          }),
          signal: ac.signal,
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 400)}`);
        }
        const data = (await resp.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const content = data.choices?.[0]?.message?.content ?? "";
        const parsed = parseLlmJsonContent(content);
        const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
        const modelFields = parseLlmScopeModelFields(parsed);
        const combined = combineLlmScopeTokens({
          ...modelFields,
          thinkingTokensPerSecond: thinkingTokPerSec,
          maxThinkingDurationSeconds: maxThinkSec,
          difficultyExtraTokensPerStep: diffPerStep,
        });

        let likely: string[] = [];
        let related: string[] = [];
        if (graphPack) {
          likely = filterToGraphPaths(parsed.likelyFiles, graphPack.nodeSet);
          related = filterToGraphPaths(parsed.relatedFiles, graphPack.nodeSet);
        }

        const budgetRel = tpGet<string>(
          "tokenPrediction.importGraph.graphTokenBudgetRelativePath",
          ".cursor/token_prediction_graph_token_budget.json"
        );
        const root = folder?.uri.fsPath;
        const scopePaths = [...new Set([...likely, ...related])];
        const budgetRef =
          root && scopePaths.length > 0
            ? sumBudgetTokensForPaths(root, budgetRel, scopePaths)
            : { sum: 0, matched: 0 };

        const estCtx = buildEstimateRuntimeContext(context.extensionUri, folder?.uri.fsPath);
        let { est, extraNotes } = await runEstimateWithKeywords(text, baseOpts, keywordMode, estCtx);
        const workspaceEnabled = tpGet<boolean>("tokenPrediction.workspaceContextInEstimates", true);
        const paths: WorkspaceContextPaths = {
          graphRelativePath: tpGet<string>(
            "tokenPrediction.importGraph.graphOutputRelativePath",
            ".cursor/token_prediction_import_graph.json"
          ),
          scanRelativePath: tpGet<string>(
            "tokenPrediction.workspaceScan.outputRelativePath",
            ".cursor/token_prediction_workspace_scan.json"
          ),
          llmLastRelativePath: tpGet<string>(
            "tokenPrediction.llm.lastScopeOutputRelativePath",
            ".cursor/token_prediction_llm_scope_last.json"
          ),
          graphTokenBudgetRelativePath: tpGet<string>(
            "tokenPrediction.importGraph.graphTokenBudgetRelativePath",
            ".cursor/token_prediction_graph_token_budget.json"
          ),
        };
        est = enrichEstimateIfWorkspaceArtifacts(est, root, workspaceEnabled, paths, { skipLlmCache: true });

        const llmParts = [
          `LLM extra combined ${combined.extraContextTokensCombined} tok (modelGuess=${modelFields.extraContextTokensGuess}, thinking→${combined.thinkingTokensFromDuration}, difficulty→${combined.difficultyExtraTokens})`,
        ];
        est = applyWorkspaceContextBoost(est, combined.extraContextTokensCombined, llmParts);

        const fileLines: string[] = [];
        if (graphPack) {
          fileLines.push(
            `Likely files (LLM, ${likely.length}): ${likely.slice(0, 8).join(", ") || "(none)"}${likely.length > 8 ? " …" : ""}`
          );
          fileLines.push(
            `Related files (LLM, ${related.length}): ${related.slice(0, 8).join(", ") || "(none)"}${related.length > 8 ? " …" : ""}`
          );
          if (budgetRef.sum > 0) {
            fileLines.push(
              `Ref: tiktoken sum for ${budgetRef.matched}/${scopePaths.length} paths in graph budget JSON (not added again — workspace boost may already include full graph).`
            );
          }
        } else {
          fileLines.push("Import graph: not loaded — run Scan workspace + import graph for likely/related file paths.");
        }

        const msg = [
          "Source: clipboard + LLM (one API call; import-graph scope cache not applied here).",
          ...fileLines,
          `Tokenizer: ${est.tokenizerId}`,
          `Task profile (heuristic): ${est.notes.find((n) => n.startsWith("Task profile:")) ?? `taskKind=${baseOpts.taskKind}`}`,
          `Input tokens: ${est.inputTokens}`,
          `Output (heuristic): ${est.outputTokensExpected} (range ${est.outputTokensLow}–${est.outputTokensHigh})`,
          `Total (est.): ${est.totalTokensExpected} (range ${est.totalTokensLow}–${est.totalTokensHigh})`,
          `LLM: needsThinking=${modelFields.needsThinking}, thinkingDurationSeconds=${modelFields.thinkingDurationSeconds}, questionDifficulty=${modelFields.questionDifficulty}`,
          `LLM merge: +${combined.extraContextTokensCombined} tok to totals (see Output for rationale)`,
          ...extraNotes,
        ].join("\n");

        vscode.window.showInformationMessage(msg, { modal: true });

        const ch = getOutputChannel();
        ch.clear();
        ch.appendLine("Token Prediction — Clipboard + LLM");
        ch.appendLine("");
        ch.appendLine(`extraContextTokensGuess (model): ${modelFields.extraContextTokensGuess}`);
        ch.appendLine(
          `needsThinking: ${modelFields.needsThinking}; thinkingDurationSeconds: ${modelFields.thinkingDurationSeconds}; questionDifficulty: ${modelFields.questionDifficulty}`
        );
        ch.appendLine(
          `thinkingTokensFromDuration: ${combined.thinkingTokensFromDuration}; difficultyExtraTokens: ${combined.difficultyExtraTokens}`
        );
        ch.appendLine(`extraContextTokensCombined: ${combined.extraContextTokensCombined}`);
        ch.appendLine("");
        if (graphPack) {
          ch.appendLine(`likelyFiles (${likely.length}):`);
          likely.forEach((p) => ch.appendLine(`  ${p}`));
          ch.appendLine("");
          ch.appendLine(`relatedFiles (${related.length}):`);
          related.forEach((p) => ch.appendLine(`  ${p}`));
          ch.appendLine("");
          if (budgetRef.sum > 0) {
            ch.appendLine(
              `Reference tiktoken sum (graph budget, matched paths): ${budgetRef.sum} tok (${budgetRef.matched} files matched in byFile)`
            );
            ch.appendLine("");
          }
        } else {
          ch.appendLine("(No import graph in workspace — likelyFiles/relatedFiles not used.)");
          ch.appendLine("");
        }
        ch.appendLine("rationale:");
        ch.appendLine(rationale || "(none)");
        ch.show();

        if (folder) {
          try {
            const rel = tpGet<string>(
              "tokenPrediction.llm.clipboardLlmLastOutputRelativePath",
              ".cursor/token_prediction_clipboard_llm_last.json"
            );
            const lastPath = path.join(folder.uri.fsPath, ...rel.split(/[/\\]/).filter(Boolean));
            fs.mkdirSync(path.dirname(lastPath), { recursive: true });
            fs.writeFileSync(
              lastPath,
              JSON.stringify(
                {
                  schemaVersion: 1,
                  kind: "clipboard_llm_estimate",
                  generatedAtIso: new Date().toISOString(),
                  extraContextTokensGuess: modelFields.extraContextTokensGuess,
                  needsThinking: modelFields.needsThinking,
                  thinkingDurationSeconds: modelFields.thinkingDurationSeconds,
                  questionDifficulty: modelFields.questionDifficulty,
                  thinkingTokensFromDuration: combined.thinkingTokensFromDuration,
                  difficultyExtraTokens: combined.difficultyExtraTokens,
                  extraContextTokensCombined: combined.extraContextTokensCombined,
                  likelyFiles: likely,
                  relatedFiles: related,
                  graphBudgetTokensRefSum: budgetRef.sum,
                  graphBudgetTokensRefMatched: budgetRef.matched,
                },
                null,
                0
              ),
              "utf8"
            );
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        void vscode.window.showErrorMessage(`Token Prediction: clipboard + LLM failed: ${msg}`);
      } finally {
        sub.dispose();
      }
    }
  );
}
