import type { InputLengthModel, PredictionOptions, TaskKind, TokenizerId } from "./types";

/** Defaults match OpenAI-style chat models using cl100k_base / o200k_base. */
export const DEFAULT_TOKENIZER: TokenizerId = "cl100k_base";

export const DEFAULT_PREDICTION_OPTIONS: PredictionOptions = {
  tokenizerId: DEFAULT_TOKENIZER,
  granularity: "total",
  taskKind: "general",
  inputLengthModel: "tiktoken",
  extraHistoryTurns: 0,
  rangeOutputLowFactor: 0.6,
  rangeOutputHighFactor: 2.2,
};

export function predictionOptionsFromVsConfig(raw: {
  tokenizer: string;
  taskKind: string;
  includeHistoryTurns: number;
  inputLengthModel?: string;
}): PredictionOptions {
  const tokenizerId = (raw.tokenizer === "o200k_base" ? "o200k_base" : "cl100k_base") as TokenizerId;
  const taskKind = (["general", "code", "refactor", "explain", "chat"].includes(raw.taskKind)
    ? raw.taskKind
    : "general") as TaskKind;
  const ilm = raw.inputLengthModel;
  const inputLengthModel: InputLengthModel =
    ilm === "char_heuristic" || ilm === "both" ? ilm : "tiktoken";
  return {
    ...DEFAULT_PREDICTION_OPTIONS,
    tokenizerId,
    taskKind,
    inputLengthModel,
    extraHistoryTurns: Math.max(0, Math.floor(raw.includeHistoryTurns)),
  };
}
