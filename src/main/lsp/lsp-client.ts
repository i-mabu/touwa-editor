import { SessionManager } from "../process/session-manager.ts";

// ==========================================
// 📌 LSP client core (Phase 3)
// ==========================================
// 🖥️ Minimal Language Server Protocol client over stdio, built on the
// shared session manager. Framing is the LSP base protocol:
// "Content-Length: <bytes>\r\n\r\n<JSON>". The parser works on raw
// Buffers because a message (or a multi-byte character) may be split
// across arbitrary chunk boundaries.
//
// The client is transport- and server-agnostic: requests with
// timeouts, notifications both ways, and a default responder for
// server-to-client requests (null results, except
// workspace/configuration which answers one null per requested item).

export function encodeLspMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  return Buffer.concat([header, body]);
}

const MAX_BUFFER_BYTES = 32_000_000;

export class LspMessageParser {
  private buffer = Buffer.alloc(0);

  /** Feed a chunk; returns every complete message it contained. */
  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      throw new Error("LSP message buffer overflow.");
    }
    const messages: unknown[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error("LSP message without Content-Length.");
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) break;
      const body = this.buffer
        .subarray(bodyStart, bodyStart + length)
        .toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      messages.push(JSON.parse(body));
    }
    return messages;
  }
}

type PendingRequest = {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type NotificationHandler = (params: never) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LspClient {
  private readonly manager: SessionManager;
  private readonly parser = new LspMessageParser();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly handlers = new Map<string, Set<NotificationHandler>>();
  private nextId = 1;
  private sessionId: string | null = null;
  private stopped = false;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  async start(options: {
    command: string;
    args: string[];
    cwd: string;
  }): Promise<void> {
    this.sessionId = await this.manager.start(options, {
      // 📝 Text events are unused; the protocol runs on raw bytes.
      onData: () => undefined,
      onBinaryData: (chunk) => this.handleChunk(chunk),
      onExit: () => {
        this.failAllPending(new Error("Language server exited."));
      },
    });
  }

  get running(): boolean {
    return this.sessionId !== null && !this.stopped;
  }

  private handleChunk(chunk: Buffer): void {
    let messages: unknown[];
    try {
      messages = this.parser.push(chunk);
    } catch {
      // ⚠️ A framing error desynchronizes the stream beyond repair;
      // stop the client rather than guessing at boundaries.
      void this.stop();
      return;
    }
    for (const message of messages) this.handleMessage(message);
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    const { id, method, params, result, error } = message;
    if (typeof method === "string" && id !== undefined) {
      this.answerServerRequest(id, method, params);
      return;
    }
    if (typeof method === "string") {
      const handlers = this.handlers.get(method);
      if (handlers) {
        for (const handler of [...handlers]) {
          handler(params as never);
        }
      }
      return;
    }
    if (id !== undefined) {
      const pending = this.pending.get(id as number);
      if (!pending) return;
      this.pending.delete(id as number);
      clearTimeout(pending.timer);
      if (isRecord(error)) {
        pending.reject(
          new Error(
            typeof error.message === "string"
              ? error.message
              : "Language server request failed.",
          ),
        );
      } else {
        pending.resolve(result as never);
      }
    }
  }

  private answerServerRequest(
    id: unknown,
    method: string,
    params: unknown,
  ): void {
    // ⚙️ workspace/configuration expects one result per requested item;
    // everything else gets a null result, which servers tolerate for
    // the requests they send a fresh client (registerCapability,
    // workDoneProgress/create, applyEdit is answered as not applied
    // by the service layer if it ever matters).
    const result =
      method === "workspace/configuration" && Array.isArray(params)
        ? params.map(() => null)
        : null;
    this.send({ jsonrpc: "2.0", id, result });
  }

  private send(message: unknown): void {
    if (this.sessionId === null) {
      throw new Error("Language server is not running.");
    }
    this.manager.write(
      this.sessionId,
      encodeLspMessage(message).toString("utf8"),
    );
  }

  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.running) {
      return Promise.reject(new Error("Language server is not running."));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        timer,
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params: params ?? null });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error("Failed to send request."));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.running) return;
    this.send({ jsonrpc: "2.0", method, params: params ?? null });
  }

  onNotification(method: string, handler: (params: never) => void): () => void {
    const set = this.handlers.get(method) ?? new Set<NotificationHandler>();
    set.add(handler as NotificationHandler);
    this.handlers.set(method, set);
    return () => {
      set.delete(handler as NotificationHandler);
    };
  }

  /** The initialize handshake; resolves with the server's result. */
  async initialize(rootUri: string): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true },
          synchronization: { didSave: false },
          completion: {
            completionItem: {
              snippetSupport: false,
              documentationFormat: ["markdown", "plaintext"],
            },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ["markdown", "plaintext"],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
        },
        workspace: { configuration: true },
      },
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
    });
    this.notify("initialized", {});
    return result;
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    if (this.sessionId === null || this.stopped) return;
    this.stopped = true;
    try {
      await this.request("shutdown", null, 3_000);
    } catch {
      // 🖥️ The server may already be gone; stopping continues regardless.
    }
    try {
      this.notify("exit");
    } catch {
      // 🔗 Ignored: the session is being torn down anyway.
    }
    this.manager.kill(this.sessionId);
    this.sessionId = null;
    this.failAllPending(new Error("Language server stopped."));
  }
}
