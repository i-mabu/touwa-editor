// Phase 2 runtime tests for the Main workspace service.
// Run with: npm test   (Node >= 22.18 runs the TypeScript sources directly.)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  appendFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listDirectory,
  listWorkspace,
  readWorkspaceFile,
  renameWorkspaceEntry,
  statWorkspaceFile,
  writeWorkspaceFile,
  searchWorkspace,
  replaceInWorkspace,
} from "../src/main/workspace/workspace-service.ts";
import { createWorkspaceWatcher } from "../src/main/workspace/watcher.ts";

async function makeWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-phase2-"));
  await mkdir(path.join(root, "src", "nested"), { recursive: true });
  await writeFile(
    path.join(root, "src", "a.ts"),
    "const greeting = 'hello';\nconst bye = 'hello';\n",
  );
  await writeFile(
    path.join(root, "src", "nested", "b.ts"),
    "const greeting = 'hello';\n",
  );
  await writeFile(path.join(root, "README.md"), "# Touwa\nhello world\n");
  return root;
}

test("listWorkspace lists only the root level, listDirectory recurses lazily", async () => {
  const root = await makeWorkspace();
  const top = await listWorkspace(root);
  assert.deepEqual(top.map((e) => e.name).sort(), ["README.md", "src"]);
  assert.equal(top.find((e) => e.name === "src")?.kind, "directory");
  const nested = await listDirectory(root, "src");
  assert.deepEqual(nested.map((e) => e.name).sort(), ["a.ts", "nested"]);
  const deep = await listDirectory(root, "src/nested");
  assert.deepEqual(
    deep.map((e) => e.name),
    ["b.ts"],
  );
  await assert.rejects(
    () => listDirectory(root, "../outside"),
    /outside|relative/,
  );
});

test("read returns a snapshot; write is atomic and conflict-aware", async () => {
  const root = await makeWorkspace();
  const snapshot = await readWorkspaceFile(root, "src/a.ts");
  assert.equal(snapshot.content.includes("hello"), true);
  assert.equal(typeof snapshot.mtimeMs, "number");
  assert.equal(snapshot.hash.length, 64);

  const saved = await writeWorkspaceFile(
    root,
    "src/a.ts",
    "const x = 1;\n",
    snapshot.mtimeMs,
  );
  assert.equal(
    await readFile(path.join(root, "src", "a.ts"), "utf8"),
    "const x = 1;\n",
  );
  assert.notEqual(saved.mtimeMs, snapshot.mtimeMs);

  // Stale expected mtime must be refused, and the disk content untouched.
  await assert.rejects(
    () =>
      writeWorkspaceFile(root, "src/a.ts", "const y = 2;\n", snapshot.mtimeMs),
    /changed on disk/,
  );
  assert.equal(
    await readFile(path.join(root, "src", "a.ts"), "utf8"),
    "const x = 1;\n",
  );

  // Explicit overwrite (no expected mtime) succeeds.
  await writeWorkspaceFile(root, "src/a.ts", "const y = 2;\n");
  assert.equal(
    await readFile(path.join(root, "src", "a.ts"), "utf8"),
    "const y = 2;\n",
  );

  // Boundary: paths outside the workspace are still refused.
  await assert.rejects(
    () => readWorkspaceFile(root, "../outside.txt"),
    /outside/,
  );
  await assert.rejects(
    () => writeWorkspaceFile(root, "../outside.txt", "x"),
    /outside/,
  );
});

test("stat detects an external change", async () => {
  const root = await makeWorkspace();
  const before = await statWorkspaceFile(root, "README.md");
  await writeFile(path.join(root, "README.md"), "# Touwa\nchanged\n");
  const after = await statWorkspaceFile(root, "README.md");
  assert.notEqual(after.hash, before.hash);
});

test("search finds matches across nested files; replace is atomic per file", async () => {
  const root = await makeWorkspace();
  const found = await searchWorkspace(root, "hello");
  assert.equal(found.matches.length, 4);
  assert.deepEqual(
    [...new Set(found.matches.map((m) => m.relativePath))].sort(),
    ["README.md", "src/a.ts", "src/nested/b.ts"],
  );

  const caseSensitive = await searchWorkspace(root, "Hello", {
    caseSensitive: true,
  });
  assert.equal(caseSensitive.matches.length, 0);
  const insensitive = await searchWorkspace(root, "HELLO");
  assert.equal(insensitive.matches.length, 4);

  const regex = await searchWorkspace(root, "greet\\w+", { regex: true });
  assert.equal(regex.matches.length, 2);

  const replaced = await replaceInWorkspace(root, "hello", "hi");
  assert.equal(replaced.filesChanged, 3);
  assert.equal(replaced.totalReplacements, 4);
  assert.deepEqual(replaced.skipped, []);
  assert.equal(
    await readFile(path.join(root, "src", "a.ts"), "utf8"),
    "const greeting = 'hi';\nconst bye = 'hi';\n",
  );
  const after = await searchWorkspace(root, "hello");
  assert.equal(after.matches.length, 0);
});

test("search rejects an empty or over-long query", async () => {
  const root = await makeWorkspace();
  await assert.rejects(() => searchWorkspace(root, ""), /1 to 200/);
  await assert.rejects(
    () => searchWorkspace(root, "x".repeat(201)),
    /1 to 200/,
  );
  await assert.rejects(
    () => searchWorkspace(root, "(", { regex: true }),
    /Invalid regular expression/,
  );
});

test("plain-text replace treats $ in the replacement literally in every mode", async () => {
  const root = await makeWorkspace();
  // Case-insensitive plain replace used to go through RegExp.replace,
  // where $& / $5 in the replacement are substitution patterns.
  const insensitive = await replaceInWorkspace(root, "hello", "$&-$5");
  assert.equal(insensitive.totalReplacements, 4);
  assert.equal(
    await readFile(path.join(root, "src", "a.ts"), "utf8"),
    "const greeting = '$&-$5';\nconst bye = '$&-$5';\n",
  );
  const sensitive = await replaceInWorkspace(root, "$&-$5", "hi", {
    caseSensitive: true,
  });
  assert.equal(sensitive.totalReplacements, 4);
  assert.equal(
    await readFile(path.join(root, "src", "a.ts"), "utf8"),
    "const greeting = 'hi';\nconst bye = 'hi';\n",
  );
  // Regex mode keeps substitution semantics (capture groups).
  const regex = await replaceInWorkspace(root, "(hi)", "[$1]", { regex: true });
  assert.equal(regex.totalReplacements, 4);
  assert.equal(
    await readFile(path.join(root, "src", "a.ts"), "utf8"),
    "const greeting = '[hi]';\nconst bye = '[hi]';\n",
  );
});

test("replace-all is not bounded by the search result cap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "touwa-replace-cap-"));
  await writeFile(path.join(root, "a.txt"), "x\n".repeat(500));
  await writeFile(path.join(root, "b.txt"), "x\n".repeat(10));
  // Search results stop at 500 matches; building the replace file list
  // from them used to leave b.txt untouched and unreported.
  const replaced = await replaceInWorkspace(root, "x", "y");
  assert.equal(replaced.filesChanged, 2);
  assert.equal(replaced.totalReplacements, 510);
  assert.deepEqual(replaced.skipped, []);
  assert.equal(
    await readFile(path.join(root, "b.txt"), "utf8"),
    "y\n".repeat(10),
  );
});

test("write size limit is measured in UTF-8 bytes, not characters", async () => {
  const root = await makeWorkspace();
  // 8M characters is under the old char-count check but 24 MB as UTF-8,
  // and the written file could then never be opened again.
  await assert.rejects(
    () => writeWorkspaceFile(root, "big.txt", "あ".repeat(8_000_000)),
    /Invalid file content/,
  );
  await writeWorkspaceFile(root, "small.txt", "あ".repeat(100));
  const snapshot = await readWorkspaceFile(root, "small.txt");
  assert.equal(snapshot.size, 300);
});

test("stat refuses files over the size limit instead of reading them fully", async () => {
  const root = await makeWorkspace();
  await writeFile(path.join(root, "big.bin"), "a".repeat(20_000_001));
  await assert.rejects(() => statWorkspaceFile(root, "big.bin"), /too large/);
});

test("rename refuses the workspace root itself", async () => {
  const root = await makeWorkspace();
  await assert.rejects(
    () => renameWorkspaceEntry(root, ".", "moved"),
    /cannot be changed/,
  );
  await assert.rejects(
    () => renameWorkspaceEntry(root, "", "moved"),
    /cannot be changed/,
  );
});

test("listings include symlinks with the kind of their target", async (t) => {
  const root = await makeWorkspace();
  try {
    await symlink(path.join(root, "README.md"), path.join(root, "link.md"));
    await symlink(path.join(root, "src"), path.join(root, "src-link"));
  } catch {
    t.skip("symlink creation is not permitted on this platform");
    return;
  }
  const top = await listWorkspace(root);
  assert.equal(top.find((e) => e.name === "link.md")?.kind, "file");
  assert.equal(top.find((e) => e.name === "src-link")?.kind, "directory");
  // A symlink that escapes the workspace is listed, but opening it is
  // still refused by the realpath boundary check.
  const outside = await mkdtemp(path.join(tmpdir(), "touwa-outside-"));
  await writeFile(path.join(outside, "secret.txt"), "secret");
  await symlink(
    path.join(outside, "secret.txt"),
    path.join(root, "escape.txt"),
  );
  await assert.rejects(() => readWorkspaceFile(root, "escape.txt"), /outside/);
});

test("watcher reports subdirectory changes with their full relative path", async () => {
  const root = await makeWorkspace();
  const events = [];
  const watcher = createWorkspaceWatcher(root, (change) => events.push(change));
  try {
    // A change made before the OS watcher is fully armed can be missed
    // (seen on Windows CI), so keep appending until an event lands
    // instead of relying on a single write. Debounce is 250 ms.
    for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) {
      await appendFile(path.join(root, "src", "a.ts"), "// external\n");
      for (let i = 0; i < 10 && events.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  } finally {
    watcher.close();
  }
  assert.equal(events.length > 0, true);
  assert.equal(
    events.every((e) => e.relativePath === "src/a.ts"),
    true,
  );
});
