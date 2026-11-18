// Phase 4 runtime tests: extension manifest discovery and validation,
// plus the layered settings schema and service.
// Run with: npm test   (Node >= 22.18 runs the TypeScript sources directly.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  engineSatisfied,
  parseExtensionManifest,
  scanExtensions,
} from "../src/main/extensions/extensions-service.ts";
import {
  settingDef,
  validateSettingValue,
} from "../src/main/settings/settings-schema.ts";
import {
  getEffectiveSettings,
  mergeSettings,
  parseSettingsFile,
  setUserSetting,
} from "../src/main/settings/settings-service.ts";

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

test("validateSettingValue accepts valid values and rejects the rest", () => {
  const fontSize = settingDef("editor.fontSize");
  const wordWrap = settingDef("editor.wordWrap");
  const minimap = settingDef("editor.minimap.enabled");
  const fontFamily = settingDef("editor.fontFamily");
  // Valid values come back unchanged, range boundaries included.
  assert.equal(validateSettingValue(fontSize, 20), 20);
  assert.equal(validateSettingValue(fontSize, 8), 8);
  assert.equal(validateSettingValue(fontSize, 72), 72);
  assert.equal(validateSettingValue(wordWrap, "on"), "on");
  assert.equal(validateSettingValue(minimap, true), true);
  assert.equal(validateSettingValue(fontFamily, "monospace"), "monospace");
  // Type mismatches throw.
  assert.throws(() => validateSettingValue(fontSize, "20"), /数値/);
  assert.throws(() => validateSettingValue(minimap, 1), /真偽値/);
  assert.throws(() => validateSettingValue(fontFamily, 12), /文字列/);
  // Numbers outside the declared range throw (fontSize is 8–72).
  assert.throws(() => validateSettingValue(fontSize, 7), /範囲/);
  assert.throws(() => validateSettingValue(fontSize, 73), /範囲/);
  // Values outside the enum throw.
  assert.throws(() => validateSettingValue(wordWrap, "sometimes"), /いずれか/);
});

test("parseSettingsFile validates whole layers and filters by scope", () => {
  // Unknown keys are rejected outright.
  assert.throws(
    () => parseSettingsFile(JSON.stringify({ "editor.unknown": 1 }), "user"),
    /未知の設定キー/,
  );
  // A type mismatch anywhere invalidates the whole layer: the
  // parser throws instead of returning a partially-valid map.
  assert.throws(
    () =>
      parseSettingsFile(
        JSON.stringify({ "editor.fontSize": 20, "editor.tabSize": "wide" }),
        "user",
      ),
    /数値/,
  );
  // workbench.colorTheme is scoped "user": in the workspace layer
  // it is silently excluded (no error), in the user layer it is kept.
  const text = JSON.stringify({
    "workbench.colorTheme": "custom-theme",
    "editor.fontSize": 18,
  });
  assert.deepEqual(parseSettingsFile(text, "workspace"), {
    "editor.fontSize": 18,
  });
  assert.deepEqual(parseSettingsFile(text, "user"), {
    "workbench.colorTheme": "custom-theme",
    "editor.fontSize": 18,
  });
});

test("mergeSettings overrides defaults per key", () => {
  const merged = mergeSettings({ "editor.fontSize": 20 });
  // Only fontSize changes; every other key keeps its schema default.
  assert.equal(merged["editor.fontSize"], 20);
  assert.equal(merged["editor.tabSize"], 2);
  assert.equal(merged["editor.wordWrap"], "off");
  assert.equal(merged["editor.minimap.enabled"], false);
  assert.equal(merged["workbench.colorTheme"], "touwa-dark");
  // Later layers win over earlier ones, per key.
  const layered = mergeSettings(
    { "editor.fontSize": 20, "editor.tabSize": 4 },
    { "editor.fontSize": 22 },
  );
  assert.equal(layered["editor.fontSize"], 22);
  assert.equal(layered["editor.tabSize"], 4);
});

test("getEffectiveSettings layers files with per-layer errors", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "touwa-phase4-settings-"));
  const userPath = path.join(base, "user", "settings.json");
  const workspaceRoot = path.join(base, "ws");
  await mkdir(workspaceRoot, { recursive: true });

  // No files at all: pure defaults, no errors on either layer.
  const empty = await getEffectiveSettings(userPath, workspaceRoot);
  assert.equal(empty.effective["editor.fontSize"], 14);
  assert.equal(empty.effective["workbench.colorTheme"], "touwa-dark");
  assert.deepEqual(empty.errors, { user: null, workspace: null });
  // No workspace open: the workspace layer reports no error either.
  const noWorkspace = await getEffectiveSettings(userPath, null);
  assert.deepEqual(noWorkspace.errors, { user: null, workspace: null });

  // A user settings file is reflected over the defaults.
  await mkdir(path.dirname(userPath), { recursive: true });
  await writeFile(
    userPath,
    JSON.stringify({ "editor.fontSize": 20, "editor.tabSize": 4 }),
  );
  const userOnly = await getEffectiveSettings(userPath, workspaceRoot);
  assert.equal(userOnly.effective["editor.fontSize"], 20);
  assert.equal(userOnly.effective["editor.tabSize"], 4);
  assert.deepEqual(userOnly.errors, { user: null, workspace: null });

  // The workspace layer wins over the user layer, per key.
  await mkdir(path.join(workspaceRoot, ".touwa"), { recursive: true });
  const workspaceFile = path.join(workspaceRoot, ".touwa", "settings.json");
  await writeFile(workspaceFile, JSON.stringify({ "editor.fontSize": 24 }));
  const layered = await getEffectiveSettings(userPath, workspaceRoot);
  assert.equal(layered.effective["editor.fontSize"], 24);
  assert.equal(layered.effective["editor.tabSize"], 4);

  // A broken user file drops only that layer: its error is
  // reported, the values fall back to defaults, and the workspace
  // layer still applies.
  await writeFile(userPath, "{broken json");
  const broken = await getEffectiveSettings(userPath, workspaceRoot);
  assert.equal(typeof broken.errors.user, "string");
  assert.equal(broken.errors.workspace, null);
  assert.equal(broken.effective["editor.fontSize"], 24);
  assert.equal(broken.effective["editor.tabSize"], 2);
});

test("setUserSetting writes the user layer and reports effective values", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "touwa-phase4-set-"));
  const userPath = path.join(base, "user", "settings.json");

  // The file (and its parent directory) is created, and the new
  // value shows up in the returned effective settings.
  const result = await setUserSetting(userPath, null, "editor.fontSize", 22);
  assert.equal(result.effective["editor.fontSize"], 22);
  assert.deepEqual(result.errors, { user: null, workspace: null });
  const written = JSON.parse(await readFile(userPath, "utf8"));
  assert.deepEqual(written, { "editor.fontSize": 22 });

  // A second write merges with the existing file content.
  const again = await setUserSetting(userPath, null, "editor.wordWrap", "on");
  assert.equal(again.effective["editor.fontSize"], 22);
  assert.equal(again.effective["editor.wordWrap"], "on");

  // Unknown keys are rejected before anything is written.
  await assert.rejects(
    () => setUserSetting(userPath, null, "editor.nope", 1),
    /未知の設定キー/,
  );

  // A broken existing file is reported, never silently overwritten.
  await writeFile(userPath, "{broken json");
  await assert.rejects(
    () => setUserSetting(userPath, null, "editor.fontSize", 16),
    /現在のユーザー設定に問題があります/,
  );
  assert.equal(await readFile(userPath, "utf8"), "{broken json");
});
