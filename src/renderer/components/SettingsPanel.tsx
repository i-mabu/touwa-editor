import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import type { SettingValue, SettingsLoadResult } from "./types";

type SettingsPanelProps = {
  onGetSettings: () => Promise<SettingsLoadResult>;
  onSetSetting: (
    key: string,
    value: SettingValue,
  ) => Promise<SettingsLoadResult>;
};

const FONT_SIZE_KEY = "editor.fontSize";
const FONT_FAMILY_KEY = "editor.fontFamily";
const TAB_SIZE_KEY = "editor.tabSize";
const WORD_WRAP_KEY = "editor.wordWrap";
const MINIMAP_KEY = "editor.minimap.enabled";
const COLOR_THEME_KEY = "workbench.colorTheme";

function numberValue(
  values: Record<string, SettingValue>,
  key: string,
  fallback: number,
): number {
  const value = values[key];
  return typeof value === "number" ? value : fallback;
}

function stringValue(
  values: Record<string, SettingValue>,
  key: string,
): string {
  const value = values[key];
  return typeof value === "string" ? value : "";
}

export default function SettingsPanel({
  onGetSettings,
  onSetSetting,
}: SettingsPanelProps): JSX.Element {
  const [values, setValues] = useState<Record<string, SettingValue>>({});
  const [errors, setErrors] = useState<SettingsLoadResult["errors"]>({
    user: null,
    workspace: null,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [info, setInfo] = useState("読み込み中…");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const applyResult = useCallback((result: SettingsLoadResult): void => {
    setValues(result.effective);
    setErrors(result.errors);
    setLoadError(null);
    setInfo("");
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const result = await onGetSettings();
      applyResult(result);
      setDrafts({});
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : "設定を読めませんでした",
      );
      setInfo("");
    }
  }, [onGetSettings, applyResult]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearDraft = useCallback((key: string): void => {
    setDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const commit = useCallback(
    async (key: string, value: SettingValue): Promise<void> => {
      setBusy(true);
      try {
        const result = await onSetSetting(key, value);
        applyResult(result);
      } catch (e) {
        setLoadError(
          e instanceof Error ? e.message : "設定を保存できませんでした",
        );
      } finally {
        // Success or failure, the input falls back to the effective
        // value Main reports, so a rejected save never lingers.
        clearDraft(key);
        setBusy(false);
      }
    },
    [onSetSetting, applyResult, clearDraft],
  );

  const draftFor = (key: string, fallback: string): string =>
    drafts[key] ?? fallback;

  const setDraft = (key: string, text: string): void => {
    setDrafts((prev) => ({ ...prev, [key]: text }));
  };

  // Text and number inputs edit a local draft and only save on blur
  // (or Enter), so a save never fires per keystroke.
  const commitText = (key: string): void => {
    const text = drafts[key];
    if (text === undefined) return;
    if (text === stringValue(values, key)) {
      clearDraft(key);
      return;
    }
    void commit(key, text);
  };

  const commitNumber = (key: string, min: number, max: number): void => {
    const text = drafts[key];
    if (text === undefined) return;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      clearDraft(key);
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    if (clamped === values[key]) {
      clearDraft(key);
      return;
    }
    void commit(key, clamped);
  };

  const blurOnEnter = (
    e: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  return (
    <aside className="git-panel">
      <div className="pane-title">SETTINGS</div>
      <div className="git-body">
        <div className="git-actions">
          <button onClick={() => void refresh()}>再読み込み</button>
        </div>
        {loadError && <div className="search-info">{loadError}</div>}
        {errors.user && (
          <div className="search-info">
            ユーザー設定の読み込みエラー: {errors.user}
          </div>
        )}
        {errors.workspace && (
          <div className="search-info">
            ワークスペース設定の読み込みエラー: {errors.workspace}
          </div>
        )}
        {info && <div className="search-info">{info}</div>}

        <div className="git-section">エディタ</div>
        <div className="task-row">
          <div className="task-main">
            <div className="task-label">フォントサイズ</div>
            <div className="task-command">
              {FONT_SIZE_KEY}（8〜72）
            </div>
          </div>
          <input
            type="number"
            min={8}
            max={72}
            value={draftFor(
              FONT_SIZE_KEY,
              String(numberValue(values, FONT_SIZE_KEY, 14)),
            )}
            disabled={busy}
            onChange={(e) => setDraft(FONT_SIZE_KEY, e.target.value)}
            onBlur={() => commitNumber(FONT_SIZE_KEY, 8, 72)}
            onKeyDown={blurOnEnter}
          />
        </div>
        <div className="task-row">
          <div className="task-main">
            <div className="task-label">フォント</div>
            <div className="task-command">
              {FONT_FAMILY_KEY}（空欄の場合は既定のフォント）
            </div>
          </div>
          <input
            type="text"
            value={draftFor(
              FONT_FAMILY_KEY,
              stringValue(values, FONT_FAMILY_KEY),
            )}
            placeholder="空欄で既定フォント"
            disabled={busy}
            onChange={(e) => setDraft(FONT_FAMILY_KEY, e.target.value)}
            onBlur={() => commitText(FONT_FAMILY_KEY)}
            onKeyDown={blurOnEnter}
          />
        </div>
        <div className="task-row">
          <div className="task-main">
            <div className="task-label">タブ幅</div>
            <div className="task-command">{TAB_SIZE_KEY}（1〜8）</div>
          </div>
          <input
            type="number"
            min={1}
            max={8}
            value={draftFor(
              TAB_SIZE_KEY,
              String(numberValue(values, TAB_SIZE_KEY, 4)),
            )}
            disabled={busy}
            onChange={(e) => setDraft(TAB_SIZE_KEY, e.target.value)}
            onBlur={() => commitNumber(TAB_SIZE_KEY, 1, 8)}
            onKeyDown={blurOnEnter}
          />
        </div>
        <div className="task-row">
          <div className="task-main">
            <div className="task-label">行の折り返し</div>
            <div className="task-command">{WORD_WRAP_KEY}</div>
          </div>
          <select
            value={
              stringValue(values, WORD_WRAP_KEY) === "on" ? "on" : "off"
            }
            disabled={busy}
            onChange={(e) => void commit(WORD_WRAP_KEY, e.target.value)}
          >
            <option value="off">折り返さない（off）</option>
            <option value="on">折り返す（on）</option>
          </select>
        </div>
        <div className="task-row">
          <div className="task-main">
            <div className="task-label">ミニマップ</div>
            <div className="task-command">{MINIMAP_KEY}</div>
          </div>
          <input
            type="checkbox"
            checked={values[MINIMAP_KEY] !== false}
            disabled={busy}
            onChange={(e) => void commit(MINIMAP_KEY, e.target.checked)}
          />
        </div>

        <div className="git-section">ワークベンチ</div>
        <div className="task-row">
          <div className="task-main">
            <div className="task-label">カラーテーマ</div>
            <div className="task-command">{COLOR_THEME_KEY}</div>
            <div className="task-command">
              テーマの切り替え自体は今後の Themes 増分で有効になります（現在は保存のみ）
            </div>
            <div className="task-command">
              このキーはユーザー設定のみが対象です（ワークスペース設定では指定できません）
            </div>
          </div>
          <input
            type="text"
            value={draftFor(
              COLOR_THEME_KEY,
              stringValue(values, COLOR_THEME_KEY),
            )}
            placeholder="vs-dark"
            disabled={busy}
            onChange={(e) => setDraft(COLOR_THEME_KEY, e.target.value)}
            onBlur={() => commitText(COLOR_THEME_KEY)}
            onKeyDown={blurOnEnter}
          />
        </div>
      </div>
      <div className="search-hint">
        変更はユーザー設定に保存されます。ワークスペースに
        .touwa/settings.json がある場合、一部の設定はそちらが優先されます。
      </div>
    </aside>
  );
}
