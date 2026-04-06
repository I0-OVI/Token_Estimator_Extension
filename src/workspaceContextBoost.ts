/**
 * Optional extra token budget when workspace artifacts exist (import graph, scan, last LLM scope).
 * Does nothing if files are missing — baseline estimate unchanged.
 */
import * as fs from "fs";
import * as path from "path";
import type { TokenEstimate } from "./types";
import { tpGet } from "./configRead";

export interface WorkspaceContextPaths {
  graphRelativePath: string;
  scanRelativePath: string;
  llmLastRelativePath: string;
  /** Precomputed tiktoken sum over graph node **source files** (file body per path; written on scan). */
  graphTokenBudgetRelativePath: string;
}

export interface LoadedWorkspaceArtifacts {
  graphNodeCount?: number;
  /** Sum of tiktoken counts for bounded reads of graph node **file contents** (if cache exists). */
  graphTokenBudget?: number;
  scanFileCount?: number;
  llmExtraGuess?: number;
  hasLlmFile: boolean;
}

function readJsonIfExists<T>(absPath: string): T | undefined {
  try {
    const raw = fs.readFileSync(absPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function joinUnderRoot(root: string, rel: string): string {
  const parts = rel.split(/[/\\]/).filter(Boolean);
  return path.join(root, ...parts);
}

export function loadWorkspaceArtifacts(
  root: string,
  paths: WorkspaceContextPaths,
  options?: { skipLlmCache?: boolean }
): LoadedWorkspaceArtifacts {
  const out: LoadedWorkspaceArtifacts = { hasLlmFile: false };
  const g = readJsonIfExists<{
    stats?: { nodeCount?: number };
    nodes?: unknown[];
  }>(joinUnderRoot(root, paths.graphRelativePath));
  if (typeof g?.stats?.nodeCount === "number" && g.stats.nodeCount > 0) {
    out.graphNodeCount = g.stats.nodeCount;
  } else if (Array.isArray(g?.nodes) && g.nodes.length > 0) {
    out.graphNodeCount = g.nodes.length;
  }

  const s = readJsonIfExists<{
    totals?: { fileCount?: number };
  }>(joinUnderRoot(root, paths.scanRelativePath));
  if (typeof s?.totals?.fileCount === "number" && s.totals.fileCount > 0) {
    out.scanFileCount = s.totals.fileCount;
  }

  const llmPath = joinUnderRoot(root, paths.llmLastRelativePath);
  if (!options?.skipLlmCache && fs.existsSync(llmPath)) {
    out.hasLlmFile = true;
    const l = readJsonIfExists<{
      extraContextTokensGuess?: number;
      extraContextTokensCombined?: number;
    }>(llmPath);
    const combined =
      typeof l?.extraContextTokensCombined === "number" && Number.isFinite(l.extraContextTokensCombined)
        ? Math.round(l.extraContextTokensCombined)
        : undefined;
    const legacy =
      typeof l?.extraContextTokensGuess === "number" && Number.isFinite(l.extraContextTokensGuess)
        ? Math.round(l.extraContextTokensGuess)
        : undefined;
    const pick = combined ?? legacy;
    if (pick !== undefined) {
      out.llmExtraGuess = pick;
    }
  }

  const budgetPath = joinUnderRoot(root, paths.graphTokenBudgetRelativePath);
  const budget = readJsonIfExists<{ totalTokens?: number }>(budgetPath);
  if (typeof budget?.totalTokens === "number" && budget.totalTokens > 0) {
    out.graphTokenBudget = Math.round(budget.totalTokens);
  }

  return out;
}

const BOOST_CAP = 500_000;

/**
 * Prefer precomputed tiktoken sum over import-graph **node file bodies** (after scan), not path-only counts.
 * Else last LLM extraContextTokensGuess. Else sublinear heuristics from node/file counts.
 */
export function computeContextBoost(a: LoadedWorkspaceArtifacts): { boost: number; parts: string[] } {
  const parts: string[] = [];

  const graphTok = a.graphTokenBudget ?? 0;
  const llm = a.llmExtraGuess ?? 0;

  if (graphTok > 0) {
    const cappedG = Math.min(BOOST_CAP, graphTok);
    parts.push(
      `graph node source files tiktoken sum ${graphTok} tok (full file text per node, capped; boost ${cappedG})`
    );
    if (llm > 0) {
      const cappedL = Math.min(BOOST_CAP, llm);
      const b = Math.max(cappedG, cappedL);
      parts.push(`LLM last ${llm} tok; boost=max(graph, LLM)=${b}`);
      return { boost: b, parts };
    }
    return { boost: cappedG, parts };
  }

  if (llm > 0) {
    const capped = Math.min(BOOST_CAP, Math.max(0, llm));
    parts.push(`last LLM scope (+${capped})`);
    return { boost: capped, parts };
  }

  let boost = 0;
  if (a.graphNodeCount !== undefined) {
    const g = Math.min(80_000, Math.round(45 * Math.log1p(a.graphNodeCount)));
    boost += g;
    parts.push(`import graph ${a.graphNodeCount} nodes (heuristic +${g})`);
  }
  if (a.scanFileCount !== undefined) {
    const s = Math.min(80_000, Math.round(35 * Math.log1p(a.scanFileCount / 150)));
    boost += s;
    parts.push(`workspace scan ${a.scanFileCount} files (heuristic +${s})`);
  }

  const cappedTotal = Math.min(120_000, boost);
  if (parts.length && cappedTotal < boost) {
    parts.push(`capped to ${cappedTotal}`);
  }

  return { boost: cappedTotal, parts };
}

export function applyWorkspaceContextBoost(
  est: TokenEstimate,
  boost: number,
  detailParts: string[]
): TokenEstimate {
  const b = Math.max(0, Math.round(boost));
  if (b <= 0 && detailParts.length === 0) {
    return est;
  }
  const lowBase = est.totalTokensLow ?? est.totalTokensExpected;
  const highBase = est.totalTokensHigh ?? est.totalTokensExpected;
  const note =
    b > 0
      ? `Workspace context boost: +${b} tok (${detailParts.join("; ")})`
      : `Workspace context (no numeric boost): ${detailParts.join("; ")}`;
  return {
    ...est,
    totalTokensExpected: est.totalTokensExpected + b,
    totalTokensLow: lowBase + b,
    totalTokensHigh: highBase + b,
    notes: [...est.notes, note],
  };
}

export function enrichEstimateIfWorkspaceArtifacts(
  est: TokenEstimate,
  workspaceRoot: string | undefined,
  enabled: boolean,
  paths: WorkspaceContextPaths,
  options?: { skipLlmCache?: boolean }
): TokenEstimate {
  if (!enabled || !workspaceRoot) {
    return est;
  }
  const loaded = loadWorkspaceArtifacts(workspaceRoot, paths, options);
  const hasNumericContext =
    (loaded.graphTokenBudget !== undefined && loaded.graphTokenBudget > 0) ||
    loaded.graphNodeCount !== undefined ||
    loaded.scanFileCount !== undefined ||
    (loaded.llmExtraGuess !== undefined && loaded.llmExtraGuess > 0);
  if (!hasNumericContext) {
    return est;
  }
  const { boost, parts } = computeContextBoost(loaded);
  return applyWorkspaceContextBoost(est, boost, parts);
}

/** Shared by estimate dialogs and status bar (same settings + paths). */
export function enrichEstimateFromWorkspaceSettings(
  est: TokenEstimate,
  workspaceFolderPath: string | undefined,
  enrichOptions?: { skipLlmCache?: boolean }
): TokenEstimate {
  const enabled = tpGet<boolean>("tokenPrediction.workspaceContextInEstimates", true);
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
  return enrichEstimateIfWorkspaceArtifacts(est, workspaceFolderPath, enabled, paths, enrichOptions);
}
