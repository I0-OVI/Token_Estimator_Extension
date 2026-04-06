/**
 * Pure helpers: combine model-reported extras with thinking-duration → tokens and difficulty steps.
 * Kept separate for reuse by offline script (same formulas).
 */

export interface LlmScopeParsedModel {
  extraContextTokensGuess: number;
  needsThinking: boolean;
  thinkingDurationSeconds: number;
  questionDifficulty: number;
}

export interface LlmScopeCombineParams extends LlmScopeParsedModel {
  thinkingTokensPerSecond: number;
  maxThinkingDurationSeconds: number;
  difficultyExtraTokensPerStep: number;
}

export interface LlmScopeCombineResult {
  thinkingTokensFromDuration: number;
  difficultyExtraTokens: number;
  extraContextTokensCombined: number;
}

const BOOST_CAP = 500_000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function parseLlmScopeModelFields(raw: Record<string, unknown>): LlmScopeParsedModel {
  const extra =
    typeof raw.extraContextTokensGuess === "number" && Number.isFinite(raw.extraContextTokensGuess)
      ? Math.round(raw.extraContextTokensGuess)
      : 0;
  const needsThinking = raw.needsThinking === true;
  let thinkingSec = 0;
  if (typeof raw.thinkingDurationSeconds === "number" && Number.isFinite(raw.thinkingDurationSeconds)) {
    thinkingSec = Math.round(raw.thinkingDurationSeconds);
  }
  let diff = 3;
  if (typeof raw.questionDifficulty === "number" && Number.isFinite(raw.questionDifficulty)) {
    diff = Math.round(raw.questionDifficulty);
  }
  return {
    extraContextTokensGuess: extra,
    needsThinking,
    thinkingDurationSeconds: thinkingSec,
    questionDifficulty: clamp(diff, 1, 5),
  };
}

export function combineLlmScopeTokens(p: LlmScopeCombineParams): LlmScopeCombineResult {
  const cappedSec = clamp(p.thinkingDurationSeconds, 0, p.maxThinkingDurationSeconds);
  const effectiveSec = p.needsThinking ? cappedSec : 0;
  const thinkingTokensFromDuration = Math.round(effectiveSec * Math.max(0, p.thinkingTokensPerSecond));
  const steps = Math.max(0, clamp(p.questionDifficulty, 1, 5) - 1);
  const difficultyExtraTokens =
    p.difficultyExtraTokensPerStep > 0 ? Math.round(steps * p.difficultyExtraTokensPerStep) : 0;
  const sum = p.extraContextTokensGuess + thinkingTokensFromDuration + difficultyExtraTokens;
  const extraContextTokensCombined = clamp(sum, 0, BOOST_CAP);
  return { thinkingTokensFromDuration, difficultyExtraTokens, extraContextTokensCombined };
}
