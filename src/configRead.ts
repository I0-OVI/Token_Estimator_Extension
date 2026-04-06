/**
 * Read `tokenPrediction.*` settings by full dotted id (reliable across VS Code / Cursor builds).
 */
import * as vscode from "vscode";

export function tpGet<T>(fullKey: string, defaultValue: T): T {
  const v = vscode.workspace.getConfiguration().get<T>(fullKey, defaultValue);
  return v ?? defaultValue;
}
