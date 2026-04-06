import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface LoggedInteractionV1 {
  schemaVersion: 1;
  timestampIso: string;
  userPrompt: string;
  assistantMarkdown: string;
  /** From Cursor usage UI when you copy it; null if skipped. */
  cursorReportedTokens: number | null;
  linesAdded: number;
  linesRemoved: number;
  /** linesAdded + linesRemoved (activity volume) */
  linesTotalAbs: number;
  filesChangedCount: number;
  filesTouched: string[];
  /**
   * Rough count of files surfaced via grep / codebase search style tools (manual).
   */
  grepContextFileCount: number;
  /**
   * Rough count of files read via read_file (or similar) style tools (manual).
   */
  readContextFileCount: number;
  /**
   * Optional paths for debugging or fine-grained features — can be empty; counts above are enough for most training.
   */
  filesRead: string[];
  /**
   * Total context reads: `grepContextFileCount + readContextFileCount`, or `filesRead.length` if counts are 0 but paths were filled.
   */
  filesReadCount: number;
  /**
   * Model reasoning / "thinking" text (paste from UI if shown), parallel to userPrompt / assistantMarkdown.
   * Empty string if none.
   */
  thoughtMarkdown: string;
  /** Optional: user-prompt-only char heuristic (0.3/0.6) for offline eval. */
  charHeuristicInputTokens?: number;
  /** Optional: import graph node count when graph JSON existed at log time. */
  graphNodeCountAtLogTime?: number;
  /** Optional: paths from LLM scope (manual paste); validated offline only if needed. */
  llmLikelyFiles?: string[];
}

export class EditSessionTracker implements vscode.Disposable {
  private linesAdded = 0;
  private linesRemoved = 0;
  private readonly files = new Set<string>();
  private readonly sub: vscode.Disposable;

  constructor(workspaceRoot: string | undefined) {
    this.sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme !== "file") return;
      let touched = false;
      for (const c of e.contentChanges) {
        const linesOld =
          c.rangeLength === 0 ? 0 : Math.max(1, c.range.end.line - c.range.start.line + 1);
        const linesNew =
          c.text.length === 0 ? 0 : Math.max(1, c.text.split(/\r?\n/).length);
        this.linesAdded += linesNew;
        this.linesRemoved += linesOld;
        touched = true;
      }
      if (touched) {
        const rel = workspaceRoot ? path.relative(workspaceRoot, e.document.uri.fsPath) : e.document.uri.fsPath;
        this.files.add(rel);
      }
    });
  }

  getStats(workspaceRoot: string | undefined): {
    linesAdded: number;
    linesRemoved: number;
    linesTotalAbs: number;
    filesChangedCount: number;
    filesTouched: string[];
  } {
    const filesTouched = [...this.files];
    return {
      linesAdded: this.linesAdded,
      linesRemoved: this.linesRemoved,
      linesTotalAbs: this.linesAdded + this.linesRemoved,
      filesChangedCount: filesTouched.length,
      filesTouched,
    };
  }

  dispose(): void {
    this.sub.dispose();
  }
}

export function getDefaultLogPath(): string | undefined {
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (!wf) return undefined;
  return path.join(wf.uri.fsPath, ".cursor", "token_prediction_log.jsonl");
}

export function resolveLogFilePath(configPath: string | undefined): string | undefined {
  if (configPath?.trim()) {
    const p = configPath.trim();
    if (path.isAbsolute(p)) return p;
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (wf) return path.join(wf.uri.fsPath, p);
  }
  return getDefaultLogPath();
}

export function appendInteractionLog(entry: LoggedInteractionV1, filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf8");
}
