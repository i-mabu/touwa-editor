import type { FileSnapshot } from "../components/types.ts";

export type TabState = {
  id: string;
  relativePath: string;
  name: string;
  content: string;
  savedContent: string;
  savedMtimeMs: number;
  savedHash: string;
  /** Disk changed after this tab was opened / last saved. */
  externalChanged: boolean;
};

export type EditorGroupState = {
  id: string;
  tabs: TabState[];
  activeTabId: string | null;
};

export type GroupsState = { groups: EditorGroupState[]; activeGroupId: string };

export function isDirty(tab: TabState): boolean {
  return tab.content !== tab.savedContent;
}

export function createTab(
  relativePath: string,
  snapshot: FileSnapshot,
): TabState {
  return {
    id: `${relativePath}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    relativePath,
    name: relativePath.split("/").pop() ?? relativePath,
    content: snapshot.content,
    savedContent: snapshot.content,
    savedMtimeMs: snapshot.mtimeMs,
    savedHash: snapshot.hash,
    externalChanged: false,
  };
}

export function emptyGroups(): GroupsState {
  return {
    groups: [{ id: "group-1", tabs: [], activeTabId: null }],
    activeGroupId: "group-1",
  };
}

export function activeGroup(state: GroupsState): EditorGroupState {
  return (
    state.groups.find((group) => group.id === state.activeGroupId) ??
    state.groups[0]!
  );
}

export function activeTab(state: GroupsState): TabState | null {
  const group = activeGroup(state);
  return group.tabs.find((tab) => tab.id === group.activeTabId) ?? null;
}

export function findTab(
  state: GroupsState,
  relativePath: string,
): { group: EditorGroupState; tab: TabState } | null {
  for (const group of state.groups) {
    const tab = group.tabs.find(
      (candidate) => candidate.relativePath === relativePath,
    );
    if (tab) return { group, tab };
  }
  return null;
}

/** Open a tab in the given group, or focus it if it is already open anywhere. */
export function openTabInGroup(
  state: GroupsState,
  groupId: string,
  tab: TabState,
): GroupsState {
  const existing = findTab(state, tab.relativePath);
  if (existing) {
    return {
      ...state,
      activeGroupId: existing.group.id,
      groups: state.groups.map((group) =>
        group.id === existing.group.id
          ? { ...group, activeTabId: existing.tab.id }
          : group,
      ),
    };
  }
  return {
    ...state,
    activeGroupId: groupId,
    groups: state.groups.map((group) =>
      group.id === groupId
        ? { ...group, tabs: [...group.tabs, tab], activeTabId: tab.id }
        : group,
    ),
  };
}

export function closeTab(
  state: GroupsState,
  groupId: string,
  tabId: string,
): GroupsState {
  return {
    ...state,
    groups: state.groups.map((group) => {
      if (group.id !== groupId) return group;
      const index = group.tabs.findIndex((tab) => tab.id === tabId);
      const tabs = group.tabs.filter((tab) => tab.id !== tabId);
      // 🗂️ Activate the neighbour that slides into the closed tab's place
      // (or the new last tab), not the group's last tab: closing a
      // middle tab used to jump the editor to the end of the tab bar.
      const activeTabId =
        group.activeTabId === tabId
          ? (tabs[Math.min(Math.max(index, 0), tabs.length - 1)]?.id ?? null)
          : group.activeTabId;
      return { ...group, tabs, activeTabId };
    }),
  };
}

export function updateTabContent(
  state: GroupsState,
  groupId: string,
  tabId: string,
  content: string,
): GroupsState {
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            tabs: group.tabs.map((tab) =>
              tab.id === tabId ? { ...tab, content } : tab,
            ),
          }
        : group,
    ),
  };
}

export function markTabSaved(
  state: GroupsState,
  groupId: string,
  tabId: string,
  snapshot: FileSnapshot,
): GroupsState {
  return {
    ...state,
    groups: state.groups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            tabs: group.tabs.map((tab) =>
              tab.id === tabId
                ? {
                    ...tab,
                    savedContent: snapshot.content,
                    savedMtimeMs: snapshot.mtimeMs,
                    savedHash: snapshot.hash,
                    externalChanged: false,
                  }
                : tab,
            ),
          }
        : group,
    ),
  };
}

export function markTabExternalChanged(
  state: GroupsState,
  relativePath: string,
): GroupsState {
  return {
    ...state,
    groups: state.groups.map((group) => ({
      ...group,
      tabs: group.tabs.map((tab) =>
        tab.relativePath === relativePath
          ? { ...tab, externalChanged: true }
          : tab,
      ),
    })),
  };
}

export function reloadTab(
  state: GroupsState,
  relativePath: string,
  snapshot: FileSnapshot,
): GroupsState {
  return {
    ...state,
    groups: state.groups.map((group) => ({
      ...group,
      tabs: group.tabs.map((tab) =>
        tab.relativePath === relativePath
          ? {
              ...tab,
              content: snapshot.content,
              savedContent: snapshot.content,
              savedMtimeMs: snapshot.mtimeMs,
              savedHash: snapshot.hash,
              externalChanged: false,
            }
          : tab,
      ),
    })),
  };
}

/** Rename a file tab, or every tab under a renamed directory. */
export function renameTabs(
  state: GroupsState,
  oldPath: string,
  newPath: string,
  isDirectory: boolean,
): GroupsState {
  const renameOne = (relativePath: string): string => {
    if (!isDirectory) return relativePath === oldPath ? newPath : relativePath;
    if (relativePath === oldPath) return newPath;
    return relativePath.startsWith(`${oldPath}/`)
      ? newPath + relativePath.slice(oldPath.length)
      : relativePath;
  };
  return {
    ...state,
    groups: state.groups.map((group) => ({
      ...group,
      tabs: group.tabs.map((tab) => {
        const next = renameOne(tab.relativePath);
        return next === tab.relativePath
          ? tab
          : { ...tab, relativePath: next, name: next.split("/").pop() ?? next };
      }),
    })),
  };
}

/** Close tabs for a deleted file, or every tab under a deleted directory. */
export function closeTabsForPath(
  state: GroupsState,
  relativePath: string,
  isDirectory: boolean,
): GroupsState {
  const matches = (tabPath: string): boolean =>
    isDirectory
      ? tabPath === relativePath || tabPath.startsWith(`${relativePath}/`)
      : tabPath === relativePath;
  return {
    ...state,
    groups: state.groups.map((group) => {
      const tabs = group.tabs.filter((tab) => !matches(tab.relativePath));
      const activeTabId =
        group.activeTabId && tabs.some((tab) => tab.id === group.activeTabId)
          ? group.activeTabId
          : (tabs[tabs.length - 1]?.id ?? null);
      return { ...group, tabs, activeTabId };
    }),
  };
}

/** VS Code-style Ctrl+Tab / Ctrl+Shift+Tab cycling within the active group. */
export function activateNextTab(
  state: GroupsState,
  direction: 1 | -1,
): GroupsState {
  const group = activeGroup(state);
  if (group.tabs.length <= 1) return state;
  const index = group.tabs.findIndex((tab) => tab.id === group.activeTabId);
  const next =
    group.tabs[(index + direction + group.tabs.length) % group.tabs.length]!;
  return {
    ...state,
    groups: state.groups.map((candidate) =>
      candidate.id === group.id
        ? { ...candidate, activeTabId: next.id }
        : candidate,
    ),
  };
}

/** Split the active tab into a second group (Phase 2 limit: at most 2 groups). */
export function splitActiveTabRight(state: GroupsState): GroupsState {
  if (state.groups.length >= 2) return state;
  const group = activeGroup(state);
  const tab = group.tabs.find(
    (candidate) => candidate.id === group.activeTabId,
  );
  if (!tab) return state;
  const second: EditorGroupState = {
    id: "group-2",
    tabs: [tab],
    activeTabId: tab.id,
  };
  const first: EditorGroupState = {
    ...group,
    tabs: group.tabs.filter((candidate) => candidate.id !== tab.id),
    activeTabId:
      group.tabs.filter((candidate) => candidate.id !== tab.id).at(-1)?.id ??
      null,
  };
  return { groups: [first, second], activeGroupId: second.id };
}

export function closeGroup(state: GroupsState, groupId: string): GroupsState {
  if (state.groups.length <= 1) return state;
  const closing = state.groups.find((group) => group.id === groupId);
  const remaining = state.groups.filter((group) => group.id !== groupId);
  if (!closing || remaining.length === 0) return state;
  const target = remaining[0]!;
  const merged: EditorGroupState = {
    ...target,
    tabs: [
      ...target.tabs,
      ...closing.tabs.filter(
        (tab) => !target.tabs.some((t) => t.relativePath === tab.relativePath),
      ),
    ],
    activeTabId: target.activeTabId ?? closing.activeTabId,
  };
  return { groups: [merged], activeGroupId: merged.id };
}
