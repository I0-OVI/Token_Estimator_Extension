/**
 * Optional LLM call with local import graph to suggest likely files (paths validated against graph nodes).
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { tpGet } from "./configRead";

const SECRET_KEY = "tokenPrediction.llm.apiKey";

/** Built-in OpenAI-compatible chat completions endpoint (no user URL required). */
export const BUILTIN_OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

/** DeepSeek OpenAI-compatible API (use DeepSeek dashboard API key, not OpenAI). */
export const BUILTIN_DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/v1/chat/completions";

function normalizeLlmPreset(raw: string | undefined): "openai" | "deepseek" | "custom" {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "openai" || s === "deepseek" || s === "custom") {
    return s;
  }
  return "deepseek";
}

function resolveLlmApiUrl(): { url: string; error?: string } {
  const preset = normalizeLlmPreset(tpGet<string>("tokenPrediction.llm.endpointPreset", "deepseek"));
  if (preset === "custom") {
    const url = tpGet<string>("tokenPrediction.llm.apiUrl", "").trim();
    if (!url) {
      return {
        url: "",
        error:
          "Token Prediction: set tokenPrediction.llm.apiUrl (Custom), or set endpoint preset to OpenAI / DeepSeek.",
      };
    }
    return { url };
  }
  if (preset === "deepseek") {
    return { url: BUILTIN_DEEPSEEK_CHAT_COMPLETIONS_URL };
  }
  return { url: BUILTIN_OPENAI_CHAT_COMPLETIONS_URL };
}

export async function setLlmApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: "Token Prediction",
    prompt: "LLM API key (stored in VS Code Secret Storage, not in settings.json)",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) {
    return;
  }
  await context.secrets.store(SECRET_KEY, key);
  void vscode.window.showInformationMessage("Token Prediction: LLM API key saved.");
}

function parseLlmJsonContent(content: string): Record<string, unknown> {
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    s = fence[1].trim();
  }
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) {
    throw new Error("No JSON object in model response");
  }
  return JSON.parse(m[0]) as Record<string, unknown>;
}

function filterToGraphPaths(paths: unknown, nodeSet: Set<string>): string[] {
  if (!Array.isArray(paths)) {
    return [];
  }
  const byBase = new Map<string, string[]>();
  for (const id of nodeSet) {
    const base = path.posix.basename(id);
    if (!byBase.has(base)) {
      byBase.set(base, []);
    }
    byBase.get(base)!.push(id);
  }
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string") {
      continue;
    }
    const t = p.trim().replace(/\\/g, "/");
    if (nodeSet.has(t)) {
      out.push(t);
      continue;
    }
    const base = path.posix.basename(t);
    const cands = byBase.get(base);
    if (cands?.length === 1) {
      out.push(cands[0]);
    }
  }
  return [...new Set(out)];
}

let outputChannel: vscode.OutputChannel | undefined;

function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Token Prediction");
  }
  return outputChannel;
}

export async function runEstimateScopeWithLlm(context: vscode.ExtensionContext): Promise<void> {
  const { url: apiUrl, error: urlError } = resolveLlmApiUrl();
  if (urlError || !apiUrl) {
    void vscode.window.showErrorMessage(urlError ?? "Token Prediction: could not resolve LLM URL.");
    return;
  }
  const model =
    tpGet<string>("tokenPrediction.llm.model", "deepseek-chat").trim() || "deepseek-chat";

  const apiKey = await context.secrets.get(SECRET_KEY);
  if (!apiKey) {
    void vscode.window.showInformationMessage(
      "Token Prediction: set your API key first — run command: Token Prediction: Set LLM API key"
    );
    return;
  }

  const editor = vscode.window.activeTextEditor;
  let text = "";
  if (editor) {
    const sel = editor.selection;
    text =
      sel && !sel.isEmpty ? editor.document.getText(sel) : editor.document.getText();
  }
  if (!text.trim()) {
    text = (await vscode.env.clipboard.readText()).replace(/\r\n/g, "\n");
  }
  if (!text.trim()) {
    void vscode.window.showWarningMessage(
      "Token Prediction: no text in editor/selection or clipboard."
    );
    return;
  }

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage("Token Prediction: open a workspace folder.");
    return;
  }

  const graphRel = tpGet<string>(
    "tokenPrediction.importGraph.graphOutputRelativePath",
    ".cursor/token_prediction_import_graph.json"
  );
  const parts = graphRel.split(/[/\\]/).filter(Boolean);
  let graphUri = folder.uri;
  for (const p of parts) {
    graphUri = vscode.Uri.joinPath(graphUri, p);
  }

  let graphRaw: string;
  try {
    const bytes = await vscode.workspace.fs.readFile(graphUri);
    graphRaw = Buffer.from(bytes).toString("utf8");
  } catch {
    void vscode.window.showErrorMessage(
      "Token Prediction: import graph missing. Run: Token Prediction: Scan workspace + build import graph."
    );
    return;
  }

  let graph: {
    nodes?: { id: string; roleHint?: string }[];
    edges?: unknown[];
    stats?: { nodeCount?: number };
  };
  try {
    graph = JSON.parse(graphRaw) as typeof graph;
  } catch {
    void vscode.window.showErrorMessage("Token Prediction: invalid import graph JSON.");
    return;
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
  const graphSummary = {
    nodeCount: graph.stats?.nodeCount ?? nodes.length,
    truncatedSampleNodes,
    /** @deprecated LLM prompts use truncatedSampleNodes (id + roleHint). Kept for tiny payloads. */
    truncatedSampleNodeIds: truncatedSampleNodes.map((n) => n.id),
    edgesSample: edges.slice(0, maxEdges),
  };

  const userPayload = JSON.stringify({
    userText: text.slice(0, 12000),
    workspaceName: folder.name,
    graphSummary,
  });

  const systemPrompt = `You are helping estimate which source files a coding agent might touch. You receive user text and a partial import graph. Each node has "id" (repo-relative path) and "roleHint" (short description: e.g. package.json lists npm script names). Reply with JSON only, no markdown:
{"likelyFiles":[],"relatedFiles":[],"rationale":"","extraContextTokensGuess":0}
Rules:
- likelyFiles: 0–12 paths that best match the user's intent; each path MUST be exactly one of the strings in graphSummary.truncatedSampleNodes[].id (or unambiguous prefix/suffix match). Use roleHint to choose files for tasks like "packaging", "build", "tests", etc.
- relatedFiles: neighbors in the graph that may also be read/changed.
- extraContextTokensGuess: rough integer for extra tokens beyond the visible user text (system/tools/context), 0–500000.
If uncertain, use empty arrays and explain in rationale.`;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Token Prediction: LLM scope…",
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
        const likelyRaw = parsed.likelyFiles;
        const relatedRaw = parsed.relatedFiles;
        const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
        const extraGuess =
          typeof parsed.extraContextTokensGuess === "number" && Number.isFinite(parsed.extraContextTokensGuess)
            ? Math.round(parsed.extraContextTokensGuess)
            : 0;

        const likely = filterToGraphPaths(likelyRaw, nodeSet);
        const related = filterToGraphPaths(relatedRaw, nodeSet);

        const ch = getOutputChannel();
        ch.clear();
        ch.appendLine("Token Prediction — LLM scope (paths filtered to import graph)");
        ch.appendLine("");
        ch.appendLine(`likelyFiles (${likely.length}):`);
        likely.forEach((p) => ch.appendLine(`  ${p}`));
        ch.appendLine("");
        ch.appendLine(`relatedFiles (${related.length}):`);
        related.forEach((p) => ch.appendLine(`  ${p}`));
        ch.appendLine("");
        ch.appendLine(`extraContextTokensGuess (model): ${extraGuess}`);
        ch.appendLine("");
        ch.appendLine("rationale:");
        ch.appendLine(rationale || "(none)");
        ch.show();

        void vscode.window.showInformationMessage(
          `Token Prediction: LLM scope ready (${likely.length} likely, ${related.length} related). See Output → Token Prediction.`
        );

        try {
          const llmLastRel = tpGet<string>(
            "tokenPrediction.llm.lastScopeOutputRelativePath",
            ".cursor/token_prediction_llm_scope_last.json"
          );
          const lastPath = path.join(folder.uri.fsPath, ...llmLastRel.split(/[/\\]/).filter(Boolean));
          fs.mkdirSync(path.dirname(lastPath), { recursive: true });
          fs.writeFileSync(
            lastPath,
            JSON.stringify(
              {
                schemaVersion: 1,
                generatedAtIso: new Date().toISOString(),
                extraContextTokensGuess: extraGuess,
                likelyFilesCount: likely.length,
                relatedFilesCount: related.length,
              },
              null,
              0
            ),
            "utf8"
          );
        } catch {
          /* ignore cache write errors */
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const hint401Openai =
          /401/.test(msg) &&
          (msg.includes("openai.com") || msg.includes("Incorrect API key"));
        const extra = hint401Openai
          ? " If your key is from DeepSeek, set tokenPrediction.llm.endpointPreset to deepseek and llm.model to deepseek-chat (Settings)."
          : "";
        void vscode.window.showErrorMessage(`Token Prediction: LLM request failed: ${msg}${extra}`);
      } finally {
        sub.dispose();
      }
    }
  );
}
