#!/usr/bin/env node
/**
 * Load token_prediction_log.jsonl → CSV feature table + baseline MAE vs cursorReportedTokens.
 * Optionally merges import-graph stats from .cursor/token_prediction_import_graph.json (run npm run build-import-graph).
 * Requires: npm run compile (uses out/predict.js heuristic aligned with src/predict.ts).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { get_encoding } from "@dqbd/tiktoken";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const { estimateTokens } = require(path.join(root, "out/predict.js"));
const { DEFAULT_PREDICTION_OPTIONS } = require(path.join(root, "out/config.js"));
const { countCharTokenHeuristic } = require(path.join(root, "out/charTokenHeuristic.js"));

const enc = get_encoding("cl100k_base");

function countTok(text) {
  if (!text) return 0;
  return enc.encode(text).length;
}

function fillDefaults(rec) {
  return {
    ...rec,
    grepContextFileCount: rec.grepContextFileCount ?? 0,
    readContextFileCount: rec.readContextFileCount ?? 0,
    filesReadCount: rec.filesReadCount ?? 0,
    filesRead: Array.isArray(rec.filesRead) ? rec.filesRead : [],
    filesTouched: Array.isArray(rec.filesTouched) ? rec.filesTouched : [],
    llmLikelyFiles: Array.isArray(rec.llmLikelyFiles) ? rec.llmLikelyFiles : [],
    thoughtMarkdown: rec.thoughtMarkdown ?? "",
  };
}

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const t = String(val);
  if (/[",\n\r]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function rowToCsv(cols, obj) {
  return cols.map((c) => csvEscape(obj[c])).join(",");
}

const jsonlPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, ".cursor", "token_prediction_log.jsonl");

function inferRepoRootFromJsonl(jsonlPathResolved) {
  const d = path.dirname(jsonlPathResolved);
  if (path.basename(d) === ".cursor") {
    return path.dirname(d);
  }
  return root;
}

const repoRoot = inferRepoRootFromJsonl(jsonlPath);
const graphJsonPath = path.join(repoRoot, ".cursor", "token_prediction_import_graph.json");

/** @returns {null | { nodeSet: Set<string>, adj: Map<string, string[]>, stats: object }} */
function loadImportGraph(graphPath) {
  if (!fs.existsSync(graphPath)) {
    return null;
  }
  let g;
  try {
    g = JSON.parse(fs.readFileSync(graphPath, "utf8"));
  } catch {
    return null;
  }
  if (!g.nodes || !Array.isArray(g.edges)) {
    return null;
  }
  const nodeSet = new Set(g.nodes.map((n) => n.id));
  const adj = new Map();
  for (const n of nodeSet) {
    adj.set(n, []);
  }
  for (const e of g.edges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    const list = adj.get(e.from);
    if (list && !list.includes(e.to)) {
      list.push(e.to);
    }
  }
  return { nodeSet, adj, stats: g.stats || {} };
}

/** @param {Map<string, string[]>} adj */
function reachableWithinOutgoingHops(adj, startIds, hopCount) {
  const seen = new Set();
  for (const id of startIds) {
    if (adj.has(id)) seen.add(id);
  }
  let frontier = startIds.filter((id) => adj.has(id));
  for (let h = 0; h < hopCount; h++) {
    const next = [];
    for (const u of frontier) {
      for (const v of adj.get(u) || []) {
        if (!seen.has(v)) {
          seen.add(v);
          next.push(v);
        }
      }
    }
    frontier = next;
  }
  return seen.size;
}

/**
 * @param {string[]} rawPaths
 * @param {Set<string>} nodeSet
 */
function resolveAnchorsToNodes(rawPaths, nodeSet) {
  /** @type {Map<string, string[]>} */
  const byBase = new Map();
  for (const id of nodeSet) {
    const base = path.posix.basename(id);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(id);
  }
  const matched = new Set();
  for (const s of rawPaths) {
    if (!s || typeof s !== "string") continue;
    const t = s.trim().replace(/\\/g, "/");
    if (nodeSet.has(t)) {
      matched.add(t);
      continue;
    }
    const base = path.posix.basename(t);
    const cands = byBase.get(base);
    if (!cands) continue;
    if (cands.length === 1) {
      matched.add(cands[0]);
      continue;
    }
    for (const c of cands) {
      if (t === c || t.endsWith(c) || c.endsWith(t)) {
        matched.add(c);
      }
    }
  }
  return [...matched];
}

const graphData = loadImportGraph(graphJsonPath);
if (!graphData) {
  console.warn(
    `No import graph at ${graphJsonPath} — graph columns will be 0. Run: npm run build-import-graph`
  );
}

const outDir = path.join(root, "scripts", "ml", "output");
const outCsv = path.join(outDir, "feature_table.csv");

const raw = fs.readFileSync(jsonlPath, "utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");

const cols = [
  "row_index",
  "timestampIso",
  "cursorReportedTokens",
  "user_char_len",
  "assistant_char_len",
  "tiktoken_user",
  "tiktoken_assistant",
  "tiktoken_sum",
  "thought_char_len",
  "tiktoken_thought",
  "thought_tokens_legacy",
  "tiktoken_sum_incl_thought",
  "naive_char_baseline_tokens",
  "baseline_heuristic_total",
  "linesAdded",
  "linesRemoved",
  "linesTotalAbs",
  "filesChangedCount",
  "grepContextFileCount",
  "readContextFileCount",
  "filesReadCount",
  "filesTouched_count",
  "log1p_tiktoken_sum",
  "log1p_tiktoken_incl_thought",
  "graph_node_count",
  "graph_edge_count",
  "graph_avg_out_degree",
  "graph_reachable_2hop",
  "char_heuristic_user_tokens",
  "graph_node_count_at_log_time",
  "llm_likely_files_count",
];

const rows = [];
let idx = 0;
for (const line of lines) {
  idx++;
  let rec;
  try {
    rec = fillDefaults(JSON.parse(line));
  } catch {
    console.error(`Skip invalid JSON line ${idx}`);
    continue;
  }
  const user = rec.userPrompt ?? "";
  const asst = rec.assistantMarkdown ?? "";
  const thought = rec.thoughtMarkdown ?? "";
  const legacyThoughtTok =
    typeof rec.thoughtTokens === "number" && Number.isFinite(rec.thoughtTokens)
      ? Math.max(0, Math.floor(rec.thoughtTokens))
      : 0;
  const charHeuristicUser = countCharTokenHeuristic(user).inputTokensApprox;
  const graphNodeAtLog =
    typeof rec.graphNodeCountAtLogTime === "number" && Number.isFinite(rec.graphNodeCountAtLogTime)
      ? Math.round(rec.graphNodeCountAtLogTime)
      : "";
  const llmLikelyCount = Array.isArray(rec.llmLikelyFiles) ? rec.llmLikelyFiles.length : 0;
  const tu = countTok(user);
  const ta = countTok(asst);
  const tt = countTok(thought);
  const tsum = tu + ta;
  const tsumIncl = tsum + tt;
  const charLen = user.length + asst.length;
  const naive = Math.max(0, Math.ceil(charLen / 4));
  const est = estimateTokens(user, DEFAULT_PREDICTION_OPTIONS);
  const y = rec.cursorReportedTokens;

  let graph_node_count = 0;
  let graph_edge_count = 0;
  let graph_avg_out_degree = 0;
  let graph_reachable_2hop = 0;
  if (graphData) {
    graph_node_count = graphData.stats.nodeCount ?? graphData.nodeSet.size;
    graph_edge_count = graphData.stats.edgeCount ?? 0;
    graph_avg_out_degree = graphData.stats.avgOutDegree ?? 0;
    const anchors = resolveAnchorsToNodes(
      [...rec.filesRead, ...rec.filesTouched],
      graphData.nodeSet
    );
    graph_reachable_2hop =
      anchors.length === 0
        ? 0
        : reachableWithinOutgoingHops(graphData.adj, anchors, 2);
  }

  rows.push({
    row_index: idx,
    timestampIso: rec.timestampIso ?? "",
    cursorReportedTokens: y === null || y === undefined ? "" : y,
    user_char_len: user.length,
    assistant_char_len: asst.length,
    tiktoken_user: tu,
    tiktoken_assistant: ta,
    tiktoken_sum: tsum,
    thought_char_len: thought.length,
    tiktoken_thought: tt,
    thought_tokens_legacy: legacyThoughtTok,
    tiktoken_sum_incl_thought: tsumIncl,
    naive_char_baseline_tokens: naive,
    baseline_heuristic_total: est.totalTokensExpected,
    linesAdded: rec.linesAdded ?? 0,
    linesRemoved: rec.linesRemoved ?? 0,
    linesTotalAbs: rec.linesTotalAbs ?? 0,
    filesChangedCount: rec.filesChangedCount ?? 0,
    grepContextFileCount: rec.grepContextFileCount,
    readContextFileCount: rec.readContextFileCount,
    filesReadCount: rec.filesReadCount,
    filesTouched_count: rec.filesTouched.length,
    log1p_tiktoken_sum: Math.log1p(tsum),
    log1p_tiktoken_incl_thought: Math.log1p(tsumIncl),
    graph_node_count,
    graph_edge_count,
    graph_avg_out_degree,
    graph_reachable_2hop,
    char_heuristic_user_tokens: charHeuristicUser,
    graph_node_count_at_log_time: graphNodeAtLog,
    llm_likely_files_count: llmLikelyCount,
  });
}

fs.mkdirSync(outDir, { recursive: true });
const header = cols.join(",");
const body = rows.map((r) => rowToCsv(cols, r)).join("\n");
fs.writeFileSync(outCsv, header + "\n" + body + "\n", "utf8");

const withY = rows
  .map((r, i) => ({ ...r, _i: i }))
  .filter((r) => typeof r.cursorReportedTokens === "number" && Number.isFinite(r.cursorReportedTokens));

function mae(predFn) {
  if (withY.length === 0) return NaN;
  let s = 0;
  for (const r of withY) {
    const y = r.cursorReportedTokens;
    s += Math.abs(predFn(r) - y);
  }
  return s / withY.length;
}

function mape(predFn) {
  if (withY.length === 0) return NaN;
  let s = 0;
  let n = 0;
  for (const r of withY) {
    const y = r.cursorReportedTokens;
    if (y <= 0) continue;
    s += Math.abs(predFn(r) - y) / y;
    n++;
  }
  return n ? s / n : NaN;
}

console.log(`Wrote ${outCsv} (${rows.length} rows)`);
console.log(`Labeled rows (cursorReportedTokens present): ${withY.length}`);
console.log("");
console.log("MAE vs cursorReportedTokens:");
console.log(`  tiktoken_sum (user+assistant cl100k):     ${mae((r) => r.tiktoken_sum).toFixed(2)}`);
console.log(`  char_heuristic_user_tokens (0.3/0.6 user): ${mae((r) => r.char_heuristic_user_tokens).toFixed(2)}`);
console.log(`  naive_char_baseline_tokens (chars/4):     ${mae((r) => r.naive_char_baseline_tokens).toFixed(2)}`);
console.log(`  baseline_heuristic_total (predict.ts):    ${mae((r) => r.baseline_heuristic_total).toFixed(2)}`);
console.log("");
console.log("MAPE (labeled, y>0 only):");
console.log(`  tiktoken_sum:          ${(mape((r) => r.tiktoken_sum) * 100).toFixed(2)}%`);
console.log(`  char_heuristic_user:   ${(mape((r) => r.char_heuristic_user_tokens) * 100).toFixed(2)}%`);
console.log(`  naive_char/4:          ${(mape((r) => r.naive_char_baseline_tokens) * 100).toFixed(2)}%`);
console.log(`  baseline_heuristic:    ${(mape((r) => r.baseline_heuristic_total) * 100).toFixed(2)}%`);

enc.free();
