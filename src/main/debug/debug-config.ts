import fs from "node:fs/promises";
import path from "node:path";

// ==========================================
// ⚙️ External debug adapter configuration (Phase 3)
// ==========================================
// 🐛 Workspaces can register external Debug Adapter Protocol servers
// in `.touwa/debug.json`:
//
//   { "adapters": [
//       { "id": "python", "command": "python",
//         "args": ["-m", "debugpy.adapter"], "extensions": [".py"] }
//   ] }
//
// Files whose extension matches an adapter are debugged through it;
// .js/.mjs/.cjs files keep using the built-in Node.js debugger.
// The command must be a bare executable name on PATH (the shared
// process contract forbids paths), and every field is validated in
// Main — the renderer never sees or edits this file's raw content.

export type DebugAdapterConfig = {
  id: string;
  command: string;
  args: string[];
  extensions: string[];
};

export type DebugConfigResult = {
  adapters: DebugAdapterConfig[];
  error: string | null;
};

export const DEBUG_CONFIG_FILE = ".touwa/debug.json";
const MAX_ADAPTERS = 10;
const MAX_ARGS = 32;
const MAX_EXTENSIONS = 16;

export function parseDebugConfig(text: string): DebugAdapterConfig[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("debug.json が JSON として読めません");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("debug.json はオブジェクトである必要があります");
  }
  const adapters = (data as { adapters?: unknown }).adapters;
  if (!Array.isArray(adapters)) {
    throw new Error("debug.json の adapters は配列である必要があります");
  }
  if (adapters.length > MAX_ADAPTERS) {
    throw new Error(`アダプタは最大 ${MAX_ADAPTERS} 件までです`);
  }
  const seen = new Set<string>();
  return adapters.map((entry, index) => {
    const label = `adapters[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label} はオブジェクトである必要があります`);
    }
    const candidate = entry as {
      id?: unknown;
      command?: unknown;
      args?: unknown;
      extensions?: unknown;
    };
    if (
      typeof candidate.id !== "string" ||
      candidate.id.length === 0 ||
      candidate.id.length > 64
    ) {
      throw new Error(`${label}.id が不正です`);
    }
    if (seen.has(candidate.id)) {
      throw new Error(`アダプタ id が重複しています: ${candidate.id}`);
    }
    seen.add(candidate.id);
    if (
      typeof candidate.command !== "string" ||
      candidate.command.length === 0 ||
      candidate.command.includes("/") ||
      candidate.command.includes("\\") ||
      candidate.command.includes("\0")
    ) {
      throw new Error(
        `${label}.command は PATH 上の実行ファイル名で指定してください`,
      );
    }
    const args = candidate.args ?? [];
    if (
      !Array.isArray(args) ||
      args.length > MAX_ARGS ||
      args.some((arg) => typeof arg !== "string" || arg.length > 1024)
    ) {
      throw new Error(`${label}.args が不正です`);
    }
    if (
      !Array.isArray(candidate.extensions) ||
      candidate.extensions.length === 0 ||
      candidate.extensions.length > MAX_EXTENSIONS
    ) {
      throw new Error(`${label}.extensions が不正です`);
    }
    const extensions = candidate.extensions.map((ext) => {
      if (typeof ext !== "string" || !/^\.[a-z0-9]+$/i.test(ext)) {
        throw new Error(`${label}.extensions に不正な拡張子があります`);
      }
      return ext.toLowerCase();
    });
    return {
      id: candidate.id,
      command: candidate.command,
      args: args as string[],
      extensions,
    };
  });
}

export async function loadDebugConfig(
  root: string,
): Promise<DebugConfigResult> {
  const file = path.join(root, DEBUG_CONFIG_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    // ⚠️ No debug.json is a normal state, not an error.
    return { adapters: [], error: null };
  }
  try {
    return { adapters: parseDebugConfig(text), error: null };
  } catch (e) {
    return {
      adapters: [],
      error: e instanceof Error ? e.message : "debug.json の読み込みに失敗しました",
    };
  }
}

/** Finds the adapter registered for a file's extension, if any. */
export function adapterForPath(
  adapters: DebugAdapterConfig[],
  relativePath: string,
): DebugAdapterConfig | null {
  const ext = path.extname(relativePath).toLowerCase();
  if (!ext) return null;
  return adapters.find((adapter) => adapter.extensions.includes(ext)) ?? null;
}
