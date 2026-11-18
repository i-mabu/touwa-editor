import { dialog, ipcMain, type WebContents } from "electron";
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  listDirectory,
  listWorkspace,
  listWorkspaceFiles,
  readWorkspaceFile,
  renameWorkspaceEntry,
  replaceInWorkspace,
  searchWorkspace,
  statWorkspaceFile,
  writeWorkspaceFile,
  type SearchOptions,
} from "../workspace/workspace-service";
import {
  createWorkspaceWatcher,
  type WorkspaceWatcher,
} from "../workspace/watcher";
import {
  commitChanges,
  discardChanges,
  fetchRemote,
  getGitLog,
  getGitStatus,
  pullChanges,
  pushChanges,
  stageFiles,
  unstageFiles,
  DEFAULT_LOG_ENTRIES,
  MAX_LOG_ENTRIES,
  MAX_MUTATION_PATHS,
} from "../git/git-service";

const workspaceRoots = new Map<number, string>();
const watchers = new Map<number, WorkspaceWatcher>();
const cleanupAttached = new Set<number>();
function requireRoot(senderId: number): string {
  const root = workspaceRoots.get(senderId);
  if (!root) throw new Error("Open a workspace first.");
  return root;
}

/**
 * Release a sender's watcher and workspace root when its window goes
 * away. Without this, every closed window leaked an fs.watch handle
 * and a stale root entry for the rest of the app's lifetime (on macOS
 * the app outlives its windows).
 */
function attachSenderCleanup(sender: WebContents): void {
  if (cleanupAttached.has(sender.id)) return;
  cleanupAttached.add(sender.id);
  sender.once("destroyed", () => {
    cleanupAttached.delete(sender.id);
    watchers.get(sender.id)?.close();
    watchers.delete(sender.id);
    workspaceRoots.delete(sender.id);
  });
}

function parseSearchOptions(value: unknown): SearchOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid search options.");
  const options = value as Record<string, unknown>;
  const result: SearchOptions = {};
  if (options.caseSensitive !== undefined) {
    if (typeof options.caseSensitive !== "boolean")
      throw new Error("Invalid search options.");
    result.caseSensitive = options.caseSensitive;
  }
  if (options.regex !== undefined) {
    if (typeof options.regex !== "boolean")
      throw new Error("Invalid search options.");
    result.regex = options.regex;
  }
  if (options.maxMatches !== undefined) {
    // SearchOptions advertises maxMatches and the service clamps it,
    // but it used to be silently dropped here.
    if (
      typeof options.maxMatches !== "number" ||
      !Number.isFinite(options.maxMatches)
    ) {
      throw new Error("Invalid search options.");
    }
    result.maxMatches = Math.floor(options.maxMatches);
  }
  return result;
}

export function registerIpc(): void {
  ipcMain.handle("workspace:open", async (event) => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const root = result.filePaths[0];
    const sender = event.sender;
    attachSenderCleanup(sender);
    // List first: if the new workspace cannot be read, the previous
    // workspace and its watcher stay in place instead of being
    // replaced by a broken root with a live watcher.
    const entries = await listWorkspace(root);
    const previous = watchers.get(sender.id);
    if (previous) {
      previous.close();
      watchers.delete(sender.id);
    }
    workspaceRoots.set(sender.id, root);
    const watcher = createWorkspaceWatcher(root, (change) => {
      if (!sender.isDestroyed()) sender.send("workspace:changed", change);
    });
    watchers.set(sender.id, watcher);
    return { root, entries };
  });
  ipcMain.handle("workspace:list", async (event) =>
    listWorkspace(requireRoot(event.sender.id)),
  );
  ipcMain.handle("workspace:listDir", async (event, relativeDir: unknown) => {
    if (typeof relativeDir !== "string") throw new Error("Invalid path.");
    return listDirectory(requireRoot(event.sender.id), relativeDir);
  });
  ipcMain.handle(
    "workspace:search",
    async (event, query: unknown, options: unknown) => {
      if (typeof query !== "string") throw new Error("Invalid search query.");
      return searchWorkspace(
        requireRoot(event.sender.id),
        query,
        parseSearchOptions(options),
      );
    },
  );
  ipcMain.handle(
    "workspace:replace",
    async (event, query: unknown, replacement: unknown, options: unknown) => {
      if (typeof query !== "string" || typeof replacement !== "string")
        throw new Error("Invalid replace request.");
      return replaceInWorkspace(
        requireRoot(event.sender.id),
        query,
        replacement,
        parseSearchOptions(options),
      );
    },
  );
  ipcMain.handle("workspace:files", async (event) =>
    listWorkspaceFiles(requireRoot(event.sender.id)),
  );
  ipcMain.handle(
    "workspace:create",
    async (event, relativePath: unknown, kind: unknown) => {
      if (
        typeof relativePath !== "string" ||
        (kind !== "file" && kind !== "directory")
      ) {
        throw new Error("Invalid create request.");
      }
      return createWorkspaceEntry(
        requireRoot(event.sender.id),
        relativePath,
        kind,
      );
    },
  );
  ipcMain.handle(
    "workspace:rename",
    async (event, oldRelativePath: unknown, newRelativePath: unknown) => {
      if (
        typeof oldRelativePath !== "string" ||
        typeof newRelativePath !== "string"
      )
        throw new Error("Invalid rename request.");
      return renameWorkspaceEntry(
        requireRoot(event.sender.id),
        oldRelativePath,
        newRelativePath,
      );
    },
  );
  ipcMain.handle("workspace:delete", async (event, relativePath: unknown) => {
    if (typeof relativePath !== "string") throw new Error("Invalid path.");
    await deleteWorkspaceEntry(requireRoot(event.sender.id), relativePath);
    return { ok: true };
  });
  ipcMain.handle("file:read", async (event, relativePath: unknown) => {
    if (typeof relativePath !== "string") throw new Error("Invalid path.");
    return readWorkspaceFile(requireRoot(event.sender.id), relativePath);
  });
  ipcMain.handle("file:stat", async (event, relativePath: unknown) => {
    if (typeof relativePath !== "string") throw new Error("Invalid path.");
    return statWorkspaceFile(requireRoot(event.sender.id), relativePath);
  });
  ipcMain.handle("git:status", async (event) =>
    getGitStatus(requireRoot(event.sender.id)),
  );
  ipcMain.handle("git:log", async (event, limit: unknown) => {
    if (limit === undefined || limit === null) {
      return getGitLog(requireRoot(event.sender.id), DEFAULT_LOG_ENTRIES);
    }
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      throw new Error("Invalid log limit.");
    }
    const count = Math.max(1, Math.min(Math.floor(limit), MAX_LOG_ENTRIES));
    return getGitLog(requireRoot(event.sender.id), count);
  });
  const parseGitPaths = (value: unknown): string[] => {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > MAX_MUTATION_PATHS ||
      value.some((entry) => typeof entry !== "string")
    ) {
      throw new Error("Invalid path list.");
    }
    return value as string[];
  };
  ipcMain.handle("git:stage", async (event, paths: unknown) =>
    stageFiles(requireRoot(event.sender.id), parseGitPaths(paths)),
  );
  ipcMain.handle("git:unstage", async (event, paths: unknown) =>
    unstageFiles(requireRoot(event.sender.id), parseGitPaths(paths)),
  );
  ipcMain.handle("git:discard", async (event, paths: unknown) =>
    discardChanges(requireRoot(event.sender.id), parseGitPaths(paths)),
  );
  ipcMain.handle("git:commit", async (event, message: unknown) => {
    if (typeof message !== "string") {
      throw new Error("Invalid commit message.");
    }
    return commitChanges(requireRoot(event.sender.id), message);
  });
  ipcMain.handle("git:fetch", async (event) =>
    fetchRemote(requireRoot(event.sender.id)),
  );
  ipcMain.handle("git:pull", async (event) =>
    pullChanges(requireRoot(event.sender.id)),
  );
  ipcMain.handle("git:push", async (event) =>
    pushChanges(requireRoot(event.sender.id)),
  );
  ipcMain.handle(
    "file:write",
    async (
      event,
      relativePath: unknown,
      content: unknown,
      expectedMtimeMs: unknown,
    ) => {
      if (typeof relativePath !== "string" || typeof content !== "string")
        throw new Error("Invalid file request.");
      if (
        expectedMtimeMs !== undefined &&
        expectedMtimeMs !== null &&
        typeof expectedMtimeMs !== "number"
      ) {
        throw new Error("Invalid file request.");
      }
      return writeWorkspaceFile(
        requireRoot(event.sender.id),
        relativePath,
        content,
        expectedMtimeMs === null
          ? undefined
          : (expectedMtimeMs as number | undefined),
      );
    },
  );
}
