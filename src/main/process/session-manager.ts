import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  assertValidArgs,
  assertValidCommand,
  assertValidCwd,
} from "./process-runner.ts";

// ===== Long-lived process sessions (Phase 3) =====
// runProcess covers one-shot commands; sessions cover processes that
// stay alive and exchange data over time (terminal shells now,
// language servers later). The safety contract is the same as the
// one-shot runner: bare executable names chosen by Main services,
// argv arrays, shell: false, a validated existing cwd. Sessions have
// no timeout — their lifetime belongs to the user — but they are
// always killable, and the app kills every session on quit.
//
// start() resolves only after the child actually spawned (the
// 'spawn' event), so a missing executable rejects instead of
// producing a session that is already dead.

export type SessionDataEvent = {
  stream: "stdout" | "stderr";
  text: string;
};

export type SessionExitEvent = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type SessionHooks = {
  onData: (event: SessionDataEvent) => void;
  onExit: (event: SessionExitEvent) => void;
};

export type StartSessionOptions = {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

const MAX_WRITE_LENGTH = 65_536;
const KILL_GRACE_MS = 1_500;

export class SessionManager {
  private readonly sessions = new Map<string, ChildProcessWithoutNullStreams>();
  private counter = 0;

  get size(): number {
    return this.sessions.size;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  async start(
    options: StartSessionOptions,
    hooks: SessionHooks,
  ): Promise<string> {
    assertValidCommand(options.command);
    assertValidArgs(options.args);
    assertValidCwd(options.cwd);
    const id = `session-${++this.counter}`;
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: options.env ?? process.env,
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        child.off("spawn", onSpawn);
        reject(
          new Error(`Failed to start "${options.command}": ${error.message}`),
        );
      };
      const onSpawn = (): void => {
        child.off("error", onError);
        resolve();
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    this.sessions.set(id, child);
    child.stdout.on("data", (chunk: Buffer) =>
      hooks.onData({ stream: "stdout", text: chunk.toString("utf8") }),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      hooks.onData({ stream: "stderr", text: chunk.toString("utf8") }),
    );
    child.on("close", (exitCode, signal) => {
      this.sessions.delete(id);
      hooks.onExit({ exitCode, signal });
    });
    // After a successful spawn, a later 'error' (e.g. a failed kill)
    // must not become an unhandled error event; 'close' still fires
    // and reports the exit.
    child.on("error", () => undefined);
    return id;
  }

  write(id: string, data: string): boolean {
    if (
      typeof data !== "string" ||
      data.length === 0 ||
      data.length > MAX_WRITE_LENGTH
    ) {
      throw new Error("Invalid session input.");
    }
    const child = this.sessions.get(id);
    if (!child) return false;
    return child.stdin.write(data);
  }

  kill(id: string): boolean {
    const child = this.sessions.get(id);
    if (!child) return false;
    child.kill("SIGTERM");
    const grace = setTimeout(() => {
      if (this.sessions.has(id)) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    grace.unref();
    return true;
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
