/**
 * Prediction surface area: align labels and tokenizer with the API you bill against.
 */
export type TokenizerId = "cl100k_base" | "o200k_base";

/** What we estimate (can combine flags). */
export type PredictionGranularity = "input" | "output" | "total";

/** Point estimate or simple range for UI. */
export type PredictionForm = "point" | "range";

/** How input-side length feeds the output heuristic (see charTokenHeuristic.ts). */
export type InputLengthModel = "tiktoken" | "char_heuristic" | "both";

export interface PredictionOptions {
  tokenizerId: TokenizerId;
  /** Which parts to fill in the result. */
  granularity: PredictionGranularity;
  /** Task profile for output heuristics (baseline). */
  taskKind: TaskKind;
  /** Primary input length model for totals; default tiktoken. */
  inputLengthModel: InputLengthModel;
  /**
   * Multi-round: approximate extra full turns (user + assistant) beyond the current payload.
   * Each "turn" here is a coarse multiplier on top of single-shot heuristics.
   */
  extraHistoryTurns: number;
  /** When form is "range", output/total use these quantiles around the point heuristic. */
  rangeOutputLowFactor: number;
  rangeOutputHighFactor: number;
}

export type TaskKind = "general" | "code" | "refactor" | "explain" | "chat";

export interface TokenEstimate {
  tokenizerId: TokenizerId;
  inputTokens: number;
  /** When inputLengthModel is both or for reference. */
  inputTokensTiktoken?: number;
  /** Char-based proxy (0.3 en / 0.6 CJK per char); set when both or char_heuristic. */
  inputTokensCharHeuristic?: number;
  /** Heuristic expected output tokens (baseline). */
  outputTokensExpected: number;
  outputTokensLow?: number;
  outputTokensHigh?: number;
  totalTokensExpected: number;
  totalTokensLow?: number;
  totalTokensHigh?: number;
  /** Rounds accounted for in the heuristic (1 + extraHistoryTurns scaled). */
  effectiveTurns: number;
  notes: string[];
}
