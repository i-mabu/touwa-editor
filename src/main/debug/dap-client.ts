import { SessionManager } from "../process/session-manager.ts";
import {
  LspMessageParser,
  encodeLspMessage,
} from "../lsp/lsp-client.ts";

// ===== Debug Adapter Protocol client (Phase 3) =====
// DAP uses the same Content-Length framing as LSP, so the framing
// helpers are shared with the language-server client. This class
// adds the DAP request/response/event bookkeeping on top: outgoing
// requests carry a sequence number, responses resolve by
// request_seq, events fan out to handlers, and reverse requests
// from the adapter are answered as unsupported (this client does
// not implement runInTerminal).

export type DapHooks = {
  /** Adapter stderr, surfaced as session output. */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  onExit: () => void;
};

type DapMessage = {
  seq?: number;
  type?: string;
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
};

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export class DapClient {
  private readonly manager: SessionManager;
  private sessionId: string | null = null;
  private readonly parser = new LspMessageParser();
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: never) => void; reject: (error: Error) => void }
  >();
  private readonly handlers = new Map<
    string,
    Set<(body: never) => void>
  >();

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  get running(): boolean {
    return this.sessionId !== null;
  }

  async start(
    options: { command: string; args: string[]; cwd: string },
    hooks: DapHooks,
  ): Promise<void> {
    this.sessionId = await this.manager.start(options, {
      onData: (event) => {
        // stdout carries the protocol itself; only stderr is
        // human-readable adapter output.
        if (event.stream === "stderr") {
          hooks.onOutput?.("stderr", event.text);
        }
      },
      onBinaryData: (chunk) => {
        if (chunk.length > MAX_MESSAGE_BYTES) return;
        for (const message of this.parser.push(chunk)) {
          this.handleMessage(message as DapMessage);
        }
      },
      onExit: () => {
        this.sessionId = null;
        this.failAll(new Error("The debug adapter exited."));
        hooks.onExit();
      },
    });
  }

  request<T>(command: string, args?: unknown): Promise<T> {
    const seq = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Debug adapter request timed out: ${command}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(seq, {
        resolve: (value: never) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.sendRaw({
        seq,
        type: "request",
        command,
        arguments: args ?? {},
      });
    });
  }

  on(event: string, handler: (body: never) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (body: never) => void);
    this.handlers.set(event, set);
  }

  private sendRaw(message: Record<string, unknown>): void {
    if (this.sessionId === null) return;
    try {
      this.manager.write(
        this.sessionId,
        encodeLspMessage(message).toString("utf8"),
      );
    } catch {
      // The session is going away; pending requests fail on exit.
    }
  }

  private handleMessage(message: DapMessage): void {
    if (message.type === "response" && typeof message.request_seq === "number") {
      const pending = this.pending.get(message.request_seq);
      if (!pending) return;
      this.pending.delete(message.request_seq);
      if (message.success) {
        pending.resolve(message.body as never);
      } else {
        pending.reject(
          new Error(message.message ?? "Debug adapter request failed."),
        );
      }
      return;
    }
    if (message.type === "event" && typeof message.event === "string") {
      const set = this.handlers.get(message.event);
      if (set) {
        for (const handler of [...set]) {
          handler(message.body as never);
        }
      }
      return;
    }
    if (message.type === "request" && typeof message.seq === "number") {
      // Reverse requests (runInTerminal etc.) are not supported.
      this.sendRaw({
        seq: ++this.seq,
        type: "response",
        request_seq: message.seq,
        command: message.command ?? "",
        success: false,
        message: "Unsupported client request.",
      });
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    if (this.sessionId !== null) {
      const id = this.sessionId;
      this.sessionId = null;
      this.manager.kill(id);
    }
  }
}
