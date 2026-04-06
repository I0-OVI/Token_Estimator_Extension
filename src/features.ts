/**
 * Observable features the host (e.g. VS Code) can supply for richer models later.
 * Privacy: only derive aggregates client-side; never send raw code without consent.
 */
export interface TaskContextFeatures {
  /** UTF-16 length (editor); cheap proxy before tokenization. */
  charLength: number;
  /** Token count under chosen tokenizer (exact for "input" side). */
  inputTokensExact: number;
  /** Rough language signal from file path extension, if any. */
  fileExtension?: string;
  /** Whether selection is non-empty (user focused on a fragment). */
  hasSelection: boolean;
  /** Estimated prior turns in session if the host tracks it (optional). */
  sessionTurnCount?: number;
  /** Model id string if known (different output distributions). */
  modelId?: string;
}

/**
 * What the extension can access today vs. future:
 * - Stable: active editor text, selection, document language id, uri path extension.
 * - Optional / policy: workspace-wide context size, chat history — require user scope and consent.
 */
export const PRIVACY_AND_PERMISSIONS = {
  localOnlyDefault: true,
  noNetworkRequiredForBaseline: true,
  sensitiveFields: ["rawText", "filePath"] as const,
  recommendation:
    "Store only aggregates or hashed fingerprints if telemetry is enabled; gate on opt-in.",
} as const;
