import fs from "node:fs";
import path from "node:path";
import { runProcess } from "../process/process-runner.ts";
import { assertWorkspacePath } from "../workspace/path-security.ts";

// ==========================================
// 📌 Tasks (Phase 3)
// ==========================================
// 🗂️ A workspace may declare tasks in .touwa/tasks.json:
//   { "tasks": [ { "label": "test", "command": "npm",
//                  "args": ["test"], "cwd": "." } ] }
// Security model:
//   - Tasks run ONLY when the user explicitly clicks Run in the
//     Tasks panel. Nothing ever auto-runs on folder open.
//   - The renderer sends only a task label; Main re-reads and
//     re-validates the file at run time, so the renderer can never
//     supply a command or arguments of its own.
//   - Commands are bare executable names and arguments are an argv
//     array (the shared runner enforces shell: false), and the
//     working directory must stay inside the workspace.
// A malformed file yields an error message and no tasks, never a
// partially-valid list.

export type TaskDef = {
  label: string;
  command: string;
  args: string[];
  /** Workspace-relative working directory ("." for the root). */
  cwd: string;
};

export type TasksListResult = {
  tasks: TaskDef[];
  /** Why the list is empty due to a problem, or null. */
  error: string | null;
};

export type TaskRunResult = {
  label: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
};

export const MAX_TASKS = 20;
const MAX_LABEL_LENGTH = 100;
const MAX_TASK_ARGS = 64;
const TASK_TIMEOUT_MS = 120_000;
const TASKS_FILE = path.join(".touwa", "tasks.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTaskDef(value: unknown, index: number): TaskDef {
  const where = `tasks[${index}]`;
  if (!isRecord(value)) throw new Error(`${where} はオブジェクトが必要です`);
  const { label, command, args, cwd } = value;
  if (
    typeof label !== "string" ||
    label.trim().length === 0 ||
    label.length > MAX_LABEL_LENGTH
  ) {
    throw new Error(`${where}.label が不正です`);
  }
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.includes("/") ||
    command.includes("\\") ||
    command.includes("\0")
  ) {
    throw new Error(
      `${where}.command は実行ファイル名のみを指定してください（パス不可）`,
    );
  }
  if (
    !Array.isArray(args) ||
    args.length > MAX_TASK_ARGS ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  ) {
    throw new Error(`${where}.args が不正です`);
  }
  if (
    cwd !== undefined &&
    (typeof cwd !== "string" || cwd.length === 0 || cwd.includes("\0"))
  ) {
    throw new Error(`${where}.cwd が不正です`);
  }
  return {
    label,
    command,
    args: args as string[],
    cwd: typeof cwd === "string" ? cwd : ".",
  };
}

export function parseTasksFile(text: string): TaskDef[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("tasks.json が JSON として読めません");
  }
  if (!isRecord(data) || !Array.isArray(data.tasks)) {
    throw new Error('tasks.json には { "tasks": [...] } が必要です');
  }
  if (data.tasks.length > MAX_TASKS) {
    throw new Error(`タスクは最大 ${MAX_TASKS} 件までです`);
  }
  const tasks = data.tasks.map((entry, index) => parseTaskDef(entry, index));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.label)) {
      throw new Error(`ラベルが重複しています: ${task.label}`);
    }
    seen.add(task.label);
  }
  return tasks;
}

export async function loadTasks(root: string): Promise<TasksListResult> {
  const file = path.join(root, TASKS_FILE);
  let text: string;
  try {
    text = await fs.promises.readFile(file, "utf8");
  } catch {
    // ⚠️ No tasks file is a normal state, not an error.
    return { tasks: [], error: null };
  }
  try {
    return { tasks: parseTasksFile(text), error: null };
  } catch (e) {
    return {
      tasks: [],
      error: e instanceof Error ? e.message : "tasks.json を読めません",
    };
  }
}

export async function runTask(
  root: string,
  label: string,
): Promise<TaskRunResult> {
  if (typeof label !== "string" || label.length === 0) {
    throw new Error("Invalid task label.");
  }
  const { tasks, error } = await loadTasks(root);
  if (error !== null) throw new Error(error);
  const task = tasks.find((entry) => entry.label === label);
  if (!task) throw new Error(`Task not found: ${label}`);
  // 📁 The task's working directory must stay inside the workspace.
  const cwd =
    task.cwd === "."
      ? root
      : assertWorkspacePath(root, task.cwd.replace(/\\/g, "/"));
  const started = Date.now();
  const result = await runProcess({
    command: task.command,
    args: task.args,
    cwd,
    timeoutMs: TASK_TIMEOUT_MS,
  });
  return {
    label: task.label,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: Date.now() - started,
  };
}
