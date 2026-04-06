#!/usr/bin/env node
/**
 * Walks agent_transcripts_backup (recursive) for all .jsonl and analyzes every line:
 * - parses JSON per line (failed lines still emit a row so line_index matches the file)
 * - extracts visible text (nested message.content / .text)
 * - tiktoken cl100k counts per line, rolled up per file and totals
 * - role_normalized: user | assistant | system | tool | other (not "everything else → assistant")
 *
 * Default root: cursor_export_20260403_141133/agent_transcripts_backup
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEFAULT_BACKUP = path.join(ROOT, "cursor_export_20260403_141133", "agent_transcripts_backup");

function parseArgs() {
  const args = process.argv.slice(2);
  let backupRoot = DEFAULT_BACKUP;
  let outDir = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) backupRoot = path.resolve(args[++i]);
    if (args[i] === "--out" && args[i + 1]) outDir = path.resolve(args[++i]);
  }
  if (!outDir) outDir = path.join(path.dirname(backupRoot), "organized");
  return { backupRoot, outDir };
}

/** Map Cursor/OpenAI-style roles to a stable bucket for aggregation. */
function normalizeRole(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "user") return "user";
  if (s === "assistant") return "assistant";
  if (s === "system") return "system";
  if (s === "tool" || s === "function") return "tool";
  return "other";
}

function addToRoleBuckets(buckets, norm, tok) {
  if (norm === "user") buckets.user += tok;
  else if (norm === "assistant") buckets.assistant += tok;
  else if (norm === "system") buckets.system += tok;
  else if (norm === "tool") buckets.tool += tok;
  else buckets.other += tok;
}

/** Collect string fragments from message payloads (user/assistant/tool-ish). */
function extractTextsFromLine(obj) {
  const parts = [];
  function walk(n) {
    if (n == null) return;
    if (typeof n === "string") {
      parts.push(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n === "object") {
      if (typeof n.text === "string") parts.push(n.text);
      for (const k of Object.keys(n)) {
        if (k === "text") continue;
        walk(n[k]);
      }
    }
  }
  walk(obj);
  return parts.join("\n");
}

function walkJsonlFiles(dir) {
  const out = [];
  function rec(d) {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, name.name);
      if (name.isDirectory()) rec(p);
      else if (name.isFile() && name.name.endsWith(".jsonl")) out.push(p);
    }
  }
  rec(dir);
  return out.sort();
}

function stripBom(s) {
  if (s.length > 0 && s.charCodeAt(0) === 0xfeff) return s.slice(1);
  return s;
}

function csvEscape(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

async function main() {
  const { backupRoot, outDir } = parseArgs();
  if (!fs.existsSync(backupRoot)) {
    console.error(`Backup folder not found: ${backupRoot}`);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const { get_encoding } = await import("@dqbd/tiktoken");
  const enc = get_encoding("cl100k_base");
  const count = (t) => enc.encode(t ?? "").length;

  const files = walkJsonlFiles(backupRoot);
  const perFileRows = [];
  const lineDetails = [];

  let grandLines = 0;
  let grandTokens = 0;
  let grandParseErrors = 0;
  let grandEmptyTextLines = 0;
  const grandBuckets = { user: 0, assistant: 0, system: 0, tool: 0, other: 0 };

  for (const filePath of files) {
    const rel = path.relative(backupRoot, filePath);
    let raw = fs.readFileSync(filePath, "utf8");
    raw = stripBom(raw);
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);

    let fileTokens = 0;
    const fileBuckets = { user: 0, assistant: 0, system: 0, tool: 0, other: 0 };
    let parseErrors = 0;
    let emptyTextLines = 0;

    lines.forEach((line, lineIndex) => {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        parseErrors++;
        grandParseErrors++;
        lineDetails.push({
          file_rel: rel,
          line_index: lineIndex,
          parse_ok: 0,
          role: "",
          role_normalized: "other",
          char_length: 0,
          tokens_cl100k: 0,
          text_empty: 1,
        });
        return;
      }
      const role = obj.role ?? "";
      const roleNorm = normalizeRole(role);
      const text = extractTextsFromLine(obj);
      const tok = count(text);
      const isEmpty = text.trim().length === 0 ? 1 : 0;
      if (isEmpty) {
        emptyTextLines++;
        grandEmptyTextLines++;
      }

      fileTokens += tok;
      addToRoleBuckets(fileBuckets, roleNorm, tok);
      addToRoleBuckets(grandBuckets, roleNorm, tok);

      lineDetails.push({
        file_rel: rel,
        line_index: lineIndex,
        parse_ok: 1,
        role,
        role_normalized: roleNorm,
        char_length: text.length,
        tokens_cl100k: tok,
        text_empty: isEmpty,
      });
    });

    grandLines += lines.length;
    grandTokens += fileTokens;

    perFileRows.push({
      relative_path: rel,
      jsonl_lines: lines.length,
      parse_errors: parseErrors,
      empty_text_lines: emptyTextLines,
      tokens_cl100k_total: fileTokens,
      tokens_user: fileBuckets.user,
      tokens_assistant: fileBuckets.assistant,
      tokens_system: fileBuckets.system,
      tokens_tool: fileBuckets.tool,
      tokens_other: fileBuckets.other,
    });
  }

  if (perFileRows.length) {
    const headers = Object.keys(perFileRows[0]);
    const csv =
      headers.join(",") +
      "\n" +
      perFileRows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")).join("\n");
    fs.writeFileSync(path.join(outDir, "agent_transcripts_per_file.csv"), csv, "utf8");
  } else {
    fs.writeFileSync(
      path.join(outDir, "agent_transcripts_per_file.csv"),
      "relative_path,jsonl_lines,parse_errors,empty_text_lines,tokens_cl100k_total,tokens_user,tokens_assistant,tokens_system,tokens_tool,tokens_other\n",
      "utf8"
    );
  }

  const lineHeaders = [
    "file_rel",
    "line_index",
    "parse_ok",
    "role",
    "role_normalized",
    "char_length",
    "tokens_cl100k",
    "text_empty",
  ];
  const lineCsv =
    lineHeaders.join(",") +
    "\n" +
    lineDetails.map((r) => lineHeaders.map((h) => csvEscape(r[h])).join(",")).join("\n");
  fs.writeFileSync(path.join(outDir, "agent_transcripts_per_line.csv"), lineCsv, "utf8");

  fs.writeFileSync(
    path.join(outDir, "agent_transcripts_summary.json"),
    JSON.stringify(
      {
        schemaVersion: 2,
        backup_root: backupRoot,
        jsonl_files: files.length,
        total_jsonl_lines: grandLines,
        parse_error_lines: grandParseErrors,
        empty_text_lines: grandEmptyTextLines,
        tokens_cl100k_all: grandTokens,
        tokens_by_role: { ...grandBuckets },
        note: "Per-line text is extracted by walking nested JSON; tool/system rows are counted under role_normalized, not merged into assistant.",
      },
      null,
      2
    ),
    "utf8"
  );

  enc.free();
  console.log(
    `Files: ${files.length} jsonl | Lines: ${grandLines} | Parse errors: ${grandParseErrors} | Empty text rows: ${grandEmptyTextLines} | Tokens (cl100k): ${grandTokens}`
  );
  console.log(`Wrote ${path.join(outDir, "agent_transcripts_per_file.csv")}`);
  console.log(`Wrote ${path.join(outDir, "agent_transcripts_per_line.csv")} (${lineDetails.length} rows)`);
  console.log(`Wrote ${path.join(outDir, "agent_transcripts_summary.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
