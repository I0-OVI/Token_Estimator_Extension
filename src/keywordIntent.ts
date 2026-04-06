/**
 * Local keyword/pattern signals → TaskKind for output heuristics. No network.
 * Tie-breaking: if multiple kinds share the max score, prefer `fallback` when it is among them; else first by priority order.
 */
import { estimateTokens } from "./predict";
import type { PredictionOptions, TaskKind, TokenEstimate } from "./types";

export type KeywordTaskKindMode = "off" | "override" | "hint_only";

const TIE_PRIORITY: TaskKind[] = ["refactor", "code", "explain", "chat", "general"];

/** Weighted rules: (match → add score to kind, record label). */
const RULES: { test: (t: string, lower: string) => boolean; kind: TaskKind; w: number; label: string }[] = [
  { test: (t) => /[?？]/.test(t), kind: "explain", w: 2, label: "question_mark" },
  { test: (t) => /```/.test(t), kind: "code", w: 2, label: "code_fence" },
  { test: (_t, l) => l.includes("refactor") || l.includes("rename") || l.includes("extract"), kind: "refactor", w: 3, label: "en_refactor" },
  { test: (t) => /重构|重命名|抽取/.test(t), kind: "refactor", w: 3, label: "cn_refactor" },
  { test: (_t, l) => l.includes("implement") || l.includes("write a ") || l.includes("add ") || l.includes("feature"), kind: "code", w: 2, label: "en_code" },
  { test: (_t, l) => /\bfix\b/.test(l) || l.includes("bug") || l.includes("broken"), kind: "code", w: 2, label: "en_fix" },
  { test: (t) => /实现|写代码|添加|功能|修复|bug|报错/.test(t), kind: "code", w: 2, label: "cn_code" },
  { test: (_t, l) => l.includes("explain") || l.includes("why ") || l.includes("what is") || l.includes("how does"), kind: "explain", w: 2, label: "en_explain" },
  { test: (t) => /解释|为什么|什么意思|是什么|如何理解|原理/.test(t), kind: "explain", w: 2, label: "cn_explain" },
  {
    test: (_t, l) =>
      l.includes("thanks") || /\b(hello|hi|hey)\b/.test(l),
    kind: "chat",
    w: 2,
    label: "en_chat",
  },
  { test: (t) => /谢谢|你好|您好|嗨|哈喽/.test(t), kind: "chat", w: 2, label: "cn_chat" },
];

function emptyScores(): Record<TaskKind, number> {
  return { general: 0, chat: 0, explain: 0, code: 0, refactor: 0 };
}

export function inferTaskKindFromText(text: string): {
  kind: TaskKind;
  matched: string[];
  scores: Record<TaskKind, number>;
} {
  const scores = emptyScores();
  const matched: string[] = [];
  const lower = text.toLowerCase();
  for (const r of RULES) {
    if (r.test(text, lower)) {
      scores[r.kind] += r.w;
      if (!matched.includes(r.label)) matched.push(r.label);
    }
  }
  const winner = pickTaskKindFromScores(scores, "general");
  return { kind: winner, matched, scores };
}

export function pickTaskKindFromScores(scores: Record<TaskKind, number>, fallback: TaskKind): TaskKind {
  let max = -1;
  for (const k of TIE_PRIORITY) {
    max = Math.max(max, scores[k]);
  }
  if (max <= 0) {
    return fallback;
  }
  const atMax = TIE_PRIORITY.filter((k) => scores[k] === max);
  if (atMax.includes(fallback)) {
    return fallback;
  }
  return atMax[0];
}

/**
 * Merge keyword inference with settings. `settingsTaskKind` is the user’s configured taskKind from VS Code.
 */
export function resolveKeywordTaskOptions(
  text: string,
  baseOpts: PredictionOptions,
  settingsTaskKind: TaskKind,
  mode: KeywordTaskKindMode
): { opts: PredictionOptions; extraNotes: string[] } {
  if (mode === "off") {
    return { opts: baseOpts, extraNotes: [] };
  }
  const { scores, matched } = inferTaskKindFromText(text);
  const winner = pickTaskKindFromScores(scores, settingsTaskKind);

  if (mode === "override") {
    const opts = { ...baseOpts, taskKind: winner };
    const extraNotes: string[] = [];
    if (matched.length > 0) {
      extraNotes.push(`Keyword signals → taskKind=${winner} (${matched.slice(0, 10).join(", ")})`);
    }
    return { opts, extraNotes };
  }

  // hint_only
  const extraNotes = [
    `Keyword intent (hint; settings taskKind=${settingsTaskKind}): inferred=${winner} (signals: ${matched.slice(0, 10).join(", ") || "none"})`,
  ];
  return { opts: baseOpts, extraNotes };
}

/** Single entry: apply keyword mode then run baseline estimateTokens. */
export function runEstimateWithKeywords(
  text: string,
  baseOpts: PredictionOptions,
  mode: KeywordTaskKindMode
): { est: TokenEstimate; extraNotes: string[] } {
  const { opts, extraNotes } = resolveKeywordTaskOptions(text, baseOpts, baseOpts.taskKind, mode);
  const est = estimateTokens(text, opts);
  return { est, extraNotes };
}

export function parseKeywordTaskKindMode(raw: string | undefined): KeywordTaskKindMode {
  if (raw === "override" || raw === "hint_only" || raw === "off") {
    return raw;
  }
  return "off";
}
