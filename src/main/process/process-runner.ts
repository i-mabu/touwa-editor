import { spawn } from "node:child_process";
import fs from "node:fs";

// ==========================================
// ⚙️ Shared external-process runner (Phase 3 foundation)
// ==========================================
// 🌐 Every Phase 3 feature that talks to an external program (Git,
// language servers, tasks, debuggers) goes through this runner so the
// safety contract from ROADMAP.md lives in exactly one place:
//   - shell: false, always. Arguments are passed as an argv array and
//     are never concatenated into a shell command line.
//   - The command must be a bare executable name chosen by a Main
//     service. Renderer input can never reach this function.
//   - cwd must be an existing directory (services pass a path that has
//     already been validated against the workspace boundary).
//   - Every run has a timeout; a timed-out process is terminated
//     (SIGTERM, then SIGKILL after a grace period).
//   - stdout and stderr are captured separately, each bounded, and
//     the exit code / signal are reported to the caller.

export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type RunProcessOptions = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
};

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const MAX_ARGS = 256;
const MAX_ARG_LENGTH = 32_768;
const KILL_GRACE_MS = 1_500;

export function assertValidCommand(command: string): void {
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.includes("/") ||
    command.includes("\\") ||
    command.includes("\0")
  ) {
    throw new Error("A bare executable name is required.");
  }
}

export function assertValidArgs(args: string[]): void {
  if (!Array.isArray(args) || args.length > MAX_ARGS) {
    throw new Error("Invalid process arguments.");
  }
  for (const arg of args) {
    if (
      typeof arg !== "string" ||
      arg.length > MAX_ARG_LENGTH ||
      arg.includes("\0")
    ) {
      throw new Error("Invalid process arguments.");
    }
  }
}

function assertValidEnv(env: NodeJS.ProcessEnv | undefined): void {
  if (env === undefined) return;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (
      key.length === 0 ||
      key.includes("=") ||
      key.includes("\0") ||
      value.includes("\0")
    ) {
      throw new Error("Invalid process environment.");
    }
  }
}

export function assertValidCwd(cwd: string): void {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("A working directory is required.");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new Error("Working directory does not exist.");
  }
  if (!stat.isDirectory()) {
    throw new Error("Working directory is not a directory.");
  }
}

export function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid timeout.");
  }
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

export async function runProcess(
  options: RunProcessOptions,
): Promise<ProcessResult> {
  assertValidCommand(options.command);
  assertValidArgs(options.args);
  assertValidCwd(options.cwd);
  assertValidEnv(options.env);
  const timeoutMs = clampTimeout(options.timeoutMs);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !Number.isFinite(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > 16_000_000
  ) {
    throw new Error("Invalid output limit.");
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: options.env ?? process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const collect =
      (chunks: Buffer[], track: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
        const used = track === "stdout" ? stdoutBytes : stderrBytes;
        if (used >= maxOutputBytes) {
          if (track === "stdout") stdoutTruncated = true;
          else stderrTruncated = true;
          return;
        }
        const room = maxOutputBytes - used;
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room));
          if (track === "stdout") {
            stdoutBytes += room;
            stdoutTruncated = true;
          } else {
            stderrBytes += room;
            stderrTruncated = true;
          }
        } else {
          chunks.push(chunk);
          if (track === "stdout") stdoutBytes += chunk.length;
          else stderrBytes += chunk.length;
        }
      };
    child.stdout.on("data", collect(stdoutChunks, "stdout"));
    child.stderr.on("data", collect(stderrChunks, "stderr"));

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const graceTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      graceTimer.unref();
    }, timeoutMs);
    killTimer.unref();

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      reject(
        new Error(`Failed to start "${options.command}": ${error.message}`),
      );
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}
