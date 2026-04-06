/**
 * Inference-time feature vector aligned with scripts/ml/train_offline.py FEATURE_COLS
 * and scripts/ml/build-feature-table.mjs (tiktoken columns use cl100k_base like the table build).
 */
import fs from "fs";
import path from "path";
import { countCharTokenHeuristic } from "./charTokenHeuristic";
import { DEFAULT_PREDICTION_OPTIONS } from "./config";
import { estimateTokens } from "./predict";
import { countTokens } from "./tokenizer";
/** Must stay in lockstep with FEATURE_COLS in scripts/ml/train_offline.py */
export const LEARNED_FEATURE_COLS = [
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
] as const;

export const LEARNED_FEATURE_DIM = LEARNED_FEATURE_COLS.length;

type GraphPack = {
  nodeSet: Set<string>;
  adj: Map<string, string[]>;
  stats: { nodeCount?: number; edgeCount?: number; avgOutDegree?: number };
};

function loadImportGraph(graphPath: string): GraphPack | null {
  if (!fs.existsSync(graphPath)) return null;
  let g: {
    nodes?: { id: string }[];
    edges?: { from: string; to: string }[];
    stats?: GraphPack["stats"];
  };
  try {
    g = JSON.parse(fs.readFileSync(graphPath, "utf8")) as typeof g;
  } catch {
    return null;
  }
  if (!g.nodes || !Array.isArray(g.edges)) return null;
  const nodeSet = new Set(g.nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const n of nodeSet) adj.set(n, []);
  for (const e of g.edges) {
    if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
    const list = adj.get(e.from);
    if (list && !list.includes(e.to)) list.push(e.to);
  }
  return { nodeSet, adj, stats: g.stats || {} };
}

function reachableWithinOutgoingHops(
  adj: Map<string, string[]>,
  startIds: string[],
  hopCount: number
): number {
  const seen = new Set<string>();
  for (const id of startIds) {
    if (adj.has(id)) seen.add(id);
  }
  let frontier = startIds.filter((id) => adj.has(id));
  for (let h = 0; h < hopCount; h++) {
    const next: string[] = [];
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

function resolveAnchorsToNodes(rawPaths: string[], nodeSet: Set<string>): string[] {
  const byBase = new Map<string, string[]>();
  for (const id of nodeSet) {
    const base = path.posix.basename(id);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base)!.push(id);
  }
  const matched = new Set<string>();
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

/** Training table uses cl100k_base for all tiktoken columns. */
const LEARNED_TOKENIZER = "cl100k_base" as const;

export interface InferenceFeatureParams {
  userText: string;
  /** Live estimate has no assistant/thought unless we add them later. */
  assistantText?: string;
  thoughtText?: string;
  workspaceRoot?: string;
  graphRelativePath?: string;
}

/**
 * Build a 1×N row matching FEATURE_COLS. Missing log-only fields are zero; graph stats
 * come from the workspace import graph JSON when present.
 */
export function buildInferenceFeatureVector(params: InferenceFeatureParams): Float32Array {
  const user = params.userText ?? "";
  const asst = params.assistantText ?? "";
  const thought = params.thoughtText ?? "";

  const tu = countTokens(user, LEARNED_TOKENIZER);
  const ta = countTokens(asst, LEARNED_TOKENIZER);
  const tt = countTokens(thought, LEARNED_TOKENIZER);
  const tsum = tu + ta;
  const tsumIncl = tsum + tt;
  const charLen = user.length + asst.length;
  const naive = Math.max(0, Math.ceil(charLen / 4));
  const charHeuristicUser = countCharTokenHeuristic(user).inputTokensApprox;

  const baselineHeuristic = estimateTokens(user, DEFAULT_PREDICTION_OPTIONS).totalTokensExpected;

  let graph_node_count = 0;
  let graph_edge_count = 0;
  let graph_avg_out_degree = 0;
  let graph_reachable_2hop = 0;

  const graphRel = params.graphRelativePath ?? ".cursor/token_prediction_import_graph.json";
  if (params.workspaceRoot) {
    const graphPath = path.join(params.workspaceRoot, graphRel);
    const graphData = loadImportGraph(graphPath);
    if (graphData) {
      graph_node_count = graphData.stats.nodeCount ?? graphData.nodeSet.size;
      graph_edge_count = graphData.stats.edgeCount ?? 0;
      graph_avg_out_degree = graphData.stats.avgOutDegree ?? 0;
      const anchors = resolveAnchorsToNodes([], graphData.nodeSet);
      graph_reachable_2hop =
        anchors.length === 0 ? 0 : reachableWithinOutgoingHops(graphData.adj, anchors, 2);
    }
  }

  const row: Record<(typeof LEARNED_FEATURE_COLS)[number], number> = {
    user_char_len: user.length,
    assistant_char_len: asst.length,
    tiktoken_user: tu,
    tiktoken_assistant: ta,
    tiktoken_sum: tsum,
    thought_char_len: thought.length,
    tiktoken_thought: tt,
    thought_tokens_legacy: 0,
    tiktoken_sum_incl_thought: tsumIncl,
    naive_char_baseline_tokens: naive,
    baseline_heuristic_total: baselineHeuristic,
    linesAdded: 0,
    linesRemoved: 0,
    linesTotalAbs: 0,
    filesChangedCount: 0,
    grepContextFileCount: 0,
    readContextFileCount: 0,
    filesReadCount: 0,
    filesTouched_count: 0,
    log1p_tiktoken_sum: Math.log1p(tsum),
    log1p_tiktoken_incl_thought: Math.log1p(tsumIncl),
    graph_node_count,
    graph_edge_count,
    graph_avg_out_degree,
    graph_reachable_2hop,
    char_heuristic_user_tokens: charHeuristicUser,
    graph_node_count_at_log_time: 0,
    llm_likely_files_count: 0,
  };

  const out = new Float32Array(LEARNED_FEATURE_DIM);
  for (let i = 0; i < LEARNED_FEATURE_DIM; i++) {
    const key = LEARNED_FEATURE_COLS[i];
    out[i] = row[key];
  }
  return out;
}
