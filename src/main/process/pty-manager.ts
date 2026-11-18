import type { IPty } from "node-pty";
import {
  assertValidArgs,
  assertValidCommand,
  assertValidCwd,
} from "./process-runner.ts";

// ===== PTY sessions (Phase 3) =====
// Long-lived pseudo-terminal sessions via node-pty. node-pty is a
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
    const proc = mod.spawn(options.command, options.args, {
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
      // The process may already be gone; the session is dropped either way.
    }
    return true;
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
  }
}
