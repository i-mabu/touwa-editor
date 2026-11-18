# ADR 0004: Phase 2 コアエディタ

## 背景

Phase 1 は単一ファイル表示と Workspace 直下の一覧だけで、日常の編集にはタブ、再帰 Explorer、検索、未保存・競合の扱いが欠けていました。ROADMAP の Phase 2 は、既存のセキュリティ境界と検証可能性を維持したままこれらを追加する計画でした。

## 決定

- **Tabs / Editor Groups**: タブとグループの状態遷移を `src/renderer/state/tabs.ts` の純粋関数に分離し、React コンポーネントから切り離して `node --test` で検証できるようにします。グループは最大2つまでとします。
- **Recursive Explorer**: ディレクトリを `workspace:listDir` で遅延読み込みします。大きな Workspace を開いた瞬間に全走査しないためです。
- **Search / Replace**: 走査と置換は Main 側で行い、Renderer は結果表示だけを担当します。検索対象から `.git` / `node_modules` などを除外し、件数とファイル数に上限を設けます。
- **Atomic Write / Conflict**: 保存は同一ディレクトリの一時ファイル＋rename で行い、開いた時点の mtime と異なる場合は拒否します。外部変更の検知は Main Watcher（Windows / macOS は再帰、Linux はルート＋直下）と、開いているタブの定期 `file:stat` 確認の二重化とします。Watcher だけに依存しません。
- **Snapshot**: `file.read` / `file.write` は内容と mtime・サイズ・SHA-256 ハッシュを返します。mtime だけでは同一時刻の書き換えを見逃すため、ハッシュも比較します。
- **Multi Cursor / Find**: Monaco 標準機能を使い、自前エディタは実装しません。`multiCursorModifier: 'ctrlCmd'` を有効化します。

## 代替案

- タブ状態を App.tsx 内に残す: 検証が GUI 経由だけになり、回帰検出が遅れるため却下。
- Watcher だけで外部変更を検知する: Linux の `fs.watch` は再帰非対応で、見逃しがあり得るため却下。定期 stat 確認と保存時チェックを併用します。
- 保存時に常に上書きする: 外部変更を無言で消すため却下。明示的な上書き操作のときだけ競合チェックを外します。
- 検索を Renderer で行う: Renderer にファイル走査権限を与えることになり、境界を崩すため却下。

## 結果

- タブ／グループの振る舞いは `npm test` で回帰検証できます。
- 保存の失敗が「競合」としてユーザーに伝わり、再読込か上書きかを選べます。
- Linux では深い階層の外部変更通知が遅れる場合がありますが、5秒以内の stat 確認と保存時チェックで最終的に検知します。
- Editor Groups は2つまで、検索は2000ファイル／500件までという上限が残ります。
