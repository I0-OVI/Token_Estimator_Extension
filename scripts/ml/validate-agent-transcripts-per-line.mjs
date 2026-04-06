#!/usr/bin/env node
/**
 * Sanity-checks agent_transcripts_per_line.csv: column alignment, duplicate (file_rel,line_index).
 *
 * Usage:
 *   node scripts/ml/validate-agent-transcripts-per-line.mjs [path/to/agent_transcripts_per_line.csv]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const defaultCsv = path.join(
  root,
  "cursor_export_20260403_141133",
  "organized",
  "agent_transcripts_per_line.csv"
);
const inPath = process.argv[2] ? path.resolve(process.argv[2]) : defaultCsv;

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          q = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') q = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
  }
  out.push(cur);
  return out;
}

if (!fs.existsSync(inPath)) {
  console.error(`Missing ${inPath}`);
  process.exit(1);
}

const text = fs.readFileSync(inPath, "utf8");
const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
if (lines.length < 2) {
  console.error("Empty or header-only CSV");
  process.exit(1);
}

const header = parseCsvLine(lines[0]);
const nCol = header.length;
let badRows = 0;
const seen = new Map();
let dup = 0;

for (let li = 1; li < lines.length; li++) {
  const cols = parseCsvLine(lines[li]);
  if (cols.length !== nCol) {
    badRows++;
    if (badRows <= 5) console.warn(`Row ${li + 1}: expected ${nCol} columns, got ${cols.length}`);
  }
  const iFile = header.indexOf("file_rel");
  const iLine = header.indexOf("line_index");
  if (iFile >= 0 && iLine >= 0 && cols.length > Math.max(iFile, iLine)) {
    const key = `${cols[iFile]}\t${cols[iLine]}`;
    if (seen.has(key)) dup++;
    else seen.set(key, li + 1);
  }
}

console.log(`File: ${inPath}`);
console.log(`Rows (excl. header): ${lines.length - 1} | columns: ${nCol}`);
console.log(`Mismatched column counts: ${badRows}`);
console.log(`Duplicate (file_rel, line_index): ${dup}`);

if (badRows > 0 || dup > 0) process.exit(1);
console.log("OK");
process.exit(0);
