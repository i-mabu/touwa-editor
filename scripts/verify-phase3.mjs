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
      "--porcelain=v2",
      "--no-optional-locks",
    ],
  ],
  [
    "src/main/ipc/register-ipc.ts",
    ["git:status", "git:log", "Invalid log limit."],
  ],
  [
    "src/preload/preload.ts",
    ["git", "git:status", "git:log", "GitStatus", "GitCommit"],
  ],
  [
    "src/renderer/components/GitPanel.tsx",
    ["SOURCE CONTROL", "onLoadStatus", "onLoadLog", "onOpenFile"],
  ],
  ["src/renderer/App.tsx", ["GitPanel", "Ctrl+Shift+G", '"git"']],
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
