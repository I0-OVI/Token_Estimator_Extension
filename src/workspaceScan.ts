/**
 * Workspace structure scan — versioned JSON for offline evaluation (no file contents read).
 *
 * Schema (schemaVersion 1):
 * - generatedAtIso, workspaceFolderName
 * - workspaceFolderAbsolutePath: only if setting includeAbsolutePathsInOutput
 * - limits: { maxFiles, filesVisited, truncated }
 * - totals: { fileCount, totalBytes }
 * - byExtension: { ".ts": n, "(none)": n, ... }
 * - topLevelDirs: { "src": n, "(root)": n, ... } — first path segment under folder
 * - samplePaths: optional relative posix paths
 */
import * as path from "path";
import * as vscode from "vscode";

const SCHEMA_VERSION = 1;

const BUILTIN_EXCLUDES = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/out/**",
  "**/.cursor/**",
];

function mergeExcludeGlobs(userExtra: string): string {
  const extras = userExtra
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const all = [...BUILTIN_EXCLUDES, ...extras];
  return `{${all.join(",")}}`;
}

function toPosixRel(fsPath: string, rootFs: string): string {
  let rel = path.relative(rootFs, fsPath);
  if (!rel || rel === "") {
    return "";
  }
  return rel.split(path.sep).join("/");
}

function firstSegment(relPosix: string): string {
  if (!relPosix) {
    return "(root)";
  }
  const i = relPosix.indexOf("/");
  return i < 0 ? "(root)" : relPosix.slice(0, i);
}

function extKey(filePath: string): string {
  const e = path.extname(filePath);
  return e === "" ? "(none)" : e;
}

async function ensureParentDirectories(root: vscode.Uri, outputRelativePath: string): Promise<void> {
  const parts = outputRelativePath.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 1) {
    return;
  }
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = vscode.Uri.joinPath(cur, parts[i]);
    try {
      await vscode.workspace.fs.stat(cur);
    } catch {
      await vscode.workspace.fs.createDirectory(cur);
    }
  }
}

export interface WorkspaceScanResult {
  writtenPaths: string[];
  summaryLines: string[];
}

export async function runWorkspaceStructureScan(opts?: { quiet?: boolean }): Promise<WorkspaceScanResult> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    void vscode.window.showWarningMessage("Token Prediction: open a workspace folder first.");
    return { writtenPaths: [], summaryLines: [] };
  }

  const cfg = vscode.workspace.getConfiguration("tokenPrediction");
  const includeGlob = cfg.get<string>("workspaceScan.includeGlob", "**/*");
  const excludeExtra = cfg.get<string>("workspaceScan.excludeGlob", "");
  const maxFiles = cfg.get<number>("workspaceScan.maxFiles", 50000);
  const outputRelativePath = cfg.get<string>(
    "workspaceScan.outputRelativePath",
    ".cursor/token_prediction_workspace_scan.json"
  );
  const samplePathCount = cfg.get<number>("workspaceScan.samplePathCount", 20);
  const includeAbs = cfg.get<boolean>("workspaceScan.includeAbsolutePathsInOutput", false);

  const excludeMerged = mergeExcludeGlobs(excludeExtra);
  const writtenPaths: string[] = [];
  const summaryLines: string[] = [];

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Token Prediction: scanning workspace…",
      cancellable: true,
    },
    async (progress, token) => {
      for (let fi = 0; fi < folders.length; fi++) {
        const folder = folders[fi];
        const root = folder.uri;
        const rootFs = root.fsPath;
        const label = folders.length > 1 ? ` (${folder.name})` : "";
        progress.report({ message: `${folder.name}${label}`, increment: 0 });

        const includePattern = new vscode.RelativePattern(folder, includeGlob);
        const excludePattern = new vscode.RelativePattern(folder, excludeMerged);

        const findCap = Math.min(maxFiles + 1, 500001);
        let uris: vscode.Uri[];
        try {
          uris = await vscode.workspace.findFiles(includePattern, excludePattern, findCap, token);
        } catch (e) {
          if (token.isCancellationRequested) {
            void vscode.window.showInformationMessage("Token Prediction: workspace scan cancelled.");
            return;
          }
          throw e;
        }

        if (token.isCancellationRequested) {
          void vscode.window.showInformationMessage("Token Prediction: workspace scan cancelled.");
          return;
        }

        const truncated = uris.length > maxFiles;
        const toProcess = truncated ? uris.slice(0, maxFiles) : uris;

        const byExtension: Record<string, number> = {};
        const topLevelDirs: Record<string, number> = {};
        let totalBytes = 0;
        const samplePaths: string[] = [];
        let filesVisited = 0;

        for (let i = 0; i < toProcess.length; i++) {
          if (token.isCancellationRequested) {
            void vscode.window.showInformationMessage("Token Prediction: workspace scan cancelled.");
            return;
          }
          if (i % 500 === 0) {
            progress.report({ message: `${folder.name}: ${i}/${toProcess.length}` });
          }

          const u = toProcess[i];
          const rel = toPosixRel(u.fsPath, rootFs);
          if (samplePaths.length < samplePathCount && rel) {
            samplePaths.push(rel);
          }

          let size = 0;
          try {
            const st = await vscode.workspace.fs.stat(u);
            if (st.type === vscode.FileType.File) {
              size = st.size;
            }
          } catch {
            /* skip missing */
          }

          totalBytes += size;
          filesVisited += 1;

          const ext = extKey(u.fsPath);
          byExtension[ext] = (byExtension[ext] ?? 0) + 1;

          const seg = firstSegment(rel);
          topLevelDirs[seg] = (topLevelDirs[seg] ?? 0) + 1;
        }

        const payload: Record<string, unknown> = {
          schemaVersion: SCHEMA_VERSION,
          generatedAtIso: new Date().toISOString(),
          workspaceFolderName: folder.name,
        };
        if (includeAbs) {
          payload.workspaceFolderAbsolutePath = rootFs;
        }
        payload.limits = {
          maxFiles,
          filesVisited,
          truncated,
        };
        payload.totals = {
          fileCount: filesVisited,
          totalBytes,
        };
        payload.byExtension = byExtension;
        payload.topLevelDirs = topLevelDirs;
        if (samplePathCount > 0 && samplePaths.length > 0) {
          payload.samplePaths = samplePaths;
        }

        await ensureParentDirectories(root, outputRelativePath);
        const outParts = outputRelativePath.split(/[/\\]/).filter(Boolean);
        let outUri = root;
        for (const p of outParts) {
          outUri = vscode.Uri.joinPath(outUri, p);
        }

        const json = JSON.stringify(payload, null, 2);
        await vscode.workspace.fs.writeFile(outUri, Buffer.from(json, "utf8"));

        const written = outUri.fsPath;
        writtenPaths.push(written);
        summaryLines.push(
          `${folder.name}: ${filesVisited} files, ${totalBytes} bytes${truncated ? " (truncated)" : ""} → ${toPosixRel(written, rootFs) || outputRelativePath}`
        );
      }
    }
  );

  if (writtenPaths.length > 0 && !opts?.quiet) {
    const hint =
      writtenPaths.length === 1
        ? writtenPaths[0]
        : `${writtenPaths.length} files (one per workspace folder — see ${outputRelativePath})`;
    void vscode.window.showInformationMessage(`Token Prediction: workspace scan saved. ${hint}`);
  }

  return { writtenPaths, summaryLines };
}
