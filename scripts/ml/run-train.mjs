#!/usr/bin/env node
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const venvPy = path.join(root, ".venv", "bin", "python");
const py = fs.existsSync(venvPy) ? venvPy : "python3";
const script = path.join(root, "scripts", "ml", "train_offline.py");
const args = process.argv.slice(2);
const r = spawnSync(py, [script, ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
