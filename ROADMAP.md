# Roadmap

Roadmap は、機能数を増やすことよりも、既存のセキュリティ境界と検証可能性を維持しながら段階的に拡張するための計画です。各 Phase の機能は、完了条件と回帰検証を満たすまで完成扱いにしません。

## Phase 1 — Foundation

**Status: ✅ 基盤実装済み**

Electron、React、TypeScript、Monaco、Preload、型付き IPC、Workspace の基本読み書き、Security verification、CI/CD、文書を提供します。完了条件は `npm ci`、`npm run typecheck`、`npm run verify:all`、`npm run build`、`npm run package` が通過し、Windows CI で主要フローが確認できることです。

## Phase 2 — Core Editor

**Status: ✅ 実装済み**

Tabs、Editor Groups（最大2グループ）、再帰 Explorer（遅延読み込み）、Workspace Search / Replace、Multi Cursor（Monaco 標準）、未保存変更表示、競合検知を追加しました。

```text
Explorer selection -> model registry -> tab state -> editor group layout
```

大きな Workspace の性能、ファイル Watcher、Atomic Write を設計してから実装しました。Watcher は Windows / macOS では再帰監視、Linux ではルート＋直下ディレクトリ監視＋開いているタブの `file:stat` ポーリング（5秒）で補完します。保存は同一ディレクトリの一時ファイルへの書き込み＋rename による Atomic Write で、開いた時点の mtime と異なる場合は上書きを拒否します。検索は最大2000ファイル／500件、1ファイル1MBまで、`.git` / `node_modules` / `out` / `dist` / `release` と隠しファイルを除外します。

## Phase 3 — Developer Tools

**Status: ⏳ 一部実装（共通基盤＋Git 読み取り）**

Language Server、Completion、Hover、Signature Help、Diagnostics、Git、Integrated Terminal、Tasks、Debugger / DAP を追加します。外部 process は `shell: false`、argv 分離、cwd 検証、timeout、stop、exit code、stdout / stderr 分離を共通要件とします。

実装済み:

- 共通の外部プロセス実行サービス（`src/main/process/process-runner.ts`）。上記の共通要件を一箇所に集約し、コマンドは Main のサービスが選ぶ素の実行ファイル名のみ、出力は stdout / stderr 分離＋上限付きで捕捉します。
- Git パネル（Source Control、Ctrl+Shift+G）。`git status --porcelain=v2 --branch` のパースによるブランチ・ahead/behind・ステージ済み／変更／未追跡の一覧と、最近のコミット（最大100件）の表示。変更エントリのクリックでファイルを開けます。
- Git の書き込み操作: ステージング、ステージ取り消し、変更の破棄（確認ダイアログ付き）、コミット。パスは Main で Workspace 境界を再検証し、`--` 区切りで argv として渡します。
- Git の同期: フェッチ、プル（fast-forward のみ）、プッシュ（初回は upstream を自動設定）。資格情報プロンプトは無効化し、認証はユーザーの Git 設定に委ねます。

- Diagnostics 第一弾: Problems パネル（Ctrl+Shift+M）。ワークスペース自身の TypeScript（`tsc --noEmit`）の出力をパースし、ファイル別にエラー／警告を表示、クリックで該当位置へ移動します。結果の形式はチェッカー非依存で、将来の言語サーバー診断も同じパネルに流せます。

- Tasks: `.touwa/tasks.json` のタスク定義を Tasks パネルから実行（明示的な実行操作のみ、自動実行なし）。定義の検証は Main で行い、Renderer からはラベルだけを受けます。書式は `docs/TASKS.md`。

- 常駐プロセスセッション基盤（`src/main/process/session-manager.ts`）と Terminal パネル（Ctrl+`）。シェルをワークスペースで起動し、入出力をストリーミングします。現状はパイプ接続のコンソールで PTY ではないため、TTY が必要な全画面プログラムは動作しません。PTY 化は今後の課題です。セッション基盤は言語サーバー接続にも流用できます。

未実装: Language Server 系（Completion / Hover / Signature Help と常駐型の診断）、Debugger / DAP、ターミナルの PTY 化。

## Phase 4 — Extensibility

**Status: ⏳ 計画中**

Settings、Themes、Extension Host、Extension manifest、capability-based permissions、API versioning を追加します。Extension に Main の無制限権限を与えず、プロセスと権限を分離します。

## Phase 5 — Quality

**Status: ⏳ 計画中**

Regression tests、Security hardening、Performance profiling、Release automation、Dependency automation、Crash diagnostics を強化します。

## Prioritization rules

優先順位は Security、Stability、Correctness、Maintainability、Testability、Extensibility、UX、新機能の順です。各機能は、既存の境界を曖昧にする場合は延期し、まず共通 service または verification の改善を行います。
