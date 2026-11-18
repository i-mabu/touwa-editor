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

**Status: ✅ 完了**

Language Server、Completion、Hover、Signature Help、Diagnostics、Git、Integrated Terminal、Tasks、Debugger / DAP を追加します。外部 process は `shell: false`、argv 分離、cwd 検証、timeout、stop、exit code、stdout / stderr 分離を共通要件とします。

実装済み:

- 共通の外部プロセス実行サービス（`src/main/process/process-runner.ts`）。上記の共通要件を一箇所に集約し、コマンドは Main のサービスが選ぶ素の実行ファイル名のみ、出力は stdout / stderr 分離＋上限付きで捕捉します。
- Git パネル（Source Control、Ctrl+Shift+G）。`git status --porcelain=v2 --branch` のパースによるブランチ・ahead/behind・ステージ済み／変更／未追跡の一覧と、最近のコミット（最大100件）の表示。変更エントリのクリックでファイルを開けます。
- Git の書き込み操作: ステージング、ステージ取り消し、変更の破棄（確認ダイアログ付き）、コミット。パスは Main で Workspace 境界を再検証し、`--` 区切りで argv として渡します。
- Git の同期: フェッチ、プル（fast-forward のみ）、プッシュ（初回は upstream を自動設定）。資格情報プロンプトは無効化し、認証はユーザーの Git 設定に委ねます。

- Diagnostics 第一弾: Problems パネル（Ctrl+Shift+M）。ワークスペース自身の TypeScript（`tsc --noEmit`）の出力をパースし、ファイル別にエラー／警告を表示、クリックで該当位置へ移動します。結果の形式はチェッカー非依存で、将来の言語サーバー診断も同じパネルに流せます。

- Tasks: `.touwa/tasks.json` のタスク定義を Tasks パネルから実行（明示的な実行操作のみ、自動実行なし）。定義の検証は Main で行い、Renderer からはラベルだけを受けます。書式は `docs/TASKS.md`。

- 常駐プロセスセッション基盤（`src/main/process/session-manager.ts`）と Terminal パネル（Ctrl+`）。シェルをワークスペースで起動し、入出力をストリーミングします。セッション基盤は言語サーバー接続にも流用できます。

- Terminal の PTY 化: セッションは node-pty による疑似端末で起動します（`src/main/process/pty-manager.ts`）。対話プロンプト、エコーなしのパスワード入力、Ctrl+C、isatty 判定が実端末どおりに機能します。node-pty（ネイティブモジュール）を読み込めない環境ではパイプ接続に自動でフォールバックし、パネルに接続モード（PTY / パイプ）を表示します。パネルはスクロール型コンソールのため、全画面 TUI の描画には対応しません。

- Language Server 第一弾: 同梱の typescript-language-server による常駐型の診断。開いている TypeScript / JavaScript ファイルを全文同期し（変更は Renderer で 400ms デバウンス）、サーバーが発行する診断を tsc と同じ形式に変換して Problems パネルに常時表示します（出典は [lsp] / [tsc] で区別）。サーバーはワークスペース自身の TypeScript を優先し、無ければ同梱版を使います。プロセス管理はセッション基盤を、フレーミングと JSON-RPC は `src/main/lsp/` を使います。

- Language Server 第二弾: Completion / Hover / Signature Help。Monaco にプロバイダを登録し、言語サーバーの結果を表示します（補完候補は最大200件、種別は Monaco の CompletionItemKind に変換）。リクエスト前に保留中の変更同期を即時送信してサーバーとエディタの内容を一致させます。重複を避けるため、TS/JS については Monaco 標準の補完・Hover・Signature Help を無効化しています。

- Debugger 第一弾: Node.js デバッガ。対象ファイル（.js / .mjs / .cjs）を `node --inspect-brk` で起動し、V8 Inspector（CDP）を Main の `src/main/debug/` が DAP 方式の API に変換します。Debug パネル（Ctrl+Shift+D）から開始／停止／再開／一時停止／ステップ実行ができ、コールスタックと変数（オブジェクトは展開可能）を表示します。ブレークポイントはエディタのガターマージン（行番号の左）のクリックで切り替え、停止中の行はエディタにハイライトします。ブレークポイントは実行中の変更も即時反映され、ファイルの削除・リネームにも追従します。同時に実行できるセッションは1つです。

- 外部 DAP アダプタ: `.touwa/debug.json` に登録した Debug Adapter Protocol サーバーで他言語をデバッグできます（`src/main/debug/dap-client.ts` / `dap-debug-service.ts` / `debug-config.ts`）。対象ファイルの拡張子で内蔵 Node.js デバッガと自動で切り替え、ブレークポイント／ステップ実行／コールスタック／変数表示は同じ Debug パネルで操作します。起動引数は program / cwd / stopOnEntry の汎用セットのみで、アダプタの逆リクエストには対応しません。書式は `docs/DEBUGGING.md`。

## Phase 4 — Extensibility

**Status: ⏳ 一部実装（拡張の検出・マニフェスト検証、Settings 基盤まで）**

Settings、Themes、Extension Host、Extension manifest、capability-based permissions、API versioning を追加します。Extension に Main の無制限権限を与えず、プロセスと権限を分離します。

- Extension manifest 第一弾: ユーザー拡張フォルダとワークスペースの `.touwa/extensions` を走査し、`package.json` マニフェストを検証して Extensions パネル（Ctrl+Shift+X）に一覧表示します（`src/main/extensions/extensions-service.ts`）。`engines.touwa` の範囲チェック（fail closed）、contributes.commands の抽出、capabilities の許可リスト照合（未知の権限は警告として分離）までを含みます。拡張コードの実行はまだ行いません。書式は `docs/EXTENSIONS.md`。

- Settings 基盤: スキーマ宣言表に基づく3層設定（既定 < ユーザー設定 < ワークスペース `.touwa/settings.json`）。各層は全項目を Main で検証し、不正な層は理由付きで丸ごと無効化、`scope: "user"` のキーはワークスペース層から設定できません。Settings パネル（Ctrl+,）でユーザー設定を編集でき、Monaco の fontSize / fontFamily / tabSize / wordWrap / minimap に即時反映されます（`src/main/settings/`、書式は `docs/SETTINGS.md`）。

未実装: Themes（`workbench.colorTheme` の実効化を含む）、Extension Host（拡張の実行）、API versioning。

## Phase 5 — Quality

**Status: ⏳ 計画中**

Regression tests、Security hardening、Performance profiling、Release automation、Dependency automation、Crash diagnostics を強化します。

## Prioritization rules

優先順位は Security、Stability、Correctness、Maintainability、Testability、Extensibility、UX、新機能の順です。各機能は、既存の境界を曖昧にする場合は延期し、まず共通 service または verification の改善を行います。
