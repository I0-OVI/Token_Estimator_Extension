#!/usr/bin/env node
/**
 * Heuristic token split from Cursor export (no real API usage):
 * - input_tokens: sum of tiktoken(prompt text) from aiService.prompts
 * - est_nl_completion_tokens: rough assistant natural-language output ~ input * multiplier
 * - est_program_proxy_tokens: rough code/diff/tool payload ~ linesAdded * r1 + filesChanged * r2
 * - est_total_tokens: input + nl completion + program proxy (order-of-magnitude only)
 *
 * aiService.generations textDescription is NOT used as "code size" — see GENERATIONS_NOTE.md
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { jsonrepair } from "jsonrepair";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEFAULT_EXPORT = path.join(ROOT, "cursor_export_20260403_141133");

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

function listWorkspaceDirs(exportRoot) {
  return fs
    .readdirSync(exportRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("workspaceStorage_"))
    .map((d) => path.join(exportRoot, d.name))
    .sort();
}

function parseArgs() {
  const args = process.argv.slice(2);
  let input = DEFAULT_EXPORT;
  let nlMult = 1.15;
  let tokensPerLine = 0.12;
  let tokensPerFileChange = 28;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--input" && args[i + 1]) input = path.resolve(args[++i]);
    if (args[i] === "--nl-mult" && args[i + 1]) nlMult = Number(args[++i]);
    if (args[i] === "--tokens-per-line" && args[i + 1]) tokensPerLine = Number(args[++i]);
    if (args[i] === "--tokens-per-file" && args[i + 1]) tokensPerFileChange = Number(args[++i]);
  }
  return { input, nlMult, tokensPerLine, tokensPerFileChange };
}

async function main() {
  const { input: exportRoot, nlMult, tokensPerLine, tokensPerFileChange } = parseArgs();
  const { get_encoding } = await import("@dqbd/tiktoken");
  const enc = get_encoding("cl100k_base");
  const count = (t) => enc.encode(t ?? "").length;

  const outDir = path.join(exportRoot, "organized");
  if (!fs.existsSync(outDir)) {
    console.error("Run npm run organize-cursor-export first (missing organized/).");
    process.exit(1);
  }

  const rows = [];

  for (const wsDir of listWorkspaceDirs(exportRoot)) {
    const folder = path.basename(wsDir);

    let inputTokens = 0;
    const promptsPath = path.join(wsDir, "aiService.prompts");
    if (fs.existsSync(promptsPath)) {
      try {
        const prompts = parseJsonLoose(fs.readFileSync(promptsPath, "utf8"));
        if (Array.isArray(prompts)) {
          for (const p of prompts) {
            inputTokens += count(p.text ?? "");
          }
        }
      } catch {
        //
      }
    }

    let generationCount = 0;
    let generationDescTokens = 0;
    const genPath = path.join(wsDir, "aiService.generations");
    if (fs.existsSync(genPath)) {
      try {
        const gens = parseJsonLoose(fs.readFileSync(genPath, "utf8"));
        if (Array.isArray(gens)) {
          generationCount = gens.length;
          for (const g of gens) {
            generationDescTokens += count(g.textDescription ?? "");
          }
        }
      } catch {
        //
      }
    }

    let linesAdded = 0;
    let linesRemoved = 0;
    let filesChanged = 0;
    let agentSessions = 0;
    const composerPath = path.join(wsDir, "composer.composerData");
    if (fs.existsSync(composerPath)) {
      try {
        const data = parseJsonLoose(fs.readFileSync(composerPath, "utf8"));
        const list = Array.isArray(data?.allComposers) ? data.allComposers : [];
        for (const c of list) {
          linesAdded += Number(c.totalLinesAdded) || 0;
          linesRemoved += Number(c.totalLinesRemoved) || 0;
          filesChanged += Number(c.filesChangedCount) || 0;
          if (c.unifiedMode === "agent") agentSessions++;
        }
      } catch {
        //
      }
    }

    const estNlCompletion = Math.round(inputTokens * nlMult);
    const estProgramProxy = Math.round(
      linesAdded * tokensPerLine + filesChanged * tokensPerFileChange
    );
    const estTotal = inputTokens + estNlCompletion + estProgramProxy;

    rows.push({
      workspace_folder: folder,
      prompt_input_tokens_cl100k: inputTokens,
      generation_event_count: generationCount,
      generation_textDescription_tokens_sum_cl100k: generationDescTokens,
      composer_lines_added_sum: linesAdded,
      composer_lines_removed_sum: linesRemoved,
      composer_files_changed_sum: filesChanged,
      composer_agent_sessions: agentSessions,
      heuristic_nl_output_multiplier: nlMult,
      est_nl_completion_tokens: estNlCompletion,
      est_program_proxy_tokens: estProgramProxy,
      est_total_tokens: estTotal,
    });
  }

  if (!rows.length) {
    console.error("No workspace folders found.");
    process.exit(1);
  }
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
  ].join("\n");
  const outPath = path.join(outDir, "token_estimates_heuristic.csv");
  fs.writeFileSync(outPath, csv, "utf8");
  fs.writeFileSync(
    path.join(outDir, "token_estimates_heuristic.README.txt"),
    `Heuristic token split (not Cursor billing).

- prompt_input_tokens_cl100k: sum of tiktoken counts over aiService.prompts text.
- generation_*: from aiService.generations (event count + textDescription tokens). textDescription is request summary, not code output.
- composer_*: sums from composer.composerData (lines added/removed, files changed, agent session count).
- est_nl_completion_tokens: input * ${nlMult} (expected assistant prose / explanation).
- est_program_proxy_tokens: linesAdded * ${tokensPerLine} + filesChanged * ${tokensPerFileChange} (proxy for diffs, code blocks, tools — calibrate on your data).
- est_total_tokens: input + est_nl_completion + est_program_proxy (rough order of magnitude).

Tune: --nl-mult --tokens-per-line --tokens-per-file
`,
    "utf8"
  );
  enc.free();
  console.log(`Wrote ${outPath} (${rows.length} workspaces)`);
}

function csvEscape(s) {
  if (s == null) return "";
  const str = String(s);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
