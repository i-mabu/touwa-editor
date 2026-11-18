import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor, languages } from "monaco-editor";
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
import DebugPanel from "./components/DebugPanel";
import type {
  DebugBreakpoint,
  Diagnostic,
  FileEntry,
  SearchMatch,
} from "./components/types";
import {
  isLspLanguagePath,
  languageForPath,
  monacoCompletionKind,
} from "./components/types";
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

type Pane =
  | "explorer"
  | "search"
  | "git"
  | "problems"
  | "tasks"
  | "terminal"
  | "debug";

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
  const [lspDiagnostics, setLspDiagnostics] = useState<
    Map<string, Diagnostic[]>
  >(new Map());
  const lspChangeTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const lspProvidersRegisteredRef = useRef(false);
  const monacoRef = useRef<Monaco | null>(null);
  // Debugger state: breakpoints live in the renderer (the full set is
  // passed at start; edits during a session are pushed to Main).
  const [breakpoints, setBreakpoints] = useState<Map<string, number[]>>(
    new Map(),
  );
  const breakpointsRef = useRef(breakpoints);
  breakpointsRef.current = breakpoints;
  const debugActiveRef = useRef(false);
  const [pausedFrame, setPausedFrame] = useState<{
    relativePath: string;
    line: number;
  } | null>(null);
  const pausedFrameRef = useRef(pausedFrame);
  pausedFrameRef.current = pausedFrame;
  const decorationCollectionsRef = useRef(
    new Map<string, editor.IEditorDecorationsCollection>(),
  );

  const applyEditorDecorations = useCallback((tabId: string) => {
    const instance = editorsRef.current.get(tabId);
    const monacoInstance = monacoRef.current;
    if (!instance || !monacoInstance) return;
    const found = groupsRef.current.groups
      .flatMap((g) => g.tabs)
      .find((t) => t.id === tabId);
    if (!found) return;
    let collection = decorationCollectionsRef.current.get(tabId);
    if (!collection) {
      collection = instance.createDecorationsCollection();
      decorationCollectionsRef.current.set(tabId, collection);
    }
    const decorations: editor.IModelDeltaDecoration[] = (
      breakpointsRef.current.get(found.relativePath) ?? []
    ).map((line) => ({
      range: new monacoInstance.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: "touwa-breakpoint",
        glyphMarginHoverMessage: { value: "ブレークポイント" },
      },
    }));
    const paused = pausedFrameRef.current;
    if (paused && paused.relativePath === found.relativePath) {
      decorations.push({
        range: new monacoInstance.Range(paused.line, 1, paused.line, 1),
        options: {
          isWholeLine: true,
          className: "touwa-paused-line",
        },
      });
    }
    collection.set(decorations);
  }, []);

  const toggleBreakpoint = useCallback(
    (relativePath: string, line: number) => {
      const current = breakpointsRef.current.get(relativePath) ?? [];
      const next = current.includes(line)
        ? current.filter((l) => l !== line)
        : [...current, line].sort((a, b) => a - b);
      const map = new Map(breakpointsRef.current);
      if (next.length === 0) map.delete(relativePath);
      else map.set(relativePath, next);
      breakpointsRef.current = map;
      setBreakpoints(map);
      if (debugActiveRef.current) {
        void window.touwa.debug
          .setBreakpoints(relativePath, next)
          .catch(() => {});
      }
    },
    [],
  );

  // Track the debug session in App as well: breakpoint edits are
  // pushed live only while a session runs, and the paused line is
  // highlighted in the editor.
  useEffect(() => {
    return window.touwa.debug.onState((event) => {
      debugActiveRef.current = event.status !== "terminated";
      if (event.status === "paused" && event.frames && event.frames[0]) {
        setPausedFrame({
          relativePath: event.frames[0].relativePath,
          line: event.frames[0].line,
        });
      } else {
        setPausedFrame(null);
      }
    });
  }, []);

  useEffect(() => {
    for (const tabId of editorsRef.current.keys()) {
      applyEditorDecorations(tabId);
    }
  }, [breakpoints, pausedFrame, groups, applyEditorDecorations]);

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

  // Language server sync: the renderer owns the text, so it mirrors
  // open documents to the main process (changes debounced) and
  // collects the diagnostics the server publishes for the Problems
  // panel. Only TypeScript / JavaScript files are synced.
  useEffect(() => {
    return window.touwa.lsp.onDiagnostics((event) => {
      setLspDiagnostics((prev) => {
        const next = new Map(prev);
        if (event.diagnostics.length === 0) next.delete(event.relativePath);
        else next.set(event.relativePath, event.diagnostics);
        return next;
      });
    });
  }, []);

  const lspOpen = useCallback((relativePath: string, text: string): void => {
    if (!isLspLanguagePath(relativePath)) return;
    void window.touwa.lsp.open(relativePath, text).catch(() => {});
  }, []);

  const lspClose = useCallback((relativePath: string): void => {
    if (!isLspLanguagePath(relativePath)) return;
    const timer = lspChangeTimersRef.current.get(relativePath);
    if (timer) {
      clearTimeout(timer);
      lspChangeTimersRef.current.delete(relativePath);
    }
    void window.touwa.lsp.close(relativePath).catch(() => {});
  }, []);

  const lspSyncChange = useCallback(
    (relativePath: string, text: string): void => {
      if (!isLspLanguagePath(relativePath)) return;
      const timers = lspChangeTimersRef.current;
      const pending = timers.get(relativePath);
      if (pending) clearTimeout(pending);
      timers.set(
        relativePath,
        setTimeout(() => {
          timers.delete(relativePath);
          void window.touwa.lsp.change(relativePath, text).catch(() => {});
        }, 400),
      );
    },
    [],
  );

  // Requests (completion / hover / signature help) must not race the
  // 400ms debounce: flush the current text first so the server answers
  // against the same document the user sees.
  const lspSyncNow = useCallback(
    async (relativePath: string, text: string): Promise<void> => {
      if (!isLspLanguagePath(relativePath)) return;
      const timers = lspChangeTimersRef.current;
      const pending = timers.get(relativePath);
      if (pending) {
        clearTimeout(pending);
        timers.delete(relativePath);
      }
      await window.touwa.lsp.change(relativePath, text).catch(() => {});
    },
    [],
  );

  const pathForModel = useCallback(
    (model: editor.ITextModel): string | null => {
      for (const [tabId, instance] of editorsRef.current) {
        if (instance.getModel() !== model) continue;
        const found = groupsRef.current.groups
          .flatMap((g) => g.tabs)
          .find((t) => t.id === tabId);
        return found?.relativePath ?? null;
      }
      return null;
    },
    [],
  );

  // Registers the language-server-backed Monaco providers once. The
  // server owns completion / hover / signature help for TS/JS, so
  // Monaco's built-in providers for those features are disabled to
  // avoid duplicate suggestions.
  const registerLspProviders = useCallback(
    (monacoInstance: Monaco): void => {
      if (lspProvidersRegisteredRef.current) return;
      lspProvidersRegisteredRef.current = true;
      const tsLanguages = monacoInstance.languages.typescript;
      if (tsLanguages) {
        for (const defaults of [
          tsLanguages.typescriptDefaults,
          tsLanguages.javascriptDefaults,
        ]) {
          defaults.setModeConfiguration({
            ...defaults.modeConfiguration,
            completionItems: false,
            hovers: false,
            signatureHelp: false,
          });
        }
      }
      for (const language of ["typescript", "javascript"]) {
        monacoInstance.languages.registerCompletionItemProvider(language, {
          triggerCharacters: [".", '"', "'"],
          provideCompletionItems: async (model, position, _context, token) => {
            const relativePath = pathForModel(model);
            if (!relativePath) return { suggestions: [] };
            await lspSyncNow(relativePath, model.getValue());
            if (token.isCancellationRequested) return { suggestions: [] };
            const items = await window.touwa.lsp
              .completion(relativePath, position.lineNumber, position.column)
              .catch(() => []);
            if (token.isCancellationRequested) return { suggestions: [] };
            // Monaco requires a range per item; when the server did
            // not send a textEdit, replace the word at the cursor.
            const word = model.getWordUntilPosition(position);
            const defaultRange = {
              startLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endLineNumber: position.lineNumber,
              endColumn: word.endColumn,
            };
            return {
              suggestions: items.map((item) => ({
                label: item.label,
                kind: monacoCompletionKind(
                  item.kind,
                ) as languages.CompletionItemKind,
                detail: item.detail || undefined,
                documentation: item.documentation
                  ? { value: item.documentation }
                  : undefined,
                insertText: item.insertText,
                range: item.range
                  ? {
                      startLineNumber: item.range.startLine,
                      startColumn: item.range.startColumn,
                      endLineNumber: item.range.endLine,
                      endColumn: item.range.endColumn,
                    }
                  : defaultRange,
              })),
              incomplete: true,
            };
          },
        });
        monacoInstance.languages.registerHoverProvider(language, {
          provideHover: async (model, position, token) => {
            const relativePath = pathForModel(model);
            if (!relativePath) return null;
            await lspSyncNow(relativePath, model.getValue());
            if (token.isCancellationRequested) return null;
            const hover = await window.touwa.lsp
              .hover(relativePath, position.lineNumber, position.column)
              .catch(() => null);
            if (!hover || token.isCancellationRequested) return null;
            return {
              contents: [{ value: hover.contents }],
              range: hover.range
                ? new monacoInstance.Range(
                    hover.range.startLine,
                    hover.range.startColumn,
                    hover.range.endLine,
                    hover.range.endColumn,
                  )
                : undefined,
            };
          },
        });
        monacoInstance.languages.registerSignatureHelpProvider(language, {
          signatureHelpTriggerCharacters: ["(", ","],
          provideSignatureHelp: async (model, position, token) => {
            const relativePath = pathForModel(model);
            if (!relativePath) return null;
            await lspSyncNow(relativePath, model.getValue());
            if (token.isCancellationRequested) return null;
            const help = await window.touwa.lsp
              .signatureHelp(
                relativePath,
                position.lineNumber,
                position.column,
              )
              .catch(() => null);
            if (!help || token.isCancellationRequested) return null;
            return {
              value: {
                signatures: help.signatures.map((signature) => ({
                  label: signature.label,
                  documentation: signature.documentation
                    ? { value: signature.documentation }
                    : undefined,
                  parameters: signature.parameters.map((parameter) => ({
                    label: parameter.label,
                    documentation: parameter.documentation
                      ? { value: parameter.documentation }
                      : undefined,
                  })),
                })),
                activeSignature: help.activeSignature,
                activeParameter: help.activeParameter,
              },
              dispose: () => {},
            };
          },
        });
      }
    },
    [lspSyncNow, pathForModel],
  );

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
        // The main process keys language-server documents by root;
        // diagnostics from the previous workspace no longer apply.
        setLspDiagnostics(new Map());
        setBreakpoints(new Map());
        setPausedFrame(null);
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
        lspOpen(existing.relativePath, existing.content);
        setStatus(`Opened ${entry.name}`);
        return;
      }
      try {
        const snapshot = await window.touwa.file.read(entry.relativePath);
        const nextTab = createTab(entry.relativePath, snapshot);
        setGroups((prev) =>
          openTabInGroup(prev, groupId ?? prev.activeGroupId, nextTab),
        );
        lspOpen(entry.relativePath, snapshot.content);
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
      lspSyncChange(current.relativePath, snapshot.content);
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
    // The same file can be open in another group (split); only close
    // the language-server document when the last tab for it goes away.
    const stillOpen = groupsRef.current.groups
      .flatMap((g) => g.tabs)
      .some(
        (t) => t.id !== target.id && t.relativePath === target.relativePath,
      );
    if (!stillOpen) lspClose(target.relativePath);
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
    const openTabs = groupsRef.current.groups.flatMap((g) => g.tabs);
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
      // Re-sync language-server documents under their new paths.
      for (const openTab of openTabs) {
        const affected =
          entry.kind === "directory"
            ? openTab.relativePath.startsWith(`${entry.relativePath}/`)
            : openTab.relativePath === entry.relativePath;
        if (!affected) continue;
        const renamedPath =
          newPath + openTab.relativePath.slice(entry.relativePath.length);
        lspClose(openTab.relativePath);
        lspOpen(renamedPath, openTab.content);
      }
      // Breakpoints follow the rename as well.
      setBreakpoints((prev) => {
        const next = new Map<string, number[]>();
        for (const [bpPath, lines] of prev) {
          const affected =
            entry.kind === "directory"
              ? bpPath.startsWith(`${entry.relativePath}/`)
              : bpPath === entry.relativePath;
          next.set(
            affected
              ? newPath + bpPath.slice(entry.relativePath.length)
              : bpPath,
            lines,
          );
        }
        return next;
      });
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
    const affectedPaths = new Set(
      groupsRef.current.groups
        .flatMap((g) => g.tabs)
        .filter((t) =>
          entry.kind === "directory"
            ? t.relativePath.startsWith(`${entry.relativePath}/`)
            : t.relativePath === entry.relativePath,
        )
        .map((t) => t.relativePath),
    );
    try {
      await window.touwa.workspace.delete(entry.relativePath);
      setGroups((prev) =>
        closeTabsForPath(prev, entry.relativePath, entry.kind === "directory"),
      );
      for (const affectedPath of affectedPaths) lspClose(affectedPath);
      // Breakpoints on deleted files are dropped.
      setBreakpoints((prev) => {
        const next = new Map<string, number[]>();
        for (const [bpPath, lines] of prev) {
          const affected =
            entry.kind === "directory"
              ? bpPath.startsWith(`${entry.relativePath}/`)
              : bpPath === entry.relativePath;
          if (!affected) next.set(bpPath, lines);
        }
        return next;
      });
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
      id: "show-debug",
      title: "View: Show Debug",
      shortcut: "Ctrl+Shift+D",
      run: () => {
        setSidebarVisible(true);
        setPane("debug");
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
      } else if (key === "d" && e.shiftKey) {
        e.preventDefault();
        setSidebarVisible(true);
        setPane("debug");
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
          <div
            className={`activity-icon ${sidebarVisible && pane === "debug" ? "active" : ""}`}
            title="Debug (Ctrl+Shift+D)"
            onClick={() => {
              setSidebarVisible(true);
              setPane("debug");
            }}
          >
            DB
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
                    lspSyncChange(file.relativePath, snapshot.content);
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
              lspDiagnostics={lspDiagnostics}
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
          ) : pane === "terminal" ? (
            <TerminalPanel
              onStart={() => window.touwa.terminal.start()}
              onWrite={(id, data) => window.touwa.terminal.write(id, data)}
              onKill={(id) => window.touwa.terminal.kill(id)}
              onData={(callback) => window.touwa.terminal.onData(callback)}
              onExit={(callback) => window.touwa.terminal.onExit(callback)}
            />
          ) : (
            <DebugPanel
              activePath={tab?.relativePath ?? ""}
              breakpoints={[...breakpoints.entries()].flatMap(
                ([relativePath, lines]) =>
                  lines.map(
                    (line): DebugBreakpoint => ({ relativePath, line }),
                  ),
              )}
              onStart={(script) =>
                window.touwa.debug.start(
                  script,
                  [...breakpointsRef.current.entries()].flatMap(
                    ([relativePath, lines]) =>
                      lines.map(
                        (line): DebugBreakpoint => ({ relativePath, line }),
                      ),
                  ),
                )
              }
              onStop={() => window.touwa.debug.stop()}
              onResume={() => window.touwa.debug.resume()}
              onStepOver={() => window.touwa.debug.stepOver()}
              onStepInto={() => window.touwa.debug.stepInto()}
              onStepOut={() => window.touwa.debug.stepOut()}
              onPause={() => window.touwa.debug.pause()}
              onFrameVariables={(frameIndex) =>
                window.touwa.debug.frameVariables(frameIndex)
              }
              onVariables={(ref) => window.touwa.debug.variables(ref)}
              onState={(callback) => window.touwa.debug.onState(callback)}
              onOutput={(callback) => window.touwa.debug.onOutput(callback)}
              onJumpTo={(relativePath, line, column) => {
                const entry: FileEntry = {
                  name: relativePath.split("/").pop() ?? relativePath,
                  relativePath,
                  kind: "file",
                };
                void openFile(entry, undefined, line, column);
              }}
              onRemoveBreakpoint={(relativePath, line) =>
                toggleBreakpoint(relativePath, line)
              }
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
                      onChange={(v) => {
                        const text = v ?? "";
                        setGroups((prev) =>
                          updateTabContent(
                            prev,
                            editorGroup.id,
                            groupTab.id,
                            text,
                          ),
                        );
                        lspSyncChange(groupTab.relativePath, text);
                      }}
                      onMount={(instance, monacoInstance) => {
                        monacoRef.current = monacoInstance;
                        registerLspProviders(monacoInstance);
                        editorsRef.current.set(groupTab.id, instance);
                        // Drop the reference when Monaco disposes the
                        // editor (tab closed), otherwise the map grows
                        // for the whole session and reveal() could act
                        // on a disposed instance.
                        instance.onDidDispose(() => {
                          editorsRef.current.delete(groupTab.id);
                          decorationCollectionsRef.current.delete(
                            groupTab.id,
                          );
                        });
                        // Clicking the glyph margin toggles a
                        // breakpoint for that line of this file.
                        instance.onMouseDown((e) => {
                          if (
                            e.target.type ===
                              monacoInstance.editor.MouseTargetType
                                .GUTTER_GLYPH_MARGIN &&
                            e.target.position
                          ) {
                            toggleBreakpoint(
                              groupTab.relativePath,
                              e.target.position.lineNumber,
                            );
                          }
                        });
                        applyEditorDecorations(groupTab.id);
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
                        glyphMargin: true,
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
