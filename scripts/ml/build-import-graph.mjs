#!/usr/bin/env node
/**
 * CLI wrapper for src/importGraphCore.ts (compiled to out/importGraphCore.js).
 * Run: npm run compile && node scripts/ml/build-import-graph.mjs [repoRoot]
 */
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const require = createRequire(import.meta.url);
const corePath = path.join(root, "out/importGraphCore.js");
if (!fs.existsSync(corePath)) {
  console.error(`Missing ${corePath}; run: npm run compile`);
  process.exit(1);
}
const { buildImportGraphAtRoot } = require(corePath);

function parseArgs(argv) {
  let repoRoot = root;
  let outRel = ".cursor/token_prediction_import_graph.json";
  let maxFilesRead = 100_000;
  let maxBytesPerFile = 512_000;
  let edgesCap = 500_000;
  const extraExcludeDirs = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      repoRoot = path.resolve(argv[++i]);
    } else if (argv[i] === "--out" && argv[i + 1]) {
      outRel = argv[++i];
    } else if (argv[i] === "--max-files" && argv[i + 1]) {
      maxFilesRead = parseInt(argv[++i], 10) || maxFilesRead;
    } else if (argv[i] === "--max-bytes" && argv[i + 1]) {
      maxBytesPerFile = parseInt(argv[++i], 10) || maxBytesPerFile;
    } else if (argv[i] === "--edges-cap" && argv[i + 1]) {
      edgesCap = parseInt(argv[++i], 10) || edgesCap;
    } else if (argv[i] === "--exclude-dir" && argv[i + 1]) {
      extraExcludeDirs.push(argv[++i]);
    } else if (!argv[i].startsWith("-")) {
      repoRoot = path.resolve(argv[i]);
    }
  }
  return { repoRoot, outRel, maxFilesRead, maxBytesPerFile, edgesCap, extraExcludeDirs };
}

const opts = parseArgs(process.argv);
const r = buildImportGraphAtRoot(opts.repoRoot, {
  maxFilesRead: opts.maxFilesRead,
  maxBytesPerFile: opts.maxBytesPerFile,
  edgesCap: opts.edgesCap,
  outRelativePath: opts.outRel,
  extraExcludeDirs: opts.extraExcludeDirs,
});
console.log(`Wrote ${r.outPath}`);
console.log(`  nodes: ${r.nodeCount} | edges: ${r.edgeCount} | avg out-degree: ${r.avgOutDegree.toFixed(3)}`);
if (r.truncatedFiles || r.edgesTruncated) {
  console.log(`  note: truncatedFiles=${r.truncatedFiles} edgesTruncated=${r.edgesTruncated}`);
}
