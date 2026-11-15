// Phase 2 runtime tests for the Renderer tab / editor-group model.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeTab,
  closeGroup,
  closeTab,
  createTab,
  emptyGroups,
  isDirty,
  markTabExternalChanged,
  markTabSaved,
  openTabInGroup,
  splitActiveTabRight,
  updateTabContent,
} from "../src/renderer/state/tabs.ts";

const snapshot = (content) => ({
  content,
  mtimeMs: 1000,
  size: content.length,
  hash: "abc",
});

test("opening the same file twice focuses the existing tab", () => {
  let state = emptyGroups();
  const tab = createTab("src/a.ts", snapshot("hello"));
  state = openTabInGroup(state, state.activeGroupId, tab);
  assert.equal(state.groups[0].tabs.length, 1);
  assert.equal(activeTab(state)?.relativePath, "src/a.ts");
  const again = createTab("src/a.ts", snapshot("hello"));
  state = openTabInGroup(state, state.activeGroupId, again);
  assert.equal(state.groups[0].tabs.length, 1);
  assert.equal(activeTab(state)?.id, tab.id);
});

test("dirty tracking, save and external-change flags", () => {
  let state = emptyGroups();
  const tab = createTab("src/a.ts", snapshot("hello"));
  state = openTabInGroup(state, state.activeGroupId, tab);
  assert.equal(isDirty(activeTab(state)), false);
  state = updateTabContent(state, state.activeGroupId, tab.id, "hello!");
  assert.equal(isDirty(activeTab(state)), true);
  state = markTabSaved(state, state.activeGroupId, tab.id, snapshot("hello!"));
  assert.equal(isDirty(activeTab(state)), false);
  state = markTabExternalChanged(state, "src/a.ts");
  assert.equal(activeTab(state)?.externalChanged, true);
});

test("split moves the active tab to a second group; closing merges back", () => {
  let state = emptyGroups();
  const a = createTab("src/a.ts", snapshot("a"));
  const b = createTab("src/b.ts", snapshot("b"));
  state = openTabInGroup(state, state.activeGroupId, a);
  state = openTabInGroup(state, state.activeGroupId, b);
  assert.equal(state.groups[0].tabs.length, 2);
  state = splitActiveTabRight(state);
  assert.equal(state.groups.length, 2);
  assert.equal(state.groups[0].tabs.length, 1);
  assert.equal(state.groups[1].tabs[0]?.relativePath, "src/b.ts");
  assert.equal(activeTab(state)?.relativePath, "src/b.ts");
  // A third split is a no-op at the Phase 2 limit of 2 groups.
  state = splitActiveTabRight(state);
  assert.equal(state.groups.length, 2);
  state = closeGroup(state, "group-2");
  assert.equal(state.groups.length, 1);
  assert.equal(state.groups[0].tabs.length, 2);
});

test("closing the active tab activates its neighbour", () => {
  let state = emptyGroups();
  const a = createTab("src/a.ts", snapshot("a"));
  const b = createTab("src/b.ts", snapshot("b"));
  state = openTabInGroup(state, state.activeGroupId, a);
  state = openTabInGroup(state, state.activeGroupId, b);
  state = closeTab(state, state.activeGroupId, b.id);
  assert.equal(activeTab(state)?.relativePath, "src/a.ts");
});

test("closing a middle tab activates the tab that takes its place, not the last tab", () => {
  let state = emptyGroups();
  const a = createTab("src/a.ts", snapshot("a"));
  const b = createTab("src/b.ts", snapshot("b"));
  const c = createTab("src/c.ts", snapshot("c"));
  state = openTabInGroup(state, state.activeGroupId, a);
  state = openTabInGroup(state, state.activeGroupId, b);
  state = openTabInGroup(state, state.activeGroupId, c);
  // Make the first tab active, then close it: the editor used to jump
  // to the last tab (c) instead of the neighbour (b).
  state = {
    ...state,
    groups: state.groups.map((g) => ({ ...g, activeTabId: a.id })),
  };
  state = closeTab(state, state.activeGroupId, a.id);
  assert.equal(activeTab(state)?.relativePath, "src/b.ts");
});
