import fs from "node:fs/promises";
import path from "node:path";
import {
  defaultSettings,
  settingDef,
  validateSettingValue,
  type SettingValue,
} from "./settings-schema.ts";

// ===== Settings service (Phase 4) =====
// Layered settings, following the tasks/debug config precedent
// (pure parser, { values, error }, all-or-nothing per layer, Main
// validates everything):
//   defaults (schema) < user settings.json < workspace
//   .touwa/settings.json, merged per key.
// A layer that fails to parse or validate is dropped whole, with
// its reason reported; the other layers still apply. Keys scoped
// "user" in the schema are filtered out of the workspace layer
// before validation, so a repository cannot set them and cannot
// break its own layer by trying. Nothing is cached: every read
// goes to disk, like tasks.

export type SettingsLayer = "user" | "workspace";

export type SettingsLoadResult = {
  effective: Record<string, SettingValue>;
  errors: Record<SettingsLayer, string | null>;
};

export const WORKSPACE_SETTINGS_FILE = ".touwa/settings.json";

export function parseSettingsFile(
  text: string,
  layer: SettingsLayer,
): Record<string, SettingValue> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("settings.json が JSON として読めません");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("settings.json はオブジェクトである必要があります");
  }
  const values: Record<string, SettingValue> = {};
  for (const [key, raw] of Object.entries(data)) {
    const def = settingDef(key);
    if (!def) throw new Error(`未知の設定キーです: ${key}`);
    if (layer === "workspace" && def.scope === "user") {
      // User-only keys are silently out of the workspace layer's
      // reach (see the header comment).
      continue;
    }
    values[key] = validateSettingValue(def, raw);
  }
  return values;
}

async function loadSettingsFile(
  file: string,
  layer: SettingsLayer,
): Promise<{ values: Record<string, SettingValue>; error: string | null }> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    // No settings file is a normal state, not an error.
    return { values: {}, error: null };
  }
  try {
    return { values: parseSettingsFile(text, layer), error: null };
  } catch (e) {
    return {
      values: {},
      error: e instanceof Error ? e.message : "settings.json を読めません",
    };
  }
}

/** Merges validated layers over the schema defaults, per key. */
export function mergeSettings(
  ...layers: Record<string, SettingValue>[]
): Record<string, SettingValue> {
  const effective = defaultSettings();
  for (const layer of layers) Object.assign(effective, layer);
  return effective;
}

export async function getEffectiveSettings(
  userSettingsPath: string,
  workspaceRoot: string | null,
): Promise<SettingsLoadResult> {
  const user = await loadSettingsFile(userSettingsPath, "user");
  const workspace =
    workspaceRoot !== null
      ? await loadSettingsFile(
          path.join(workspaceRoot, WORKSPACE_SETTINGS_FILE),
          "workspace",
        )
      : { values: {}, error: null };
  return {
    effective: mergeSettings(user.values, workspace.values),
    errors: { user: user.error, workspace: workspace.error },
  };
}

/**
 * Writes one key into the user layer and returns the new effective
 * settings. The user file is re-read and re-validated first; a
 * broken existing file is reported, never silently overwritten.
 */
export async function setUserSetting(
  userSettingsPath: string,
  workspaceRoot: string | null,
  key: string,
  value: unknown,
): Promise<SettingsLoadResult> {
  const def = settingDef(key);
  if (!def) throw new Error(`未知の設定キーです: ${key}`);
  const validated = validateSettingValue(def, value);
  const existing = await loadSettingsFile(userSettingsPath, "user");
  if (existing.error !== null) {
    throw new Error(`現在のユーザー設定に問題があります: ${existing.error}`);
  }
  const next = { ...existing.values, [key]: validated };
  await fs.mkdir(path.dirname(userSettingsPath), { recursive: true });
  const tmp = `${userSettingsPath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tmp, userSettingsPath);
  return getEffectiveSettings(userSettingsPath, workspaceRoot);
}
