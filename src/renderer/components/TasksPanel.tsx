import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type { TaskDef, TaskRunResult, TasksListResult } from "./types";

type TasksPanelProps = {
  onListTasks: () => Promise<TasksListResult>;
  onRunTask: (label: string) => Promise<TaskRunResult>;
};

export default function TasksPanel({
  onListTasks,
  onRunTask,
}: TasksPanelProps): JSX.Element {
  const [tasks, setTasks] = useState<TaskDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState("読み込み中…");
  const [runningLabel, setRunningLabel] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<TaskRunResult | null>(null);
  const [runError, setRunError] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await onListTasks();
      setTasks(result.tasks);
      setError(result.error);
      setInfo(
        result.error
          ? ""
          : result.tasks.length === 0
            ? ".touwa/tasks.json にタスクが定義されていません"
            : "",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "タスクを読めませんでした");
    }
  }, [onListTasks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(task: TaskDef): Promise<void> {
    setRunningLabel(task.label);
    setRunError("");
    try {
      setLastRun(await onRunTask(task.label));
    } catch (e) {
      setLastRun(null);
      setRunError(
        e instanceof Error ? e.message : "タスクの実行に失敗しました",
      );
    } finally {
      setRunningLabel(null);
    }
  }

  return (
    <aside className="git-panel">
      <div className="pane-title">TASKS</div>
      <div className="git-body">
        <div className="git-actions">
          <button onClick={() => void refresh()}>再読み込み</button>
        </div>
        {error && <div className="search-info">{error}</div>}
        {info && <div className="search-info">{info}</div>}
        {tasks.map((task) => (
          <div key={task.label} className="task-row">
            <div className="task-main">
              <div className="task-label">{task.label}</div>
              <div className="task-command">
                {task.command}
                {task.args.length > 0 ? ` ${task.args.join(" ")}` : ""}
                {task.cwd !== "." ? ` （cwd: ${task.cwd}）` : ""}
              </div>
            </div>
            <button
              className="git-row-action task-run"
              title="タスクを実行"
              disabled={runningLabel !== null}
              onClick={() => void run(task)}
            >
              {runningLabel === task.label ? "…" : "▶"}
            </button>
          </div>
        ))}
        {runError && <div className="search-info">{runError}</div>}
        {lastRun && (
          <>
            <div className="git-section">
              {lastRun.label} —{" "}
              {lastRun.timedOut
                ? "タイムアウト"
                : `終了コード ${lastRun.exitCode ?? "?"}`}{" "}
              （{(lastRun.durationMs / 1000).toFixed(1)} 秒）
            </div>
            {lastRun.stdout && (
              <pre className="task-output">{lastRun.stdout}</pre>
            )}
            {lastRun.stderr && (
              <pre className="task-output task-stderr">{lastRun.stderr}</pre>
            )}
            {(lastRun.stdoutTruncated || lastRun.stderrTruncated) && (
              <div className="search-info">
                出力が長いため一部省略しています
              </div>
            )}
            {!lastRun.stdout && !lastRun.stderr && (
              <div className="search-info">出力はありませんでした</div>
            )}
          </>
        )}
      </div>
      <div className="search-hint">
        タスクは .touwa/tasks.json で定義し、実行ボタンを押したときだけ
        動きます（自動実行はしません）。書式は docs/TASKS.md
        を参照してください。
      </div>
    </aside>
  );
}
