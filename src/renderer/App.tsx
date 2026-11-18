import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import Editor from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import CommandPalette, {
  type PaletteCommand,
} from "./components/CommandPalette";
import Explorer from "./components/Explorer";
import QuickOpen from "./components/QuickOpen";
import SearchPanel from "./components/SearchPanel";
import GitPanel from "./components/GitPanel";
import ProblemsPanel from "./components/ProblemsPanel";
import TasksPanel from "./components/TasksPanel";
import TerminalPanel from "./components/TerminalPanel";
import type { FileEntry, SearchMatch } from "./components/types";
import { languageForPath } from "./components/types";
import {
  activateNextTab,
  activeGroup,
  activeTab,
  closeGroup as closeGroupState,
  closeTab as closeTabState,
  closeTabsForPath,
  createTab,
  emptyGroups,
  isDirty,
  markTabExternalChanged,
  markTabSaved,
  openTabInGroup,
  reloadTab,
  renameTabs,
  splitActiveTabRight,
  updateTabContent,
  type GroupsState,
  type TabState,
} from "./state/tabs";

type Pane = "explorer" | "search" | "git" | "problems" | "tasks" | "terminal";

export default function App(): JSX.Element {
  const [root, setRoot] = useState("No workspace");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [groups, setGroups] = useState<GroupsState>(emptyGroups());
  const [pane, setPane] = useState<Pane>("explorer");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [showPalette, setShowPalette] = useState(false);
  const [showQuickOpen, setShowQuickOpen] = useState(false);
  const [quickFiles, setQuickFiles] = useState<string[]>([]);
  const [explorerKey, setExplorerKey] = useState(0);
  const [status, setStatus] = useState("Ready");
  const [cursor, setCursor] = useState("Ln 1, Col 1");
  const [pendingJump, setPendingJump] = useState<{
    relativePath: string;
    line: number;
    column: number;
  } | null>(null);

  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const editorsRef = useRef(new Map<string, editor.IStandaloneCodeEditor>());
  const savingTabsRef = useRef(new Set<string>());

  const tab = activeTab(groups);

  const reveal = useCallback((tabId: string, line: number, column: number) => {
    const instance = editorsRef.current.get(tabId);
    if (!instance) return;
    instance.revealLineInCenter(line);
    instance.setPosition({ lineNumber: line, column });
    instance.focus();
  }, []);

  useEffect(() => {
    if (!pendingJump) return;
    const found = groups.groups
      .flatMap((g) => g.tabs)
      .find((t) => t.relativePath === pendingJump.relativePath);
    if (found) {
      reveal(found.id, pendingJump.line, pendingJump.column);
      setPendingJump(null);
    }
  }, [pendingJump, groups, reveal]);

  async function refreshEntries(): Promise<void> {
    try {
      setEntries(await window.touwa.workspace.list());
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Unable to list workspace");
    }
  }

  async function openWorkspace(): Promise<void> {
    try {
      const result = await window.touwa.workspace.open();
      if (result) {
        setRoot(result.root);
        setEntries(result.entries);
        setGroups(emptyGroups());
        setQuickFiles([]);
        setStatus("Workspace opened");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Unable to open workspace");
    }
  }

  const openFile = useCallback(
    async (
      entry: FileEntry,
      groupId?: string,
      line?: number,
      column?: number,
    ): Promise<void> => {
      if (entry.kind !== "file") return;
      const current = groupsRef.current;
      const existing = current.groups
        .flatMap((g) => g.tabs)
        .find((t) => t.relativePath === entry.relativePath);
      if (existing) {
        setGroups((prev) => {
          const targetGroup = prev.groups.find((g) =>
            g.tabs.some((t) => t.id === existing.id),
          );
          if (!targetGroup) return prev;
          return {
            ...prev,
            activeGroupId: targetGroup.id,
            groups: prev.groups.map((g) =>
              g.id === targetGroup.id ? { ...g, activeTabId: existing.id } : g,
            ),
          };
        });
        if (line)
          setPendingJump({
            relativePath: entry.relativePath,
            line,
            column: column ?? 1,
          });
        setStatus(`Opened ${entry.name}`);
        return;
      }
      try {
        const snapshot = await window.touwa.file.read(entry.relativePath);
        const nextTab = createTab(entry.relativePath, snapshot);
        setGroups((prev) =>
          openTabInGroup(prev, groupId ?? prev.activeGroupId, nextTab),
        );
        if (line)
          setPendingJump({
            relativePath: entry.relativePath,
            line,
            column: column ?? 1,
          });
        setStatus(`Opened ${entry.name}`);
      } catch (e) {
        setStatus(e instanceof Error ? e.message : "Unable to read file");
      }
    },
    [],
  );

  const saveTab = useCallback(
    async (target: TabState, force: boolean): Promise<boolean> => {
      // A second save for the same tab while one is in flight would send
      // the same expected mtime; once the first write lands, the second
      // is refused as a false "changed on disk" conflict against the
      // tab's own save. Ignore the duplicate instead.
      if (savingTabsRef.current.has(target.id)) return false;
      savingTabsRef.current.add(target.id);
      try {
        const snapshot = await window.touwa.file.write(
          target.relativePath,
          target.content,
          force ? undefined : target.savedMtimeMs,
        );
        setGroups((prev) => {
          const g = prev.groups.find((candidate) =>
            candidate.tabs.some((t) => t.id === target.id),
          );
          return g ? markTabSaved(prev, g.id, target.id, snapshot) : prev;
        });
        setStatus(`Saved ${target.relativePath}`);
        return true;
      } catch (e) {
        const message = e instanceof Error ? e.message : "Unable to save file";
        if (message.includes("changed on disk")) {
          setGroups((prev) =>
            markTabExternalChanged(prev, target.relativePath),
          );
          setStatus(
            `Conflict: ${target.relativePath} changed on disk. Reload or overwrite.`,
          );
        } else {
          setStatus(message);
        }
        return false;
      } finally {
        savingTabsRef.current.delete(target.id);
      }
    },
    [],
  );

  async function saveActive(): Promise<void> {
    const current = activeTab(groupsRef.current);
    if (!current) {
      setStatus("Select a file before saving");
      return;
    }
    if (current.externalChanged) {
      setStatus(
        `Conflict: ${current.relativePath} changed on disk. Use Reload or Overwrite.`,
      );
      return;
    }
    await saveTab(current, false);
  }

  async function saveAll(): Promise<void> {
    const all = groupsRef.current.groups.flatMap((g) => g.tabs);
    let saved = 0;
    for (const candidate of all) {
      if (!isDirty(candidate) || candidate.externalChanged) continue;
      if (await saveTab(candidate, false)) saved += 1;
    }
    setStatus(`Saved ${saved} file(s)`);
  }

  async function reloadActive(target?: TabState): Promise<void> {
    const current = target ?? activeTab(groupsRef.current);
    if (!current) return;
    if (
      isDirty(current) &&
      !window.confirm("未保存の変更を破棄してディスクの内容で再読込しますか？")
    )
      return;
    try {
      const snapshot = await window.touwa.file.read(current.relativePath);
      setGroups((prev) => reloadTab(prev, current.relativePath, snapshot));
      setStatus(`Reloaded ${current.relativePath}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Unable to reload file");
    }
  }

  async function overwriteActive(target?: TabState): Promise<void> {
    const current = target ?? activeTab(groupsRef.current);
    if (!current) return;
    if (!window.confirm("ディスク上の変更を上書きして保存しますか？")) return;
    await saveTab(current, true);
  }

  function closeTabById(groupId: string, target: TabState): void {
    if (
      isDirty(target) &&
      !window.confirm(
        `「${target.name}」には未保存の変更があります。閉じますか？`,
      )
    )
      return;
    setGroups((prev) => closeTabState(prev, groupId, target.id));
  }

  function closeActiveTab(): void {
    const currentGroup = activeGroup(groupsRef.current);
    const current = activeTab(groupsRef.current);
    if (!current) return;
    closeTabById(currentGroup.id, current);
  }

  function goToLine(): void {
    const current = activeTab(groupsRef.current);
    if (!current) {
      setStatus("Select a file before going to a line");
      return;
    }
    editorsRef.current
      .get(current.id)
      ?.getAction("editor.action.gotoLine")
      ?.run();
  }

  async function openQuickOpen(): Promise<void> {
    if (root === "No workspace") {
      setStatus("Open a folder first");
      return;
    }
    try {
      setQuickFiles(await window.touwa.workspace.files());
      setShowQuickOpen(true);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Unable to list files");
    }
  }

  async function createEntry(
    kind: "file" | "directory",
    parentDir: string,
  ): Promise<void> {
    if (root === "No workspace") {
      setStatus("Open a folder first");
      return;
    }
    const name = window.prompt(
      kind === "file" ? "New file name" : "New folder name",
    );
    if (name === null) return;
    const trimmed = name.trim();
    if (
      !trimmed ||
      trimmed.includes("/") ||
      trimmed.includes("\\") ||
      trimmed === "." ||
      trimmed === ".."
    ) {
      setStatus("Enter a single file or folder name.");
      return;
    }
    const relativePath = parentDir === "" ? trimmed : `${parentDir}/${trimmed}`;
    try {
      const created = await window.touwa.workspace.create(relativePath, kind);
      await refreshEntries();
      setExplorerKey((k) => k + 1);
      setStatus(`Created ${relativePath}`);
      if (created.kind === "file") void openFile(created);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Unable to create entry");
    }
  }

  async function renameEntry(entry: FileEntry): Promise<void> {
    const name = window.prompt("Rename to", entry.name);
    if (name === null) return;
    const trimmed = name.trim();
    if (
      !trimmed ||
      trimmed.includes("/") ||
      trimmed.includes("\\") ||
      trimmed === "." ||
      trimmed === ".."
    ) {
      setStatus("Enter a single file or folder name.");
      return;
    }
    const dir = entry.relativePath.split("/").slice(0, -1).join("/");
    const newPath = dir === "" ? trimmed : `${dir}/${trimmed}`;
    if (newPath === entry.relativePath) return;
    try {
      await window.touwa.workspace.rename(entry.relativePath, newPath);
      setGroups((prev) =>
        renameTabs(
          prev,
          entry.relativePath,
          newPath,
          entry.kind === "directory",
        ),
      );
      await refreshEntries();
      setExplorerKey((k) => k + 1);
      setStatus(`Renamed to ${newPath}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Unable to rename entry");
    }
  }

  async function deleteEntry(entry: FileEntry): Promise<void> {
    const message =
      entry.kind === "directory"
        ? `「${entry.relativePath}」と中身をすべて削除しますか？`
        : `「${entry.relativePath}」を削除しますか？`;
    if (!window.confirm(message)) return;
    try {
      await window.touwa.workspace.delete(entry.relativePath);
      setGroups((prev) =>
        closeTabsForPath(prev, entry.relativePath, entry.kind === "directory"),
      );
      await refreshEntries();
      setExplorerKey((k) => k + 1);
      setStatus(`Deleted ${entry.relativePath}`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Unable to delete entry");
    }
  }

  const commands: PaletteCommand[] = [
    {
      id: "open-folder",
      title: "File: Open Folder",
      shortcut: "",
      run: () => void openWorkspace(),
    },
    {
      id: "quick-open",
      title: "Go to File...",
      shortcut: "Ctrl+P",
      run: () => void openQuickOpen(),
    },
    {
      id: "go-to-line",
      title: "Go to Line...",
      shortcut: "Ctrl+G",
      run: goToLine,
    },
    {
      id: "save",
      title: "File: Save",
      shortcut: "Ctrl+S",
      run: () => void saveActive(),
    },
    {
      id: "save-all",
      title: "File: Save All",
      shortcut: "Ctrl+Shift+S",
      run: () => void saveAll(),
    },
    {
      id: "close-tab",
      title: "View: Close Editor",
      shortcut: "Ctrl+W",
      run: closeActiveTab,
    },
    {
      id: "split-right",
      title: "View: Split Editor Right",
      shortcut: "",
      run: () => setGroups((prev) => splitActiveTabRight(prev)),
    },
    {
      id: "toggle-sidebar",
      title: "View: Toggle Primary Side Bar",
      shortcut: "Ctrl+B",
      run: () => setSidebarVisible((v) => !v),
    },
    {
      id: "show-explorer",
      title: "View: Show Explorer",
      shortcut: "Ctrl+Shift+E",
      run: () => {
        setSidebarVisible(true);
        setPane("explorer");
      },
    },
    {
      id: "show-search",
      title: "View: Show Search",
      shortcut: "Ctrl+Shift+F",
      run: () => {
        setSidebarVisible(true);
        setPane("search");
      },
    },
    {
      id: "show-git",
      title: "View: Show Source Control",
      shortcut: "Ctrl+Shift+G",
      run: () => {
        setSidebarVisible(true);
        setPane("git");
      },
    },
    {
      id: "show-problems",
      title: "View: Show Problems",
      shortcut: "Ctrl+Shift+M",
      run: () => {
        setSidebarVisible(true);
        setPane("problems");
      },
    },
    {
      id: "show-tasks",
      title: "View: Show Tasks",
      run: () => {
        setSidebarVisible(true);
        setPane("tasks");
      },
    },
    {
      id: "show-terminal",
      title: "View: Show Terminal",
      shortcut: "Ctrl+`",
      run: () => {
        setSidebarVisible(true);
        setPane("terminal");
      },
    },
    {
      id: "reload",
      title: "File: Reload from Disk",
      shortcut: "",
      run: () => void reloadActive(),
    },
  ];

  // External-change detection: Main watcher events + polling as a safety net.
  useEffect(() => {
    const unsubscribe = window.touwa.workspace.onChanged((change) => {
      const open = groupsRef.current.groups
        .flatMap((g) => g.tabs)
        .find((t) => t.relativePath === change.relativePath);
      if (!open) return;
      void window.touwa.file
        .stat(change.relativePath)
        .then((stat) => {
          if (
            stat.mtimeMs !== open.savedMtimeMs ||
            stat.hash !== open.savedHash
          ) {
            setGroups((prev) =>
              markTabExternalChanged(prev, change.relativePath),
            );
            setStatus(`External change detected: ${change.relativePath}`);
          }
        })
        .catch(() => undefined);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const all = groupsRef.current.groups.flatMap((g) => g.tabs);
      for (const candidate of all) {
        if (candidate.externalChanged) continue;
        void window.touwa.file
          .stat(candidate.relativePath)
          .then((stat) => {
            if (
              stat.mtimeMs !== candidate.savedMtimeMs ||
              stat.hash !== candidate.savedHash
            ) {
              setGroups((prev) =>
                markTabExternalChanged(prev, candidate.relativePath),
              );
            }
          })
          .catch(() => undefined);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // VS Code-style global shortcuts. Monaco keeps its own editor shortcuts
  // (Ctrl+F / Ctrl+H find, Ctrl+D select next, Ctrl+/ comment, Alt+Up/Down
  // move line, Shift+Alt+Down duplicate line, Ctrl+Shift+K delete line).
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (showPalette || showQuickOpen) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod && e.key !== "F1") return;
      const key = e.key.toLowerCase();
      if (e.key === "F1") {
        e.preventDefault();
        setShowPalette(true);
        return;
      }
      if (key === "s" && e.shiftKey) {
        e.preventDefault();
        void saveAll();
      } else if (key === "s") {
        e.preventDefault();
        void saveActive();
      } else if (key === "p" && e.shiftKey) {
        e.preventDefault();
        setShowPalette(true);
      } else if (key === "p") {
        e.preventDefault();
        void openQuickOpen();
      } else if (key === "w") {
        e.preventDefault();
        closeActiveTab();
      } else if (key === "tab") {
        e.preventDefault();
        setGroups((prev) => activateNextTab(prev, e.shiftKey ? -1 : 1));
      } else if (key === "b") {
        e.preventDefault();
        setSidebarVisible((v) => !v);
      } else if (key === "g" && e.shiftKey) {
        e.preventDefault();
        setSidebarVisible(true);
        setPane("git");
      } else if (key === "g") {
        e.preventDefault();
        goToLine();
      } else if (key === "e" && e.shiftKey) {
        e.preventDefault();
        setSidebarVisible(true);
        setPane("explorer");
      } else if (key === "f" && e.shiftKey) {
        e.preventDefault();
        setSidebarVisible(true);
        setPane("search");
      } else if (key === "m" && e.shiftKey) {
        e.preventDefault();
        setSidebarVisible(true);
        setPane("problems");
      } else if (key === "`") {
        e.preventDefault();
        setSidebarVisible(true);
        setPane("terminal");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // The handler reads everything else through refs (groupsRef,
    // editorsRef), so it only needs to re-register when the values it
    // closes over directly change. Without a dependency array it was
    // removed and re-added on every render — i.e. every keystroke in
    // the editor.
  }, [showPalette, showQuickOpen, root]);

  const dirtyCount = groups.groups
    .flatMap((g) => g.tabs)
    .filter(isDirty).length;

  return (
    <div className="app">
      <header className="titlebar">
        <strong>Touwa Editor</strong>
        <span className="workspace-label">{root}</span>
        <button onClick={() => void openWorkspace()}>Open Folder</button>
        <button onClick={() => void saveActive()}>Save</button>
        <button onClick={() => void saveAll()}>Save All</button>
        <button
          disabled={!tab || groups.groups.length >= 2}
          onClick={() => setGroups((prev) => splitActiveTabRight(prev))}
        >
          Split Right
        </button>
        <button onClick={() => setShowPalette(true)}>Command Palette</button>
      </header>
      <div className="body">
        <nav className="activity">
          <div
            className={`activity-icon ${sidebarVisible && pane === "explorer" ? "active" : ""}`}
            title="Explorer (Ctrl+Shift+E)"
            onClick={() => {
              setSidebarVisible(true);
              setPane("explorer");
            }}
          >
            EX
          </div>
          <div
            className={`activity-icon ${sidebarVisible && pane === "search" ? "active" : ""}`}
            title="Search (Ctrl+Shift+F)"
            onClick={() => {
              setSidebarVisible(true);
              setPane("search");
            }}
          >
            SC
          </div>
          <div
            className={`activity-icon ${sidebarVisible && pane === "git" ? "active" : ""}`}
            title="Source Control (Ctrl+Shift+G)"
            onClick={() => {
              setSidebarVisible(true);
              setPane("git");
            }}
          >
            GT
          </div>
          <div
            className={`activity-icon ${sidebarVisible && pane === "problems" ? "active" : ""}`}
            title="Problems (Ctrl+Shift+M)"
            onClick={() => {
              setSidebarVisible(true);
              setPane("problems");
            }}
          >
            PR
          </div>
          <div
            className={`activity-icon ${sidebarVisible && pane === "tasks" ? "active" : ""}`}
            title="Tasks"
            onClick={() => {
              setSidebarVisible(true);
              setPane("tasks");
            }}
          >
            TK
          </div>
          <div
            className={`activity-icon ${sidebarVisible && pane === "terminal" ? "active" : ""}`}
            title="Terminal (Ctrl+`)"
            onClick={() => {
              setSidebarVisible(true);
              setPane("terminal");
            }}
          >
            TM
          </div>
        </nav>
        {sidebarVisible &&
          (pane === "explorer" ? (
            <Explorer
              key={explorerKey}
              rootName={root.split(/[\\/]/).pop() ?? root}
              entries={entries}
              activePath={tab?.relativePath ?? ""}
              onOpenFile={(entry) => void openFile(entry)}
              onListDir={(relativeDir) =>
                window.touwa.workspace.listDir(relativeDir)
              }
              onCreate={(kind, parentDir) => void createEntry(kind, parentDir)}
              onRename={(entry) => void renameEntry(entry)}
              onDelete={(entry) => void deleteEntry(entry)}
            />
          ) : pane === "search" ? (
            <SearchPanel
              onSearch={(query, options) =>
                window.touwa.workspace.search(query, options)
              }
              onReplaceAll={async (query, replacement, options) => {
                const result = await window.touwa.workspace.replace(
                  query,
                  replacement,
                  options,
                );
                // Replaced files that are open and clean are reloaded; dirty
                // tabs are flagged so the user can resolve them.
                for (const file of result.perFile) {
                  const open = groupsRef.current.groups
                    .flatMap((g) => g.tabs)
                    .find((t) => t.relativePath === file.relativePath);
                  if (!open) continue;
                  if (isDirty(open)) {
                    setGroups((prev) =>
                      markTabExternalChanged(prev, file.relativePath),
                    );
                  } else {
                    const snapshot = await window.touwa.file.read(
                      file.relativePath,
                    );
                    setGroups((prev) =>
                      reloadTab(prev, file.relativePath, snapshot),
                    );
                  }
                }
                return result;
              }}
              onJumpTo={(match: SearchMatch) => {
                const entry: FileEntry = {
                  name:
                    match.relativePath.split("/").pop() ?? match.relativePath,
                  relativePath: match.relativePath,
                  kind: "file",
                };
                void openFile(entry, undefined, match.line, match.column);
              }}
            />
          ) : pane === "git" ? (
            <GitPanel
              onLoadStatus={() => window.touwa.git.status()}
              onLoadLog={(limit) => window.touwa.git.log(limit)}
              onStage={(paths) => window.touwa.git.stage(paths)}
              onUnstage={(paths) => window.touwa.git.unstage(paths)}
              onDiscard={(paths) => window.touwa.git.discard(paths)}
              onCommit={(commitMessage) =>
                window.touwa.git.commit(commitMessage)
              }
              onFetch={() => window.touwa.git.fetch()}
              onPull={() => window.touwa.git.pull()}
              onPush={() => window.touwa.git.push()}
              onOpenFile={(relativePath) => {
                const entry: FileEntry = {
                  name: relativePath.split("/").pop() ?? relativePath,
                  relativePath,
                  kind: "file",
                };
                void openFile(entry);
              }}
            />
          ) : pane === "problems" ? (
            <ProblemsPanel
              onRunDiagnostics={() => window.touwa.diagnostics.run()}
              onJumpTo={(relativePath, line, column) => {
                const entry: FileEntry = {
                  name: relativePath.split("/").pop() ?? relativePath,
                  relativePath,
                  kind: "file",
                };
                void openFile(entry, undefined, line, column);
              }}
            />
          ) : pane === "tasks" ? (
            <TasksPanel
              onListTasks={() => window.touwa.tasks.list()}
              onRunTask={(label) => window.touwa.tasks.run(label)}
            />
          ) : (
            <TerminalPanel
              onStart={() => window.touwa.terminal.start()}
              onWrite={(id, data) => window.touwa.terminal.write(id, data)}
              onKill={(id) => window.touwa.terminal.kill(id)}
              onData={(callback) => window.touwa.terminal.onData(callback)}
              onExit={(callback) => window.touwa.terminal.onExit(callback)}
            />
          ))}
        <main className="editor-groups">
          {groups.groups.map((editorGroup) => {
            const groupTab =
              editorGroup.tabs.find((t) => t.id === editorGroup.activeTabId) ??
              null;
            return (
              <section
                key={editorGroup.id}
                className={`editor-group ${editorGroup.id === groups.activeGroupId ? "active-group" : ""}`}
              >
                <div className="tabs">
                  {editorGroup.tabs.map((t) => (
                    <span
                      key={t.id}
                      className={`tab ${t.id === editorGroup.activeTabId ? "active" : ""} ${t.externalChanged ? "conflict" : ""}`}
                      title={t.relativePath}
                      onClick={() =>
                        setGroups((prev) => ({
                          ...prev,
                          activeGroupId: editorGroup.id,
                          groups: prev.groups.map((g) =>
                            g.id === editorGroup.id
                              ? { ...g, activeTabId: t.id }
                              : g,
                          ),
                        }))
                      }
                      onMouseDown={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          closeTabById(editorGroup.id, t);
                        }
                      }}
                    >
                      {t.name}
                      {isDirty(t) ? " ●" : ""}
                      {t.externalChanged ? " ⚠" : ""}
                      <button
                        className="tab-close"
                        aria-label={`Close ${t.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTabById(editorGroup.id, t);
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {editorGroup.tabs.length === 0 && (
                    <span className="tab empty">No file open</span>
                  )}
                  {groups.groups.length > 1 && (
                    <button
                      className="group-close"
                      onClick={() =>
                        setGroups((prev) =>
                          closeGroupState(prev, editorGroup.id),
                        )
                      }
                    >
                      Close Group
                    </button>
                  )}
                </div>
                {groupTab?.externalChanged && (
                  <div className="conflict-banner">
                    <span>
                      このファイルは外部で変更されました。未保存の変更があります。
                    </span>
                    <button onClick={() => void reloadActive(groupTab)}>
                      再読込
                    </button>
                    <button onClick={() => void overwriteActive(groupTab)}>
                      上書き保存
                    </button>
                  </div>
                )}
                {groupTab ? (
                  <div className="editor-wrap">
                    <Editor
                      key={groupTab.id}
                      theme="vs-dark"
                      language={languageForPath(groupTab.relativePath)}
                      value={groupTab.content}
                      onChange={(v) =>
                        setGroups((prev) =>
                          updateTabContent(
                            prev,
                            editorGroup.id,
                            groupTab.id,
                            v ?? "",
                          ),
                        )
                      }
                      onMount={(instance) => {
                        editorsRef.current.set(groupTab.id, instance);
                        // Drop the reference when Monaco disposes the
                        // editor (tab closed), otherwise the map grows
                        // for the whole session and reveal() could act
                        // on a disposed instance.
                        instance.onDidDispose(() => {
                          editorsRef.current.delete(groupTab.id);
                        });
                        instance.onDidChangeCursorPosition((e) => {
                          setCursor(
                            `Ln ${e.position.lineNumber}, Col ${e.position.column}`,
                          );
                        });
                        if (
                          pendingJump?.relativePath === groupTab.relativePath
                        ) {
                          reveal(
                            groupTab.id,
                            pendingJump.line,
                            pendingJump.column,
                          );
                          setPendingJump(null);
                        }
                      }}
                      options={{
                        fontSize: 14,
                        minimap: { enabled: false },
                        automaticLayout: true,
                        tabSize: 2,
                        wordWrap: "off",
                        multiCursorModifier: "ctrlCmd",
                        multiCursorMergeOverlapping: true,
                        find: {
                          addExtraSpaceOnTop: false,
                          autoFindInSelection: "never",
                          seedSearchStringFromSelection: "selection",
                        },
                      }}
                    />
                  </div>
                ) : (
                  <div className="welcome">
                    <p>Open a folder and a file to start coding.</p>
                    <p>
                      Ctrl+P: Quick Open · Ctrl+Shift+P: Command Palette ·
                      Ctrl+Shift+E / F: Explorer / Search · Ctrl+B: Toggle
                      Sidebar · Ctrl+G: Go to Line · Ctrl+Tab: Switch Tab
                    </p>
                  </div>
                )}
              </section>
            );
          })}
        </main>
      </div>
      <footer className="statusbar">
        <span>{status}</span>
        <span>{dirtyCount > 0 ? `${dirtyCount} unsaved` : "Saved"}</span>
        <span>UTF-8</span>
        <span>{tab ? languageForPath(tab.relativePath) : "Plain Text"}</span>
        <span>{cursor}</span>
        <button
          className="status-close"
          onClick={closeActiveTab}
          disabled={!tab}
        >
          Close Tab
        </button>
      </footer>
      {showPalette && (
        <CommandPalette
          commands={commands}
          onClose={() => setShowPalette(false)}
        />
      )}
      {showQuickOpen && (
        <QuickOpen
          files={quickFiles}
          onOpen={(relativePath) => {
            const entry: FileEntry = {
              name: relativePath.split("/").pop() ?? relativePath,
              relativePath,
              kind: "file",
            };
            void openFile(entry);
          }}
          onClose={() => setShowQuickOpen(false)}
        />
      )}
    </div>
  );
}
