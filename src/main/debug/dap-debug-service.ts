import path from "node:path";
import { SessionManager } from "../process/session-manager.ts";
import { assertWorkspacePath } from "../workspace/path-security.ts";
import { DapClient } from "./dap-client.ts";
import type { DebugAdapterConfig } from "./debug-config.ts";
import type {
  DebugBreakpoint,
  DebugFrame,
  DebugHooks,
  DebugVariable,
} from "./debug-service.ts";

// ===== External DAP debug session (Phase 3) =====
// Drives an external Debug Adapter Protocol server (registered in
// .touwa/debug.json) through the same editor-facing API as the
// built-in Node.js debugger: start / breakpoints / stepping / stack
// frames / variables, with state and output as events. The launch
// arguments are the near-universal { program, cwd, stopOnEntry }
// set; adapter-specific options are out of scope by design.

type DapStackFrame = {
  id?: unknown;
  name?: unknown;
  source?: { path?: unknown };
  line?: unknown;
  column?: unknown;
};

type DapVariable = {
  name?: unknown;
  value?: unknown;
  type?: unknown;
  variablesReference?: unknown;
};

const MAX_VARIABLES = 100;
const INITIALIZED_WAIT_MS = 3_000;

export function sourcePathToRelative(root: string, sourcePath: string): string {
  const relative = path.relative(root, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
  return relative.split(path.sep).join("/");
}

export function mapDapVariable(variable: DapVariable): DebugVariable | null {
  if (typeof variable.name !== "string") return null;
  return {
    name: variable.name,
    value: typeof variable.value === "string" ? variable.value : "",
    type: typeof variable.type === "string" ? variable.type : "",
    variablesReference:
      typeof variable.variablesReference === "number"
        ? variable.variablesReference
        : 0,
  };
}

export class DapDebugService {
  private readonly manager: SessionManager;
  private client: DapClient | null = null;
  private root: string | null = null;
  private hooks: DebugHooks | null = null;
  private terminatedEmitted = false;
  private configured = false;
  private readonly breakpoints = new Map<string, number[]>();
  private dapFrameIds: number[] = [];
  private currentThreadId: number | null = null;
  private stoppedChain: Promise<void> = Promise.resolve();

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  get running(): boolean {
    return this.client !== null;
  }

  async start(
    root: string,
    adapter: DebugAdapterConfig,
    scriptRelativePath: string,
    breakpoints: DebugBreakpoint[],
    hooks: DebugHooks,
  ): Promise<void> {
    if (this.client !== null) {
      throw new Error("A debug session is already running.");
    }
    const absoluteScript = assertWorkspacePath(root, scriptRelativePath);
    this.root = root;
    this.hooks = hooks;
    this.terminatedEmitted = false;
    this.configured = false;
    this.currentThreadId = null;
    this.dapFrameIds = [];
    this.breakpoints.clear();
    for (const breakpoint of breakpoints) {
      const lines = this.breakpoints.get(breakpoint.relativePath) ?? [];
      lines.push(breakpoint.line);
      this.breakpoints.set(breakpoint.relativePath, lines);
    }
    const client = new DapClient(this.manager);
    this.client = client;

    let resolveInitialized: () => void = () => {};
    const initialized = new Promise<void>((resolve) => {
      resolveInitialized = resolve;
    });
    client.on("initialized", () => {
      resolveInitialized();
    });
    client.on("stopped", (body) => {
      const stopped = body as { threadId?: unknown; reason?: unknown };
      this.stoppedChain = this.stoppedChain.then(() =>
        this.handleStopped(
          typeof stopped.threadId === "number" ? stopped.threadId : null,
          typeof stopped.reason === "string" ? stopped.reason : "",
        ),
      );
    });
    client.on("continued", () => {
      this.dapFrameIds = [];
      this.hooks?.onState({ status: "running" });
    });
    client.on("terminated", () => {
      this.emitTerminated();
    });
    client.on("output", (body) => {
      const output = body as { category?: unknown; output?: unknown };
      if (typeof output.output === "string") {
        this.hooks?.onOutput(
          output.category === "stderr" ? "stderr" : "stdout",
          output.output,
        );
      }
    });

    try {
      await client.start(
        { command: adapter.command, args: adapter.args, cwd: root },
        {
          onOutput: (stream, text) => {
            this.hooks?.onOutput(stream, text);
          },
          onExit: () => {
            this.emitTerminated();
          },
        },
      );
      await client.request("initialize", {
        clientID: "touwa-editor",
        clientName: "Touwa Editor",
        adapterID: adapter.id,
        pathFormat: "path",
        linesStartAt1: true,
        columnsStartAt1: true,
        supportsVariableType: true,
        supportsRunInTerminalRequest: false,
      });
      await client.request("launch", {
        program: absoluteScript,
        cwd: root,
        stopOnEntry: false,
      });
      // Adapters announce readiness with the initialized event;
      // proceed after it, or after a grace period for adapters
      // that never send it.
      await Promise.race([
        initialized,
        new Promise((resolve) => setTimeout(resolve, INITIALIZED_WAIT_MS)),
      ]);
      for (const [relativePath, lines] of this.breakpoints) {
        await this.applyBreakpoints(relativePath, lines);
      }
      this.configured = true;
      await client.request("configurationDone").catch(() => {
        // Some adapters do not support configurationDone; the
        // session is usable either way.
      });
      this.hooks?.onState({ status: "running" });
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  private async handleStopped(
    threadId: number | null,
    reason: string,
  ): Promise<void> {
    if (!this.client || this.root === null) return;
    try {
      let targetThread = threadId;
      if (targetThread === null) {
        const threads = await this.client.request<{
          threads?: { id?: unknown }[];
        }>("threads");
        const first = threads?.threads?.[0]?.id;
        targetThread = typeof first === "number" ? first : null;
      }
      if (targetThread === null) return;
      this.currentThreadId = targetThread;
      const trace = await this.client.request<{
        stackFrames?: DapStackFrame[];
      }>("stackTrace", {
        threadId: targetThread,
        startFrame: 0,
        levels: 20,
      });
      const rawFrames = trace?.stackFrames ?? [];
      this.dapFrameIds = rawFrames.map((frame) =>
        typeof frame.id === "number" ? frame.id : 0,
      );
      const frames: DebugFrame[] = rawFrames.map((frame, index) => ({
        id: index,
        name: typeof frame.name === "string" ? frame.name : "(unknown)",
        relativePath:
          typeof frame.source?.path === "string"
            ? sourcePathToRelative(this.root as string, frame.source.path)
            : "",
        line: typeof frame.line === "number" ? frame.line : 1,
        column: typeof frame.column === "number" ? frame.column : 1,
      }));
      this.hooks?.onState({ status: "paused", reason, frames });
    } catch {
      // The session may have ended while fetching the trace; the
      // terminated path reports the final state.
    }
  }

  private async applyBreakpoints(
    relativePath: string,
    lines: number[],
  ): Promise<void> {
    if (!this.client || this.root === null) return;
    const absolute = assertWorkspacePath(this.root, relativePath);
    await this.client
      .request("setBreakpoints", {
        source: { path: absolute },
        breakpoints: lines.map((line) => ({ line })),
      })
      .catch(() => {
        // A rejected file (e.g. not loaded yet) keeps its stored
        // set; the adapter applies what it can.
      });
  }

  async setBreakpoints(
    relativePath: string,
    lines: number[],
  ): Promise<void> {
    this.breakpoints.set(relativePath, [...lines]);
    if (this.client && this.configured) {
      await this.applyBreakpoints(relativePath, lines);
    }
  }

  private threadArgs(): Record<string, unknown> {
    return this.currentThreadId !== null
      ? { threadId: this.currentThreadId }
      : {};
  }

  async resume(): Promise<void> {
    await this.client?.request("continue", this.threadArgs());
  }

  async stepOver(): Promise<void> {
    await this.client?.request("next", this.threadArgs());
  }

  async stepInto(): Promise<void> {
    await this.client?.request("stepIn", this.threadArgs());
  }

  async stepOut(): Promise<void> {
    await this.client?.request("stepOut", this.threadArgs());
  }

  async pause(): Promise<void> {
    await this.client?.request("pause", this.threadArgs());
  }

  async frameVariables(frameIndex: number): Promise<DebugVariable[]> {
    if (!this.client) return [];
    const frameId = this.dapFrameIds[frameIndex];
    if (frameId === undefined) return [];
    const scopes = await this.client.request<{
      scopes?: { variablesReference?: unknown }[];
    }>("scopes", { frameId });
    const variables: DebugVariable[] = [];
    for (const scope of scopes?.scopes ?? []) {
      if (typeof scope.variablesReference !== "number") continue;
      variables.push(...(await this.variables(scope.variablesReference)));
      if (variables.length >= MAX_VARIABLES) break;
    }
    return variables.slice(0, MAX_VARIABLES);
  }

  async variables(variablesReference: number): Promise<DebugVariable[]> {
    if (!this.client) return [];
    const result = await this.client.request<{
      variables?: DapVariable[];
    }>("variables", { variablesReference });
    return (result?.variables ?? [])
      .map(mapDapVariable)
      .filter((v): v is DebugVariable => v !== null)
      .slice(0, MAX_VARIABLES);
  }

  private emitTerminated(): void {
    if (this.terminatedEmitted) return;
    this.terminatedEmitted = true;
    this.dapFrameIds = [];
    this.hooks?.onState({ status: "terminated" });
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      await Promise.race([
        client.request("disconnect", { terminateDebuggee: true }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await client.stop();
    }
    this.emitTerminated();
  }

  /** Silent teardown for app quit: no events are emitted. */
  async dispose(): Promise<void> {
    this.hooks = null;
    this.terminatedEmitted = true;
    const client = this.client;
    this.client = null;
    if (client) await client.stop();
  }
}

/** Shared instance: IPC registers handlers on it, main stops on quit. */
export const dapDebugService = new DapDebugService(new SessionManager());
