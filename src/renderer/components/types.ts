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
