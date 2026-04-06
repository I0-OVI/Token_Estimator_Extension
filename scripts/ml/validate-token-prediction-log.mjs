#!/usr/bin/env node
/**
 * Validate token_prediction_log.jsonl: one JSON object per line, schema v1 required fields.
 * Extra optional keys (e.g. charHeuristicInputTokens, graphNodeCountAtLogTime, llmLikelyFiles) are allowed.
 * Usage: node scripts/ml/validate-token-prediction-log.mjs [.cursor/token_prediction_log.jsonl]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const defaultPath = path.join(root, ".cursor", "token_prediction_log.jsonl");
const filePath = process.argv[2] ? path.resolve(process.argv[2]) : defaultPath;

const REQUIRED = [
  "schemaVersion",
  "timestampIso",
  "userPrompt",
  "assistantMarkdown",
  "linesAdded",
  "linesRemoved",
  "linesTotalAbs",
  "filesChangedCount",
  "filesTouched",
];

let ok = 0;
let errors = [];

const raw = fs.readFileSync(filePath, "utf8");
const lines = raw.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.trim() === "") continue;
  const lineNo = i + 1;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch (e) {
    errors.push({ lineNo, err: `JSON.parse: ${e.message}` });
    continue;
  }
  const missing = REQUIRED.filter((k) => rec[k] === undefined);
  if (missing.length) {
    errors.push({ lineNo, err: `missing keys: ${missing.join(", ")}` });
    continue;
  }
  if (rec.schemaVersion !== 1) {
    errors.push({ lineNo, err: `schemaVersion ${rec.schemaVersion} (expected 1)` });
    continue;
  }
  ok++;
}

console.log(`File: ${filePath}`);
console.log(`OK lines: ${ok}`);
if (errors.length) {
  console.error(`Errors: ${errors.length}`);
  for (const e of errors) {
    console.error(`  line ${e.lineNo}: ${e.err}`);
  }
  process.exit(1);
}
console.log("All lines valid.");
process.exit(0);
