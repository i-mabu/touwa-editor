// ==========================================
// 📌 Settings schema (Phase 4)
// ==========================================
// ⚙️ The single declaration table for every user-facing setting.
// Only keys the implementation actually consumes are declared;
// each key carries its type, range, default, and which layers may
// write it. Keys scoped "user" are ignored in the workspace layer
// so a repository can never loosen security-sensitive settings.

export type SettingValue = boolean | number | string;

export type SettingDef = {
  key: string;
  type: "boolean" | "number" | "string" | "enum";
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
  defaultValue: SettingValue;
  /** Layers that may set this key: "user" keys are user-layer only. */
  scope: "user" | "both";
};

export const SETTING_DEFS: readonly SettingDef[] = [
  {
    key: "editor.fontSize",
    type: "number",
    min: 8,
    max: 72,
    defaultValue: 14,
    scope: "both",
  },
  {
    key: "editor.fontFamily",
    type: "string",
    maxLength: 200,
    defaultValue: "",
    scope: "both",
  },
  {
    key: "editor.tabSize",
    type: "number",
    min: 1,
    max: 8,
    defaultValue: 2,
    scope: "both",
  },
  {
    key: "editor.wordWrap",
    type: "enum",
    enumValues: ["off", "on"],
    defaultValue: "off",
    scope: "both",
  },
  {
    key: "editor.minimap.enabled",
    type: "boolean",
    defaultValue: false,
    scope: "both",
  },
  {
    key: "workbench.colorTheme",
    type: "string",
    maxLength: 100,
    defaultValue: "touwa-dark",
    scope: "user",
  },
];

const DEFS_BY_KEY = new Map(SETTING_DEFS.map((def) => [def.key, def]));

export function settingDef(key: string): SettingDef | undefined {
  return DEFS_BY_KEY.get(key);
}

export function defaultSettings(): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  for (const def of SETTING_DEFS) values[def.key] = def.defaultValue;
  return values;
}

/** Validates one value against its definition; throws with reason. */
export function validateSettingValue(
  def: SettingDef,
  value: unknown,
): SettingValue {
  switch (def.type) {
    case "boolean":
      if (typeof value !== "boolean") {
        throw new Error(`${def.key} は真偽値で指定してください`);
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${def.key} は数値で指定してください`);
      }
      if (
        (def.min !== undefined && value < def.min) ||
        (def.max !== undefined && value > def.max)
      ) {
        throw new Error(
          `${def.key} は ${def.min}〜${def.max} の範囲で指定してください`,
        );
      }
      return value;
    case "string":
      if (typeof value !== "string") {
        throw new Error(`${def.key} は文字列で指定してください`);
      }
      if (def.maxLength !== undefined && value.length > def.maxLength) {
        throw new Error(`${def.key} が長すぎます`);
      }
      return value;
    case "enum":
      if (
        typeof value !== "string" ||
        !(def.enumValues ?? []).includes(value)
      ) {
        throw new Error(
          `${def.key} は ${(def.enumValues ?? []).join(" / ")} のいずれかで指定してください`,
        );
      }
      return value;
  }
}
