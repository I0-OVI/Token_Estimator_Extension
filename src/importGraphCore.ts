/**
 * Build import graph JSON (same logic as scripts/ml/build-import-graph.mjs).
 * Shipped in the extension so "scan + graph" works from any workspace without scripts/.
 */
import * as fs from "fs";
import * as path from "path";

const SCHEMA_VERSION = 2;

const DEFAULT_SKIP = new Set(["node_modules", ".git", "dist", "out", ".cursor"]);

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;

const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Config / manifest files (not matched by CODE_EXT) so LLM can relate tasks like "packaging" to package.json. */
const EXTRA_GRAPH_FILES = /^package\.json$|^tsconfig\.json$|^jsconfig\.json$/i;

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ImportGraphOptions {
  maxFilesRead?: number;
  maxBytesPerFile?: number;
  edgesCap?: number;
  /** Relative to repo root, default .cursor/token_prediction_import_graph.json */
  outRelativePath?: string;
  extraExcludeDirs?: string[];
}

export interface ImportGraphResult {
  outPath: string;
  nodeCount: number;
  edgeCount: number;
  avgOutDegree: number;
  truncatedFiles: boolean;
  edgesTruncated: boolean;
}

function walkCodeFiles(rootFs: string, skipNames: Set<string>): string[] {
  const out: string[] = [];
  function walk(absDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const name = e.name;
      const abs = path.join(absDir, name);
      if (e.isDirectory()) {
        if (skipNames.has(name)) continue;
        walk(abs);
      } else if (e.isFile() && (CODE_EXT.test(name) || EXTRA_GRAPH_FILES.test(name))) {
        const rel = path.relative(rootFs, abs).split(path.sep).join("/");
        out.push(rel);
      }
    }
  }
  walk(rootFs);
  return out.sort();
}

function extractSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /(?:import|export)\s+[^'";]*?from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const s = m[1].trim();
      if (s) specs.add(s);
    }
  }
  return [...specs];
}

function resolveToInternalId(fromRel: string, specifier: string, nodeSet: Set<string>): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return null;
  }
  const spec = specifier.startsWith("/") ? specifier.slice(1) : specifier;
  const fromDir = path.posix.dirname(fromRel);
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));
  if (joined.startsWith("..")) {
    return null;
  }
  if (nodeSet.has(joined)) return joined;
  for (const ext of RESOLVE_EXTS) {
    const cand = joined + ext;
    if (nodeSet.has(cand)) return cand;
  }
  for (const idx of ["/index.ts", "/index.tsx", "/index.js", "/index.mjs", "/index.cjs"]) {
    const cand = joined + idx;
    if (nodeSet.has(cand)) return cand;
  }
  return null;
}

function edgeKind(text: string, spec: string): string {
  const e = escapeReg(spec);
  if (new RegExp(`require\\s*\\(\\s*['"]${e}['"]`).test(text)) return "require";
  if (new RegExp(`import\\s*\\(\\s*['"]${e}['"]`).test(text)) return "dynamic_import";
  return "static_import";
}

const ROLE_HINT_MAX = 220;

/**
 * Short human-readable hint for LLM scope (what this file is for).
 * Exported for tests / tooling.
 */
export function inferRoleHint(relPath: string, source: string): string {
  const maxLen = ROLE_HINT_MAX;
  const base = path.basename(relPath);

  if (base === "package.json") {
    try {
      const j = JSON.parse(source) as {
        name?: string;
        description?: string;
        scripts?: Record<string, string>;
      };
      const bits: string[] = [];
      if (j.name) bits.push(String(j.name));
      if (j.description) bits.push(String(j.description).slice(0, 120));
      if (j.scripts && typeof j.scripts === "object") {
        bits.push(`npm scripts: ${Object.keys(j.scripts).slice(0, 20).join(", ")}`);
      }
      return bits.join(" · ").slice(0, maxLen) || "npm package manifest (scripts, deps)";
    } catch {
      return "package.json";
    }
  }

  if (base === "tsconfig.json" || base === "jsconfig.json") {
    return "TS/JS compiler options (paths, module, etc.)";
  }

  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".md") {
    const line = source.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    return line.replace(/^#+\s*/, "").slice(0, maxLen);
  }

  const head = source.slice(0, 8192);
  const block = head.match(/\/\*\*?\s*([\s\S]*?)\*?\//);
  if (block) {
    const t = block[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*\*?\s?/, "").trim())
      .filter(Boolean)
      .slice(0, 6)
      .join(" ");
    if (t.length > 12) return t.slice(0, maxLen);
  }

  const fromSlash = head
    .split(/\r?\n/)
    .filter((l) => /^\s*\/\//.test(l))
    .slice(0, 5)
    .map((l) => l.replace(/^\s*\/\/\s?/, "").trim())
    .join(" ");
  if (fromSlash.length > 10) return fromSlash.slice(0, maxLen);

  const sig = head.match(
    /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+\w+|class\s+\w+|const\s+\w+\s*=|interface\s+\w+|type\s+\w+\s*=)/m
  );
  if (sig) return sig[0].trim().slice(0, maxLen);

  return `${ext || "file"} · ${base}`.slice(0, maxLen);
}

function fillMissingRoleHints(
  repoRoot: string,
  relPaths: string[],
  roleHints: Map<string, string>,
  maxBytesPerFile: number
): void {
  for (const id of relPaths) {
    if (roleHints.has(id)) continue;
    try {
      const abs = path.join(repoRoot, ...id.split("/"));
      const st = fs.statSync(abs);
      if (st.size > maxBytesPerFile) {
        roleHints.set(
          id,
          path.basename(id) === "package.json"
            ? "package.json (file too large to summarize here)"
            : `${path.basename(id)} (large file)`
        );
        continue;
      }
      const text = fs.readFileSync(abs, "utf8");
      roleHints.set(id, inferRoleHint(id, text));
    } catch {
      roleHints.set(id, path.basename(id));
    }
  }
}

const DEFAULTS: Required<Omit<ImportGraphOptions, "extraExcludeDirs">> & {
  extraExcludeDirs: string[];
} = {
  maxFilesRead: 100_000,
  maxBytesPerFile: 512_000,
  edgesCap: 500_000,
  outRelativePath: ".cursor/token_prediction_import_graph.json",
  extraExcludeDirs: [],
};

/**
 * Synchronous build; writes JSON next to repo root under outRelativePath.
 */
export function buildImportGraphAtRoot(repoRoot: string, options?: ImportGraphOptions): ImportGraphResult {
  const maxFilesRead = options?.maxFilesRead ?? DEFAULTS.maxFilesRead;
  const maxBytesPerFile = options?.maxBytesPerFile ?? DEFAULTS.maxBytesPerFile;
  const edgesCap = options?.edgesCap ?? DEFAULTS.edgesCap;
  const outRel = options?.outRelativePath ?? DEFAULTS.outRelativePath;
  const skipNames = new Set(DEFAULT_SKIP);
  for (const d of options?.extraExcludeDirs ?? []) {
    if (d) skipNames.add(d);
  }

  if (!fs.existsSync(repoRoot) || !fs.statSync(repoRoot).isDirectory()) {
    throw new Error(`Not a directory: ${repoRoot}`);
  }

  let relPaths = walkCodeFiles(repoRoot, skipNames);
  let truncatedFiles = false;
  if (relPaths.length > maxFilesRead) {
    relPaths = relPaths.slice(0, maxFilesRead);
    truncatedFiles = true;
  }

  const nodeSet = new Set(relPaths);
  const roleHints = new Map<string, string>();

  const edges: { from: string; to: string; kind: string }[] = [];
  let edgesTruncated = false;

  for (const fromRel of relPaths) {
    if (edges.length >= edgesCap) {
      edgesTruncated = true;
      break;
    }
    const abs = path.join(repoRoot, ...fromRel.split("/"));
    let text: string;
    try {
      const st = fs.statSync(abs);
      if (st.size > maxBytesPerFile) continue;
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    roleHints.set(fromRel, inferRoleHint(fromRel, text));

    const base = path.basename(fromRel);
    const isConfigJson =
      base === "package.json" || base === "tsconfig.json" || base === "jsconfig.json";
    if (isConfigJson) {
      continue;
    }

    const specs = extractSpecifiers(text);
    for (const spec of specs) {
      if (edges.length >= edgesCap) {
        edgesTruncated = true;
        break;
      }
      const toId = resolveToInternalId(fromRel, spec, nodeSet);
      if (!toId) continue;
      const kind = edgeKind(text, spec);
      edges.push({ from: fromRel, to: toId, kind });
    }
    if (edges.length >= edgesCap) {
      edgesTruncated = true;
      break;
    }
  }

  fillMissingRoleHints(repoRoot, relPaths, roleHints, maxBytesPerFile);

  const nodes = relPaths.map((id) => ({
    id,
    roleHint: roleHints.get(id) ?? path.basename(id),
  }));

  const outDegree = new Map<string, number>();
  const inDegree = new Map<string, number>();
  for (const n of relPaths) {
    outDegree.set(n, 0);
    inDegree.set(n, 0);
  }
  for (const e of edges) {
    outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }
  let isolated = 0;
  for (const n of relPaths) {
    if ((outDegree.get(n) ?? 0) === 0 && (inDegree.get(n) ?? 0) === 0) isolated++;
  }

  const edgeCount = edges.length;
  const nodeCount = nodes.length;
  let outSum = 0;
  for (const v of outDegree.values()) outSum += v;
  const avgOutDegree = nodeCount ? outSum / nodeCount : 0;

  const workspaceFolderName = path.basename(repoRoot);

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAtIso: new Date().toISOString(),
    workspaceFolderName,
    limits: {
      maxFilesRead,
      maxBytesPerFile,
      edgesCap,
      truncatedFiles,
      edgesTruncated,
    },
    stats: {
      nodeCount,
      edgeCount,
      isolatedFileCount: isolated,
      avgOutDegree,
    },
    nodes,
    edges,
  };

  const outAbs = path.isAbsolute(outRel) ? outRel : path.join(repoRoot, outRel);
  const outDir = path.dirname(outAbs);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(payload, null, 2) + "\n", "utf8");

  return {
    outPath: outAbs,
    nodeCount,
    edgeCount,
    avgOutDegree,
    truncatedFiles,
    edgesTruncated,
  };
}
