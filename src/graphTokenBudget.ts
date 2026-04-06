/**
 * Sum tiktoken counts over each graph node's **source file body** (read from disk, bounded bytes),
 * not over path strings alone. Used as workspace context boost hint.
 */
import * as fs from "fs";
import * as path from "path";
import { countTokens } from "./tokenizer";
import type { TokenizerId } from "./types";

const BUDGET_SCHEMA = 3;

const SKIP_SUBSTR = ["node_modules", ".git/", ".venv/", "dist/", "out/"];

function shouldSkipNodeId(id: string): boolean {
  const n = id.replace(/\\/g, "/");
  return SKIP_SUBSTR.some((s) => n.includes(s));
}

export interface GraphTokenBudgetOptions {
  tokenizerId: TokenizerId;
  maxNodes: number;
  maxBytesPerFile: number;
}

/** One graph node path → tiktoken count for that file body (same bounds as aggregate). */
export interface GraphTokenBudgetFileEntry {
  /** Repo-relative path (same as import-graph node id). */
  id: string;
  tokens: number;
  /** Present when the file exceeded maxBytesPerFile; `tokens` is for the truncated prefix only. */
  readTruncated?: boolean;
}

export interface GraphTokenBudgetResult {
  totalTokens: number;
  filesTokenized: number;
  filesSkipped: number;
  nodesTruncated: boolean;
  /** Ordered as processed; use for read/rewrite estimates per file. */
  byFile: GraphTokenBudgetFileEntry[];
}

export function computeGraphTokenBudget(
  repoRoot: string,
  graphJsonAbsPath: string,
  opts: GraphTokenBudgetOptions
): GraphTokenBudgetResult {
  let raw: string;
  try {
    raw = fs.readFileSync(graphJsonAbsPath, "utf8");
  } catch {
    return {
      totalTokens: 0,
      filesTokenized: 0,
      filesSkipped: 0,
      nodesTruncated: false,
      byFile: [],
    };
  }
  let g: { nodes?: { id: string }[] };
  try {
    g = JSON.parse(raw) as { nodes?: { id: string }[] };
  } catch {
    return {
      totalTokens: 0,
      filesTokenized: 0,
      filesSkipped: 0,
      nodesTruncated: false,
      byFile: [],
    };
  }
  const ids = (g.nodes ?? []).map((n) => n.id).filter((id) => id && !shouldSkipNodeId(id));
  const nodesTruncated = ids.length > opts.maxNodes;
  const slice = nodesTruncated ? ids.slice(0, opts.maxNodes) : ids;

  let totalTokens = 0;
  let filesTokenized = 0;
  let filesSkipped = 0;
  const byFile: GraphTokenBudgetFileEntry[] = [];

  for (const rel of slice) {
    const abs = path.join(repoRoot, ...rel.split("/"));
    let text: string;
    let readTruncated: boolean | undefined;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) {
        filesSkipped += 1;
        continue;
      }
      readTruncated = st.size > opts.maxBytesPerFile;
      if (readTruncated) {
        const fd = fs.openSync(abs, "r");
        const buf = Buffer.allocUnsafe(Math.min(opts.maxBytesPerFile, st.size));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        text = buf.toString("utf8");
      } else {
        text = fs.readFileSync(abs, "utf8");
      }
    } catch {
      filesSkipped += 1;
      continue;
    }
    const tokens = countTokens(text, opts.tokenizerId);
    totalTokens += tokens;
    filesTokenized += 1;
    const entry: GraphTokenBudgetFileEntry = { id: rel, tokens };
    if (readTruncated) entry.readTruncated = true;
    byFile.push(entry);
  }

  return { totalTokens, filesTokenized, filesSkipped, nodesTruncated, byFile };
}

export function writeGraphTokenBudgetJson(
  repoRoot: string,
  outRelativePath: string,
  graphJsonAbsPath: string,
  opts: GraphTokenBudgetOptions,
  result: GraphTokenBudgetResult
): string {
  const outAbs = path.isAbsolute(outRelativePath)
    ? outRelativePath
    : path.join(repoRoot, ...outRelativePath.split(/[/\\]/).filter(Boolean));
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const payload = {
    schemaVersion: BUDGET_SCHEMA,
    /** Each graph node id is a repo-relative path; we tiktoken the file contents at that path (capped), not the path string alone. */
    tokenizationScope: "file_contents" as const,
    generatedAtIso: new Date().toISOString(),
    tokenizerId: opts.tokenizerId,
    maxNodes: opts.maxNodes,
    maxBytesPerFile: opts.maxBytesPerFile,
    graphSourcePath: path.relative(repoRoot, graphJsonAbsPath).split(path.sep).join("/"),
    totalTokens: result.totalTokens,
    filesTokenized: result.filesTokenized,
    filesSkipped: result.filesSkipped,
    nodesTruncated: result.nodesTruncated,
    /** Per-file tiktoken counts (same tokenizer); sum of entries.tokens equals totalTokens. */
    byFile: result.byFile,
  };
  fs.writeFileSync(outAbs, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return outAbs;
}
