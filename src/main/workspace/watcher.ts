import fs from "node:fs";
import path from "node:path";

export type WorkspaceChange = {
  relativePath: string;
  kind: "change" | "rename";
};

export type WorkspaceWatcher = { close: () => void };

const DEBOUNCE_MS = 250;

function isIgnorable(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.includes(".touwa-tmp-") ||
    name === "node_modules" ||
    name === ".git"
  );
}

/**
 * Best-effort external-change watcher.
 *
 * Windows / macOS get a recursive watch; Linux has no recursive
 * fs.watch, so the root and its immediate subdirectories are watched
 * instead. The Renderer also polls file:stat for open tabs, so a
 * missed watcher event is still caught as a conflict on save.
 */
export function createWorkspaceWatcher(
  root: string,
  onChange: (change: WorkspaceChange) => void,
): WorkspaceWatcher {
  const watchers: fs.FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();

  const emit = (relativePath: string, kind: "change" | "rename"): void => {
    const existing = timers.get(relativePath);
    if (existing) clearTimeout(existing);
    timers.set(
      relativePath,
      setTimeout(() => {
        timers.delete(relativePath);
        onChange({ relativePath, kind });
      }, DEBOUNCE_MS),
    );
  };

  // 📁 baseRelative is the watched directory's own workspace-relative
  // path ('' for the root). fs.watch reports filenames relative to the
  // watched directory, so subdirectory watchers (Linux) must prepend
  // it: without it a change to src/a.ts was reported as just "a.ts"
  // and the Renderer never matched it to the open tab.
  const watchDir = (dir: string, baseRelative: string): void => {
    try {
      const watcher = fs.watch(
        dir,
        {
          recursive:
            process.platform === "win32" || process.platform === "darwin",
        },
        (eventType, filename) => {
          if (typeof filename !== "string" || filename.length === 0) return;
          // 🛤️ Ignore an event when any path segment is ignorable, so
          // recursive watches stay quiet for changes inside .git,
          // node_modules and hidden directories, not just at the top.
          if (filename.split(path.sep).some((segment) => isIgnorable(segment)))
            return;
          const relativePath = (
            baseRelative === "" ? filename : path.join(baseRelative, filename)
          )
            .split(path.sep)
            .join("/");
          emit(relativePath, eventType === "rename" ? "rename" : "change");
        },
      );
      watcher.on("error", () => undefined);
      watchers.push(watcher);
    } catch {
      // 💾 Watching is best-effort; stat polling and save-time conflict
      // detection remain the safety net.
    }
  };

  watchDir(root, "");
  if (process.platform === "linux") {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !isIgnorable(entry.name))
          watchDir(path.join(root, entry.name), entry.name);
      }
    } catch {
      // 👀 Ignore: root watch alone is enough as a fallback.
    }
  }

  return {
    close: () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const watcher of watchers) watcher.close();
    },
  };
}
