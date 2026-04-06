#!/usr/bin/env node
/**
 * Consolidates Cursor workspaceStorage export:
 * - workspaces_index.json / .csv
 * - composers_all.csv
 * - prompts_all.jsonl + per-workspace prompts under prompts_by_workspace/
 * - generations_all.jsonl + per-workspace (from aiService.generations: unixMs, type, textDescription)
 * Use --tokens for cl100k_base rough token counts on prompt text.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { jsonrepair } from "jsonrepair";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEFAULT_EXPORT = path.join(ROOT, "cursor_export_20260403_141133");
const OUT_SUB = "organized";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { tokens: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) {
      out.input = path.resolve(args[++i]);
    } else if (args[i] === "--tokens") {
      out.tokens = true;
    }
  }
  out.input = out.input || DEFAULT_EXPORT;
  return out;
}

function listWorkspaceDirs(exportRoot) {
  if (!fs.existsSync(exportRoot)) {
    throw new Error(`Export path not found: ${exportRoot}`);
  }
  return fs
    .readdirSync(exportRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("workspaceStorage_"))
    .map((d) => path.join(exportRoot, d.name))
    .sort();
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseJsonLoose(raw) {
  const s = stripBom(raw);
  try {
    return JSON.parse(s);
  } catch {
    return JSON.parse(jsonrepair(s));
  }
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseJsonLoose(raw);
}

function safeReadComposerData(wsDir) {
  const p = path.join(wsDir, "composer.composerData");
  if (!fs.existsSync(p)) return null;
  try {
    return readJsonFile(p);
  } catch {
    return null;
  }
}

function safeReadPrompts(wsDir) {
  const p = path.join(wsDir, "aiService.prompts");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    return parseJsonLoose(raw);
  } catch {
    return null;
  }
}

function safeReadGenerations(wsDir) {
  const p = path.join(wsDir, "aiService.generations");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf8");
    return parseJsonLoose(raw);
  } catch {
    return null;
  }
}

function csvEscape(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function msToIso(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

async function main() {
  const { input: exportRoot, tokens: countTokens } = parseArgs();
  const outDir = path.join(exportRoot, OUT_SUB);
  const promptsByWsDir = path.join(outDir, "prompts_by_workspace");
  const generationsByWsDir = path.join(outDir, "generations_by_workspace");
  fs.mkdirSync(promptsByWsDir, { recursive: true });
  fs.mkdirSync(generationsByWsDir, { recursive: true });

  let tiktokenEncode = null;
  if (countTokens) {
    const { get_encoding } = await import("@dqbd/tiktoken");
    const enc = get_encoding("cl100k_base");
    tiktokenEncode = (text) => enc.encode(text ?? "").length;
  }

  const workspaces = [];
  const composerRows = [];
  const allPromptLines = [];
  const allGenerationLines = [];

  const workspaceFolderName = (wsPath) => path.basename(wsPath);

  for (const wsDir of listWorkspaceDirs(exportRoot)) {
    const folder = workspaceFolderName(wsDir);
    const data = safeReadComposerData(wsDir);
    const list = Array.isArray(data?.allComposers) ? data.allComposers : [];

    workspaces.push({
      workspace_folder: folder,
      composer_count: list.length,
      path_hint: "",
      has_composer_file: data != null,
    });

    for (const c of list) {
      composerRows.push({
        workspace_folder: folder,
        composerId: c.composerId ?? "",
        name: c.name ?? "",
        createdAt: c.createdAt,
        createdAt_iso: msToIso(c.createdAt),
        lastUpdatedAt: c.lastUpdatedAt,
        lastUpdatedAt_iso: msToIso(c.lastUpdatedAt),
        unifiedMode: c.unifiedMode ?? "",
        forceMode: c.forceMode ?? "",
        contextUsagePercent: c.contextUsagePercent ?? "",
        totalLinesAdded: c.totalLinesAdded ?? "",
        totalLinesRemoved: c.totalLinesRemoved ?? "",
        filesChangedCount: c.filesChangedCount ?? "",
        subtitle: c.subtitle ?? "",
        isArchived: c.isArchived ?? "",
        isDraft: c.isDraft ?? "",
      });
    }

    const prompts = safeReadPrompts(wsDir);
    if (Array.isArray(prompts) && prompts.length) {
      const perWsLines = [];
      prompts.forEach((item, index) => {
        const text = item.text ?? "";
        const row = {
          workspace_folder: folder,
          index,
          commandType: item.commandType ?? "",
          text,
          char_length: text.length,
          ...(tiktokenEncode ? { text_tokens_cl100k: tiktokenEncode(text) } : {}),
        };
        const line = JSON.stringify(row);
        perWsLines.push(line);
        allPromptLines.push(line);
      });
      fs.writeFileSync(
        path.join(promptsByWsDir, `${folder}_prompts.jsonl`),
        perWsLines.map((l) => l + "\n").join(""),
        "utf8"
      );
    }

    const generations = safeReadGenerations(wsDir);
    if (Array.isArray(generations) && generations.length) {
      const perWsGen = [];
      generations.forEach((g, index) => {
        const desc = g.textDescription ?? "";
        const row = {
          workspace_folder: folder,
          index,
          unixMs: g.unixMs,
          unix_iso: msToIso(g.unixMs),
          generationUUID: g.generationUUID ?? "",
          type: g.type ?? "",
          textDescription: desc,
          char_length: desc.length,
          note:
            "textDescription is the request summary for this generation event, not assistant output or written code.",
          ...(tiktokenEncode ? { textDescription_tokens_cl100k: tiktokenEncode(desc) } : {}),
        };
        const line = JSON.stringify(row);
        perWsGen.push(line);
        allGenerationLines.push(line);
      });
      fs.writeFileSync(
        path.join(generationsByWsDir, `${folder}_generations.jsonl`),
        perWsGen.map((l) => l + "\n").join(""),
        "utf8"
      );
    }
  }

  composerRows.sort(
    (a, b) => (b.lastUpdatedAt || b.createdAt || 0) - (a.lastUpdatedAt || a.createdAt || 0)
  );

  fs.writeFileSync(
    path.join(outDir, "workspaces_index.json"),
    JSON.stringify(
      { export_root: exportRoot, workspace_count: workspaces.length, workspaces },
      null,
      2
    ),
    "utf8"
  );

  const indexCsv = [
    "workspace_folder,composer_count,has_composer_file,path_hint",
    ...workspaces.map(
      (w) =>
        `${csvEscape(w.workspace_folder)},${w.composer_count},${w.has_composer_file},${csvEscape(w.path_hint)}`
    ),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "workspaces_index.csv"), indexCsv, "utf8");

  const compHeaders = [
    "workspace_folder",
    "composerId",
    "name",
    "createdAt",
    "createdAt_iso",
    "lastUpdatedAt",
    "lastUpdatedAt_iso",
    "unifiedMode",
    "forceMode",
    "contextUsagePercent",
    "totalLinesAdded",
    "totalLinesRemoved",
    "filesChangedCount",
    "subtitle",
    "isArchived",
    "isDraft",
  ];
  const compCsv = [
    compHeaders.join(","),
    ...composerRows.map((r) => compHeaders.map((h) => csvEscape(r[h])).join(",")),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "composers_all.csv"), compCsv, "utf8");

  fs.writeFileSync(
    path.join(outDir, "prompts_all.jsonl"),
    allPromptLines.map((l) => l + "\n").join(""),
    "utf8"
  );

  fs.writeFileSync(
    path.join(outDir, "generations_all.jsonl"),
    allGenerationLines.map((l) => l + "\n").join(""),
    "utf8"
  );

  fs.writeFileSync(
    path.join(outDir, "GENERATIONS_NOTE.md"),
    `# aiService.generations

Each row is a **generation event** with \`unixMs\`, \`type\`, \`generationUUID\`, and \`textDescription\`.

- \`textDescription\` is a **short summary of the user request** for that turn (similar to prompts), **not** the model\'s full reply and **not** the code written to disk.
- To approximate **how much "program" was involved**, use \`composers_all.csv\`: \`totalLinesAdded\`, \`filesChangedCount\`, \`contextUsagePercent\`.
- See \`token_estimates_heuristic.csv\` (run \`npm run estimate-token-split\`) for a rough split: natural-language completion vs code/diff proxy.

`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(outDir, "AGENT_TRANSCRIPTS.md"),
    `# Agent transcripts (optional)

This export did not include \`agent-transcripts\` folders (see export_summary.txt — paths point to the original machine).

To add full conversation JSONL for alignment with \`composerId\`:

1. On the source PC, copy from \`%USERPROFILE%\\.cursor\\projects\\\` (or \`~/.cursor/projects/\` on macOS) into e.g. \`${OUT_SUB}/agent_transcripts_import/\`.
2. Re-run analysis scripts against those files if you add a parser for your Cursor version.

Composer session metadata is in \`composers_all.csv\`; user prompts are in \`prompts_all.jsonl\` (no per-composer id in \`aiService.prompts\`).
`,
    "utf8"
  );

  console.log(`Wrote ${outDir}`);
  console.log(`  workspaces_index.json/csv: ${workspaces.length} workspaces`);
  console.log(`  composers_all.csv: ${composerRows.length} rows`);
  console.log(`  prompts_all.jsonl: ${allPromptLines.length} lines`);
  console.log(`  prompts_by_workspace/: per-workspace jsonl`);
  console.log(`  generations_all.jsonl: ${allGenerationLines.length} lines`);
  console.log(`  generations_by_workspace/: per-workspace jsonl`);
  console.log(`  GENERATIONS_NOTE.md`);
  console.log(`  AGENT_TRANSCRIPTS.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
