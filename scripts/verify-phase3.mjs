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
      "GitStatus",
      "GitCommit",
    ],
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
    "src/renderer/App.tsx",
    [
      "GitPanel",
      "ProblemsPanel",
      "Ctrl+Shift+G",
      "Ctrl+Shift+M",
      '"problems"',
      "TasksPanel",
      '"tasks"',
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
