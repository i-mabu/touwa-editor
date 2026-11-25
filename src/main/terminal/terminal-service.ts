import path from "node:path";
import { SessionManager } from "../process/session-manager.ts";
import type { SessionHooks } from "../process/session-manager.ts";
import { PtyManager } from "../process/pty-manager.ts";

// ==========================================
// 📌 Terminal sessions (Phase 3)
// ==========================================
// 🔗 A terminal session is the user's shell running as a long-lived
// session in the workspace root. Sessions run on a pseudo-terminal
// (node-pty) whenever that backend is available: interactive
// prompts, password input without echo, Ctrl+C and isatty checks
// then behave as in a real terminal. When node-pty cannot be loaded
// (native module unavailable), the service falls back to the
// pipe-based console and reports mode "pipe" so the UI can say so
// honestly; full-screen TUI rendering is not supported in either
// mode (the panel is a scrolling console, not a terminal emulator).
//
// The shell is chosen by Main, never by the renderer: PowerShell on
// Windows (falling back to cmd), the user's $SHELL elsewhere
// (falling back to sh). Only the bare executable name is passed to
// the session managers, per the shared process contract.

export type ShellCandidate = { command: string; args: string[] };

export function shellCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): ShellCandidate[] {
  if (platform === "win32") {
    return [
      { command: "powershell", args: ["-NoLogo"] },
      { command: "cmd", args: [] },
    ];
  }
  const fromEnv = env.SHELL ? path.basename(env.SHELL) : "";
  const candidates: ShellCandidate[] = [];
  if (
    fromEnv.length > 0 &&
    !fromEnv.includes("/") &&
    !fromEnv.includes("\\") &&
    !fromEnv.includes("\0")
  ) {
    candidates.push({ command: fromEnv, args: [] });
  }
  if (fromEnv !== "sh") candidates.push({ command: "sh", args: [] });
  return candidates;
}

export type TerminalMode = "pty" | "pipe";
export type TerminalStartResult = {
  id: string;
  shell: string;
  mode: TerminalMode;
};

export class TerminalService {
  private readonly manager: SessionManager;
  private readonly pty: PtyManager;
  private readonly kinds = new Map<string, TerminalMode>();

  constructor(
    manager: SessionManager,
    pty: PtyManager = new PtyManager(),
  ) {
    this.manager = manager;
    this.pty = pty;
  }

  async start(
    root: string,
    hooks: SessionHooks,
  ): Promise<TerminalStartResult> {
    let lastError: Error | null = null;
    const ptyAvailable = await this.pty.available();
    for (const candidate of shellCandidates(process.platform, process.env)) {
      if (ptyAvailable) {
        try {
          // ▶️ Assigned as soon as start resolves; the hooks can only
          // fire after that (the manager attaches them once spawned).
          let currentId = "";
          const id = await this.pty.start(
            { command: candidate.command, args: candidate.args, cwd: root },
            {
              onData: ({ text }) => {
                hooks.onData({ stream: "stdout", text });
              },
              onExit: ({ exitCode }) => {
                this.kinds.delete(currentId);
                hooks.onExit({ exitCode, signal: null });
              },
            },
          );
          currentId = id;
          this.kinds.set(id, "pty");
          return { id, shell: candidate.command, mode: "pty" };
        } catch (e) {
          lastError =
            e instanceof Error ? e : new Error("Failed to start shell.");
        }
      }
      try {
        const id = await this.manager.start(
          { command: candidate.command, args: candidate.args, cwd: root },
          hooks,
        );
        this.kinds.set(id, "pipe");
        return { id, shell: candidate.command, mode: "pipe" };
      } catch (e) {
        lastError =
          e instanceof Error ? e : new Error("Failed to start shell.");
      }
    }
    throw lastError ?? new Error("No shell is available.");
  }

  write(id: string, data: string): boolean {
    const kind = this.kinds.get(id);
    if (kind === "pty") return this.pty.write(id, data);
    if (kind === "pipe") return this.manager.write(id, data);
    return false;
  }

  kill(id: string): boolean {
    const kind = this.kinds.get(id);
    this.kinds.delete(id);
    if (kind === "pty") return this.pty.kill(id);
    if (kind === "pipe") return this.manager.kill(id);
    return false;
  }

  killAll(): void {
    this.kinds.clear();
    this.pty.killAll();
    this.manager.killAll();
  }
}

/** Shared instance: IPC registers handlers on it, main kills all on quit. */
export const terminalService = new TerminalService(new SessionManager());
