import { runProcess } from "../process/process-runner.ts";

// ===== Git integration (Phase 3, read-only) =====
// All git invocations go through the shared process runner with a
// fixed argv built here in Main. The renderer only ever receives the
// parsed result; it cannot influence the command line. Status uses
// the porcelain v2 format because it is stable across git versions
// and locales, and paths are requested relative to the workspace
// root (git's status.relativePaths default) so they line up with the
// Explorer's relative paths.

export type GitChangeKind =
  "tracked" | "renamed" | "unmerged" | "untracked" | "ignored";

export type GitStatusEntry = {
  relativePath: string;
  originalPath?: string;
  /** Index (staged) status character from porcelain v2 XY, "." when clean. */
  indexStatus: string;
  /** Worktree status character from porcelain v2 XY, "." when clean. */
  worktreeStatus: string;
  kind: GitChangeKind;
};

export type GitStatus = {
  isRepository: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
  truncated: boolean;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  /** Author date as unix seconds. */
  authorTime: number;
};

const MAX_STATUS_ENTRIES = 1_000;
const GIT_TIMEOUT_MS = 15_000;
export const MAX_LOG_ENTRIES = 100;
export const DEFAULT_LOG_ENTRIES = 30;

const NOT_A_REPOSITORY: GitStatus = {
  isRepository: false,
  branch: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  entries: [],
  truncated: false,
};

/** Split off the first `count` space-separated tokens; the rest is one field. */
function splitHead(line: string, count: number): string[] {
  const parts: string[] = [];
  let rest = line;
  for (let i = 0; i < count; i += 1) {
    const idx = rest.indexOf(" ");
    if (idx === -1) {
      parts.push(rest);
      rest = "";
      break;
    }
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  parts.push(rest);
  return parts;
}

export function parseGitStatusPorcelainV2(output: string): GitStatus {
  const status: GitStatus = {
    isRepository: true,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
    truncated: false,
  };
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("# ")) {
      const header = line.slice(2);
      if (header.startsWith("branch.head ")) {
        const head = header.slice("branch.head ".length).trim();
        status.branch = head.startsWith("(detached") ? null : head;
      } else if (header.startsWith("branch.upstream ")) {
        status.upstream = header.slice("branch.upstream ".length).trim();
      } else if (header.startsWith("branch.ab ")) {
        const match = /\+(\d+) -(\d+)/.exec(header);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      }
      continue;
    }
    if (status.entries.length >= MAX_STATUS_ENTRIES) {
      status.truncated = true;
      continue;
    }
    const tag = line[0];
    if (tag === "?" || tag === "!") {
      status.entries.push({
        relativePath: line.slice(2),
        indexStatus: tag,
        worktreeStatus: tag,
        kind: tag === "?" ? "untracked" : "ignored",
      });
    } else if (tag === "1") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = splitHead(line, 8);
      const xy = parts[1] ?? "..";
      status.entries.push({
        relativePath: parts[8] ?? "",
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
        kind: "tracked",
      });
    } else if (tag === "2") {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <newPath>\t<origPath>
      const parts = splitHead(line, 9);
      const xy = parts[1] ?? "..";
      const joined = parts[9] ?? "";
      const tab = joined.indexOf("\t");
      status.entries.push({
        relativePath: tab === -1 ? joined : joined.slice(0, tab),
        originalPath: tab === -1 ? undefined : joined.slice(tab + 1),
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
        kind: "renamed",
      });
    } else if (tag === "u") {
      // u <XY> <sub> <m1> <m2> <m3> <h1> <h2> <h3> <path>
      const parts = splitHead(line, 9);
      const xy = parts[1] ?? "..";
      status.entries.push({
        relativePath: parts[9] ?? "",
        indexStatus: xy[0] ?? ".",
        worktreeStatus: xy[1] ?? ".",
        kind: "unmerged",
      });
    }
  }
  return status;
}

export function parseGitLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const fields = line.split("\u001f");
    if (fields.length !== 5) continue;
    const [hash, shortHash, subject, authorName, authorTime] = fields;
    commits.push({
      hash,
      shortHash,
      subject,
      authorName,
      authorTime: Number(authorTime) || 0,
    });
  }
  return commits;
}

async function runGit(
  root: string,
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await runProcess({
    command: "git",
    args: ["--no-optional-locks", "-c", "core.quotepath=false", ...args],
    cwd: root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return result;
}

function isNotRepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr);
}

export async function getGitStatus(root: string): Promise<GitStatus> {
  let result: Awaited<ReturnType<typeof runGit>>;
  try {
    result = await runGit(root, [
      "status",
      "--porcelain=v2",
      "--branch",
      "--untracked-files=normal",
    ]);
  } catch {
    // git is not installed or could not be started: the panel shows
    // the same "not a repository" state instead of an error dialog.
    return NOT_A_REPOSITORY;
  }
  if (result.exitCode !== 0) {
    if (isNotRepository(result.stderr)) return NOT_A_REPOSITORY;
    throw new Error(
      `git status failed: ${result.stderr.trim() || "unknown error"}`,
    );
  }
  return parseGitStatusPorcelainV2(result.stdout);
}

export async function getGitLog(
  root: string,
  limit: number = DEFAULT_LOG_ENTRIES,
): Promise<GitCommit[]> {
  const count = Math.max(
    1,
    Math.min(
      Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LOG_ENTRIES,
      MAX_LOG_ENTRIES,
    ),
  );
  let result: Awaited<ReturnType<typeof runGit>>;
  try {
    result = await runGit(root, [
      "log",
      `-n${count}`,
      "--format=%H%x1f%h%x1f%s%x1f%an%x1f%at",
    ]);
  } catch {
    return [];
  }
  if (result.exitCode !== 0) {
    // Not a repository, or a repository with no commits yet.
    return [];
  }
  return parseGitLog(result.stdout);
}
