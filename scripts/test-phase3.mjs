// Phase 3 runtime tests: the shared process runner and the Git service.
// Run with: npm test   (Node >= 22.18 runs the TypeScript sources directly.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runProcess,
  clampTimeout,
} from "../src/main/process/process-runner.ts";
import {
  parseGitStatusPorcelainV2,
  parseGitLog,
  getGitStatus,
  getGitLog,
} from "../src/main/git/git-service.ts";

const execFileAsync = promisify(execFile);

test("runProcess captures stdout/stderr separately and reports the exit code", async () => {
  const ok = await runProcess({
    command: "node",
    args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
    cwd: tmpdir(),
  });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout, "out");
  assert.equal(ok.stderr, "err");
  assert.equal(ok.timedOut, false);

  const failing = await runProcess({
    command: "node",
    args: ["-e", "process.exit(3)"],
    cwd: tmpdir(),
  });
  assert.equal(failing.exitCode, 3);
});

test("runProcess enforces the timeout and the output cap", async () => {
  const slow = await runProcess({
    command: "node",
    args: ["-e", "setTimeout(() => {}, 30_000)"],
    cwd: tmpdir(),
    timeoutMs: 150,
  });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.exitCode, null);

  const loud = await runProcess({
    command: "node",
    args: ["-e", "process.stdout.write('x'.repeat(10_000))"],
    cwd: tmpdir(),
    maxOutputBytes: 100,
  });
  assert.equal(loud.stdout.length, 100);
  assert.equal(loud.stdoutTruncated, true);
});

test("runProcess rejects unsafe invocations before spawning", async () => {
  await assert.rejects(
    () => runProcess({ command: "../bin/sh", args: [], cwd: tmpdir() }),
    /bare executable/,
  );
  await assert.rejects(
    () => runProcess({ command: "node", args: ["a\0b"], cwd: tmpdir() }),
    /Invalid process arguments/,
  );
  await assert.rejects(
    () =>
      runProcess({
        command: "node",
        args: [],
        cwd: path.join(tmpdir(), "touwa-no-such-dir-xyz"),
      }),
    /does not exist/,
  );
  await assert.rejects(
    () =>
      runProcess({
        command: "touwa-no-such-command-xyz",
        args: [],
        cwd: tmpdir(),
      }),
    /Failed to start/,
  );
  assert.throws(() => clampTimeout(0), /Invalid timeout/);
  assert.equal(clampTimeout(10_000_000), 120_000);
});

test("parseGitStatusPorcelainV2 parses branch, changes, renames, untracked", () => {
  const output = [
    "# branch.oid 1234567890abcdef1234567890abcdef12345678",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
    "1 M. N... 100644 100644 100644 aaaa bbbb staged.ts",
    "1 .M N... 100644 100644 100644 aaaa bbbb dirty file.ts",
    "1 A. N... 000000 100644 100644 0000 bbbb added.ts",
    "2 R. N... 100644 100644 100644 aaaa bbbb R100 new-name.ts\told-name.ts",
    "u UU N... 100644 100644 100644 aaaa bbbb cccc conflict.ts",
    "? untracked.ts",
    "! ignored.log",
    "",
  ].join("\n");
  const status = parseGitStatusPorcelainV2(output);
  assert.equal(status.isRepository, true);
  assert.equal(status.branch, "main");
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.equal(status.entries.length, 7);
  const byPath = new Map(status.entries.map((e) => [e.relativePath, e]));
  assert.equal(byPath.get("staged.ts")?.indexStatus, "M");
  assert.equal(byPath.get("staged.ts")?.worktreeStatus, ".");
  assert.equal(byPath.get("dirty file.ts")?.worktreeStatus, "M");
  assert.equal(byPath.get("added.ts")?.indexStatus, "A");
  assert.equal(byPath.get("new-name.ts")?.kind, "renamed");
  assert.equal(byPath.get("new-name.ts")?.originalPath, "old-name.ts");
  assert.equal(byPath.get("conflict.ts")?.kind, "unmerged");
  assert.equal(byPath.get("untracked.ts")?.kind, "untracked");
  assert.equal(byPath.get("ignored.log")?.kind, "ignored");
});

test("parseGitLog parses the unit-separated format", () => {
  const output =
    "abcdef1234567890\u001fabcdef1\u001f初回コミット\u001fTaro\u001f1700000000\n" +
    "1234567890abcdef\u001f1234567\u001fsecond commit\u001fHanako\u001f1700000100\n";
  const commits = parseGitLog(output);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].shortHash, "abcdef1");
  assert.equal(commits[0].subject, "初回コミット");
  assert.equal(commits[0].authorTime, 1700000000);
  assert.deepEqual(parseGitLog(""), []);
});

async function makeGitRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-"));
  const git = (args) =>
    execFileAsync(
      "git",
      [
        "-c",
        "user.name=Touwa Test",
        "-c",
        "user.email=test@example.com",
        ...args,
      ],
      { cwd: root },
    );
  await git(["init", "-b", "main"]);
  await writeFile(path.join(root, "a.txt"), "hello\n");
  await git(["add", "a.txt"]);
  await git(["commit", "-m", "initial commit"]);
  return { root, git };
}

test("getGitStatus / getGitLog work against a real repository", async () => {
  const { root } = await makeGitRepo();
  await appendFile(path.join(root, "a.txt"), "changed\n");
  await writeFile(path.join(root, "b.txt"), "new\n");

  const status = await getGitStatus(root);
  assert.equal(status.isRepository, true);
  assert.equal(status.branch, "main");
  const byPath = new Map(status.entries.map((e) => [e.relativePath, e]));
  assert.equal(byPath.get("a.txt")?.worktreeStatus, "M");
  assert.equal(byPath.get("b.txt")?.kind, "untracked");

  const log = await getGitLog(root);
  assert.equal(log.length, 1);
  assert.equal(log[0].subject, "initial commit");
  assert.equal(log[0].authorName, "Touwa Test");
});

test("getGitStatus reports a plain folder as not a repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-plain-"));
  const status = await getGitStatus(root);
  assert.equal(status.isRepository, false);
  assert.deepEqual(status.entries, []);
  assert.deepEqual(await getGitLog(root), []);
});
