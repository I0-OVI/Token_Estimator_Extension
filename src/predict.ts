import { OUTPUT_HEURISTIC, effectiveTurnMultiplier } from "./baselines";
import { countCharTokenHeuristic } from "./charTokenHeuristic";
import { countTokens } from "./tokenizer";
import type { PredictionOptions, PredictionGranularity, TokenEstimate } from "./types";

/**
 * Optional future backend: `scripts/ml/train_offline.py` fits a model on JSONL
 * (`cursorReportedTokens` + structured features). If offline MAE beats this
 * heuristic, consider a setting such as `tokenPrediction.learnedModelPath`
 * pointing at exported JSON weights or ONNX — keep heuristic as default to
 * avoid bundling heavy runtimes until metrics justify it.
 */
export function estimateTokens(text: string, opts: PredictionOptions): TokenEstimate {
  const tik = countTokens(text, opts.tokenizerId);
  const ch = countCharTokenHeuristic(text);

  let inputTokens: number;
  let inputTokensTiktoken: number | undefined;
  let inputTokensCharHeuristic: number | undefined;

  if (opts.inputLengthModel === "tiktoken") {
    inputTokens = tik;
  } else if (opts.inputLengthModel === "char_heuristic") {
    inputTokens = ch.inputTokensApprox;
    inputTokensCharHeuristic = ch.inputTokensApprox;
    inputTokensTiktoken = tik;
  } else {
    inputTokens = tik;
    inputTokensTiktoken = tik;
    inputTokensCharHeuristic = ch.inputTokensApprox;
  }

  const h = OUTPUT_HEURISTIC[opts.taskKind];
  const turnMul = effectiveTurnMultiplier(opts.extraHistoryTurns);
  const expectedOut = Math.round(inputTokens * h.baseMultiplier * turnMul);
  const lowOut = Math.round(inputTokens * h.minMultiplier * turnMul * opts.rangeOutputLowFactor);
  const highOut = Math.round(inputTokens * h.maxMultiplier * turnMul * opts.rangeOutputHighFactor);

  const totalExpected = inputTokens + expectedOut;
  const totalLow = inputTokens + lowOut;
  const totalHigh = inputTokens + highOut;

  const notes: string[] = [];
  if (opts.inputLengthModel === "tiktoken") {
    notes.push("Baseline: exact input token count + task-kind output heuristic.");
  } else if (opts.inputLengthModel === "char_heuristic") {
    notes.push(
      "Input: char heuristic (0.3 per non-CJK char, 0.6 per CJK); output uses task-kind multipliers on that input."
    );
    notes.push(`Tiktoken reference (not used for totals): ${tik}`);
  } else {
    notes.push("Input totals: tiktoken; char heuristic (0.3/0.6) shown as reference.");
    notes.push(
      `Char heuristic: ${ch.inputTokensApprox} tok (${ch.enChars} non-CJK + ${ch.cjkChars} CJK).`
    );
  }
  notes.push(`Task profile: ${opts.taskKind}; assumed extra history turns: ${opts.extraHistoryTurns}.`);

  const base: TokenEstimate = {
    tokenizerId: opts.tokenizerId,
    inputTokens,
    inputTokensTiktoken,
    inputTokensCharHeuristic,
    outputTokensExpected: expectedOut,
    outputTokensLow: lowOut,
    outputTokensHigh: highOut,
    totalTokensExpected: totalExpected,
    totalTokensLow: totalLow,
    totalTokensHigh: totalHigh,
    effectiveTurns: 1 + opts.extraHistoryTurns,
    notes,
  };

  return applyGranularityMask(base, opts.granularity);
}

function applyGranularityMask(est: TokenEstimate, g: PredictionGranularity): TokenEstimate {
  if (g === "total") return est;
  if (g === "input") {
    return {
      ...est,
      outputTokensExpected: 0,
      outputTokensLow: undefined,
      outputTokensHigh: undefined,
      totalTokensExpected: est.inputTokens,
      totalTokensLow: est.inputTokens,
      totalTokensHigh: est.inputTokens,
      notes: [...est.notes, "Granularity: input only."],
    };
  }
  return {
    ...est,
    inputTokens: 0,
    totalTokensExpected: est.outputTokensExpected,
    totalTokensLow: est.outputTokensLow,
    totalTokensHigh: est.outputTokensHigh,
    notes: [...est.notes, "Granularity: output heuristic only (input not counted)."],
  };
}
