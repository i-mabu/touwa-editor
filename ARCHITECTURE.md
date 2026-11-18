# アーキテクチャ

## 設計原則

Touwa Editor は、Renderer を UI に限定し、OS やファイルシステムへの権限を Main に集約します。機能数よりも、境界の明確さ、検証可能性、将来の拡張性を優先します。

## プロセスモデル

```text
┌─────────────────────────────┐
│ Renderer: React / Monaco    │  UI、表示状態、ユーザー操作
└──────────────┬──────────────┘
               │ typed window.touwa API
┌──────────────▼──────────────┐
│ Preload: contextBridge      │  最小限の IPC bridge
└──────────────┬──────────────┘
               │ explicit channels
┌──────────────▼──────────────┐
│ Main: IPC / Workspace       │  検証、FileSystem、OS API
└──────────────┬──────────────┘
               ▼
        FileSystem / Process / OS
```

## 責務

| レイヤー | 担当                                         | 禁止事項                                    |
| -------- | -------------------------------------------- | ------------------------------------------- |
| Renderer | React UI、Monaco、tabs、表示状態             | `fs`、`child_process`、任意 IPC             |
| Preload  | 型付き bridge、channel の固定                | ビジネスロジックの肥大化、Node API の全公開 |
| Main     | FileSystem、Workspace、process、OS、入力検証 | Renderer UI 状態の直接管理                  |

## ファイルの流れ

ファイルを開く場合、Renderer が `window.touwa.file.read(relativePath)` を呼び、Preload が `file:read` channel を invoke し、Main が Workspace root を解決して境界を検証します。検証に成功した場合だけ UTF-8 で読み込み、結果または安全なエラーを返します。

```text
click file
  -> window.touwa.file.read("src/main.ts")
  -> ipcRenderer.invoke("file:read", relativePath)
  -> Main validates root + path + realpath
  -> fs.readFile(target, "utf8")
  -> Renderer updates Monaco model
```

## Workspace セキュリティサービス

`src/main/workspace/path-security.ts` は、複数の FileSystem 機能が再利用する境界ユーティリティです。UI コンポーネントごとに検証を実装してはいけません。新しい copy、move、delete、rename API も同じ utility を利用します。

## 拡張ポイント

将来の機能は bounded service として追加します。

| ディレクトリ  | 責務                                     |
| ------------- | ---------------------------------------- |
| `terminal/`   | 外部 process と lifecycle                |
| `tasks/`      | task schema、実行権限、ログ              |
| `git/`        | argv 分離した Git client                 |
| `language/`   | Language Server lifecycle と diagnostics |
| `debugger/`   | DAP transport と session 管理            |
| `extensions/` | 権限付き Extension Host                  |

各サービスは Renderer に直接 Node.js API を渡さず、Preload に必要最小限の API を追加します。

## 状態管理

UI state は React component state で管理しています。Tabs と Editor Groups のドメイン state は `src/renderer/state/tabs.ts` に純粋関数として分離し、表示 state（ペイン切替、カーソル位置、ステータス）と区別しています。タブは開いた時点の内容・mtime・SHA-256 ハッシュを持ち、内容と保存済み内容の差分で未保存（dirty）を判定します。Main の永続 state（ディスク上のファイル）と Renderer の表示 state を混同しません。

## Phase 2 — コアエディタ

- **Tabs / Editor Groups**: `tabs.ts` の純粋関数で open / close / split / merge を行い、最大2グループまで対応します。同じファイルは既存タブへフォーカスします。
- **Recursive Explorer**: `workspace:listDir` でディレクトリを遅延読み込みします。ルート一覧は従来の `workspace:list` のままです。
- **Search / Replace**: Main の `searchWorkspace` / `replaceInWorkspace` が Workspace 境界内で走査します。検索は最大2000ファイル／500件、1ファイル1MBまで、`.git` / `node_modules` などを除外します。
- **Atomic Write / Conflict**: 保存は同一ディレクトリの一時ファイル＋rename で行い、開いた時点の mtime と異なる場合は拒否します。外部変更は Main の `watcher.ts`（Windows / macOS は再帰監視、Linux はルート＋直下）と、開いているタブの5秒ごとの `file:stat` 確認で検知します。
- **Multi Cursor / Find**: Monaco 標準機能です。`multiCursorModifier: 'ctrlCmd'` を有効化し、Find / Replace ウィジェットは既定のまま利用します。

## パフォーマンス指針

大量ファイルの Explorer では遅延読み込み、大きなファイルではサイズ制限または段階読み込み、Terminal では出力上限と backpressure、Watcher では debounce を検討します。UI thread を同期 FileSystem 操作でブロックしません。
