/**
 * Optional future logging / training schema (opt-in). Align label `usage_*` with API `usage` fields.
 */
export interface TokenUsageLabel {
  /** From API response when available. */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface TelemetryRecordV1 {
  schemaVersion: 1;
  /** No raw text: store only hashes or aggregates if needed. */
  featureSummary: {
    inputTokensExact: number;
    charLength: number;
    taskKind: string;
    tokenizerId: string;
    extraHistoryTurns: number;
  };
  /** Filled when user compares against a real API call. */
  actual?: TokenUsageLabel;
  /** What we predicted at send time (for offline eval). */
  predicted?: {
    outputTokensExpected: number;
    totalTokensExpected: number;
  };
  consent: "none" | "analytics";
  createdAtIso: string;
}

export function emptyTelemetryV1(
  partial: Omit<TelemetryRecordV1, "schemaVersion" | "createdAtIso" | "consent"> & {
    consent?: TelemetryRecordV1["consent"];
  }
): TelemetryRecordV1 {
  return {
    schemaVersion: 1,
    createdAtIso: new Date().toISOString(),
    consent: partial.consent ?? "none",
    ...partial,
  };
}
