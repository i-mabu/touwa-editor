// Phase 3 runtime tests: the shared process runner and the Git service.
// Run with: npm test   (Node >= 22.18 runs the TypeScript sources directly.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  writeFile,
  appendFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
  stageFiles,
  unstageFiles,
  discardChanges,
  commitChanges,
  fetchRemote,
  pullChanges,
  pushChanges,
} from "../src/main/git/git-service.ts";
import {
  parseTscOutput,
  runDiagnostics,
} from "../src/main/diagnostics/diagnostics-service.ts";
import {
  parseTasksFile,
  loadTasks,
  runTask,
} from "../src/main/tasks/tasks-service.ts";
import { SessionManager } from "../src/main/process/session-manager.ts";
import {
  TerminalService,
  shellCandidates,
} from "../src/main/terminal/terminal-service.ts";
import {
  LspClient,
  LspMessageParser,
  encodeLspMessage,
} from "../src/main/lsp/lsp-client.ts";
import {
  LspService,
  languageIdForPath,
  mapCompletionResult,
  mapHoverResult,
  mapLspDiagnostic,
  mapPublishDiagnostics,
  mapSignatureHelpResult,
  markupToText,
} from "../src/main/lsp/lsp-service.ts";
import {
  DebugService,
  allocatePort,
  isDebuggablePath,
  mapCallFrame,
  mapRemoteProperties,
  urlToRelativePath,
} from "../src/main/debug/debug-service.ts";

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

test("runProcess passes extra environment variables to the child", async () => {
  const result = await runProcess({
    command: "node",
    args: [
      "-e",
      "process.stdout.write(process.env.TOUWA_PHASE3_ENV ?? 'missing')",
    ],
    cwd: tmpdir(),
    env: { ...process.env, TOUWA_PHASE3_ENV: "hello-env" },
  });
  assert.equal(result.stdout, "hello-env");
  await assert.rejects(
    () =>
      runProcess({
        command: "node",
        args: [],
        cwd: tmpdir(),
        env: { "BAD=KEY": "x" },
      }),
    /Invalid process environment/,
  );
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
  // Repo-local identity so product-side `git commit` works on machines
  // (like CI runners) that have no global git identity configured.
  await git(["config", "user.name", "Touwa Test"]);
  await git(["config", "user.email", "test@example.com"]);
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

test("stage / unstage / discard / commit round-trip on a real repository", async () => {
  const { root } = await makeGitRepo();
  const byPath = (status) =>
    new Map(status.entries.map((e) => [e.relativePath, e]));

  // Stage a new file and commit it.
  await writeFile(path.join(root, "b.txt"), "new\n");
  let status = await stageFiles(root, ["b.txt"]);
  assert.equal(byPath(status).get("b.txt")?.indexStatus, "A");
  status = await commitChanges(root, "add b");
  assert.equal(status.entries.length, 0);
  let log = await getGitLog(root);
  assert.equal(log[0].subject, "add b");
  assert.equal(log.length, 2);

  // Modify, stage, then unstage: the change falls back to worktree-only.
  await appendFile(path.join(root, "b.txt"), "more\n");
  status = await stageFiles(root, ["b.txt"]);
  assert.equal(byPath(status).get("b.txt")?.indexStatus, "M");
  status = await unstageFiles(root, ["b.txt"]);
  assert.equal(byPath(status).get("b.txt")?.indexStatus, ".");
  assert.equal(byPath(status).get("b.txt")?.worktreeStatus, "M");

  // Discard restores the committed content.
  status = await discardChanges(root, ["b.txt"]);
  assert.equal(status.entries.length, 0);
});

test("unstage works in a repository with no commits yet", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-fresh-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await writeFile(path.join(root, "a.txt"), "hello\n");
  let status = await stageFiles(root, ["a.txt"]);
  assert.equal(status.entries[0]?.indexStatus, "A");
  status = await unstageFiles(root, ["a.txt"]);
  assert.equal(status.entries[0]?.kind, "untracked");
});

test("git mutations validate their input", async () => {
  const { root } = await makeGitRepo();
  await assert.rejects(() => stageFiles(root, []), /No paths/);
  await assert.rejects(() => stageFiles(root, ["../outside.txt"]), /outside/);
  await assert.rejects(() => stageFiles(root, ["/abs/path.txt"]), /relative/);
  await assert.rejects(() => commitChanges(root, "   "), /message is required/);
  await assert.rejects(
    () => commitChanges(root, "nothing staged"),
    /git commit failed/,
  );
});

test("fetch / pull / push sync against a local bare remote", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "touwa-phase3-remote-"));
  const remote = path.join(base, "remote.git");
  await execFileAsync("git", ["init", "--bare", "-b", "main", remote]);

  const { root: a, git: gitA } = await makeGitRepo();
  await gitA(["remote", "add", "origin", remote]);

  // First push sets the upstream automatically.
  let status = await pushChanges(a);
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.ahead, 0);

  // Clone B from the remote and give it a local identity.
  const b = path.join(base, "b");
  await execFileAsync("git", ["clone", remote, b]);
  const gitB = (args) =>
    execFileAsync(
      "git",
      [
        "-c",
        "user.name=Touwa Test",
        "-c",
        "user.email=test@example.com",
        ...args,
      ],
      { cwd: b },
    );
  await gitB(["config", "user.name", "Touwa Test"]);
  await gitB(["config", "user.email", "test@example.com"]);

  // A commits and pushes a second change.
  await appendFile(path.join(a, "a.txt"), "second\n");
  await stageFiles(a, ["a.txt"]);
  await commitChanges(a, "second commit");
  await pushChanges(a);

  // B fetches (behind becomes visible), then pulls fast-forward.
  status = await fetchRemote(b);
  assert.equal(status.behind, 1);
  status = await pullChanges(b);
  assert.equal(status.behind, 0);
  const log = await getGitLog(b);
  assert.equal(log[0].subject, "second commit");

  // A diverged pull is rejected instead of merging silently.
  await writeFile(path.join(b, "local.txt"), "local\n");
  await gitB(["add", "local.txt"]);
  await gitB(["commit", "-m", "local commit"]);
  await appendFile(path.join(a, "a.txt"), "third\n");
  await stageFiles(a, ["a.txt"]);
  await commitChanges(a, "third commit");
  await pushChanges(a);
  await fetchRemote(b);
  await assert.rejects(() => pullChanges(b), /git pull failed/);
});

test("parseTscOutput parses positioned and global diagnostics", () => {
  const output = [
    "src/bad.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/other.ts(12,3): warning TS6133: 'x' is declared but its value is never read.",
    "error TS18003: No inputs were found in config file 'tsconfig.json'.",
    "  The file is in the program because:",
    "    Root file specified for compilation",
    "",
  ].join("\n");
  const diagnostics = parseTscOutput(output);
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[0].relativePath, "src/bad.ts");
  assert.equal(diagnostics[0].line, 1);
  assert.equal(diagnostics[0].column, 7);
  assert.equal(diagnostics[0].severity, "error");
  assert.equal(diagnostics[0].code, "TS2322");
  assert.equal(diagnostics[1].severity, "warning");
  assert.equal(diagnostics[2].relativePath, "");
  assert.equal(diagnostics[2].code, "TS18003");
  assert.deepEqual(parseTscOutput(""), []);
});

test("runDiagnostics checks a real workspace with its own tsc", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-diag-"));
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["src"],
    }),
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "bad.ts"),
    'const n: number = "text";\n',
  );
  // Point the workspace at this repository's own TypeScript install,
  // the same layout a real workspace with typescript installed has.
  const repoTypescript = fileURLToPath(
    new URL("../node_modules/typescript", import.meta.url),
  );
  await mkdir(path.join(root, "node_modules"), { recursive: true });
  await symlink(
    repoTypescript,
    path.join(root, "node_modules", "typescript"),
    "junction",
  );

  const bad = await runDiagnostics(root);
  assert.equal(bad.available, true);
  assert.equal(bad.diagnostics.length, 1);
  assert.equal(bad.diagnostics[0].code, "TS2322");
  assert.equal(bad.diagnostics[0].relativePath, "src/bad.ts");
  assert.equal(bad.diagnostics[0].line, 1);

  await writeFile(path.join(root, "src", "bad.ts"), "const n: number = 42;\n");
  const clean = await runDiagnostics(root);
  assert.equal(clean.available, true);
  assert.equal(clean.diagnostics.length, 0);
});

test("runDiagnostics reports unavailable without a tsconfig", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-diag-none-"));
  const result = await runDiagnostics(root);
  assert.equal(result.available, false);
  assert.deepEqual(result.diagnostics, []);
});

test("parseTasksFile validates the tasks.json schema strictly", () => {
  const ok = parseTasksFile(
    JSON.stringify({
      tasks: [
        { label: "test", command: "npm", args: ["test"] },
        { label: "build", command: "npm", args: ["run", "build"], cwd: "." },
      ],
    }),
  );
  assert.equal(ok.length, 2);
  assert.equal(ok[0].cwd, ".");
  assert.throws(() => parseTasksFile("not json"), /JSON/);
  assert.throws(() => parseTasksFile("{}"), /tasks/);
  assert.throws(
    () =>
      parseTasksFile(
        JSON.stringify({
          tasks: [{ label: "x", command: "../bin/sh", args: [] }],
        }),
      ),
    /command/,
  );
  assert.throws(
    () =>
      parseTasksFile(
        JSON.stringify({
          tasks: [
            { label: "dup", command: "npm", args: [] },
            { label: "dup", command: "npm", args: [] },
          ],
        }),
      ),
    /重複/,
  );
  assert.throws(
    () =>
      parseTasksFile(
        JSON.stringify({
          tasks: [{ label: "x", command: "npm", args: "test" }],
        }),
      ),
    /args/,
  );
});

test("loadTasks / runTask execute a declared task end to end", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-tasks-"));
  // No file yet: an empty, error-free list.
  const empty = await loadTasks(root);
  assert.deepEqual(empty, { tasks: [], error: null });

  await mkdir(path.join(root, ".touwa"), { recursive: true });
  await writeFile(
    path.join(root, ".touwa", "tasks.json"),
    JSON.stringify({
      tasks: [
        {
          label: "hello",
          command: "node",
          args: ["-e", "process.stdout.write('task-ok')"],
        },
        { label: "fail", command: "node", args: ["-e", "process.exit(5)"] },
      ],
    }),
  );
  const listed = await loadTasks(root);
  assert.equal(listed.tasks.length, 2);
  assert.equal(listed.error, null);

  const ran = await runTask(root, "hello");
  assert.equal(ran.exitCode, 0);
  assert.equal(ran.stdout, "task-ok");
  const failed = await runTask(root, "fail");
  assert.equal(failed.exitCode, 5);
  await assert.rejects(() => runTask(root, "missing"), /Task not found/);
});

function waitFor(predicate, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("waitFor timed out"));
      }
    }, 25);
  });
}

async function waitForAsync(check, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitForAsync timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("SessionManager streams stdin/stdout and reports exit", async () => {
  const manager = new SessionManager();
  let received = "";
  let exit = null;
  const id = await manager.start(
    {
      command: "node",
      args: [
        "-e",
        "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase()))",
      ],
      cwd: tmpdir(),
    },
    {
      onData: (event) => {
        received += event.text;
      },
      onExit: (event) => {
        exit = event;
      },
    },
  );
  assert.equal(manager.has(id), true);
  manager.write(id, "abc\n");
  await waitFor(() => received.includes("ABC"));
  assert.equal(manager.kill(id), true);
  await waitFor(() => exit !== null);
  assert.equal(manager.has(id), false);
  assert.equal(manager.write(id, "x"), false);
  await assert.rejects(
    () =>
      manager.start(
        { command: "../bin/sh", args: [], cwd: tmpdir() },
        { onData: () => undefined, onExit: () => undefined },
      ),
    /bare executable/,
  );
  await assert.rejects(
    () =>
      manager.start(
        { command: "touwa-no-such-command-xyz", args: [], cwd: tmpdir() },
        { onData: () => undefined, onExit: () => undefined },
      ),
    /Failed to start/,
  );
});

test("shellCandidates prefers PowerShell on Windows and $SHELL elsewhere", () => {
  assert.equal(shellCandidates("win32", {})[0].command, "powershell");
  assert.equal(shellCandidates("win32", {})[1].command, "cmd");
  assert.deepEqual(
    shellCandidates("linux", { SHELL: "/bin/bash" }).map((c) => c.command),
    ["bash", "sh"],
  );
  assert.deepEqual(
    shellCandidates("linux", {}).map((c) => c.command),
    ["sh"],
  );
});

test("TerminalService runs the platform shell end to end", async () => {
  const manager = new SessionManager();
  const service = new TerminalService(manager);
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-term-"));
  let received = "";
  let exited = false;
  const { id, shell } = await service.start(root, {
    onData: (event) => {
      received += event.text;
    },
    onExit: () => {
      exited = true;
    },
  });
  assert.ok(shell.length > 0);
  service.write(id, "echo terminal-ok\n");
  await waitFor(() => received.includes("terminal-ok"));
  service.kill(id);
  await waitFor(() => exited);
});

test("LSP framing survives arbitrary chunk splits and batching", () => {
  const a = { jsonrpc: "2.0", id: 1, result: { ok: true } };
  const b = {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri: "file:///x.ts", diagnostics: [] },
  };
  const stream = Buffer.concat([encodeLspMessage(a), encodeLspMessage(b)]);
  const parser = new LspMessageParser();
  const received = [];
  // Feed one byte at a time: headers and bodies split everywhere.
  for (const byte of stream) {
    received.push(...parser.push(Buffer.from([byte])));
  }
  assert.equal(received.length, 2);
  assert.deepEqual(received[0], a);
  assert.deepEqual(received[1], b);
  // Multi-byte characters count as bytes, not characters.
  const japanese = { jsonrpc: "2.0", method: "x", params: { text: "診断" } };
  const parser2 = new LspMessageParser();
  assert.deepEqual(parser2.push(encodeLspMessage(japanese)), [japanese]);
});

test("LspClient completes a full session against a fake server", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "touwa-phase3-lsp-fake-"));
  const serverScript = path.join(dir, "fake-server.mjs");
  await writeFile(
    serverScript,
    `
let buf = Buffer.alloc(0);
function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf("\\r\\n\\r\\n");
    if (end === -1) break;
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, end).toString())[1]);
    if (buf.length < end + 4 + len) break;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString());
    buf = buf.subarray(end + 4 + len);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
    else if (msg.method === "textDocument/hover") send({ jsonrpc: "2.0", id: msg.id, result: { contents: "fake hover" } });
    else if (msg.method === "shutdown") send({ jsonrpc: "2.0", id: msg.id, result: null });
    else if (msg.method === "textDocument/didOpen") {
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 3 } }, severity: 1, code: 9999, message: "fake problem" }],
      }});
    }
  }
});
`,
  );
  const client = new LspClient(new SessionManager());
  await client.start({ command: "node", args: [serverScript], cwd: dir });
  const init = await client.initialize("file://" + dir);
  assert.deepEqual(init, { capabilities: {} });
  let published = null;
  client.onNotification("textDocument/publishDiagnostics", (params) => {
    published = params;
  });
  client.notify("textDocument/didOpen", {
    textDocument: {
      uri: "file://" + dir + "/a.ts",
      languageId: "typescript",
      version: 1,
      text: "const a = 1;",
    },
  });
  await waitFor(() => published !== null);
  assert.equal(published.diagnostics[0].message, "fake problem");
  const hover = await client.request("textDocument/hover", {});
  assert.deepEqual(hover, { contents: "fake hover" });
  await client.stop();
  assert.equal(client.running, false);
});

test("LSP diagnostic mapping matches the shared Diagnostic shape", () => {
  assert.equal(languageIdForPath("src/a.ts"), "typescript");
  assert.equal(languageIdForPath("src/a.jsx"), "javascriptreact");
  assert.equal(languageIdForPath("src/a.py"), null);
  const mapped = mapLspDiagnostic({
    range: { start: { line: 4, character: 6 } },
    severity: 1,
    code: 2322,
    message: "boom",
  });
  assert.deepEqual(mapped, {
    relativePath: "",
    line: 5,
    column: 7,
    severity: "error",
    code: "2322",
    message: "boom",
    source: "lsp",
  });
  const root = path.join(tmpdir(), "ws");
  const published = mapPublishDiagnostics(root, {
    uri: "file://" + path.join(root, "src", "a.ts"),
    diagnostics: [{ severity: 2, message: "warn" }],
  });
  assert.equal(published.relativePath, "src/a.ts");
  assert.equal(published.diagnostics[0].severity, "warning");
  assert.equal(
    mapPublishDiagnostics(root, { uri: "file:///outside.ts", diagnostics: [] }),
    null,
  );
});

test("LspService streams real diagnostics from the bundled server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-lsp-real-"));
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src"],
    }),
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(
    path.join(root, "src", "bad.ts"),
    'const n: number = "text";\n',
  );
  const service = new LspService(new SessionManager());
  const byPath = new Map();
  service.onDiagnostics((relativePath, diagnostics) => {
    byPath.set(relativePath, diagnostics);
  });
  try {
    await service.openDocument(
      root,
      "src/bad.ts",
      'const n: number = "text";\n',
    );
    await waitFor(
      () => (byPath.get("src/bad.ts") ?? []).some((d) => d.code === "2322"),
      30_000,
    );
    const found = byPath.get("src/bad.ts").find((d) => d.code === "2322");
    assert.equal(found.severity, "error");
    assert.equal(found.line, 1);
    assert.equal(found.source, "lsp");
    await service.changeDocument(root, "src/bad.ts", "const n: number = 42;\n");
    await waitFor(() => (byPath.get("src/bad.ts") ?? []).length === 0, 30_000);
  } finally {
    await service.dispose();
  }
});

test("LSP completion/hover/signature-help results map to renderer shapes", () => {
  assert.equal(markupToText("plain"), "plain");
  assert.equal(markupToText({ kind: "markdown", value: "**md**" }), "**md**");
  assert.equal(
    markupToText({ language: "typescript", value: "const x = 1;" }),
    "```typescript\nconst x = 1;\n```",
  );
  assert.equal(
    markupToText(["first", { kind: "plaintext", value: "second" }]),
    "first\n\nsecond",
  );
  assert.equal(markupToText(null), "");
  assert.equal(markupToText(42), "");

  const completions = mapCompletionResult({
    isIncomplete: true,
    items: [
      {
        label: "length",
        kind: 10,
        detail: "property length: number",
        documentation: { kind: "markdown", value: "The length." },
        textEdit: {
          range: {
            start: { line: 1, character: 2 },
            end: { line: 1, character: 3 },
          },
          newText: "length",
        },
      },
      { label: "charAt", insertText: "charAt()" },
      { kind: 3 },
    ],
  });
  assert.equal(completions.length, 2);
  assert.deepEqual(completions[0], {
    label: "length",
    kind: 10,
    detail: "property length: number",
    documentation: "The length.",
    insertText: "length",
    range: { startLine: 2, startColumn: 3, endLine: 2, endColumn: 4 },
  });
  assert.equal(completions[1].insertText, "charAt()");
  assert.equal(completions[1].range, null);
  assert.deepEqual(mapCompletionResult(null), []);
  assert.equal(mapCompletionResult([{ label: "x" }]).length, 1);

  const hover = mapHoverResult({
    contents: { kind: "markdown", value: "docs" },
    range: {
      start: { line: 0, character: 1 },
      end: { line: 0, character: 5 },
    },
  });
  assert.deepEqual(hover, {
    contents: "docs",
    range: { startLine: 1, startColumn: 2, endLine: 1, endColumn: 6 },
  });
  assert.equal(mapHoverResult(null), null);
  assert.equal(mapHoverResult({ contents: "" }), null);

  const help = mapSignatureHelpResult({
    signatures: [
      {
        label: "greet(name: string): string",
        documentation: "Greets.",
        parameters: [{ label: [6, 18], documentation: "Who to greet." }],
      },
    ],
    activeSignature: 0,
    activeParameter: 0,
  });
  assert.equal(help.signatures[0].parameters[0].label, "name: string");
  assert.equal(help.signatures[0].parameters[0].documentation, "Who to greet.");
  assert.equal(mapSignatureHelpResult(null), null);
  assert.equal(mapSignatureHelpResult({ signatures: [] }), null);
});

test("LspService answers completion, hover and signature help from the bundled server", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-lsp-req-"));
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true },
      include: ["src"],
    }),
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  const text = [
    "function greet(name: string): string {",
    '  return "hi " + name;',
    "}",
    'const message: string = greet("world");',
    "message.",
    "",
  ].join("\n");
  await writeFile(path.join(root, "src", "main.ts"), text);
  const service = new LspService(new SessionManager());
  try {
    await service.openDocument(root, "src/main.ts", text);
    // Requests for a document that was never opened answer empty.
    assert.deepEqual(await service.completion(root, "src/other.ts", 1, 1), []);
    assert.equal(await service.hover(root, "src/other.ts", 1, 1), null);
    // Completion after "message." offers the string members.
    await waitForAsync(async () =>
      (await service.completion(root, "src/main.ts", 5, 9)).some(
        (item) => item.label === "length",
      ),
    );
    // Hover over the greet call shows the function signature.
    await waitForAsync(async () => {
      const hover = await service.hover(root, "src/main.ts", 4, 27);
      return hover !== null && hover.contents.includes("greet");
    });
    // Signature help inside the greet( call lists the name parameter.
    await service.changeDocument(
      root,
      "src/main.ts",
      text.replace('greet("world")', "greet("),
    );
    await waitForAsync(async () => {
      const help = await service.signatureHelp(root, "src/main.ts", 4, 31);
      return (
        help !== null &&
        help.signatures[0].label.includes("greet") &&
        help.signatures[0].parameters.some((p) => p.label.includes("name"))
      );
    });
  } finally {
    await service.dispose();
  }
});

test("debugger mapping helpers convert CDP shapes", async () => {
  assert.equal(isDebuggablePath("src/app.js"), true);
  assert.equal(isDebuggablePath("src/app.mjs"), true);
  assert.equal(isDebuggablePath("src/app.ts"), false);
  const port = await allocatePort();
  assert.ok(port > 0 && port < 65536);

  const root = path.join(tmpdir(), "ws");
  assert.equal(
    urlToRelativePath(root, "file://" + path.join(root, "src", "a.js")),
    "src/a.js",
  );
  assert.equal(urlToRelativePath(root, "file:///outside.js"), "");
  assert.equal(urlToRelativePath(root, "node:internal/modules/run_main"), "");

  const frame = mapCallFrame(
    root,
    {
      functionName: "main",
      location: { scriptId: "7", lineNumber: 4, columnNumber: 2 },
    },
    0,
    "file://" + path.join(root, "src", "a.js"),
  );
  assert.deepEqual(frame, {
    id: 0,
    name: "main",
    relativePath: "src/a.js",
    line: 5,
    column: 3,
  });
  assert.equal(
    mapCallFrame(root, { location: { lineNumber: 0, columnNumber: 0 } }, 1, "")
      .name,
    "(anonymous)",
  );

  const variables = mapRemoteProperties([
    { name: "count", value: { type: "number", value: 3 } },
    { name: "label", value: { type: "string", value: "hi" } },
    {
      name: "obj",
      value: {
        type: "object",
        description: "Object",
        objectId: "obj-1",
      },
    },
    { name: "fn", value: { type: "function", description: "function f() {}" } },
    { name: "missing", value: { type: "undefined" } },
    { name: "noValue" },
    "junk",
  ]);
  assert.deepEqual(
    variables.map((v) => [v.name, v.value, v.objectId]),
    [
      ["count", "3", null],
      ["label", "hi", null],
      ["obj", "Object", "obj-1"],
      ["fn", "function f() {}", null],
      ["missing", "undefined", null],
    ],
  );
});

test("DebugService runs a real Node program with breakpoints and variables", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-debug-"));
  const source = [
    "const a = 1;",
    "const b = a + 2;",
    "const obj = { total: b };",
    'console.log("sum=" + obj.total);',
    "",
  ].join("\n");
  await writeFile(path.join(root, "app.js"), source);
  const service = new DebugService(new SessionManager());
  const states = [];
  let output = "";
  try {
    await assert.rejects(
      service.start(root, "app.ts", [], { onState() {}, onOutput() {} }),
      /Only \.js/,
    );
    await service.start(root, "app.js", [{ relativePath: "app.js", line: 2 }], {
      onState: (state) => states.push(state),
      onOutput: (_stream, text) => {
        output += text;
      },
    });
    const pausedAt = (line) =>
      states.some(
        (s) =>
          s.status === "paused" &&
          s.frames?.[0]?.relativePath === "app.js" &&
          s.frames?.[0]?.line === line,
      );
    await waitForAsync(() => pausedAt(2));
    const atLine2 = await service.frameVariables(0);
    assert.ok(
      atLine2.some((v) => v.name === "a" && v.value === "1"),
      "local variable a should be visible at line 2",
    );
    // Move the breakpoint live, then run to it.
    await service.setBreakpoints("app.js", [4]);
    await service.resume();
    await waitForAsync(() => pausedAt(4));
    const atLine4 = await service.frameVariables(0);
    const obj = atLine4.find((v) => v.name === "obj");
    assert.ok(obj && obj.variablesReference > 0, "obj should be expandable");
    const children = await service.variables(obj.variablesReference);
    assert.ok(
      children.some((v) => v.name === "total" && v.value === "3"),
      "obj.total should expand to 3",
    );
    await service.resume();
    await waitForAsync(() =>
      states.some((s) => s.status === "terminated"),
    );
    assert.ok(output.includes("sum=3"));
    assert.equal(service.running, false);
  } finally {
    await service.dispose();
  }
});

test("getGitStatus reports a plain folder as not a repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase3-plain-"));
  const status = await getGitStatus(root);
  assert.equal(status.isRepository, false);
  assert.deepEqual(status.entries, []);
  assert.deepEqual(await getGitLog(root), []);
});
