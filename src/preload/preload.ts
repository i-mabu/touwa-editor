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
};
