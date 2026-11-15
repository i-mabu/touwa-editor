// VS Code-style UX tests: fuzzy matching and tab cycling / rename / close.
// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fuzzyFilter, fuzzyScore } from "../src/renderer/state/fuzzy.ts";
import {
  activateNextTab,
  closeTabsForPath,
  createTab,
  emptyGroups,
  openTabInGroup,
  renameTabs,
  activeTab,
} from "../src/renderer/state/tabs.ts";
import {
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  listWorkspaceFiles,
  renameWorkspaceEntry,
} from "../src/main/workspace/workspace-service.ts";

const snapshot = (content) => ({
  content,
  mtimeMs: 1000,
  size: content.length,
  hash: "abc",
});

test("fuzzyScore matches subsequences and prefers the better candidate", () => {
  assert.equal(fuzzyScore("app", "src/renderer/App.tsx") !== null, true);
  assert.equal(fuzzyScore("xyz", "src/renderer/App.tsx"), null);
  assert.equal(fuzzyScore("", "anything"), 0);
  const ranked = fuzzyFilter(
    "ap",
    ["src/renderer/App.tsx", "src/main/main.ts", "README.md"],
    (s) => s,
  );
  assert.equal(ranked[0], "src/renderer/App.tsx");
});

test("Ctrl+Tab cycles tabs and wraps around", () => {
  let state = emptyGroups();
  const a = createTab("src/a.ts", snapshot("a"));
  const b = createTab("src/b.ts", snapshot("b"));
  const c = createTab("src/c.ts", snapshot("c"));
  state = openTabInGroup(state, state.activeGroupId, a);
  state = openTabInGroup(state, state.activeGroupId, b);
  state = openTabInGroup(state, state.activeGroupId, c);
  assert.equal(activeTab(state)?.relativePath, "src/c.ts");
  state = activateNextTab(state, 1);
  assert.equal(activeTab(state)?.relativePath, "src/a.ts");
  state = activateNextTab(state, -1);
  assert.equal(activeTab(state)?.relativePath, "src/c.ts");
});

test("rename updates file tabs and every tab under a renamed directory", () => {
  let state = emptyGroups();
  const a = createTab("src/a.ts", snapshot("a"));
  const b = createTab("src/nested/b.ts", snapshot("b"));
  state = openTabInGroup(state, state.activeGroupId, a);
  state = openTabInGroup(state, state.activeGroupId, b);
  state = renameTabs(state, "src/a.ts", "src/renamed.ts", false);
  assert.deepEqual(state.groups[0].tabs.map((t) => t.relativePath).sort(), [
    "src/nested/b.ts",
    "src/renamed.ts",
  ]);
  state = renameTabs(state, "src/nested", "src/moved", true);
  assert.deepEqual(state.groups[0].tabs.map((t) => t.relativePath).sort(), [
    "src/moved/b.ts",
    "src/renamed.ts",
  ]);
  state = closeTabsForPath(state, "src/moved", true);
  assert.deepEqual(
    state.groups[0].tabs.map((t) => t.relativePath),
    ["src/renamed.ts"],
  );
});

test("workspace create / rename / delete stay inside the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-vscode-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "a");
  const created = await createWorkspaceEntry(root, "src/b.ts", "file");
  assert.equal(created.relativePath, "src/b.ts");
  await assert.rejects(
    () => createWorkspaceEntry(root, "src/b.ts", "file"),
    /already exists/,
  );
  await assert.rejects(
    () => createWorkspaceEntry(root, "../outside.ts", "file"),
    /outside/,
  );
  const renamed = await renameWorkspaceEntry(root, "src/b.ts", "src/c.ts");
  assert.equal(renamed.relativePath, "src/c.ts");
  await assert.rejects(
    () => renameWorkspaceEntry(root, "src/c.ts", "../evil.ts"),
    /outside/,
  );
  const files = await listWorkspaceFiles(root);
  assert.deepEqual(files, ["src/a.ts", "src/c.ts"]);
  await deleteWorkspaceEntry(root, "src/c.ts");
  assert.deepEqual(await listWorkspaceFiles(root), ["src/a.ts"]);
  await assert.rejects(() => deleteWorkspaceEntry(root, ""), /root/);
  await assert.rejects(
    () => deleteWorkspaceEntry(root, ".git"),
    /cannot be changed/,
  );
});
