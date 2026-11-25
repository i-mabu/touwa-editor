import fs from "node:fs";
import path from "node:path";
import type { IPty } from "node-pty";
import {
  assertValidArgs,
  assertValidCommand,
  assertValidCwd,
} from "./process-runner.ts";

/**
 * Resolves a bare executable name to an absolute path on Windows by
 * searching PATH with the PATHEXT extensions. node-pty's ConPTY
 * backend does not reliably find bare names, so the lookup is done
 * here (the same approach terminal emulators take). Names that
 * already carry a path or an extension are returned unchanged, as
 * are names that cannot be found (node-pty then reports the error).
 */
export function resolveWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  if (command.includes("/") || command.includes("\\")) return command;
  const extensions = (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter((ext) => ext.length > 0);
  const hasExtension = extensions.some((ext) =>
    command.toLowerCase().endsWith(ext.toLowerCase()),
  );
  const dirs = (env.PATH ?? "").split(";").filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    // 📝 win32 joins explicitly: this helper only ever runs for
    // Windows paths, whatever the host platform of the caller is.
    const candidates = hasExtension
      ? [path.win32.join(dir, command)]
      : extensions.map((ext) => path.win32.join(dir, command + ext));
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate;
    }
  }
  return command;
}

// ==========================================
// 📌 PTY sessions (Phase 3)
// ==========================================
// 📝 Long-lived pseudo-terminal sessions via node-pty. node-pty is a
// native module, so it is loaded lazily and treated as optional:
// when it cannot be loaded (not installed, wrong ABI in a packaged
// build, no prebuild for the platform), loadModule() resolves to
// null and callers fall back to pipe-based sessions. Nothing in the
// app may fail just because the PTY backend is unavailable.

export type PtyDataEvent = { text: string };
export type PtyExitEvent = { exitCode: number | null };

export type PtyHooks = {
  onData: (event: PtyDataEvent) => void;
  onExit: (event: PtyExitEvent) => void;
};

export type StartPtyOptions = {
  command: string;
  args: string[];
  cwd: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
};

type PtyModule = typeof import("node-pty");
export type PtyLoader = () => Promise<PtyModule>;

const defaultLoader: PtyLoader = async () => import("node-pty");

const MAX_WRITE_LENGTH = 1_000_000;
export const DEFAULT_PTY_COLS = 80;
export const DEFAULT_PTY_ROWS = 24;

export class PtyManager {
  private readonly loader: PtyLoader;
  private modulePromise: Promise<PtyModule | null> | null = null;
  private readonly sessions = new Map<string, IPty>();
  private counter = 0;

  constructor(loader: PtyLoader = defaultLoader) {
    this.loader = loader;
  }

  /** Resolves to the node-pty module, or null when unavailable. */
  loadModule(): Promise<PtyModule | null> {
    if (!this.modulePromise) {
      this.modulePromise = this.loader().catch(() => null);
    }
    return this.modulePromise;
  }

  async available(): Promise<boolean> {
    return (await this.loadModule()) !== null;
  }

  async start(options: StartPtyOptions, hooks: PtyHooks): Promise<string> {
    assertValidCommand(options.command);
    assertValidArgs(options.args);
    assertValidCwd(options.cwd);
    const mod = await this.loadModule();
    if (!mod) throw new Error("PTY is not available on this system.");
    const file =
      process.platform === "win32"
        ? resolveWindowsExecutable(
            options.command,
            options.env ?? process.env,
          )
        : options.command;
    const proc = mod.spawn(file, options.args, {
      name: "xterm-256color",
      cols: options.cols ?? DEFAULT_PTY_COLS,
      rows: options.rows ?? DEFAULT_PTY_ROWS,
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    const id = `pty-${++this.counter}`;
    this.sessions.set(id, proc);
    proc.onData((data) => {
      hooks.onData({ text: data });
    });
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id);
      hooks.onExit({
        exitCode: typeof exitCode === "number" ? exitCode : null,
      });
    });
    return id;
  }

  write(id: string, data: string): boolean {
    if (typeof data !== "string" || data.length > MAX_WRITE_LENGTH) {
      return false;
    }
    const proc = this.sessions.get(id);
    if (!proc) return false;
    proc.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const proc = this.sessions.get(id);
    if (!proc) return false;
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 1 ||
      rows < 1 ||
      cols > 1_000 ||
      rows > 1_000
    ) {
      return false;
    }
    proc.resize(cols, rows);
    return true;
  }

  kill(id: string): boolean {
    const proc = this.sessions.get(id);
    if (!proc) return false;
    this.sessions.delete(id);
    try {
      proc.kill();
    } catch {
      // ⚙️ The process may already be gone; the session is dropped either way.
    }
    return true;
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
  }
}
