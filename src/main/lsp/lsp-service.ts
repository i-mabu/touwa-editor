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

/** A text range with 1-based line/column, as the renderer uses. */
export type LspTextRange = {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
};

export type LspCompletionItem = {
  label: string;
  /** LSP CompletionItemKind (1–25), or null when the server omitted it. */
  kind: number | null;
  detail: string;
  documentation: string;
  insertText: string;
  range: LspTextRange | null;
};

export type LspHoverResult = {
  contents: string;
  range: LspTextRange | null;
};

export type LspSignatureHelpResult = {
  signatures: {
    label: string;
    documentation: string;
    parameters: { label: string; documentation: string }[];
  }[];
  activeSignature: number;
  activeParameter: number;
};

type RawPosition = { line?: number; character?: number };
type RawRange = { start?: RawPosition; end?: RawPosition };

function mapRange(range: RawRange | undefined): LspTextRange | null {
  if (!range?.start || !range?.end) return null;
  return {
    startLine: (range.start.line ?? 0) + 1,
    startColumn: (range.start.character ?? 0) + 1,
    endLine: (range.end.line ?? 0) + 1,
    endColumn: (range.end.character ?? 0) + 1,
  };
}

/**
 * Flattens the LSP documentation shapes (plain string, MarkupContent,
 * MarkedString, or an array of them) into a single markdown string.
 */
export function markupToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => markupToText(entry))
      .filter((text) => text.length > 0)
      .join("\n\n");
  }
  if (value !== null && typeof value === "object") {
    const record = value as { value?: unknown; language?: unknown };
    if (typeof record.value === "string") {
      if (typeof record.language === "string" && record.language) {
        return `\`\`\`${record.language}\n${record.value}\n\`\`\``;
      }
      return record.value;
    }
  }
  return "";
}

const MAX_COMPLETION_ITEMS = 200;

export function mapCompletionResult(result: unknown): LspCompletionItem[] {
  const rawItems: unknown[] = Array.isArray(result)
    ? result
    : result !== null &&
        typeof result === "object" &&
        Array.isArray((result as { items?: unknown }).items)
      ? ((result as { items: unknown[] }).items as unknown[])
      : [];
  const items: LspCompletionItem[] = [];
  for (const raw of rawItems) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as {
      label?: unknown;
      kind?: unknown;
      detail?: unknown;
      documentation?: unknown;
      insertText?: unknown;
      textEdit?: { range?: RawRange; newText?: unknown };
    };
    const label =
      typeof item.label === "string"
        ? item.label
        : item.label !== null &&
            typeof item.label === "object" &&
            typeof (item.label as { label?: unknown }).label === "string"
          ? ((item.label as { label: string }).label as string)
          : null;
    if (label === null || label === "") continue;
    const editText =
      typeof item.textEdit?.newText === "string"
        ? item.textEdit.newText
        : null;
    items.push({
      label,
      kind: typeof item.kind === "number" ? item.kind : null,
      detail: typeof item.detail === "string" ? item.detail : "",
      documentation: markupToText(item.documentation),
      insertText:
        editText ??
        (typeof item.insertText === "string" ? item.insertText : label),
      range: mapRange(item.textEdit?.range),
    });
    if (items.length >= MAX_COMPLETION_ITEMS) break;
  }
  return items;
}

export function mapHoverResult(result: unknown): LspHoverResult | null {
  if (result === null || typeof result !== "object") return null;
  const hover = result as { contents?: unknown; range?: RawRange };
  const contents = markupToText(hover.contents);
  if (contents === "") return null;
  return { contents, range: mapRange(hover.range) };
}

export function mapSignatureHelpResult(
  result: unknown,
): LspSignatureHelpResult | null {
  if (result === null || typeof result !== "object") return null;
  const help = result as {
    signatures?: unknown;
    activeSignature?: unknown;
    activeParameter?: unknown;
  };
  if (!Array.isArray(help.signatures)) return null;
  const signatures: LspSignatureHelpResult["signatures"] = [];
  for (const raw of help.signatures) {
    if (raw === null || typeof raw !== "object") continue;
    const signature = raw as {
      label?: unknown;
      documentation?: unknown;
      parameters?: unknown;
    };
    if (typeof signature.label !== "string") continue;
    const parameters: { label: string; documentation: string }[] = [];
    if (Array.isArray(signature.parameters)) {
      for (const rawParam of signature.parameters) {
        if (rawParam === null || typeof rawParam !== "object") continue;
        const param = rawParam as { label?: unknown; documentation?: unknown };
        const label =
          typeof param.label === "string"
            ? param.label
            : Array.isArray(param.label) &&
                typeof param.label[0] === "number" &&
                typeof param.label[1] === "number"
              ? signature.label.slice(param.label[0], param.label[1])
              : "";
        parameters.push({
          label,
          documentation: markupToText(param.documentation),
        });
      }
    }
    signatures.push({
      label: signature.label,
      documentation: markupToText(signature.documentation),
      parameters,
    });
  }
  if (signatures.length === 0) return null;
  return {
    signatures,
    activeSignature:
      typeof help.activeSignature === "number" ? help.activeSignature : 0,
    activeParameter:
      typeof help.activeParameter === "number" ? help.activeParameter : 0,
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

  /**
   * Sends a position-based request for an already-synced document.
   * Returns null for unsupported files and documents the renderer has
   * not opened (the renderer flushes a change before requesting, so
   * an unopened document simply has nothing to answer with yet).
   * Positions are 1-based, as the renderer uses them.
   */
  private async requestForDocument(
    root: string,
    relativePath: string,
    method: string,
    line: number,
    column: number,
  ): Promise<unknown> {
    if (languageIdForPath(relativePath) === null) return null;
    const absolute = assertWorkspacePath(root, relativePath);
    const uri = pathToUri(absolute);
    if (!this.documents.has(uri)) return null;
    const client = await this.ensureClient(root);
    return client.request(method, {
      textDocument: { uri },
      position: { line: line - 1, character: column - 1 },
    });
  }

  async completion(
    root: string,
    relativePath: string,
    line: number,
    column: number,
  ): Promise<LspCompletionItem[]> {
    const result = await this.requestForDocument(
      root,
      relativePath,
      "textDocument/completion",
      line,
      column,
    );
    return mapCompletionResult(result);
  }

  async hover(
    root: string,
    relativePath: string,
    line: number,
    column: number,
  ): Promise<LspHoverResult | null> {
    const result = await this.requestForDocument(
      root,
      relativePath,
      "textDocument/hover",
      line,
      column,
    );
    return mapHoverResult(result);
  }

  async signatureHelp(
    root: string,
    relativePath: string,
    line: number,
    column: number,
  ): Promise<LspSignatureHelpResult | null> {
    const result = await this.requestForDocument(
      root,
      relativePath,
      "textDocument/signatureHelp",
      line,
      column,
    );
    return mapSignatureHelpResult(result);
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
