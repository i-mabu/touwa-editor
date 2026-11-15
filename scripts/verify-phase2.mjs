import { readFile } from "node:fs/promises";

const required = [
  [
    "src/main/workspace/workspace-service.ts",
    [
      "listDirectory",
      "statWorkspaceFile",
      "searchWorkspace",
      "replaceInWorkspace",
      "writeAtomic",
      "rename",
      "File changed on disk",
    ],
  ],
  [
    "src/main/workspace/watcher.ts",
    ["createWorkspaceWatcher", "fs.watch", "DEBOUNCE_MS"],
  ],
  [
    "src/main/ipc/register-ipc.ts",
    [
      "workspace:listDir",
      "workspace:search",
      "workspace:replace",
      "file:stat",
      "workspace:changed",
    ],
  ],
  [
    "src/preload/preload.ts",
    ["listDir", "onChanged", "file:stat", "search", "replace"],
  ],
  [
    "src/renderer/state/tabs.ts",
    ["splitActiveTabRight", "closeGroup", "externalChanged", "isDirty"],
  ],
  ["src/renderer/components/Explorer.tsx", ["onListDir", "expanded"]],
  [
    "src/renderer/components/SearchPanel.tsx",
    ["onSearch", "onReplaceAll", "regex"],
  ],
  [
    "src/renderer/App.tsx",
    [
      "multiCursorModifier",
      "Split Right",
      "conflict-banner",
      "Save All",
      "CommandPalette",
      "QuickOpen",
      "activateNextTab",
      "editor.action.gotoLine",
    ],
  ],
  [
    "src/renderer/components/CommandPalette.tsx",
    ["fuzzyFilter", "PaletteCommand"],
  ],
  [
    "src/renderer/components/QuickOpen.tsx",
    ["fuzzyFilter", "Type a file name"],
  ],
  ["src/renderer/state/fuzzy.ts", ["fuzzyScore", "fuzzyFilter"]],
  [
    "src/main/workspace/workspace-service.ts",
    [
      "listWorkspaceFiles",
      "createWorkspaceEntry",
      "renameWorkspaceEntry",
      "deleteWorkspaceEntry",
    ],
  ],
];

for (const [file, tokens] of required) {
  const text = await readFile(file, "utf8");
  for (const token of tokens) {
    if (!text.includes(token))
      throw new Error(`Phase 2 check missing in ${file}: ${token}`);
  }
}

// Safety: Renderer must still not import Node.js APIs directly.
const app = await readFile("src/renderer/App.tsx", "utf8");
for (const forbidden of ["node:fs", "node:path", "child_process"]) {
  if (app.includes(forbidden))
    throw new Error(`Renderer must not use ${forbidden}`);
}

console.log("verify:phase2 passed");
