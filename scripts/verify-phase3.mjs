import { readFile } from "node:fs/promises";

const required = [
  [
    "src/main/process/process-runner.ts",
    [
      "runProcess",
      "shell: false",
      "timedOut",
      "Failed to start",
      "A bare executable name is required.",
    ],
  ],
  [
    "src/main/git/git-service.ts",
    [
      "parseGitStatusPorcelainV2",
      "parseGitLog",
      "getGitStatus",
      "getGitLog",
      "stageFiles",
      "unstageFiles",
      "discardChanges",
      "commitChanges",
      "--porcelain=v2",
      "--no-optional-locks",
      "assertWorkspacePath",
      "fetchRemote",
      "pullChanges",
      "pushChanges",
      "GIT_TERMINAL_PROMPT",
    ],
  ],
  [
    "src/main/ipc/register-ipc.ts",
    [
      "git:status",
      "git:log",
      "git:stage",
      "git:unstage",
      "git:discard",
      "git:commit",
      "Invalid log limit.",
      "Invalid path list.",
      "git:fetch",
      "git:pull",
      "git:push",
      "lsp:open",
      "lsp:change",
      "lsp:close",
    ],
  ],
  [
    "src/preload/preload.ts",
    [
      "git",
      "git:status",
      "git:log",
      "git:stage",
      "git:commit",
      "git:fetch",
      "git:pull",
      "git:push",
      "diagnostics:run",
      "tasks:list",
      "tasks:run",
      "terminal:start",
      "terminal:data",
      "terminal:exit",
      "lsp:open",
      "lsp:change",
      "lsp:close",
      "lsp:diagnostics",
      "LspDiagnosticsEvent",
      "GitStatus",
      "GitCommit",
    ],
  ],
  [
    "src/main/lsp/lsp-client.ts",
    [
      "LspClient",
      "encodeLspMessage",
      "LspMessageParser",
      "Content-Length",
      "initialize",
    ],
  ],
  [
    "src/main/lsp/lsp-service.ts",
    [
      "LspService",
      "lspService",
      "mapPublishDiagnostics",
      "typescript-language-server",
      "languageIdForPath",
    ],
  ],
  [
    "src/renderer/components/ProblemsPanel.tsx",
    ["PROBLEMS", "lspDiagnostics", "onRunDiagnostics", "onJumpTo"],
  ],
  [
    "src/renderer/components/types.ts",
    ["isLspLanguagePath", "Diagnostic", "DiagnosticsResult"],
  ],
  [
    "src/renderer/components/GitPanel.tsx",
    [
      "SOURCE CONTROL",
      "onLoadStatus",
      "onLoadLog",
      "onOpenFile",
      "onStage",
      "onUnstage",
      "onDiscard",
      "onCommit",
      "onFetch",
      "onPull",
      "onPush",
      "コミット",
      "プッシュ",
    ],
  ],
  [
    "src/main/tasks/tasks-service.ts",
    ["parseTasksFile", "loadTasks", "runTask", "tasks.json"],
  ],
  [
    "src/renderer/components/TasksPanel.tsx",
    ["TASKS", "onListTasks", "onRunTask"],
  ],
  [
    "src/main/process/session-manager.ts",
    ["SessionManager", "shell: false", "Failed to start", "onBinaryData"],
  ],
  [
    "src/main/terminal/terminal-service.ts",
    ["TerminalService", "shellCandidates", "powershell", "terminalService"],
  ],
  [
    "src/renderer/components/TerminalPanel.tsx",
    ["TERMINAL", "onStart", "onWrite", "onKill", "onData", "onExit"],
  ],
  [
    "src/renderer/App.tsx",
    [
      "GitPanel",
      "ProblemsPanel",
      "Ctrl+Shift+G",
      "Ctrl+Shift+M",
      '"problems"',
      "TasksPanel",
      '"tasks"',
      "lspDiagnostics",
      "lspSyncChange",
      "window.touwa.lsp",
      "TerminalPanel",
      '"terminal"',
    ],
  ],
];

let failed = false;
for (const [file, needles] of required) {
  const text = await readFile(file, "utf8");
  for (const needle of needles) {
    if (!text.includes(needle)) {
      console.error(`verify:phase3: ${file} is missing: ${needle}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log("verify:phase3 passed");
