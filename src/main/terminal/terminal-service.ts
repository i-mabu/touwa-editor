import path from "node:path";
import { SessionManager } from "../process/session-manager.ts";
import type { SessionHooks } from "../process/session-manager.ts";

// ===== Terminal sessions (Phase 3) =====
// A terminal session is the user's shell running as a long-lived
// session in the workspace root. This is a pipe-based console, not a
// PTY: programs that need a real TTY (full-screen TUIs, interactive
// prompts that read raw keystrokes) will not behave as they would in
// a dedicated terminal emulator. Ordinary command execution — the
// common case — works, and the limitation is documented rather than
// hidden.
//
// The shell is chosen by Main, never by the renderer: PowerShell on
// Windows (falling back to cmd), the user's $SHELL elsewhere
// (falling back to sh). Only the bare executable name is passed to
// the session manager, per the shared process contract.

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

export type TerminalStartResult = { id: string; shell: string };

export class TerminalService {
  private readonly manager: SessionManager;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  async start(root: string, hooks: SessionHooks): Promise<TerminalStartResult> {
    let lastError: Error | null = null;
    for (const candidate of shellCandidates(process.platform, process.env)) {
      try {
        const id = await this.manager.start(
          { command: candidate.command, args: candidate.args, cwd: root },
          hooks,
        );
        return { id, shell: candidate.command };
      } catch (e) {
        lastError =
          e instanceof Error ? e : new Error("Failed to start shell.");
      }
    }
    throw lastError ?? new Error("No shell is available.");
  }

  write(id: string, data: string): boolean {
    return this.manager.write(id, data);
  }

  kill(id: string): boolean {
    return this.manager.kill(id);
  }

  killAll(): void {
    this.manager.killAll();
  }
}

/** Shared instance: IPC registers handlers on it, main kills all on quit. */
export const terminalService = new TerminalService(new SessionManager());
