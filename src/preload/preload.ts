import { contextBridge, ipcRenderer } from "electron";

type FileEntry = {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size?: number;
  mtimeMs?: number;
};
type FileSnapshot = {
  content: string;
  mtimeMs: number;
  size: number;
  hash: string;
};
type FileStat = { mtimeMs: number; size: number; hash: string };
type SearchOptions = {
  caseSensitive?: boolean;
  regex?: boolean;
  maxMatches?: number;
};
type SearchMatch = {
  relativePath: string;
  line: number;
  column: number;
  lineText: string;
};
type SearchResult = {
  matches: SearchMatch[];
  truncated: boolean;
  filesSearched: number;
};
type ReplaceResult = {
  filesChanged: number;
  totalReplacements: number;
  perFile: { relativePath: string; replacements: number }[];
  skipped: string[];
};
type WorkspaceChange = { relativePath: string; kind: "change" | "rename" };
type GitStatusEntry = {
  relativePath: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: "tracked" | "renamed" | "unmerged" | "untracked" | "ignored";
};
type GitStatus = {
  isRepository: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  truncated: boolean;
};
type GitCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorTime: number;
};

type Diagnostic = {
  relativePath: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  code: string;
  message: string;
  source: string;
};

type DiagnosticsResult = {
  available: boolean;
  reason: string | null;
  diagnostics: Diagnostic[];
  truncated: boolean;
};

type TaskDef = {
  label: string;
  command: string;
  args: string[];
  cwd: string;
};

type TasksListResult = {
  tasks: TaskDef[];
  error: string | null;
};

type TaskRunResult = {
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

type TerminalDataEvent = {
  id: string;
  stream: "stdout" | "stderr";
  text: string;
};

type TerminalExitEvent = {
  id: string;
  exitCode: number | null;
  signal: string | null;
};

type LspDiagnosticsEvent = {
  relativePath: string;
  diagnostics: Diagnostic[];
};

const api = {
  workspace: {
    open: (): Promise<{ root: string; entries: FileEntry[] } | null> =>
      ipcRenderer.invoke("workspace:open"),
    list: (): Promise<FileEntry[]> => ipcRenderer.invoke("workspace:list"),
    listDir: (relativeDir: string): Promise<FileEntry[]> =>
      ipcRenderer.invoke("workspace:listDir", relativeDir),
    search: (query: string, options?: SearchOptions): Promise<SearchResult> =>
      ipcRenderer.invoke("workspace:search", query, options ?? {}),
    replace: (
      query: string,
      replacement: string,
      options?: SearchOptions,
    ): Promise<ReplaceResult> =>
      ipcRenderer.invoke(
        "workspace:replace",
        query,
        replacement,
        options ?? {},
      ),
    files: (): Promise<string[]> => ipcRenderer.invoke("workspace:files"),
    create: (
      relativePath: string,
      kind: "file" | "directory",
    ): Promise<FileEntry> =>
      ipcRenderer.invoke("workspace:create", relativePath, kind),
    rename: (
      oldRelativePath: string,
      newRelativePath: string,
    ): Promise<FileEntry> =>
      ipcRenderer.invoke("workspace:rename", oldRelativePath, newRelativePath),
    delete: (relativePath: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke("workspace:delete", relativePath),
    onChanged: (listener: (change: WorkspaceChange) => void): (() => void) => {
      const handler = (_event: unknown, change: WorkspaceChange): void =>
        listener(change);
      ipcRenderer.on("workspace:changed", handler as never);
      return () => {
        ipcRenderer.removeListener("workspace:changed", handler as never);
      };
    },
  },
  git: {
    status: (): Promise<GitStatus> => ipcRenderer.invoke("git:status"),
    log: (limit?: number): Promise<GitCommit[]> =>
      ipcRenderer.invoke("git:log", limit ?? null),
    stage: (paths: string[]): Promise<GitStatus> =>
      ipcRenderer.invoke("git:stage", paths),
    unstage: (paths: string[]): Promise<GitStatus> =>
      ipcRenderer.invoke("git:unstage", paths),
    discard: (paths: string[]): Promise<GitStatus> =>
      ipcRenderer.invoke("git:discard", paths),
    commit: (message: string): Promise<GitStatus> =>
      ipcRenderer.invoke("git:commit", message),
    fetch: (): Promise<GitStatus> => ipcRenderer.invoke("git:fetch"),
    pull: (): Promise<GitStatus> => ipcRenderer.invoke("git:pull"),
    push: (): Promise<GitStatus> => ipcRenderer.invoke("git:push"),
  },
  diagnostics: {
    run: (): Promise<DiagnosticsResult> =>
      ipcRenderer.invoke("diagnostics:run"),
  },
  tasks: {
    list: (): Promise<TasksListResult> => ipcRenderer.invoke("tasks:list"),
    run: (label: string): Promise<TaskRunResult> =>
      ipcRenderer.invoke("tasks:run", label),
  },
  terminal: {
    start: (): Promise<{ id: string; shell: string }> =>
      ipcRenderer.invoke("terminal:start"),
    write: (id: string, data: string): Promise<boolean> =>
      ipcRenderer.invoke("terminal:write", id, data),
    kill: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("terminal:kill", id),
    onData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: TerminalDataEvent,
      ): void => callback(payload);
      ipcRenderer.on("terminal:data", listener);
      return () => {
        ipcRenderer.removeListener("terminal:data", listener);
      };
    },
    onExit: (callback: (event: TerminalExitEvent) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: TerminalExitEvent,
      ): void => callback(payload);
      ipcRenderer.on("terminal:exit", listener);
      return () => {
        ipcRenderer.removeListener("terminal:exit", listener);
      };
    },
  },
  lsp: {
    open: (relativePath: string, text: string): Promise<void> =>
      ipcRenderer.invoke("lsp:open", relativePath, text),
    change: (relativePath: string, text: string): Promise<void> =>
      ipcRenderer.invoke("lsp:change", relativePath, text),
    close: (relativePath: string): Promise<void> =>
      ipcRenderer.invoke("lsp:close", relativePath),
    onDiagnostics: (
      callback: (event: LspDiagnosticsEvent) => void,
    ): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: LspDiagnosticsEvent,
      ): void => callback(payload);
      ipcRenderer.on("lsp:diagnostics", listener);
      return () => {
        ipcRenderer.removeListener("lsp:diagnostics", listener);
      };
    },
  },
  file: {
    read: (relativePath: string): Promise<FileSnapshot> =>
      ipcRenderer.invoke("file:read", relativePath),
    stat: (relativePath: string): Promise<FileStat> =>
      ipcRenderer.invoke("file:stat", relativePath),
    write: (
      relativePath: string,
      content: string,
      expectedMtimeMs?: number,
    ): Promise<FileSnapshot> =>
      ipcRenderer.invoke(
        "file:write",
        relativePath,
        content,
        expectedMtimeMs ?? null,
      ),
  },
};
contextBridge.exposeInMainWorld("touwa", api);
export type TouwaApi = typeof api;
export type {
  FileEntry,
  FileSnapshot,
  FileStat,
  SearchMatch,
  SearchOptions,
  SearchResult,
  ReplaceResult,
  WorkspaceChange,
  GitStatusEntry,
  GitStatus,
  GitCommit,
  Diagnostic,
  DiagnosticsResult,
  TaskDef,
  TasksListResult,
  TaskRunResult,
  TerminalDataEvent,
  TerminalExitEvent,
  LspDiagnosticsEvent,
};
