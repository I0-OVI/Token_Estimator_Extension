#!/usr/bin/env node
/**
 * Offline CLI: call the same OpenAI-compatible LLM scope flow as the extension
 * (prompt + import graph → likelyFiles / relatedFiles / extraContextTokensGuess).
 *
 * Usage:
 *   export DEEPSEEK_API_KEY=sk-...   # or OPENAI_API_KEY / TOKEN_PREDICTION_LLM_API_KEY
 *   node scripts/llm-scope-offline.mjs --prompt "your task text"
 *   node scripts/llm-scope-offline.mjs --prompt-file path/to/prompt.txt
 *   cat prompt.txt | node scripts/llm-scope-offline.mjs
 *
 * Env (optional):
 *   LLM_API_URL   default https://api.deepseek.com/v1/chat/completions
 *   LLM_MODEL     default deepseek-chat
 *   GRAPH_JSON    default .cursor/token_prediction_import_graph.json (under --root)
 *   WORKSPACE_NAME default basename of --root
 *   THINKING_TOKENS_PER_SEC  default 32 (0 = no duration-based tokens)
 *   MAX_THINKING_SECONDS       default 1200
 *   DIFFICULTY_EXTRA_PER_STEP  default 400 (0 = no difficulty add-on)
 *
 * Flags:
 *   --root <dir>     repo root (default cwd)
 *   --graph <path>   override graph JSON path (absolute or relative to --root)
 *   --prompt "..."   prompt text
 *   --prompt-file <path>   read prompt from file (utf8)
 *   --json           print machine-readable JSON only
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDefault = process.cwd();

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i === -1) return def;
  return process.argv[i + 1] ?? def;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const root = path.resolve(arg("--root", rootDefault));
let graphPath = arg("--graph", "");
const promptInline = arg("--prompt", "");
const promptFile = arg("--prompt-file", "");
const jsonOnly = hasFlag("--json");

const apiUrl = process.env.LLM_API_URL || "https://api.deepseek.com/v1/chat/completions";
const model = process.env.LLM_MODEL || "deepseek-chat";
const apiKey =
  process.env.DEEPSEEK_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.TOKEN_PREDICTION_LLM_API_KEY ||
  "";

const workspaceName = process.env.WORKSPACE_NAME || path.basename(root);

const THINKING_TOKENS_PER_SEC = Number(process.env.THINKING_TOKENS_PER_SEC ?? "32");
const MAX_THINKING_SECONDS = Number(process.env.MAX_THINKING_SECONDS ?? "1200");
const DIFFICULTY_EXTRA_PER_STEP = Number(process.env.DIFFICULTY_EXTRA_PER_STEP ?? "400");
const BOOST_CAP = 500_000;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Keep formulas in sync with src/llmScopeCompute.ts */
function combineLlmScopeTokens(params) {
  const cappedSec = clamp(params.thinkingDurationSeconds, 0, params.maxThinkingDurationSeconds);
  const effectiveSec = params.needsThinking ? cappedSec : 0;
  const thinkingTokensFromDuration = Math.round(effectiveSec * Math.max(0, params.thinkingTokensPerSecond));
  const steps = Math.max(0, clamp(params.questionDifficulty, 1, 5) - 1);
  const difficultyExtraTokens =
    params.difficultyExtraTokensPerStep > 0 ? Math.round(steps * params.difficultyExtraTokensPerStep) : 0;
  const sum = params.extraContextTokensGuess + thinkingTokensFromDuration + difficultyExtraTokens;
  const extraContextTokensCombined = clamp(sum, 0, BOOST_CAP);
  return { thinkingTokensFromDuration, difficultyExtraTokens, extraContextTokensCombined };
}

function parseLlmScopeModelFields(parsed) {
  const extra =
    typeof parsed.extraContextTokensGuess === "number" && Number.isFinite(parsed.extraContextTokensGuess)
      ? Math.round(parsed.extraContextTokensGuess)
      : 0;
  const needsThinking = parsed.needsThinking === true;
  let thinkingSec = 0;
  if (typeof parsed.thinkingDurationSeconds === "number" && Number.isFinite(parsed.thinkingDurationSeconds)) {
    thinkingSec = Math.round(parsed.thinkingDurationSeconds);
  }
  let diff = 3;
  if (typeof parsed.questionDifficulty === "number" && Number.isFinite(parsed.questionDifficulty)) {
    diff = Math.round(parsed.questionDifficulty);
  }
  return {
    extraContextTokensGuess: extra,
    needsThinking,
    thinkingDurationSeconds: thinkingSec,
    questionDifficulty: clamp(diff, 1, 5),
  };
}

function usage(err) {
  const msg = `
llm-scope-offline.mjs — LLM predicts likely files from prompt + import graph (no VS Code).

Set API key: export DEEPSEEK_API_KEY=sk-...

Examples:
  node scripts/llm-scope-offline.mjs --prompt "Refactor src/predict.ts"
  node scripts/llm-scope-offline.mjs --root /path/to/repo --prompt-file ./task.txt
`;
  if (err) console.error(err);
  console.error(msg.trim());
  process.exit(err ? 1 : 0);
}

async function readPrompt() {
  if (promptInline) return promptInline.replace(/\r\n/g, "\n");
  if (promptFile) {
    const p = path.isAbsolute(promptFile) ? promptFile : path.join(root, promptFile);
    return fs.readFileSync(p, "utf8");
  }
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  usage("Error: provide --prompt, --prompt-file, or pipe prompt on stdin.");
}

function resolveGraphPath() {
  if (graphPath) {
    return path.isAbsolute(graphPath) ? graphPath : path.join(root, graphPath);
  }
  const envRel = process.env.GRAPH_JSON || ".cursor/token_prediction_import_graph.json";
  return path.join(root, envRel);
}

function parseJsonFromContent(content) {
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON object in model response");
  return JSON.parse(m[0]);
}

function filterToGraphPaths(paths, nodeSet) {
  if (!Array.isArray(paths)) return [];
  const byBase = new Map();
  for (const id of nodeSet) {
    const base = path.posix.basename(id);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(id);
  }
  const out = [];
  for (const p of paths) {
    if (typeof p !== "string") continue;
    const t = p.trim().replace(/\\/g, "/");
    if (nodeSet.has(t)) {
      out.push(t);
      continue;
    }
    const base = path.posix.basename(t);
    const cands = byBase.get(base);
    if (cands?.length === 1) out.push(cands[0]);
  }
  return [...new Set(out)];
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  if (!apiKey) {
    console.error(
      "Missing API key. Set DEEPSEEK_API_KEY, OPENAI_API_KEY, or TOKEN_PREDICTION_LLM_API_KEY."
    );
    process.exit(1);
  }

  const userText = (await readPrompt()).trim();
  if (!userText) {
    console.error("Empty prompt.");
    process.exit(1);
  }

  const graphAbs = resolveGraphPath();
  if (!fs.existsSync(graphAbs)) {
    console.error(`Import graph not found: ${graphAbs}`);
    process.exit(1);
  }

  const graphRaw = fs.readFileSync(graphAbs, "utf8");
  const graph = JSON.parse(graphRaw);
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
    truncatedSampleNodeIds: truncatedSampleNodes.map((n) => n.id),
    edgesSample: edges.slice(0, maxEdges),
  };

  const userPayload = JSON.stringify({
    userText: userText.slice(0, 12000),
    workspaceName,
    graphSummary,
  });

  const systemPrompt = `You are helping estimate which source files a coding agent might touch, how hard the user's question is, and how much hidden context/thinking might be needed. You receive user text and a partial import graph. Each node has "id" (repo-relative path) and "roleHint" (short description; package.json includes npm script names). Reply with JSON only, no markdown:
{"likelyFiles":[],"relatedFiles":[],"rationale":"","extraContextTokensGuess":0,"needsThinking":false,"thinkingDurationSeconds":0,"questionDifficulty":3}
Rules:
- likelyFiles: 0–12 paths that best match the user's intent; each path MUST be exactly one of graphSummary.truncatedSampleNodes[].id (or unambiguous prefix/suffix). Use roleHint for tasks like packaging, build, config.
- relatedFiles: neighbors in the graph that may also be read/changed.
- extraContextTokensGuess: rough integer for extra tokens beyond the visible user text (system/tools/context), 0–500000.
- needsThinking: true if answering well likely requires extended reasoning; false for trivial one-shot answers.
- thinkingDurationSeconds: estimated seconds of such reasoning (0 if needsThinking is false). Cap at 3600.
- questionDifficulty: integer 1–5 (1=trivial, 3=typical, 5=very hard).
If uncertain, use empty arrays, needsThinking=false, thinkingDurationSeconds=0, questionDifficulty=3, extraContextTokensGuess=0, and explain in rationale.`;

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
  });

  const rawText = await resp.text();
  if (!resp.ok) {
    console.error(`HTTP ${resp.status}: ${rawText.slice(0, 800)}`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    console.error("Invalid JSON from API:", rawText.slice(0, 500));
    process.exit(1);
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonFromContent(content);
  const likelyRaw = parsed.likelyFiles;
  const relatedRaw = parsed.relatedFiles;
  const rationale = typeof parsed.rationale === "string" ? parsed.rationale : "";
  const modelFields = parseLlmScopeModelFields(parsed);
  const combined = combineLlmScopeTokens({
    ...modelFields,
    thinkingTokensPerSecond: THINKING_TOKENS_PER_SEC,
    maxThinkingDurationSeconds: MAX_THINKING_SECONDS,
    difficultyExtraTokensPerStep: DIFFICULTY_EXTRA_PER_STEP,
  });

  const likely = filterToGraphPaths(likelyRaw, nodeSet);
  const related = filterToGraphPaths(relatedRaw, nodeSet);
  const uniquePaths = new Set([...likely, ...related]);
  const readFilesEstimate = uniquePaths.size;

  const out = {
    graphPath: graphAbs,
    apiUrl,
    model,
    likelyFiles: likely,
    relatedFiles: related,
    likelyCount: likely.length,
    relatedCount: related.length,
    /** Distinct graph paths in likely ∪ related (proxy for “how many files might be read”). */
    distinctFilesInScope: readFilesEstimate,
    extraContextTokensGuess: modelFields.extraContextTokensGuess,
    needsThinking: modelFields.needsThinking,
    thinkingDurationSeconds: modelFields.thinkingDurationSeconds,
    questionDifficulty: modelFields.questionDifficulty,
    thinkingTokensFromDuration: combined.thinkingTokensFromDuration,
    difficultyExtraTokens: combined.difficultyExtraTokens,
    extraContextTokensCombined: combined.extraContextTokensCombined,
    rationale,
  };

  if (jsonOnly) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log("--- LLM scope (offline) ---");
  console.log(`Graph: ${graphAbs}`);
  console.log(`API: ${apiUrl} | model: ${model}`);
  console.log("");
  console.log(`Likely files (${likely.length}):`);
  likely.forEach((p) => console.log(`  ${p}`));
  console.log("");
  console.log(`Related files (${related.length}):`);
  related.forEach((p) => console.log(`  ${p}`));
  console.log("");
  console.log(`Distinct paths (likely ∪ related): ${readFilesEstimate}`);
  console.log(`extraContextTokensGuess (model only): ${out.extraContextTokensGuess}`);
  console.log(
    `needsThinking: ${out.needsThinking}; thinkingDurationSeconds: ${out.thinkingDurationSeconds}; questionDifficulty: ${out.questionDifficulty}`
  );
  console.log(
    `thinkingTokensFromDuration: ${out.thinkingTokensFromDuration}; difficultyExtraTokens: ${out.difficultyExtraTokens}`
  );
  console.log(`extraContextTokensCombined: ${out.extraContextTokensCombined}`);
  console.log("");
  console.log("Rationale:");
  console.log(rationale || "(none)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
