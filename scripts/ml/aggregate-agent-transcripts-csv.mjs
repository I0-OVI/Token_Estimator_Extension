#!/usr/bin/env node
/**
 * Optional: aggregate agent_transcripts_per_line.csv by file_rel (session transcript file).
 *
 * JOIN WITH JSONL (token_prediction_log.jsonl) — limits:
 * - CSV has no cursorReportedTokens and no shared id with JSONL rows.
 * - file_rel paths are from an export machine/user; JSONL rows are per "Composer turn" with timestampIso + text.
 * - Do not assume row order alignment. To merge features you would need composer/session id, time window,
 *   or fuzzy text match; mis-joined rows would poison supervised labels — prefer JSONL-only when unsure.
 *
 * Supports schema v2 (parse_ok, role_normalized, text_empty) and legacy 5-column CSVs.
 *
 * Usage:
 *   node scripts/ml/aggregate-agent-transcripts-csv.mjs [path/to/agent_transcripts_per_line.csv]
 * Output: scripts/ml/output/agent_transcripts_by_file_rel.csv
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
const outDir = path.join(root, "scripts", "ml", "output");
const outPath = path.join(outDir, "agent_transcripts_by_file_rel.csv");

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

const text = fs.readFileSync(inPath, "utf8");
const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
if (lines.length < 2) {
  console.error("Empty or header-only CSV");
  process.exit(1);
}
const header = parseCsvLine(lines[0]);
const idx = (name) => header.indexOf(name);

const iFile = idx("file_rel");
const iRole = idx("role");
const iRoleNorm = idx("role_normalized");
const iTok = idx("tokens_cl100k");
const iLine = idx("line_index");
const iChar = idx("char_length");
const iParseOk = idx("parse_ok");
const iTextEmpty = idx("text_empty");

if (iFile < 0 || iTok < 0) {
  console.error("Expected column: file_rel, tokens_cl100k");
  process.exit(1);
}

const legacyMode = iRoleNorm < 0;
if (legacyMode) {
  console.warn(
    "Legacy CSV (no role_normalized): non-user rows are counted as assistant. Re-run: npm run analyze-agent-transcripts"
  );
}

/** @type {Map<string, object>} */
const agg = new Map();

function bucketForRow(cols) {
  if (legacyMode) {
    const role = iRole >= 0 ? cols[iRole] : "";
    if (role === "user") return "user";
    return "assistant";
  }
  const norm = cols[iRoleNorm] || "other";
  if (norm === "user" || norm === "assistant" || norm === "system" || norm === "tool") return norm;
  return "other";
}

for (let li = 1; li < lines.length; li++) {
  const cols = parseCsvLine(lines[li]);
  if (cols.length < header.length) continue;
  const fileRel = cols[iFile];
  const tok = parseInt(cols[iTok], 10) || 0;
  const lineIdx = iLine >= 0 ? parseInt(cols[iLine], 10) || 0 : 0;
  const ch = iChar >= 0 ? parseInt(cols[iChar], 10) || 0 : 0;
  const parseOk = iParseOk >= 0 ? parseInt(cols[iParseOk], 10) !== 0 : 1;
  const textEmpty = iTextEmpty >= 0 ? parseInt(cols[iTextEmpty], 10) !== 0 : 0;

  if (!agg.has(fileRel)) {
    agg.set(fileRel, {
      userTok: 0,
      assistantTok: 0,
      systemTok: 0,
      toolTok: 0,
      otherTok: 0,
      charUser: 0,
      charAssistant: 0,
      charSystem: 0,
      charTool: 0,
      charOther: 0,
      lines: 0,
      maxLine: -1,
      parseFailLines: 0,
      emptyTextLines: 0,
    });
  }
  const a = agg.get(fileRel);
  a.lines += 1;
  a.maxLine = Math.max(a.maxLine, lineIdx);
  if (!parseOk) a.parseFailLines += 1;
  if (textEmpty) a.emptyTextLines += 1;

  const bucket = bucketForRow(cols);
  if (bucket === "user") {
    a.userTok += tok;
    a.charUser += ch;
  } else if (bucket === "assistant") {
    a.assistantTok += tok;
    a.charAssistant += ch;
  } else if (bucket === "system") {
    a.systemTok += tok;
    a.charSystem += ch;
  } else if (bucket === "tool") {
    a.toolTok += tok;
    a.charTool += ch;
  } else {
    a.otherTok += tok;
    a.charOther += ch;
  }
}

const outCols = [
  "file_rel",
  "line_count",
  "max_line_index",
  "parse_fail_lines",
  "empty_text_lines",
  "tokens_user_sum",
  "tokens_assistant_sum",
  "tokens_system_sum",
  "tokens_tool_sum",
  "tokens_other_sum",
  "tokens_all_sum",
  "char_user_sum",
  "char_assistant_sum",
  "char_system_sum",
  "char_tool_sum",
  "char_other_sum",
];

function esc(v) {
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const outLines = [outCols.join(",")];
for (const [fileRel, a] of agg) {
  const sum = a.userTok + a.assistantTok + a.systemTok + a.toolTok + a.otherTok;
  outLines.push(
    [
      esc(fileRel),
      a.lines,
      a.maxLine,
      a.parseFailLines,
      a.emptyTextLines,
      a.userTok,
      a.assistantTok,
      a.systemTok,
      a.toolTok,
      a.otherTok,
      sum,
      a.charUser,
      a.charAssistant,
      a.charSystem,
      a.charTool,
      a.charOther,
    ].join(",")
  );
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, outLines.join("\n") + "\n", "utf8");
console.log(`Wrote ${outPath} (${agg.size} file_rel groups) from ${inPath}`);
