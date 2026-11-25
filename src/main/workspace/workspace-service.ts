import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  assertExistingWorkspacePath,
  assertWorkspacePath,
} from "./path-security.ts";

export type FileEntry = {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size?: number;
  mtimeMs?: number;
};

export type FileSnapshot = {
  content: string;
  mtimeMs: number;
  size: number;
  hash: string;
};

export type SearchOptions = {
  caseSensitive?: boolean;
  regex?: boolean;
  maxMatches?: number;
};

export type SearchMatch = {
  relativePath: string;
  line: number;
  column: number;
  lineText: string;
};

export type SearchResult = {
  matches: SearchMatch[];
  truncated: boolean;
  filesSearched: number;
};

export type ReplaceResult = {
  filesChanged: number;
  totalReplacements: number;
  perFile: { relativePath: string; replacements: number }[];
  skipped: string[];
};

export const MAX_FILE_SIZE = 20_000_000;
const MAX_SEARCH_FILE_SIZE = 1_000_000;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_MATCHES = 500;
const MAX_LIST_ENTRIES = 1000;
const MAX_SEARCH_DEPTH = 12;
const SKIPPED_DIRS = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "release",
  ".touwa",
]);

export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

async function listOneDir(
  rootReal: string,
  relativeDir: string,
): Promise<FileEntry[]> {
  const dir = relativeDir === "" ? rootReal : path.join(rootReal, relativeDir);
  const dirents = await fs.readdir(dir, { withFileTypes: true });
  const visible = dirents.filter((entry) => !isHidden(entry.name));
  visible.sort((a, b) => a.name.localeCompare(b.name));
  // 📁 Stat calls run in parallel: a directory can hold up to
  // MAX_LIST_ENTRIES files and sequential stats are slow on Windows.
  const entries = await Promise.all(
    visible
      .slice(0, MAX_LIST_ENTRIES)
      .map(async (entry): Promise<FileEntry | null> => {
        const relativePath = toPosix(
          relativeDir === ""
            ? entry.name
            : path.posix.join(relativeDir, entry.name),
        );
        if (entry.isDirectory()) {
          return { name: entry.name, relativePath, kind: "directory" };
        }
        if (entry.isFile()) {
          try {
            const stat = await fs.stat(path.join(dir, entry.name));
            return {
              name: entry.name,
              relativePath,
              kind: "file",
              size: stat.size,
              mtimeMs: Math.round(stat.mtimeMs),
            };
          } catch {
            return { name: entry.name, relativePath, kind: "file" };
          }
        }
        if (entry.isSymbolicLink()) {
          // 📝 List symlinks with the kind of their target. Opening one still
          // goes through the realpath boundary check in readWorkspaceFile /
          // statWorkspaceFile, so a link that escapes the workspace is
          // listed here but refused when opened. Broken links are shown
          // as files so the user can still rename / delete them.
          try {
            const stat = await fs.stat(path.join(dir, entry.name));
            return stat.isDirectory()
              ? { name: entry.name, relativePath, kind: "directory" }
              : {
                  name: entry.name,
                  relativePath,
                  kind: "file",
                  size: stat.size,
                  mtimeMs: Math.round(stat.mtimeMs),
                };
          } catch {
            return { name: entry.name, relativePath, kind: "file" };
          }
        }
        return null;
      }),
  );
  // 📝 Directories first, then name. Sorting happens after symlink targets
  // are resolved so a link to a directory sorts with the directories.
  return entries
    .filter((entry): entry is FileEntry => entry !== null)
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export async function listWorkspace(
  workspaceRoot: string,
): Promise<FileEntry[]> {
  const root = await fs.realpath(workspaceRoot);
  return listOneDir(root, "");
}

/** Lazy-loading directory listing for the recursive Explorer. */
export async function listDirectory(
  workspaceRoot: string,
  relativeDir = "",
): Promise<FileEntry[]> {
  if (typeof relativeDir !== "string" || path.isAbsolute(relativeDir)) {
    throw new Error("A relative workspace path is required.");
  }
  const root = await fs.realpath(workspaceRoot);
  if (relativeDir !== "") {
    const target = await assertExistingWorkspacePath(
      workspaceRoot,
      relativeDir,
    );
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) throw new Error("Only directories can be listed.");
    void root;
  }
  return listOneDir(root, toPosix(relativeDir));
}

export async function statWorkspaceFile(
  root: string,
  relativePath: string,
): Promise<Omit<FileSnapshot, "content">> {
  const target = await assertExistingWorkspacePath(root, relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("Only files can be opened.");
  // 🖥️ The hash needs the content, and the Renderer polls this for every
  // open tab: refuse oversized files instead of reading them in full,
  // exactly like readWorkspaceFile does.
  if (stat.size > MAX_FILE_SIZE) throw new Error("File is too large to open.");
  const content = await fs.readFile(target, "utf8");
  return {
    mtimeMs: Math.round(stat.mtimeMs),
    size: stat.size,
    hash: computeHash(content),
  };
}

export async function readWorkspaceFile(
  root: string,
  relativePath: string,
): Promise<FileSnapshot> {
  const target = await assertExistingWorkspacePath(root, relativePath);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error("Only files can be opened.");
  if (stat.size > MAX_FILE_SIZE) throw new Error("File is too large to open.");
  const content = await fs.readFile(target, "utf8");
  return {
    content,
    mtimeMs: Math.round(stat.mtimeMs),
    size: stat.size,
    hash: computeHash(content),
  };
}

async function writeAtomic(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  const tempName = `.${path.basename(target)}.touwa-tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const tempPath = path.join(dir, tempName);
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, target);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Atomic save with conflict detection. When expectedMtimeMs is given and
 * the file on disk no longer has that mtime, the write is refused so an
 * external edit is never silently overwritten. Pass no expected mtime
 * only for an explicit user-confirmed overwrite.
 */
export async function writeWorkspaceFile(
  root: string,
  relativePath: string,
  content: string,
  expectedMtimeMs?: number,
): Promise<FileSnapshot> {
  // ⚖️ Compare UTF-8 bytes, not UTF-16 code units: with multibyte text the
  // old length check accepted files well over MAX_FILE_SIZE that
  // readWorkspaceFile would then refuse to open again.
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content, "utf8") > MAX_FILE_SIZE
  )
    throw new Error("Invalid file content.");
  if (
    expectedMtimeMs !== undefined &&
    (typeof expectedMtimeMs !== "number" || !Number.isFinite(expectedMtimeMs))
  ) {
    throw new Error("Invalid expected file version.");
  }
  const target = assertWorkspacePath(root, relativePath);
  const rootReal = await fs.realpath(root);
  const parentReal = await fs.realpath(path.dirname(target));
  if (
    parentReal !== rootReal &&
    !parentReal.startsWith(`${rootReal}${path.sep}`)
  )
    throw new Error("Target is outside workspace.");
  let existing: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    existing = await fs.stat(target);
  } catch {
    existing = null;
  }
  if (existing) {
    if (!existing.isFile()) throw new Error("Only files can be saved.");
    if (
      expectedMtimeMs !== undefined &&
      Math.round(existing.mtimeMs) !== Math.round(expectedMtimeMs)
    ) {
      throw new Error(
        "File changed on disk since it was opened. Reload before saving.",
      );
    }
  }
  await writeAtomic(target, content);
  const stat = await fs.stat(target);
  return {
    content,
    mtimeMs: Math.round(stat.mtimeMs),
    size: stat.size,
    hash: computeHash(content),
  };
}

function buildMatcher(
  query: string,
  options: SearchOptions,
): { test: (line: string) => { index: number; length: number }[] } {
  if (options.regex) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(query, options.caseSensitive ? "g" : "gi");
    } catch {
      throw new Error("Invalid regular expression.");
    }
    return {
      test: (line: string) => {
        const found: { index: number; length: number }[] = [];
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(line)) !== null) {
          found.push({
            index: match.index,
            length: Math.max(match[0].length, 1),
          });
          if (match[0].length === 0) pattern.lastIndex += 1;
          if (found.length > 100) break;
        }
        return found;
      },
    };
  }
  const needle = options.caseSensitive ? query : query.toLowerCase();
  return {
    test: (line: string) => {
      const haystack = options.caseSensitive ? line : line.toLowerCase();
      const found: { index: number; length: number }[] = [];
      let from = 0;
      for (;;) {
        const index = haystack.indexOf(needle, from);
        if (index === -1) break;
        found.push({ index, length: needle.length });
        from = index + Math.max(needle.length, 1);
        if (found.length > 100) break;
      }
      return found;
    },
  };
}

async function collectSearchFiles(rootReal: string): Promise<string[]> {
  const files: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: rootReal, depth: 0 }];
  while (stack.length > 0 && files.length < MAX_SEARCH_FILES) {
    const current = stack.pop();
    if (!current) break;
    let dirents: import("node:fs").Dirent[] | null = null;
    try {
      dirents = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirents) {
      if (isHidden(entry.name) || SKIPPED_DIRS.has(entry.name)) continue;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_SEARCH_DEPTH)
          stack.push({ dir: full, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        files.push(full);
        if (files.length >= MAX_SEARCH_FILES) break;
      }
    }
  }
  return files;
}

export async function searchWorkspace(
  root: string,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  if (typeof query !== "string" || query.length === 0 || query.length > 200) {
    throw new Error("Search query must be 1 to 200 characters.");
  }
  const maxMatches = Math.min(
    Math.max(options.maxMatches ?? MAX_SEARCH_MATCHES, 1),
    MAX_SEARCH_MATCHES,
  );
  const matcher = buildMatcher(query, options);
  const rootReal = await fs.realpath(root);
  const files = await collectSearchFiles(rootReal);
  const matches: SearchMatch[] = [];
  let filesSearched = 0;
  let truncated = false;
  for (const file of files) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_SIZE) continue;
    let content: string;
    try {
      const buffer = await fs.readFile(file);
      if (buffer.includes(0)) continue; // binary
      content = buffer.toString("utf8");
    } catch {
      continue;
    }
    filesSearched += 1;
    const relativePath = toPosix(path.relative(rootReal, file));
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const hit of matcher.test(line)) {
        matches.push({
          relativePath,
          line: i + 1,
          column: hit.index + 1,
          lineText: line.slice(0, 200),
        });
        if (matches.length >= maxMatches) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
  }
  return { matches, truncated, filesSearched };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count the matches of a global pattern, advancing past empty matches. */
function countGlobalMatches(content: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    count += 1;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return count;
}

/**
 * Apply one file's replacement and report how many replacements the
 * write will actually make. Plain-text replacements are literal in
 * every mode: a `$` in the replacement is only special for regex
 * searches, where capture-group references are the point.
 */
function applyReplacement(
  content: string,
  query: string,
  replacement: string,
  options: SearchOptions,
): { next: string; count: number } {
  if (options.regex) {
    const flags = options.caseSensitive ? "g" : "gi";
    const count = countGlobalMatches(content, new RegExp(query, flags));
    if (count === 0) return { next: content, count: 0 };
    return {
      next: content.replace(new RegExp(query, flags), replacement),
      count,
    };
  }
  if (options.caseSensitive) {
    const count = content.split(query).length - 1;
    if (count === 0) return { next: content, count: 0 };
    return { next: content.split(query).join(replacement), count };
  }
  const flags = "gi";
  const count = countGlobalMatches(
    content,
    new RegExp(escapeRegExp(query), flags),
  );
  if (count === 0) return { next: content, count: 0 };
  return {
    next: content.replace(
      new RegExp(escapeRegExp(query), flags),
      () => replacement,
    ),
    count,
  };
}

export async function replaceInWorkspace(
  root: string,
  query: string,
  replacement: string,
  options: SearchOptions = {},
): Promise<ReplaceResult> {
  if (typeof query !== "string" || query.length === 0 || query.length > 200) {
    throw new Error("Search query must be 1 to 200 characters.");
  }
  if (typeof replacement !== "string" || replacement.length > 100_000) {
    throw new Error("Replacement text is too long.");
  }
  if (options.regex) {
    // ⚠️ Fail fast on an invalid pattern, before any file is touched.
    try {
      new RegExp(query, options.caseSensitive ? "g" : "gi");
    } catch {
      throw new Error("Invalid regular expression.");
    }
  }
  // 📝 Replace walks the files itself instead of reusing searchWorkspace:
  // search results are capped at MAX_SEARCH_MATCHES, so building the
  // file list from them silently left every later file unreplaced
  // (and unreported) once a workspace had more matches than the cap.
  // The per-file limits (size, binary, file count) match search.
  const rootReal = await fs.realpath(root);
  const files = await collectSearchFiles(rootReal);
  const perFile: { relativePath: string; replacements: number }[] = [];
  const skipped: string[] = [];
  let totalReplacements = 0;
  for (const file of files) {
    const relativePath = toPosix(path.relative(rootReal, file));
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_SIZE) continue;
    let content: string;
    try {
      const buffer = await fs.readFile(file);
      if (buffer.includes(0)) continue; // binary
      content = buffer.toString("utf8");
    } catch {
      continue;
    }
    const { next, count } = applyReplacement(
      content,
      query,
      replacement,
      options,
    );
    if (count === 0 || next === content) continue;
    try {
      // 📥 The mtime from before the read is the conflict guard: if the
      // file changed while it was being processed, the write is
      // refused and the file is reported as skipped.
      await writeWorkspaceFile(
        root,
        relativePath,
        next,
        Math.round(stat.mtimeMs),
      );
      perFile.push({ relativePath, replacements: count });
      totalReplacements += count;
    } catch {
      skipped.push(relativePath);
    }
  }
  return { filesChanged: perFile.length, totalReplacements, perFile, skipped };
}

/** Recursive file list for Quick Open (Ctrl+P). Names only, capped. */
export async function listWorkspaceFiles(root: string): Promise<string[]> {
  const rootReal = await fs.realpath(root);
  const files = await collectSearchFiles(rootReal);
  return files
    .map((file) => toPosix(path.relative(rootReal, file)))
    .sort((a, b) => a.localeCompare(b));
}

function refuseProtectedPath(relativePath: string): void {
  const normalized = toPosix(relativePath);
  const first = normalized.split("/")[0];
  // '' and '.' both denote the workspace root itself; '.' used to slip
  // through and surface as a raw OS error (or worse) from rename.
  if (first === ".git" || first === "" || normalized === ".")
    throw new Error("This path cannot be changed.");
}

/** Create an empty file or a directory, like VS Code's Explorer actions. */
export async function createWorkspaceEntry(
  root: string,
  relativePath: string,
  kind: "file" | "directory",
): Promise<FileEntry> {
  if (kind !== "file" && kind !== "directory")
    throw new Error("Invalid entry kind.");
  refuseProtectedPath(relativePath);
  const target = assertWorkspacePath(root, relativePath);
  const rootReal = await fs.realpath(root);
  const parentReal = await fs.realpath(path.dirname(target));
  if (
    parentReal !== rootReal &&
    !parentReal.startsWith(`${rootReal}${path.sep}`)
  )
    throw new Error("Target is outside workspace.");
  let existing: Awaited<ReturnType<typeof fs.stat>> | null = null;
  try {
    existing = await fs.stat(target);
  } catch {
    existing = null;
  }
  if (existing) throw new Error("An entry with this name already exists.");
  if (kind === "directory") {
    await fs.mkdir(target);
    return {
      name: path.basename(target),
      relativePath: toPosix(relativePath),
      kind: "directory",
    };
  }
  // 'wx' fails instead of truncating when the name was taken after the
  // existence check above (a plain writeFile would silently empty an
  // existing file in that race).
  await fs.writeFile(target, "", { encoding: "utf8", flag: "wx" });
  return {
    name: path.basename(target),
    relativePath: toPosix(relativePath),
    kind: "file",
    size: 0,
    mtimeMs: Math.round(Date.now()),
  };
}

/** Rename / move an entry within the workspace. */
export async function renameWorkspaceEntry(
  root: string,
  oldRelativePath: string,
  newRelativePath: string,
): Promise<FileEntry> {
  refuseProtectedPath(oldRelativePath);
  refuseProtectedPath(newRelativePath);
  const source = await assertExistingWorkspacePath(root, oldRelativePath);
  const target = assertWorkspacePath(root, newRelativePath);
  const rootReal = await fs.realpath(root);
  const parentReal = await fs.realpath(path.dirname(target));
  if (
    parentReal !== rootReal &&
    !parentReal.startsWith(`${rootReal}${path.sep}`)
  )
    throw new Error("Target is outside workspace.");
  try {
    await fs.stat(target);
    throw new Error("An entry with this name already exists.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists"))
      throw error;
  }
  await fs.rename(source, target);
  const stat = await fs.stat(target);
  return {
    name: path.basename(target),
    relativePath: toPosix(newRelativePath),
    kind: stat.isDirectory() ? "directory" : "file",
    size: stat.isFile() ? stat.size : undefined,
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

/** Delete a file or directory (recursive). The workspace root and .git are refused. */
export async function deleteWorkspaceEntry(
  root: string,
  relativePath: string,
): Promise<void> {
  if (
    typeof relativePath !== "string" ||
    relativePath === "" ||
    relativePath === "."
  ) {
    throw new Error("The workspace root cannot be deleted.");
  }
  refuseProtectedPath(relativePath);
  const target = await assertExistingWorkspacePath(root, relativePath);
  await fs.rm(target, { recursive: true, force: false });
}
