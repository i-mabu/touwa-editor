import fs from "node:fs";
import path from "node:path";
import { runProcess } from "../process/process-runner.ts";

// ==========================================
// 📌 Diagnostics (Phase 3)
// ==========================================
// 🗂️ First checker: the workspace's own TypeScript compiler, run through
// the shared process runner. `tsc --noEmit --pretty false` prints one
// stable, machine-readable line per problem:
//   src/a.ts(3,7): error TS2322: Type 'string' is not assignable...
// The editor never installs anything: it uses the typescript the
// workspace already depends on (node_modules/typescript/bin/tsc,
// executed with node). Without a tsconfig.json, or without a local
// typescript, diagnostics are reported as unavailable instead of
// guessing. The result shape is checker-agnostic so more checkers
// (and later, language servers) can feed the same Problems panel.

export type DiagnosticSeverity = "error" | "warning";

export type Diagnostic = {
  /** Workspace-relative path, or "" for project-wide problems. */
  relativePath: string;
  /** 1-based line, or 0 when the problem has no position. */
  line: number;
  /** 1-based column, or 0 when the problem has no position. */
  column: number;
  severity: DiagnosticSeverity;
  /** Checker code, e.g. "TS2322". */
  code: string;
  message: string;
  /** Which checker produced this entry, e.g. "tsc". */
  source: string;
};

export type DiagnosticsResult = {
  available: boolean;
  /** Why diagnostics are unavailable, when available is false. */
  reason: string | null;
  diagnostics: Diagnostic[];
  truncated: boolean;
};

export const MAX_DIAGNOSTICS = 500;
const TSC_TIMEOUT_MS = 60_000;

const POSITION_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;
const GLOBAL_LINE = /^(error|warning) (TS\d+): (.*)$/;

export function parseTscOutput(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const positioned = POSITION_LINE.exec(line);
    if (positioned) {
      diagnostics.push({
        relativePath: positioned[1].split(path.sep).join("/"),
        line: Number(positioned[2]),
        column: Number(positioned[3]),
        severity: positioned[4] as DiagnosticSeverity,
        code: positioned[5],
        message: positioned[6],
        source: "tsc",
      });
      continue;
    }
    const global = GLOBAL_LINE.exec(line);
    if (global) {
      diagnostics.push({
        relativePath: "",
        line: 0,
        column: 0,
        severity: global[1] as DiagnosticSeverity,
        code: global[2],
        message: global[3],
        source: "tsc",
      });
    }
    // 📝 Anything else (multi-line message continuations, summaries) is
    // not a diagnostic line and is ignored.
  }
  return diagnostics;
}

function unavailable(reason: string): DiagnosticsResult {
  return { available: false, reason, diagnostics: [], truncated: false };
}

export async function runDiagnostics(root: string): Promise<DiagnosticsResult> {
  const tsconfigPath = path.join(root, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) {
    return unavailable("tsconfig.json がないため、型チェックは未対応です");
  }
  const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(tscBin)) {
    return unavailable(
      "ワークスペースに TypeScript がインストールされていません（node_modules/typescript が必要です）",
    );
  }
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess({
      command: "node",
      args: [tscBin, "--noEmit", "--pretty", "false"],
      cwd: root,
      timeoutMs: TSC_TIMEOUT_MS,
      maxOutputBytes: 4_000_000,
    });
  } catch {
    return unavailable("型チェックを開始できませんでした");
  }
  if (result.timedOut) {
    return unavailable("型チェックがタイムアウトしました");
  }
  // ⚠️ tsc exits 0 (clean), 1 (problems found) or 2 (compiler error);
  // in all cases stdout carries the diagnostic lines.
  const all = parseTscOutput(result.stdout);
  return {
    available: true,
    reason: null,
    diagnostics: all.slice(0, MAX_DIAGNOSTICS),
    truncated: all.length > MAX_DIAGNOSTICS,
  };
}
