import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager } from "../process/session-manager.ts";
import { LspClient } from "./lsp-client.ts";
import { assertWorkspacePath } from "../workspace/path-security.ts";
import type { Diagnostic } from "../diagnostics/diagnostics-service.ts";

// ===== Language server service (Phase 3) =====
// Owns one TypeScript language server (typescript-language-server,
// bundled with the app) per workspace. The server prefers the
// workspace's own TypeScript and falls back to the app's bundled
// one. Documents are synced in full on open and on change (debounced
// by the renderer); diagnostics published by the server are mapped
// into the same Diagnostic shape the tsc checker produces, with
// source "lsp", and fanned out to listeners (the IPC layer forwards
// them to windows).
//
// Only TypeScript / JavaScript files are synced. The server process
// is started lazily on the first document and stopped on dispose.

const LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

export function languageIdForPath(relativePath: string): string | null {
  return LANGUAGE_IDS[path.extname(relativePath).toLowerCase()] ?? null;
}

export function pathToUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

export function uriToRelativePath(root: string, uri: string): string | null {
  let absolute: string;
  try {
    absolute = fileURLToPath(uri);
  } catch {
    return null;
  }
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

type LspDiagnostic = {
  range?: {
    start?: { line?: number; character?: number };
  };
  severity?: number;
  code?: string | number;
  message?: string;
  source?: string;
};

export function mapLspDiagnostic(diagnostic: LspDiagnostic): Diagnostic {
  return {
    relativePath: "",
    line: (diagnostic.range?.start?.line ?? 0) + 1,
    column: (diagnostic.range?.start?.character ?? 0) + 1,
    severity: diagnostic.severity === 1 ? "error" : "warning",
    code: diagnostic.code !== undefined ? String(diagnostic.code) : "",
    message: diagnostic.message ?? "",
    source: "lsp",
  };
}

export function mapPublishDiagnostics(
  root: string,
  params: { uri?: string; diagnostics?: LspDiagnostic[] },
): { relativePath: string; diagnostics: Diagnostic[] } | null {
  if (typeof params?.uri !== "string" || !Array.isArray(params.diagnostics)) {
    return null;
  }
  const relativePath = uriToRelativePath(root, params.uri);
  if (relativePath === null) return null;
  return {
    relativePath,
    diagnostics: params.diagnostics.map((diagnostic) => ({
      ...mapLspDiagnostic(diagnostic),
      relativePath,
    })),
  };
}

const MAX_DOCUMENT_CHARS = 2_000_000;

export function serverEntryPath(): string {
  // This module's depth differs between layouts (src/main/lsp in
  // tests, bundled into out/main in the app), so walk up from the
  // module directory until the bundled server is found.
  const relative = path.join(
    "node_modules",
    "typescript-language-server",
    "lib",
    "cli.mjs",
  );
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(dir, relative);
}

export type DiagnosticsListener = (
  relativePath: string,
  diagnostics: Diagnostic[],
) => void;

export class LspService {
  private readonly manager: SessionManager;
  private client: LspClient | null = null;
  private startPromise: Promise<LspClient> | null = null;
  private root: string | null = null;
  private readonly documents = new Map<
    string,
    { relativePath: string; version: number }
  >();
  private readonly listeners = new Set<DiagnosticsListener>();

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  onDiagnostics(listener: DiagnosticsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async ensureClient(root: string): Promise<LspClient> {
    if (this.client && this.root === root && this.client.running) {
      return this.client;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const client = new LspClient(this.manager);
      client.onNotification(
        "textDocument/publishDiagnostics",
        (params: { uri?: string; diagnostics?: LspDiagnostic[] }) => {
          if (this.root === null) return;
          const mapped = mapPublishDiagnostics(this.root, params);
          if (!mapped) return;
          for (const listener of [...this.listeners]) {
            listener(mapped.relativePath, mapped.diagnostics);
          }
        },
      );
      await client.start({
        command: "node",
        args: [serverEntryPath(), "--stdio"],
        cwd: root,
      });
      await client.initialize(pathToUri(root));
      this.client = client;
      this.root = root;
      this.startPromise = null;
      return client;
    })();
    try {
      return await this.startPromise;
    } catch (e) {
      this.startPromise = null;
      throw e;
    }
  }

  private resolveDocument(
    root: string,
    relativePath: string,
    text: string,
  ): { uri: string; languageId: string } {
    const languageId = languageIdForPath(relativePath);
    if (languageId === null) {
      throw new Error("Not a TypeScript/JavaScript file.");
    }
    if (typeof text !== "string" || text.length > MAX_DOCUMENT_CHARS) {
      throw new Error("Document is too large for the language server.");
    }
    const absolute = assertWorkspacePath(root, relativePath);
    return { uri: pathToUri(absolute), languageId };
  }

  async openDocument(
    root: string,
    relativePath: string,
    text: string,
  ): Promise<void> {
    const { uri, languageId } = this.resolveDocument(root, relativePath, text);
    const client = await this.ensureClient(root);
    if (this.documents.has(uri)) {
      await this.changeDocument(root, relativePath, text);
      return;
    }
    this.documents.set(uri, { relativePath, version: 1 });
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  async changeDocument(
    root: string,
    relativePath: string,
    text: string,
  ): Promise<void> {
    const { uri } = this.resolveDocument(root, relativePath, text);
    const client = await this.ensureClient(root);
    const doc = this.documents.get(uri);
    if (!doc) {
      await this.openDocument(root, relativePath, text);
      return;
    }
    doc.version += 1;
    client.notify("textDocument/didChange", {
      textDocument: { uri, version: doc.version },
      contentChanges: [{ text }],
    });
  }

  async closeDocument(root: string, relativePath: string): Promise<void> {
    if (languageIdForPath(relativePath) === null) return;
    const absolute = assertWorkspacePath(root, relativePath);
    const uri = pathToUri(absolute);
    if (!this.documents.has(uri) || !this.client) return;
    this.documents.delete(uri);
    this.client.notify("textDocument/didClose", { textDocument: { uri } });
    // The server clears diagnostics for closed files on its own; if
    // it does not, a stale entry would linger, so clear explicitly.
    for (const listener of [...this.listeners]) {
      listener(relativePath, []);
    }
  }

  async dispose(): Promise<void> {
    this.documents.clear();
    if (this.client) {
      await this.client.stop();
      this.client = null;
      this.root = null;
    }
  }
}

/** Shared instance: IPC registers handlers on it, main disposes on quit. */
export const lspService = new LspService(new SessionManager());
