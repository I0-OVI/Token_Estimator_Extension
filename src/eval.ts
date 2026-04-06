/**
 * Offline evaluation helpers: compare predicted totals to logged actuals.
 */

export interface EvalExample {
  predictedTotal: number;
  actualTotal: number;
}

export function meanAbsoluteError(examples: EvalExample[]): number {
  if (examples.length === 0) return 0;
  const sum = examples.reduce((a, e) => a + Math.abs(e.predictedTotal - e.actualTotal), 0);
  return sum / examples.length;
}

/** Mean absolute percentage error; guard zero actual. */
export function meanAbsolutePercentageError(examples: EvalExample[], eps = 1): number {
  const valid = examples.filter((e) => e.actualTotal > 0);
  if (valid.length === 0) return 0;
  const sum = valid.reduce((a, e) => a + Math.abs(e.predictedTotal - e.actualTotal) / (e.actualTotal + eps), 0);
  return sum / valid.length;
}

export type BucketLabel = "short" | "medium" | "long";

export function bucketByActualTokens(actualTotal: number, thresholds: [number, number]): BucketLabel {
  if (actualTotal < thresholds[0]) return "short";
  if (actualTotal < thresholds[1]) return "medium";
  return "long";
}

/** Share of cases where we under-estimate total (risky for budgets). */
export function underEstimationRate(examples: EvalExample[]): number {
  if (examples.length === 0) return 0;
  const under = examples.filter((e) => e.predictedTotal < e.actualTotal).length;
  return under / examples.length;
}

/** Compare model vs. a constant baseline (e.g. chars/4). */
export function compareToBaseline(
  examples: EvalExample[],
  baselinePredicted: (actual: EvalExample) => number
): { modelMae: number; baselineMae: number } {
  const modelMae = meanAbsoluteError(examples);
  const baselineExamples: EvalExample[] = examples.map((e) => ({
    predictedTotal: baselinePredicted(e),
    actualTotal: e.actualTotal,
  }));
  const baselineMae = meanAbsoluteError(baselineExamples);
  return { modelMae, baselineMae };
}
