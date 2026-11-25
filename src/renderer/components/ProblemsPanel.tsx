import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type { Diagnostic, DiagnosticsResult } from "./types";

type ProblemsPanelProps = {
  /** Resident diagnostics from the language server, keyed by path. */
  lspDiagnostics: Map<string, Diagnostic[]>;
  onRunDiagnostics: () => Promise<DiagnosticsResult>;
  onJumpTo: (relativePath: string, line: number, column: number) => void;
};

export default function ProblemsPanel({
  lspDiagnostics,
  onRunDiagnostics,
  onJumpTo,
}: ProblemsPanelProps): JSX.Element {
  const [result, setResult] = useState<DiagnosticsResult | null>(null);
  const [info, setInfo] = useState("チェック中…");
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const next = await onRunDiagnostics();
      setResult(next);
      setInfo(
        next.available
          ? next.diagnostics.length === 0
            ? "問題は見つかりませんでした"
            : ""
          : (next.reason ?? "診断を利用できません"),
      );
    } catch (e) {
      setInfo(e instanceof Error ? e.message : "診断を実行できませんでした");
    } finally {
      setBusy(false);
    }
  }, [onRunDiagnostics]);

  useEffect(() => {
    void run();
  }, [run]);

  // 🖥️ The tsc run replaces only its own results; language-server
  // diagnostics for open files are resident and persist across runs.
  const diagnostics = [
    ...(result?.diagnostics ?? []),
    ...[...lspDiagnostics.values()].flat(),
  ];
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.length - errors;

  const groups = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const key = diagnostic.relativePath;
    const list = groups.get(key);
    if (list) list.push(diagnostic);
    else groups.set(key, [diagnostic]);
  }

  return (
    <aside className="git-panel">
      <div className="pane-title">PROBLEMS</div>
      <div className="git-body">
        <div className="git-actions">
          <button disabled={busy} onClick={() => void run()}>
            再チェック
          </button>
          {result?.available && diagnostics.length > 0 && (
            <span className="git-branch">
              エラー {errors} ・ 警告 {warnings}
            </span>
          )}
        </div>
        {info && diagnostics.length === 0 && (
          <div className="search-info">{info}</div>
        )}
        {[...groups.entries()].map(([file, entries]) => (
          <div key={file || "(project)"}>
            <div className="git-section">{file || "プロジェクト全体"}</div>
            {entries.map((diagnostic, index) =>
              diagnostic.line > 0 ? (
                <button
                  key={index}
                  className="problem-entry"
                  title={`${diagnostic.relativePath}(${diagnostic.line},${diagnostic.column})`}
                  onClick={() =>
                    onJumpTo(
                      diagnostic.relativePath,
                      diagnostic.line,
                      diagnostic.column,
                    )
                  }
                >
                  <span
                    className={
                      diagnostic.severity === "error"
                        ? "git-badge deleted"
                        : "git-badge modified"
                    }
                  >
                    {diagnostic.severity === "error" ? "E" : "W"}
                  </span>
                  <span className="git-path">
                    {diagnostic.line}:{diagnostic.column} {diagnostic.code}{" "}
                    {diagnostic.message} [{diagnostic.source}]
                  </span>
                </button>
              ) : (
                <div key={index} className="problem-entry-static">
                  <span
                    className={
                      diagnostic.severity === "error"
                        ? "git-badge deleted"
                        : "git-badge modified"
                    }
                  >
                    {diagnostic.severity === "error" ? "E" : "W"}
                  </span>
                  <span className="git-path">
                    {diagnostic.code} {diagnostic.message} [{diagnostic.source}]
                  </span>
                </div>
              ),
            )}
          </div>
        ))}
        {result?.truncated && (
          <div className="search-info">
            問題が多いため一部のみ表示しています
          </div>
        )}
      </div>
      <div className="search-hint">
        開いている TypeScript / JavaScript
        ファイルは言語サーバー（LSP）が常時チェックします。「再チェック」は
        ワークスペース全体を tsc --noEmit でチェックします。
      </div>
    </aside>
  );
}
