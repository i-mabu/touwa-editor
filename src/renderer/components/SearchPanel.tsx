import { useState } from "react";
import type { SearchMatch } from "./types";

type SearchPanelProps = {
  onSearch: (
    query: string,
    options: { caseSensitive: boolean; regex: boolean },
  ) => Promise<{
    matches: SearchMatch[];
    truncated: boolean;
    filesSearched: number;
  }>;
  onReplaceAll: (
    query: string,
    replacement: string,
    options: { caseSensitive: boolean; regex: boolean },
  ) => Promise<{
    filesChanged: number;
    totalReplacements: number;
    skipped: string[];
  }>;
  onJumpTo: (match: SearchMatch) => void;
};

export default function SearchPanel({
  onSearch,
  onReplaceAll,
  onJumpTo,
}: SearchPanelProps): JSX.Element {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [info, setInfo] = useState("検索する文字列を入力してください");
  const [busy, setBusy] = useState(false);

  async function runSearch(): Promise<void> {
    if (!query) {
      setInfo("検索する文字列を入力してください");
      return;
    }
    setBusy(true);
    try {
      const result = await onSearch(query, { caseSensitive, regex });
      setMatches(result.matches);
      setInfo(
        `${result.matches.length}件${result.truncated ? "（上限に達しました）" : ""} / ${result.filesSearched}ファイル`,
      );
    } catch (e) {
      setInfo(e instanceof Error ? e.message : "検索できませんでした");
    } finally {
      setBusy(false);
    }
  }

  async function runReplaceAll(): Promise<void> {
    if (!query) return;
    if (
      !window.confirm(
        `「${query}」を「${replacement}」に置換します。よろしいですか？`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await onReplaceAll(query, replacement, {
        caseSensitive,
        regex,
      });
      setInfo(
        `${result.filesChanged}ファイル / ${result.totalReplacements}件を置換しました` +
          (result.skipped.length > 0
            ? `（スキップ: ${result.skipped.join(", ")}）`
            : ""),
      );
      await runSearch();
    } catch (e) {
      setInfo(e instanceof Error ? e.message : "置換できませんでした");
    } finally {
      setBusy(false);
    }
  }

  const byFile = new Map<string, SearchMatch[]>();
  for (const match of matches) {
    const list = byFile.get(match.relativePath) ?? [];
    list.push(match);
    byFile.set(match.relativePath, list);
  }

  return (
    <aside className="search-panel">
      <div className="pane-title">SEARCH</div>
      <div className="search-form">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch();
          }}
          placeholder="検索"
          aria-label="検索"
        />
        <input
          value={replacement}
          onChange={(e) => setReplacement(e.target.value)}
          placeholder="置換"
          aria-label="置換"
        />
        <label className="search-option">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />{" "}
          大文字小文字を区別
        </label>
        <label className="search-option">
          <input
            type="checkbox"
            checked={regex}
            onChange={(e) => setRegex(e.target.checked)}
          />{" "}
          正規表現
        </label>
        <div className="search-actions">
          <button disabled={busy} onClick={() => void runSearch()}>
            検索
          </button>
          <button
            disabled={busy || !query}
            onClick={() => void runReplaceAll()}
          >
            すべて置換
          </button>
        </div>
        <div className="search-info">{info}</div>
      </div>
      <div className="search-results">
        {[...byFile.entries()].map(([file, list]) => (
          <div key={file}>
            <div className="search-file">
              {file} ({list.length})
            </div>
            {list.map((match, index) => (
              <button
                key={`${match.line}:${match.column}:${index}`}
                className="search-match"
                onClick={() => onJumpTo(match)}
              >
                <span className="search-line-no">
                  {match.line}:{match.column}
                </span>{" "}
                {match.lineText.trim()}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="search-hint">
        エディタ内の検索・置換は Ctrl+F / Ctrl+H です。複数カーソルは
        Ctrl+クリック / Alt+クリックです。
      </div>
    </aside>
  );
}
