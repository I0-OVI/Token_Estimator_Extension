import type { TaskKind } from "./types";

/**
 * Output-side multipliers vs. input token count (cold start).
 * Tuned as coarse priors — replace with logged data when available.
 */
export const OUTPUT_HEURISTIC: Record<
  TaskKind,
  { baseMultiplier: number; minMultiplier: number; maxMultiplier: number }
> = {
  general: { baseMultiplier: 0.85, minMultiplier: 0.45, maxMultiplier: 2.0 },
  chat: { baseMultiplier: 1.0, minMultiplier: 0.5, maxMultiplier: 2.4 },
  explain: { baseMultiplier: 1.2, minMultiplier: 0.55, maxMultiplier: 2.8 },
  code: { baseMultiplier: 1.1, minMultiplier: 0.5, maxMultiplier: 2.5 },
  refactor: { baseMultiplier: 1.35, minMultiplier: 0.6, maxMultiplier: 3.0 },
};

/** Per extra full (user+assistant) turn, scale cumulative expected output upward. */
const PER_TURN_SCALE = 0.35;

export function effectiveTurnMultiplier(extraHistoryTurns: number): number {
  return 1 + extraHistoryTurns * PER_TURN_SCALE;
}

export function naiveLengthBaselineTokens(charLength: number, charsPerTokenGuess = 4): number {
  return Math.max(0, Math.ceil(charLength / charsPerTokenGuess));
}
