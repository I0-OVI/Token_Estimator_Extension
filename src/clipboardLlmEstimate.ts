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
import { parseKeywordTaskKindMode, runEstimateWithKeywords } from "./keywordIntent";
import {
  applyWorkspaceContextBoost,
  enrichEstimateIfWorkspaceArtifacts,
  type WorkspaceContextPaths,
} from "./workspaceContextBoost";
import { combineLlmScopeTokens, parseLlmScopeModelFields } from "./llmScopeCompute";
import { LLM_SECRET_KEY, parseLlmJsonContent, resolveLlmApiUrl } from "./llmScope";

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Token Prediction");
  }
  return outputChannel;
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

  const systemPrompt = `You help estimate token usage for a coding assistant turn. You only see the user's message (clipboard). Reply with JSON only, no markdown:
{"extraContextTokensGuess":0,"needsThinking":false,"thinkingDurationSeconds":0,"questionDifficulty":3,"rationale":""}
Fields:
- extraContextTokensGuess: integer 0–500000, rough extra tokens beyond the visible user text (system prompts, tools, retrieval, hidden context).
- needsThinking: true if a good answer likely needs extended reasoning (multi-step debugging, design tradeoffs); false for trivial or one-shot replies.
- thinkingDurationSeconds: integer seconds of such reasoning (0 if needsThinking is false). Cap your estimate at 3600.
- questionDifficulty: integer 1–5 (1=trivial, 3=typical task, 5=very hard / large change).
- rationale: short English explanation (optional).
If unsure, use needsThinking=false, thinkingDurationSeconds=0, questionDifficulty=3, extraContextTokensGuess=0.`;

  const userPayload = JSON.stringify({
    userText: text.slice(0, 12000),
    source: "clipboard",
  });

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

        let { est, extraNotes } = runEstimateWithKeywords(text, baseOpts, keywordMode);
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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

        const msg = [
          "Source: clipboard + LLM (one API call; import-graph LLM cache not applied here).",
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
        ch.appendLine("rationale:");
        ch.appendLine(rationale || "(none)");
        ch.show();

        const folder = vscode.workspace.workspaceFolders?.[0];
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
