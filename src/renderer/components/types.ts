export type FileEntry = {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size?: number;
  mtimeMs?: number;
};

export type FileSnapshot = {
  content: string;
  mtimeMs: number;
  size: number;
  hash: string;
};

export type SearchMatch = {
  relativePath: string;
  line: number;
  column: number;
  lineText: string;
};

export type GitStatusEntry = {
  relativePath: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: "tracked" | "renamed" | "unmerged" | "untracked" | "ignored";
};

export type GitStatus = {
  isRepository: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  truncated: boolean;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorTime: number;
};

export type Diagnostic = {
  relativePath: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code: string;
  message: string;
  source: string;
};

export type DiagnosticsResult = {
  available: boolean;
  reason: string | null;
  diagnostics: Diagnostic[];
  truncated: boolean;
};

export type TaskDef = {
  label: string;
  command: string;
  args: string[];
  cwd: string;
};

export type TasksListResult = {
  tasks: TaskDef[];
  error: string | null;
};

export type TaskRunResult = {
  label: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
};

export type TerminalDataEvent = {
  id: string;
  stream: "stdout" | "stderr";
  text: string;
};

export type TerminalExitEvent = {
  id: string;
  exitCode: number | null;
  signal: string | null;
};

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
  variablesReference: number;
};

export type DebugStateEvent = {
  status: "running" | "paused" | "terminated";
  reason?: string;
  frames?: DebugFrame[];
};

export type DebugOutputEvent = {
  stream: "stdout" | "stderr";
  text: string;
};

/** Extensions the Node.js debugger can launch. */
export function isDebuggablePath(relativePath: string): boolean {
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
  return ext === "js" || ext === "mjs" || ext === "cjs";
}

const LSP_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
]);

/** Extensions the bundled TypeScript language server can check. */
export function isLspLanguagePath(relativePath: string): boolean {
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
  return LSP_EXTENSIONS.has(ext);
}

/**
 * LSP CompletionItemKind (1–25) → Monaco CompletionItemKind (numeric).
 * Monaco's enum values differ from LSP's, so kinds are translated
 * before suggestions are handed to the editor.
 */
const MONACO_COMPLETION_KINDS: Record<number, number> = {
  1: 18, // Text
  2: 0, // Method
  3: 1, // Function
  4: 2, // Constructor
  5: 3, // Field
  6: 4, // Variable
  7: 5, // Class
  8: 7, // Interface
  9: 8, // Module
  10: 9, // Property
  11: 12, // Unit
  12: 13, // Value
  13: 15, // Enum
  14: 17, // Keyword
  15: 27, // Snippet
  16: 19, // Color
  17: 20, // File
  18: 21, // Reference
  19: 23, // Folder
  20: 16, // EnumMember
  21: 14, // Constant
  22: 6, // Struct
  23: 10, // Event
  24: 11, // Operator
  25: 24, // TypeParameter
};

export function monacoCompletionKind(lspKind: number | null): number {
  if (lspKind === null) return 18; // Text
  return MONACO_COMPLETION_KINDS[lspKind] ?? 18;
}

export function languageForPath(relativePath: string): string {
  const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "javascript";
    case "json":
      return "json";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "md":
    case "markdown":
      return "markdown";
    case "py":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "yml":
    case "yaml":
      return "yaml";
    case "xml":
      return "xml";
    case "sh":
      return "shell";
    case "sql":
      return "sql";
    default:
      return "plaintext";
  }
}
