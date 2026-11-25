import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type { GitCommit, GitStatus, GitStatusEntry } from "./types";

type GitPanelProps = {
  onLoadStatus: () => Promise<GitStatus>;
  onLoadLog: (limit: number) => Promise<GitCommit[]>;
  onStage: (paths: string[]) => Promise<GitStatus>;
  onUnstage: (paths: string[]) => Promise<GitStatus>;
  onDiscard: (paths: string[]) => Promise<GitStatus>;
  onCommit: (message: string) => Promise<GitStatus>;
  onFetch: () => Promise<GitStatus>;
  onPull: () => Promise<GitStatus>;
  onPush: () => Promise<GitStatus>;
  onOpenFile: (relativePath: string) => void;
};

type Section = "staged" | "unstaged" | "ignored";

function badgeFor(entry: GitStatusEntry): { label: string; className: string } {
  if (entry.kind === "untracked")
    return { label: "U", className: "git-badge untracked" };
  if (entry.kind === "unmerged")
    return { label: "!", className: "git-badge unmerged" };
  if (entry.kind === "renamed")
    return { label: "R", className: "git-badge renamed" };
  if (entry.kind === "ignored")
    return { label: "I", className: "git-badge ignored" };
  const code =
    entry.worktreeStatus !== "." ? entry.worktreeStatus : entry.indexStatus;
  switch (code) {
    case "A":
      return { label: "A", className: "git-badge added" };
    case "D":
      return { label: "D", className: "git-badge deleted" };
    case "R":
      return { label: "R", className: "git-badge renamed" };
    default:
      return { label: "M", className: "git-badge modified" };
  }
}

function formatDate(authorTime: number): string {
  if (!authorTime) return "";
  return new Date(authorTime * 1000).toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export default function GitPanel({
  onLoadStatus,
  onLoadLog,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
  onFetch,
  onPull,
  onPush,
  onOpenFile,
}: GitPanelProps): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [info, setInfo] = useState("読み込み中…");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refreshLog = useCallback(async (): Promise<void> => {
    try {
      setCommits(await onLoadLog(30));
    } catch {
      // ⚠️ The status error (if any) is the one worth showing.
    }
  }, [onLoadLog]);

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const nextStatus = await onLoadStatus();
      setStatus(nextStatus);
      setInfo(
        nextStatus.isRepository
          ? ""
          : "このフォルダは Git リポジトリではありません（git が見つからない場合も同じ表示になります）",
      );
      await refreshLog();
    } catch (e) {
      setInfo(
        e instanceof Error ? e.message : "Git 情報を取得できませんでした",
      );
    } finally {
      setBusy(false);
    }
  }, [onLoadStatus, refreshLog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function mutate(
    action: (paths: string[]) => Promise<GitStatus>,
    paths: string[],
  ): Promise<void> {
    setBusy(true);
    try {
      setStatus(await action(paths));
      setInfo("");
    } catch (e) {
      setInfo(e instanceof Error ? e.message : "Git 操作に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function runCommit(): Promise<void> {
    if (!message.trim()) return;
    setBusy(true);
    try {
      setStatus(await onCommit(message));
      setMessage("");
      setInfo("");
      await refreshLog();
    } catch (e) {
      setInfo(e instanceof Error ? e.message : "コミットに失敗しました");
    } finally {
      setBusy(false);
    }
  }

  async function runSync(
    action: () => Promise<GitStatus>,
    doneMessage: string,
  ): Promise<void> {
    setBusy(true);
    try {
      setStatus(await action());
      setInfo(doneMessage);
      await refreshLog();
    } catch (e) {
      setInfo(e instanceof Error ? e.message : "同期に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  function runDiscard(entry: GitStatusEntry): void {
    if (
      !window.confirm(
        `「${entry.relativePath}」への変更を破棄します。元に戻せません。よろしいですか？`,
      )
    )
      return;
    void mutate(onDiscard, [entry.relativePath]);
  }

  const staged = (status?.entries ?? []).filter(
    (e) =>
      e.kind !== "untracked" && e.kind !== "ignored" && e.indexStatus !== ".",
  );
  const unstaged = (status?.entries ?? []).filter(
    (e) =>
      e.kind === "untracked" ||
      e.kind === "unmerged" ||
      e.worktreeStatus !== ".",
  );
  const ignored = (status?.entries ?? []).filter((e) => e.kind === "ignored");

  function renderEntry(entry: GitStatusEntry, section: Section): JSX.Element {
    const badge = badgeFor(entry);
    return (
      <div
        key={`${section}:${entry.kind}:${entry.relativePath}`}
        className="git-entry-row"
      >
        <button
          className="git-entry"
          title={
            entry.originalPath
              ? `${entry.originalPath} → ${entry.relativePath}`
              : entry.relativePath
          }
          onClick={() => onOpenFile(entry.relativePath)}
        >
          <span className={badge.className}>{badge.label}</span>
          <span className="git-path">{entry.relativePath}</span>
        </button>
        {section === "staged" && (
          <button
            className="git-row-action"
            title="ステージを取り消す"
            disabled={busy}
            onClick={() => void mutate(onUnstage, [entry.relativePath])}
          >
            −
          </button>
        )}
        {section === "unstaged" && (
          <>
            <button
              className="git-row-action"
              title="ステージする"
              disabled={busy}
              onClick={() => void mutate(onStage, [entry.relativePath])}
            >
              +
            </button>
            {entry.kind === "tracked" && entry.worktreeStatus !== "." && (
              <button
                className="git-row-action"
                title="変更を破棄する"
                disabled={busy}
                onClick={() => runDiscard(entry)}
              >
                ↩
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <aside className="git-panel">
      <div className="pane-title">SOURCE CONTROL</div>
      <div className="git-body">
        <div className="git-actions">
          <button disabled={busy} onClick={() => void refresh()}>
            更新
          </button>
          <button
            disabled={busy || !status?.isRepository}
            onClick={() => void runSync(onFetch, "フェッチが完了しました")}
          >
            フェッチ
          </button>
          <button
            disabled={busy || !status?.isRepository}
            onClick={() => void runSync(onPull, "プルが完了しました")}
          >
            プル
          </button>
          <button
            disabled={busy || !status?.isRepository}
            onClick={() => void runSync(onPush, "プッシュが完了しました")}
          >
            プッシュ
          </button>
          {status?.isRepository && (
            <span className="git-branch">
              {status.branch ?? "(detached HEAD)"}
              {status.upstream ? ` ↑${status.ahead} ↓${status.behind}` : ""}
            </span>
          )}
        </div>
        {info && <div className="search-info">{info}</div>}
        {status?.isRepository && (
          <>
            <div className="git-commit-form">
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="コミットメッセージ"
                aria-label="コミットメッセージ"
                rows={2}
              />
              <button
                disabled={busy || staged.length === 0 || !message.trim()}
                onClick={() => void runCommit()}
              >
                コミット（ステージ済み {staged.length} 件）
              </button>
            </div>
            <div className="git-section">ステージ済み ({staged.length})</div>
            {staged.map((entry) => renderEntry(entry, "staged"))}
            <div className="git-section">変更 ({unstaged.length})</div>
            {unstaged.map((entry) => renderEntry(entry, "unstaged"))}
            {ignored.length > 0 && (
              <>
                <div className="git-section">無視 ({ignored.length})</div>
                {ignored.map((entry) => renderEntry(entry, "ignored"))}
              </>
            )}
            {status.truncated && (
              <div className="search-info">
                変更が多いため一部のみ表示しています
              </div>
            )}
            <div className="git-section">最近のコミット</div>
            {commits.length === 0 && (
              <div className="search-info">コミットはまだありません</div>
            )}
            {commits.map((commit) => (
              <div key={commit.hash} className="git-commit" title={commit.hash}>
                <span className="git-hash">{commit.shortHash}</span>{" "}
                <span className="git-subject">{commit.subject}</span>
                <div className="git-commit-meta">
                  {commit.authorName} ・ {formatDate(commit.authorTime)}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
      <div className="search-hint">
        ステージング、コミット、フェッチ、プル（fast-forward
        のみ）、プッシュに対応しています。認証は Git
        の設定（SSH鍵や資格情報ヘルパー）を使います。
      </div>
    </aside>
  );
}
