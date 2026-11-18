import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type { ExtensionInfo, ExtensionsListResult } from "./types";

type ExtensionsPanelProps = {
  onListExtensions: () => Promise<ExtensionsListResult>;
};

function scopeLabel(scope: ExtensionInfo["scope"]): string {
  return scope === "user" ? "ユーザー" : "ワークスペース";
}

export default function ExtensionsPanel({
  onListExtensions,
}: ExtensionsPanelProps): JSX.Element {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [info, setInfo] = useState("読み込み中…");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await onListExtensions();
      setExtensions(result.extensions);
      setErrors(result.errors);
      setLoadError(null);
      setInfo(
        result.extensions.length === 0
          ? "拡張機能が見つかりませんでした"
          : "",
      );
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : "拡張機能を読めませんでした",
      );
      setInfo("");
    }
  }, [onListExtensions]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <aside className="git-panel">
      <div className="pane-title">EXTENSIONS</div>
      <div className="git-body">
        <div className="git-actions">
          <button onClick={() => void refresh()}>再読み込み</button>
        </div>
        {loadError && <div className="search-info">{loadError}</div>}
        {info && <div className="search-info">{info}</div>}
        {extensions.map((ext) => (
          <div key={`${ext.scope}:${ext.id}`} className="task-row">
            <div className="task-main">
              <div className="task-label">
                {ext.displayName} {ext.version}
              </div>
              <div className="task-command">
                {ext.id}（{scopeLabel(ext.scope)}）
              </div>
              {ext.description && (
                <div className="task-command">{ext.description}</div>
              )}
              {!ext.compatible && (
                <div className="task-command">
                  このバージョンでは非対応です
                </div>
              )}
              {ext.commands.length > 0 && (
                <>
                  <div className="git-section">コマンド</div>
                  {ext.commands.map((cmd) => (
                    <div key={cmd.command} className="task-command">
                      {cmd.title}（{cmd.command}）
                    </div>
                  ))}
                </>
              )}
              {ext.capabilities.length > 0 && (
                <div className="task-command">
                  権限: {ext.capabilities.join(", ")}
                </div>
              )}
              {ext.unknownCapabilities.length > 0 && (
                <div className="task-command">
                  警告: 未知の権限が宣言されています:{" "}
                  {ext.unknownCapabilities.join(", ")}
                </div>
              )}
            </div>
          </div>
        ))}
        {errors.length > 0 && (
          <>
            <div className="git-section">読み込みエラー</div>
            {errors.map((message, index) => (
              <div key={index} className="search-info">
                {message}
              </div>
            ))}
          </>
        )}
      </div>
      <div className="search-hint">
        拡張機能はユーザー拡張フォルダとワークスペースの .touwa/extensions
        に配置します。現在は一覧表示のみで、拡張機能の実行にはまだ対応していません。
      </div>
    </aside>
  );
}
