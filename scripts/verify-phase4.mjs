import { readFile } from "node:fs/promises";

const required = [
  [
    "src/main/extensions/extensions-service.ts",
    ["scanExtensions", "parseExtensionManifest", "KNOWN_CAPABILITIES"],
  ],
  [
    "src/main/ipc/register-ipc.ts",
    ["extensions:list"],
  ],
  [
    "src/preload/preload.ts",
    ["extensions"],
  ],
  [
    "src/renderer/components/ExtensionsPanel.tsx",
    ["ExtensionsPanel"],
  ],
  [
    "src/renderer/App.tsx",
    ["extensions"],
  ],
  [
    "src/main/settings/settings-schema.ts",
    ["SETTING_DEFS", "validateSettingValue"],
  ],
  [
    "src/main/settings/settings-service.ts",
    ["getEffectiveSettings", "setUserSetting", "parseSettingsFile"],
  ],
  [
    "src/main/ipc/register-ipc.ts",
    ["settings:get", "settings:set"],
  ],
  [
    "src/preload/preload.ts",
    ["settings"],
  ],
  [
    "src/renderer/components/SettingsPanel.tsx",
    ["SettingsPanel"],
  ],
  [
    "src/renderer/App.tsx",
    ["settings"],
  ],
];

let failed = false;
for (const [file, needles] of required) {
  const text = await readFile(file, "utf8");
  for (const needle of needles) {
    if (!text.includes(needle)) {
      console.error(`verify:phase4: ${file} is missing: ${needle}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log("verify:phase4 passed");
