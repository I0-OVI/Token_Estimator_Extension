import fs from "fs";
import path from "path";
import type * as vscode from "vscode";
import { buildInferenceFeatureVector } from "./learnedFeatures";
import { applyGranularityMask, estimateTokens } from "./predict";
import type { PredictionOptions, TokenEstimate } from "./types";

export type PredictionBackendSetting = "heuristic" | "lightgbm" | "auto";

export interface LearnedEstimateContext {
  workspaceRoot?: string;
  extensionUri?: vscode.Uri;
  /** Empty = only bundled default under media/models/ */
  learnedModelPath?: string;
  graphRelativePath?: string;
}

function appendNote(est: TokenEstimate, line: string): TokenEstimate {
  return { ...est, notes: [...est.notes, line] };
}

export function mergeLearnedTotalIntoEstimate(
  text: string,
  opts: PredictionOptions,
  learnedTotal: number
): TokenEstimate {
  const estH = estimateTokens(text, opts);
  const totalL = Math.max(0, Math.round(learnedTotal));
  const out = Math.max(0, totalL - estH.inputTokens);
  const expOut = Math.max(1, estH.outputTokensExpected);
  const lowOut = Math.round((out * (estH.outputTokensLow ?? 0)) / expOut);
  const highOut = Math.round((out * (estH.outputTokensHigh ?? expOut)) / expOut);
  const base: TokenEstimate = {
    ...estH,
    outputTokensExpected: out,
    outputTokensLow: lowOut,
    outputTokensHigh: highOut,
    totalTokensExpected: totalL,
    totalTokensLow: estH.inputTokens + lowOut,
    totalTokensHigh: estH.inputTokens + highOut,
    notes: [...estH.notes, `Learned total (ONNX regressor): ${totalL} tok.`],
  };
  return applyGranularityMask(base, opts.granularity);
}

/**
 * Prefer explicit user/workspace path when set and the file exists; otherwise bundled
 * `media/models/token_prediction.onnx` next to the extension.
 */
export function resolveLearnedModelPath(ctx: LearnedEstimateContext | undefined): string | undefined {
  const trimmed = (ctx?.learnedModelPath ?? "").trim();
  const root = ctx?.workspaceRoot;
  if (trimmed) {
    const resolved = path.isAbsolute(trimmed) ? trimmed : root ? path.join(root, trimmed) : "";
    if (resolved && fs.existsSync(resolved)) return resolved;
  }
  const ext = ctx?.extensionUri;
  if (ext) {
    const bundled = path.join(ext.fsPath, "media", "models", "token_prediction.onnx");
    if (fs.existsSync(bundled)) return bundled;
  }
  return undefined;
}

type OrtModule = typeof import("onnxruntime-node");

let ortLoader: Promise<OrtModule | null> | undefined;

async function loadOnnxRuntime(): Promise<OrtModule | null> {
  if (ortLoader === undefined) {
    ortLoader = import("onnxruntime-node").catch(() => null);
  }
  return ortLoader;
}

const sessionCache = new Map<string, Promise<import("onnxruntime-node").InferenceSession | undefined>>();

async function getSession(modelPath: string): Promise<import("onnxruntime-node").InferenceSession | undefined> {
  if (!sessionCache.has(modelPath)) {
    sessionCache.set(
      modelPath,
      (async () => {
        const ort = await loadOnnxRuntime();
        if (!ort) return undefined;
        try {
          return await ort.InferenceSession.create(modelPath);
        } catch {
          return undefined;
        }
      })()
    );
  }
  return sessionCache.get(modelPath)!;
}

export async function predictLearnedTotalOnnx(
  modelPath: string,
  features: Float32Array
): Promise<number | undefined> {
  const session = await getSession(modelPath);
  if (!session) return undefined;
  const ort = await loadOnnxRuntime();
  if (!ort) return undefined;
  const inputName = session.inputNames[0];
  const n = features.length;
  const tensor = new ort.Tensor("float32", features, [1, n]);
  const feeds: Record<string, import("onnxruntime-node").Tensor> = { [inputName]: tensor };
  let out: Record<string, import("onnxruntime-node").Tensor>;
  try {
    out = await session.run(feeds);
  } catch {
    return undefined;
  }
  const outName = session.outputNames[0];
  const t = out[outName];
  if (!t?.data) return undefined;
  const data = t.data as Float32Array;
  return Number(data[0]);
}

export async function estimateTokensWithLearnedBackend(
  text: string,
  opts: PredictionOptions,
  backend: PredictionBackendSetting,
  ctx: LearnedEstimateContext | undefined
): Promise<TokenEstimate> {
  const fallback = () => estimateTokens(text, opts);

  if (backend === "heuristic") {
    return fallback();
  }

  const modelPath = resolveLearnedModelPath(ctx);
  if (!modelPath) {
    if (backend === "lightgbm") {
      return appendNote(fallback(), "Learned ONNX model not found; using heuristic.");
    }
    return fallback();
  }

  const features = buildInferenceFeatureVector({
    userText: text,
    workspaceRoot: ctx?.workspaceRoot,
    graphRelativePath: ctx?.graphRelativePath,
  });

  const pred = await predictLearnedTotalOnnx(modelPath, features);
  if (pred === undefined || !Number.isFinite(pred)) {
    return appendNote(fallback(), "ONNX inference failed; using heuristic.");
  }

  return mergeLearnedTotalIntoEstimate(text, opts, pred);
}
