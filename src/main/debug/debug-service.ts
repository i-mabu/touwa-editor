import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "../process/session-manager.ts";
import { assertWorkspacePath } from "../workspace/path-security.ts";

// ===== Node.js debugger (Phase 3) =====
// Launches a workspace JavaScript file under the V8 Inspector
// (`node --inspect-brk`) and drives it over the Chrome DevTools
// Protocol. The editor-facing API follows the Debug Adapter
// Protocol's model — start / breakpoints / stepping / stack frames /
// variables, with state and output delivered as events — while the
// wire protocol to the debuggee is CDP, translated here.
//
// Only Node.js targets are supported, and a system `node` must be
// installed (the same requirement the language server already has).
// One session at a time; the session's output (stdout/stderr of the
// debuggee) is streamed to the owning window.

export type DebugBreakpoint = { relativePath: string; line: number };

export type DebugFrame = {
  id: number;
  name: string;
  relativePath: string;
  line: number;
  column: number;
};

export type DebugVariable = {
  name: string;
  value: string;
  type: string;
  /** Non-zero when the value is an object that can be expanded. */
  variablesReference: number;
};

export type DebugState = {
  status: "running" | "paused" | "terminated";
  reason?: string;
  frames?: DebugFrame[];
};

export type DebugHooks = {
  onState: (state: DebugState) => void;
  onOutput: (stream: "stdout" | "stderr", text: string) => void;
};

const DEBUGGABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const MAX_VARIABLES = 100;

export function isDebuggablePath(relativePath: string): boolean {
  return DEBUGGABLE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

/** Picks a currently-free localhost port for the inspector. */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("Could not allocate a debugger port."));
      });
    });
  });
}

/** Polls the inspector's HTTP endpoint until it reports a target. */
export async function fetchInspectorWsUrl(
  port: number,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const list = (await response.json()) as {
          webSocketDebuggerUrl?: unknown;
        }[];
        const found = list.find(
          (entry) => typeof entry.webSocketDebuggerUrl === "string",
        );
        if (found) return found.webSocketDebuggerUrl as string;
      }
    } catch {
      // The inspector is not accepting connections yet; keep polling.
    }
    if (Date.now() > deadline) {
      throw new Error("The debugger did not start in time.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function urlToRelativePath(root: string, url: string): string {
  if (!url.startsWith("file://")) return "";
  try {
    const absolute = fileURLToPath(url);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return "";
    return relative.split(path.sep).join("/");
  } catch {
    return "";
  }
}

type RawCallFrame = {
  functionName?: unknown;
  location?: {
    scriptId?: unknown;
    lineNumber?: unknown;
    columnNumber?: unknown;
  };
  url?: unknown;
  scopeChain?: unknown;
};

/**
 * Maps one CDP call frame. Modern V8 leaves CallFrame.url empty, so
 * the caller resolves the URL from the frame's scriptId via the
 * scriptParsed registry and passes it in.
 */
export function mapCallFrame(
  root: string,
  frame: RawCallFrame,
  index: number,
  url: string,
): DebugFrame {
  const line =
    typeof frame.location?.lineNumber === "number"
      ? frame.location.lineNumber + 1
      : 1;
  const column =
    typeof frame.location?.columnNumber === "number"
      ? frame.location.columnNumber + 1
      : 1;
  return {
    id: index,
    name:
      typeof frame.functionName === "string" && frame.functionName !== ""
        ? frame.functionName
        : "(anonymous)",
    relativePath: urlToRelativePath(root, url),
    line,
    column,
  };
}

export type RawVariable = {
  name: string;
  value: string;
  type: string;
  objectId: string | null;
};

type RawRemoteObject = {
  type?: unknown;
  value?: unknown;
  description?: unknown;
  objectId?: unknown;
};

export function describeRemoteObject(remote: RawRemoteObject): string {
  if (remote.value !== undefined) {
    if (typeof remote.value === "string") return remote.value;
    if (
      typeof remote.value === "number" ||
      typeof remote.value === "boolean" ||
      typeof remote.value === "bigint"
    ) {
      return String(remote.value);
    }
    if (remote.value === null) return "null";
  }
  if (typeof remote.description === "string") return remote.description;
  if (typeof remote.type === "string") return remote.type;
  return "";
}

/** Maps Runtime.getProperties entries to display variables. */
export function mapRemoteProperties(properties: unknown): RawVariable[] {
  if (!Array.isArray(properties)) return [];
  const variables: RawVariable[] = [];
  for (const entry of properties) {
    if (entry === null || typeof entry !== "object") continue;
    const property = entry as { name?: unknown; value?: RawRemoteObject };
    if (typeof property.name !== "string" || !property.value) continue;
    variables.push({
      name: property.name,
      value: describeRemoteObject(property.value),
      type:
        typeof property.value.type === "string" ? property.value.type : "",
      objectId:
        typeof property.value.objectId === "string"
          ? property.value.objectId
          : null,
    });
  }
  return variables;
}

type CdpResponse = { result?: unknown; error?: { message?: string } };

/** Minimal Chrome DevTools Protocol client over a WebSocket. */
class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >();
  private readonly handlers = new Map<
    string,
    Set<(params: never) => void>
  >();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => {
      let message: {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(String(event.data)) as typeof message;
      } catch {
        return;
      }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(
            new Error(message.error.message ?? "Debugger request failed."),
          );
        } else {
          pending.resolve(message.result as never);
        }
        return;
      }
      if (typeof message.method === "string") {
        const set = this.handlers.get(message.method);
        if (set) {
          for (const handler of [...set]) {
            handler(message.params as never);
          }
        }
      }
    });
    this.ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Debugger connection closed."));
      }
      this.pending.clear();
    });
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onOpen = (): void => {
        this.ws.removeEventListener("error", onError);
        resolve();
      };
      const onError = (): void => {
        this.ws.removeEventListener("open", onOpen);
        reject(new Error("Could not connect to the debugger."));
      };
      this.ws.addEventListener("open", onOpen);
      this.ws.addEventListener("error", onError);
    });
  }

  send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
      } catch (e) {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error("Failed to send."));
      }
    });
  }

  on(method: string, handler: (params: never) => void): void {
    const set = this.handlers.get(method) ?? new Set();
    set.add(handler as (params: never) => void);
    this.handlers.set(method, set);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // Already closed; teardown continues.
    }
  }
}

export class DebugService {
  private readonly manager: SessionManager;
  private sessionId: string | null = null;
  private cdp: CdpClient | null = null;
  private root: string | null = null;
  private hooks: DebugHooks | null = null;
  private started = false;
  private expectingEntryPause = false;
  private terminatedEmitted = false;
  private readonly breakpoints = new Map<string, number[]>();
  private readonly breakpointIds = new Map<string, string[]>();
  private readonly scriptUrls = new Map<string, string>();
  private pausedFrames: RawCallFrame[] = [];
  private readonly objectRefs = new Map<number, string>();
  private nextRef = 1;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  get running(): boolean {
    return this.sessionId !== null;
  }

  async start(
    root: string,
    scriptRelativePath: string,
    breakpoints: DebugBreakpoint[],
    hooks: DebugHooks,
  ): Promise<void> {
    if (this.sessionId !== null) {
      throw new Error("A debug session is already running.");
    }
    if (!isDebuggablePath(scriptRelativePath)) {
      throw new Error("Only .js / .mjs / .cjs files can be debugged.");
    }
    // Node reports script URLs from the real path it loaded (on
    // Windows the temp dir and user profile often differ in 8.3
    // short-name vs long-name form), so canonicalize the root and
    // the script path; otherwise breakpoint URLs would not match
    // the loaded script and frames would not map back to files.
    let realRoot = root;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      // Keep the given root; mapping falls back to lexical paths.
    }
    let absoluteScript = assertWorkspacePath(realRoot, scriptRelativePath);
    try {
      absoluteScript = await fs.realpath(absoluteScript);
    } catch {
      // The lexical path is used; the spawn below will surface a
      // missing file as a debugger start failure.
    }
    this.root = realRoot;
    this.hooks = hooks;
    this.started = false;
    this.terminatedEmitted = false;
    this.breakpoints.clear();
    for (const breakpoint of breakpoints) {
      if (!isDebuggablePath(breakpoint.relativePath)) continue;
      const lines = this.breakpoints.get(breakpoint.relativePath) ?? [];
      lines.push(breakpoint.line);
      this.breakpoints.set(breakpoint.relativePath, lines);
    }
    const port = await allocatePort();
    let stderrTail = "";
    const sessionId = await this.manager.start(
      {
        command: "node",
        args: [`--inspect-brk=127.0.0.1:${port}`, absoluteScript],
        cwd: root,
      },
      {
        onData: (event) => {
          this.hooks?.onOutput(event.stream, event.text);
          if (event.stream === "stderr") {
            // Once the program finishes, Node holds the process open
            // until the inspector disconnects ("Waiting for the
            // debugger to disconnect..."). Closing the socket lets
            // it exit, which the session exit hook then reports as
            // the terminated state.
            stderrTail = (stderrTail + event.text).slice(-256);
            if (
              stderrTail.includes("Waiting for the debugger to disconnect")
            ) {
              this.cdp?.close();
            }
          }
        },
        onExit: () => {
          this.sessionId = null;
          this.emitTerminated();
        },
      },
    );
    this.sessionId = sessionId;
    try {
      const wsUrl = await fetchInspectorWsUrl(port);
      const cdp = new CdpClient(wsUrl);
      this.cdp = cdp;
      this.scriptUrls.clear();
      cdp.on("Debugger.scriptParsed", (params) => {
        const parsed = params as { scriptId?: unknown; url?: unknown };
        if (
          typeof parsed.scriptId === "string" &&
          typeof parsed.url === "string"
        ) {
          this.scriptUrls.set(parsed.scriptId, parsed.url);
        }
      });
      cdp.on("Debugger.paused", (params) => {
        this.handlePaused(params as { reason?: string; callFrames?: unknown });
      });
      cdp.on("Debugger.resumed", () => {
        this.pausedFrames = [];
        this.hooks?.onState({ status: "running" });
      });
      await cdp.open();
      await cdp.send("Debugger.enable");
      await cdp.send("Runtime.enable");
      for (const [relativePath, lines] of this.breakpoints) {
        await this.applyBreakpoints(relativePath, lines);
      }
      // With --inspect-brk the target reports a "Break on start"
      // pause in response to runIfWaitingForDebugger; handlePaused
      // resumes past it automatically (see expectingEntryPause).
      this.expectingEntryPause = true;
      await cdp.send("Runtime.runIfWaitingForDebugger");
      this.started = true;
      this.hooks?.onState({ status: "running" });
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  private handlePaused(params: {
    reason?: string;
    callFrames?: unknown;
  }): void {
    // The "Break on start" pause is the --inspect-brk entry stop,
    // not a user-visible one: resume past it immediately. This is
    // checked before the started flag so an early-arriving entry
    // pause can never leave the target stopped forever.
    if (this.expectingEntryPause && params.reason === "Break on start") {
      this.expectingEntryPause = false;
      void this.cdp?.send("Debugger.resume").catch(() => {});
      return;
    }
    if (!this.started || this.root === null) return;
    const frames = Array.isArray(params.callFrames)
      ? (params.callFrames as RawCallFrame[])
      : [];
    this.pausedFrames = frames;
    this.objectRefs.clear();
    this.nextRef = 1;
    this.hooks?.onState({
      status: "paused",
      reason: typeof params.reason === "string" ? params.reason : "",
      frames: frames.map((frame, index) => {
        const scriptId =
          typeof frame.location?.scriptId === "string"
            ? frame.location.scriptId
            : "";
        const url =
          this.scriptUrls.get(scriptId) ??
          (typeof frame.url === "string" ? frame.url : "");
        return mapCallFrame(this.root as string, frame, index, url);
      }),
    });
  }

  private async applyBreakpoints(
    relativePath: string,
    lines: number[],
  ): Promise<void> {
    if (!this.cdp || this.root === null) return;
    let absolute = assertWorkspacePath(this.root, relativePath);
    try {
      absolute = await fs.realpath(absolute);
    } catch {
      // Not on disk (yet); the lexical URL is the best available.
    }
    const url = pathToFileURL(absolute).href;
    for (const id of this.breakpointIds.get(url) ?? []) {
      await this.cdp
        .send("Debugger.removeBreakpoint", { breakpointId: id })
        .catch(() => {});
    }
    const ids: string[] = [];
    for (const line of lines) {
      try {
        const result = await this.cdp.send<{ breakpointId?: unknown }>(
          "Debugger.setBreakpointByUrl",
          { lineNumber: line - 1, url },
        );
        if (typeof result?.breakpointId === "string") {
          ids.push(result.breakpointId);
        }
      } catch {
        // A line the server rejects (e.g. past the end of file) is
        // skipped; the rest of the set still applies.
      }
    }
    this.breakpointIds.set(url, ids);
  }

  /** Replaces the breakpoint set for one file, live or for next start. */
  async setBreakpoints(
    relativePath: string,
    lines: number[],
  ): Promise<void> {
    this.breakpoints.set(relativePath, [...lines]);
    if (this.cdp) await this.applyBreakpoints(relativePath, lines);
  }

  async resume(): Promise<void> {
    await this.cdp?.send("Debugger.resume");
  }

  async stepOver(): Promise<void> {
    await this.cdp?.send("Debugger.stepOver");
  }

  async stepInto(): Promise<void> {
    await this.cdp?.send("Debugger.stepInto");
  }

  async stepOut(): Promise<void> {
    await this.cdp?.send("Debugger.stepOut");
  }

  async pause(): Promise<void> {
    await this.cdp?.send("Debugger.pause");
  }

  /** Variables of the paused frame's scopes (global scope excluded). */
  async frameVariables(frameIndex: number): Promise<DebugVariable[]> {
    if (!this.cdp) return [];
    const frame = this.pausedFrames[frameIndex];
    if (!frame) return [];
    const scopes = Array.isArray(frame.scopeChain)
      ? (frame.scopeChain as {
          type?: unknown;
          object?: { objectId?: unknown };
        }[])
      : [];
    const variables: DebugVariable[] = [];
    for (const scope of scopes) {
      if (scope.type === "global") continue;
      const objectId = scope.object?.objectId;
      if (typeof objectId !== "string") continue;
      variables.push(...(await this.readProperties(objectId)));
      if (variables.length >= MAX_VARIABLES) break;
    }
    return variables.slice(0, MAX_VARIABLES);
  }

  /** Expands one object-valued variable reference. */
  async variables(variablesReference: number): Promise<DebugVariable[]> {
    const objectId = this.objectRefs.get(variablesReference);
    if (!objectId || !this.cdp) return [];
    return this.readProperties(objectId);
  }

  private async readProperties(objectId: string): Promise<DebugVariable[]> {
    if (!this.cdp) return [];
    const result = await this.cdp.send<{ result?: unknown }>(
      "Runtime.getProperties",
      { objectId, ownProperties: true },
    );
    return mapRemoteProperties(result?.result)
      .slice(0, MAX_VARIABLES)
      .map((variable) => ({
        name: variable.name,
        value: variable.value,
        type: variable.type,
        variablesReference: variable.objectId
          ? this.registerRef(variable.objectId)
          : 0,
      }));
  }

  private registerRef(objectId: string): number {
    const ref = this.nextRef++;
    this.objectRefs.set(ref, objectId);
    return ref;
  }

  private emitTerminated(): void {
    if (this.terminatedEmitted) return;
    this.terminatedEmitted = true;
    this.pausedFrames = [];
    this.hooks?.onState({ status: "terminated" });
  }

  async stop(): Promise<void> {
    const cdp = this.cdp;
    this.cdp = null;
    cdp?.close();
    if (this.sessionId !== null) {
      const id = this.sessionId;
      this.sessionId = null;
      this.manager.kill(id);
    }
    this.breakpointIds.clear();
    this.objectRefs.clear();
    this.emitTerminated();
  }

  /** Silent teardown for app quit: no events are emitted. */
  async dispose(): Promise<void> {
    this.hooks = null;
    this.terminatedEmitted = true;
    await this.stop();
  }
}

/** Shared instance: IPC registers handlers on it, main stops on quit. */
export const debugService = new DebugService(new SessionManager());
