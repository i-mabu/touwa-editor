// Phase 4 runtime tests: extension manifest discovery and validation.
// Run with: npm test   (Node >= 22.18 runs the TypeScript sources directly.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  engineSatisfied,
  parseExtensionManifest,
  scanExtensions,
} from "../src/main/extensions/extensions-service.ts";

test("parseExtensionManifest parses a full manifest", () => {
  const info = parseExtensionManifest(
    JSON.stringify({
      name: "hello",
      version: "1.2.3",
      publisher: "acme",
      displayName: "Hello Extension",
      description: "Says hello.",
      main: "./out/main.js",
      engines: { touwa: "^0.1.0" },
      activationEvents: ["onCommand:hello.say", "onStartupFinished"],
      contributes: {
        commands: [
          { command: "hello.say", title: "Say Hello" },
          { command: "hello.wave", title: "Wave" },
          { command: "hello.broken" },
        ],
      },
      capabilities: ["commands"],
    }),
    "user",
    "acme-hello",
    "0.1.0",
  );
  assert.equal(info.id, "acme.hello");
  assert.equal(info.name, "hello");
  assert.equal(info.displayName, "Hello Extension");
  assert.equal(info.description, "Says hello.");
  assert.equal(info.publisher, "acme");
  assert.equal(info.version, "1.2.3");
  assert.equal(info.scope, "user");
  assert.equal(info.folder, "acme-hello");
  assert.equal(info.main, "./out/main.js");
  assert.deepEqual(info.activationEvents, [
    "onCommand:hello.say",
    "onStartupFinished",
  ]);
  // The entry without a title is dropped; the rest are extracted.
  assert.deepEqual(info.commands, [
    { command: "hello.say", title: "Say Hello" },
    { command: "hello.wave", title: "Wave" },
  ]);
  assert.equal(info.compatible, true);
});

test("parseExtensionManifest falls back for optional fields", () => {
  const info = parseExtensionManifest(
    JSON.stringify({ name: "plain", version: "0.0.1" }),
    "workspace",
    "plain",
    "0.1.0",
  );
  // No publisher: the id is just the name.
  assert.equal(info.id, "plain");
  assert.equal(info.publisher, "");
  // displayName falls back to name, description to "".
  assert.equal(info.displayName, "plain");
  assert.equal(info.description, "");
  assert.equal(info.main, null);
  assert.deepEqual(info.activationEvents, []);
  assert.deepEqual(info.commands, []);
  assert.deepEqual(info.capabilities, []);
  assert.deepEqual(info.unknownCapabilities, []);
  // No engines range accepts any app version.
  assert.equal(info.compatible, true);
});

test("parseExtensionManifest rejects invalid manifests", () => {
  assert.throws(
    () => parseExtensionManifest("{not json", "user", "x", "0.1.0"),
    /JSON/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        JSON.stringify({ name: "Bad Name", version: "1.0.0" }),
        "user",
        "x",
        "0.1.0",
      ),
    /name/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        JSON.stringify({ name: "-leading-dash", version: "1.0.0" }),
        "user",
        "x",
        "0.1.0",
      ),
    /name/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        JSON.stringify({ version: "1.0.0" }),
        "user",
        "x",
        "0.1.0",
      ),
    /name/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        JSON.stringify({ name: "ok", version: "1.0" }),
        "user",
        "x",
        "0.1.0",
      ),
    /version/,
  );
  assert.throws(
    () =>
      parseExtensionManifest(
        JSON.stringify({ name: "ok", version: "v1.0.0" }),
        "user",
        "x",
        "0.1.0",
      ),
    /version/,
  );
});

test("parseExtensionManifest splits unknown capabilities", () => {
  const info = parseExtensionManifest(
    JSON.stringify({
      name: "caps",
      version: "1.0.0",
      capabilities: ["workspace.read", "made.up", "commands", "also.fake"],
    }),
    "user",
    "caps",
    "0.1.0",
  );
  // Known capabilities are kept in declaration order; unknown ones
  // are reported separately, never silently granted.
  assert.deepEqual(info.capabilities, ["workspace.read", "commands"]);
  assert.deepEqual(info.unknownCapabilities, ["made.up", "also.fake"]);
});

test("engineSatisfied handles ranges and fails closed", () => {
  // No range accepts anything.
  assert.equal(engineSatisfied(undefined, "0.1.0"), true);
  assert.equal(engineSatisfied("*", "0.1.0"), true);
  assert.equal(engineSatisfied("", "9.9.9"), true);
  // Caret: same major, not older than the base.
  assert.equal(engineSatisfied("^0.1.0", "0.1.0"), true);
  assert.equal(engineSatisfied("^0.1.0", "0.2.0"), true);
  assert.equal(engineSatisfied("^0.1.0", "1.0.0"), false);
  assert.equal(engineSatisfied("^0.1.0", "0.0.9"), false);
  // Exact match only.
  assert.equal(engineSatisfied("0.1.0", "0.1.0"), true);
  assert.equal(engineSatisfied("0.1.0", "0.1.1"), false);
  // Uninterpretable ranges and versions fail closed.
  assert.equal(engineSatisfied(">=0.1.0", "0.2.0"), false);
  assert.equal(engineSatisfied("latest", "0.1.0"), false);
  assert.equal(engineSatisfied("^0.1.0", "not-a-version"), false);
});

test("scanExtensions collects valid extensions and reports broken ones", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "touwa-phase4-scan-"));
  await mkdir(path.join(base, "good-ext"), { recursive: true });
  await writeFile(
    path.join(base, "good-ext", "package.json"),
    JSON.stringify({
      name: "good",
      version: "1.0.0",
      publisher: "acme",
      engines: { touwa: "^0.1.0" },
    }),
  );
  await mkdir(path.join(base, "future-ext"), { recursive: true });
  await writeFile(
    path.join(base, "future-ext", "package.json"),
    JSON.stringify({
      name: "future",
      version: "2.0.0",
      engines: { touwa: "^1.0.0" },
    }),
  );
  await mkdir(path.join(base, "broken-ext"), { recursive: true });
  await writeFile(
    path.join(base, "broken-ext", "package.json"),
    "{not json",
  );
  await mkdir(path.join(base, "empty-ext"), { recursive: true });

  const result = await scanExtensions(
    [
      { scope: "user", dir: base },
      // A missing directory is a normal state, not an error.
      { scope: "workspace", dir: path.join(base, "does-not-exist") },
    ],
    "0.1.0",
  );

  // Both readable manifests are listed, sorted by id.
  assert.deepEqual(
    result.extensions.map((e) => e.id),
    ["acme.good", "future"],
  );
  const good = result.extensions.find((e) => e.id === "acme.good");
  assert.equal(good.scope, "user");
  assert.equal(good.folder, "good-ext");
  assert.equal(good.compatible, true);
  // engines.touwa ^1.0.0 does not accept app 0.1.0.
  const future = result.extensions.find((e) => e.id === "future");
  assert.equal(future.compatible, false);
  // The broken JSON and the manifest-less folder land in errors;
  // the missing directory contributes nothing.
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some((e) => e.startsWith("user/broken-ext: ")));
  assert.ok(result.errors.some((e) => e.startsWith("user/empty-ext: ")));
});

test("scanExtensions returns empty for no locations", async () => {
  assert.deepEqual(await scanExtensions([], "0.1.0"), {
    extensions: [],
    errors: [],
  });
});
