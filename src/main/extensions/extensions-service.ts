import fs from "node:fs/promises";
import path from "node:path";

// ===== Extension discovery (Phase 4) =====
// Extensions are folders containing a package.json manifest, in
// two locations: the user extensions directory (app data) and the
// workspace's `.touwa/extensions`. This first increment only
// discovers and validates manifests — nothing is executed. The
// capability list is an allowlist: unknown capabilities are
// reported, never silently granted, and a later host will enforce
// the declared set at runtime.

export type ExtensionScope = "user" | "workspace";

export type ExtensionCommand = { command: string; title: string };

export type ExtensionInfo = {
  id: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  publisher: string;
  scope: ExtensionScope;
  folder: string;
  main: string | null;
  activationEvents: string[];
  commands: ExtensionCommand[];
  capabilities: string[];
  unknownCapabilities: string[];
  /** Whether engines.touwa accepts the running app version. */
  compatible: boolean;
};

export type ExtensionsListResult = {
  extensions: ExtensionInfo[];
  errors: string[];
};

export const KNOWN_CAPABILITIES = [
  "commands",
  "workspace.read",
  "workspace.write",
  "notifications",
  "terminal.create",
  "debug.start",
] as const;

const MAX_EXTENSIONS = 100;
const MAX_MANIFEST_BYTES = 256 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-._]*$/i;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i;

function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Minimal engines range check: undefined / "*" accepts anything,
 * "x.y.z" is exact, "^x.y.z" is same-major and not older. Anything
 * else is treated as incompatible (fail closed).
 */
export function engineSatisfied(
  range: string | undefined,
  appVersion: string,
): boolean {
  if (range === undefined || range === "*" || range === "") return true;
  const app = parseVersion(appVersion);
  if (!app) return false;
  if (range.startsWith("^")) {
    const base = parseVersion(range.slice(1));
    if (!base) return false;
    return base[0] === app[0] && compareVersion(app, base) >= 0;
  }
  const exact = parseVersion(range);
  if (!exact) return false;
  return compareVersion(app, exact) === 0;
}

export function parseExtensionManifest(
  text: string,
  scope: ExtensionScope,
  folder: string,
  appVersion: string,
): ExtensionInfo {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("package.json が JSON として読めません");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("package.json はオブジェクトである必要があります");
  }
  const m = data as Record<string, unknown>;
  if (
    typeof m.name !== "string" ||
    !NAME_PATTERN.test(m.name) ||
    m.name.length > 128
  ) {
    throw new Error("name が不正です");
  }
  if (typeof m.version !== "string" || !VERSION_PATTERN.test(m.version)) {
    throw new Error("version が不正です");
  }
  const publisher =
    typeof m.publisher === "string" && m.publisher.length <= 64
      ? m.publisher
      : "";
  const engines = m.engines as { touwa?: unknown } | undefined;
  const touwaRange =
    engines && typeof engines.touwa === "string" ? engines.touwa : undefined;
  const activationEvents = Array.isArray(m.activationEvents)
    ? m.activationEvents
        .filter((e): e is string => typeof e === "string")
        .slice(0, 32)
    : [];
  const contributes = m.contributes as
    | { commands?: unknown }
    | undefined;
  const commands: ExtensionCommand[] = [];
  if (contributes && Array.isArray(contributes.commands)) {
    for (const entry of contributes.commands.slice(0, 64)) {
      const c = entry as { command?: unknown; title?: unknown };
      if (typeof c?.command === "string" && typeof c?.title === "string") {
        commands.push({ command: c.command, title: c.title });
      }
    }
  }
  const rawCapabilities = Array.isArray(m.capabilities)
    ? m.capabilities.filter((c): c is string => typeof c === "string")
    : [];
  const known = new Set<string>(KNOWN_CAPABILITIES);
  return {
    id: publisher ? `${publisher}.${m.name}` : m.name,
    name: m.name,
    displayName:
      typeof m.displayName === "string" && m.displayName.length <= 128
        ? m.displayName
        : m.name,
    version: m.version,
    description:
      typeof m.description === "string"
        ? m.description.slice(0, 1024)
        : "",
    publisher,
    scope,
    folder,
    main: typeof m.main === "string" ? m.main : null,
    activationEvents,
    commands,
    capabilities: rawCapabilities.filter((c) => known.has(c)),
    unknownCapabilities: rawCapabilities.filter((c) => !known.has(c)),
    compatible: engineSatisfied(touwaRange, appVersion),
  };
}

export async function scanExtensions(
  locations: { scope: ExtensionScope; dir: string }[],
  appVersion: string,
): Promise<ExtensionsListResult> {
  const extensions: ExtensionInfo[] = [];
  const errors: string[] = [];
  for (const location of locations) {
    let entries: string[];
    try {
      const dirents = await fs.readdir(location.dir, {
        withFileTypes: true,
      });
      entries = dirents
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      // A missing extensions directory is a normal state.
      continue;
    }
    for (const folder of entries.slice(0, MAX_EXTENSIONS)) {
      const manifestPath = path.join(location.dir, folder, "package.json");
      try {
        const stat = await fs.stat(manifestPath);
        if (stat.size > MAX_MANIFEST_BYTES) {
          throw new Error("package.json が大きすぎます");
        }
        const text = await fs.readFile(manifestPath, "utf8");
        extensions.push(
          parseExtensionManifest(text, location.scope, folder, appVersion),
        );
      } catch (e) {
        errors.push(
          `${location.scope}/${folder}: ${e instanceof Error ? e.message : "読み込みに失敗しました"}`,
        );
      }
    }
  }
  extensions.sort((a, b) => a.id.localeCompare(b.id));
  return { extensions, errors };
}
