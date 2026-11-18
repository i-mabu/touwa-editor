# Changelog

このファイルは、利用者に影響する変更を Semantic Versioning と対応付けて記録します。Unreleased の変更は次回 Release 前に分類し、実装されていない内容を Added として記載しません。

## [Unreleased]

### Added

- Phase 3 の共通基盤として、外部プロセス実行サービス（`src/main/process/process-runner.ts`）を追加しました。`shell: false`、argv 分離、cwd 検証、timeout（SIGTERM→SIGKILL）、stdout / stderr の分離捕捉と上限、exit code の返却を共通化しています。
- Source Control パネル（Git、Ctrl+Shift+G／アクティビティバーの GT）を追加しました。ブランチと ahead/behind、ステージ済み／変更／未追跡／競合の一覧、最近のコミット（最大100件）を表示し、変更エントリのクリックでファイルを開けます。読み取り専用です。
- `git.status` / `git.log` IPC と `verify:phase3`、`npm test` に Phase 3 のテスト7件（計28件）を追加しました。
- Git パネルに書き込み操作を追加しました。変更のステージング、ステージ取り消し、破棄（確認ダイアログ付き）、コミットメッセージ欄からのコミットに対応します（`git.stage` / `git.unstage` / `git.discard` / `git.commit` IPC）。パスは Main で Workspace 境界を再検証します。Phase 3 テストは計10件（全体31件）になりました。
- Git パネルに同期操作を追加しました。フェッチ、プル（fast-forward のみ、分岐時はエラー）、プッシュ（初回は upstream を自動設定）に対応します（`git.fetch` / `git.pull` / `git.push` IPC）。プロセス実行サービスに環境変数の受け渡しを追加し、資格情報プロンプトを無効化して認証はユーザーの Git 設定に委ねます。Phase 3 テストは計12件（全体33件）になりました。
- Problems パネル（Ctrl+Shift+M）を追加しました。ワークスペース自身の TypeScript（`tsc --noEmit`）で型チェックし、エラー／警告をファイル別に表示、クリックで該当位置へ移動します（`diagnostics.run` IPC）。tsconfig が無いワークスペースでは理由を表示して利用不可とします。Phase 3 テストは計15件（全体36件）になりました。

- 複数タブと Editor Groups（最大2グループ、Split Right／Close Group）
- 再帰 Explorer（ディレクトリの遅延読み込み、ディレクトリ優先ソート）
- Workspace Search / Replace（プレーン／正規表現、大文字小文字区別、結果クリックでジャンプ）
- Monaco の Find / Replace（Ctrl+F / Ctrl+H）と Multi Cursor（Ctrl+クリック）
- 未保存変更表示（タブの ●、ステータスバーの件数、Save All、Ctrl+S）
- 外部変更の検知（Main Watcher＋開いているタブの定期 stat 確認）と競合バナー（再読込／上書き保存）
- `npm test`（workspace service 5件、tab / group model 4件）と `verify:phase2`
- VS Code 風の操作：Command Palette（Ctrl+Shift+P / F1）、Quick Open（Ctrl+P）、Go to Line（Ctrl+G）、タブ切り替え（Ctrl+Tab）、サイドバー切り替え（Ctrl+B）、Explorer／Search の表示切り替え（Ctrl+Shift+E / F）
- Explorer のファイル操作：新規ファイル／フォルダ作成、右クリックからの Rename／Delete（名前変更・削除したファイルのタブは追従／閉じる）
- タブのミドルクリックで閉じる、「Open Folder」へのボタン名変更、ショートカット一覧（`docs/KEYBOARD_SHORTCUTS.md`）
- `npm test` に VS Code UX のテスト4件を追加（計13件）

### Changed

- `file.read` / `file.write` が内容とともに mtime・サイズ・SHA-256 ハッシュを持つスナップショットを返すようになりました。
- `file.write` は保存時に Atomic Write（一時ファイル＋rename）を行います。
- TypeScript で `.ts` 拡張子付きの相対 import を許可しました（`allowImportingTsExtensions`）。
- Monaco Editor を同梱の `monaco-editor` パッケージから読み込むようになりました（従来は `@monaco-editor/react` のデフォルトで CDN から読み込んでいたため、オフラインではエディタが表示されず、バージョンも `package.json` と一致しませんでした）。
- 必要な Node.js を 22.18 以降に明示しました（`engines`）。`npm test` は TypeScript ソースを直接実行するため、型ストリッピングが標準有効なバージョンが必要です。CI の Node も 22.18.0 に更新し、`npm test` を CI／Scheduled CI／Release の各 workflow で実行するようになりました。
- ディレクトリ一覧の stat を並列化し、リンク先の種類でソートするようになりました。

### Fixed

- Workspace のすべて置換が検索結果の上限（500件）で打ち切られ、上限を超えたファイルが未置換のまま `skipped` にも入らなかった問題。置換は対象ファイルを直接走査し、実際の置換件数を数えるようになりました。
- 大文字小文字を区別しないプレーンテキスト置換で、置換文字列中の `$&` や `$5` が正規表現の置換パターンとして解釈されていた問題（プレーンテキスト置換は常にリテラルとして扱い、正規表現モードでのみ置換パターンを有効にしました）。
- 保存サイズ制限が文字数で判定され、マルチバイト文字では上限（20MB）を超えるファイルが保存できてしまい、二度と開けなくなっていた問題。UTF-8 バイト数で判定します。
- `file.stat` にサイズ制限がなく、開いているタブの定期確認のたびに巨大ファイルを全読み込みしていた問題。読み込みと同じ上限を適用しました。
- Linux でサブディレクトリ内のファイル変更が Watcher から相対パスなし（ファイル名のみ）で通知され、開いているタブの外部変更として検知できなかった問題。
- Watcher が再帰監視時に `.git` や `node_modules` の内部の変更も通知していた問題（パスの全セグメントで判定）。
- Explorer の一覧でシンボリックリンクが表示されなかった問題。リンク先の種類で表示し、Workspace 外へのリンクは従来どおり開く際に拒否します。
- ファイル作成時の存在チェックと書き込みの間に同名ファイルが作られると、既存ファイルを空に上書きする可能性があった問題（`wx` フラグで作成）。
- ワークスペースルート自体（`.`）のリネームが拒否されず、OS の生エラーになっていた問題。
- IPC の `maxMatches` が Main で検証されず黙って捨てられていた問題。
- ウィンドウを閉じても Watcher とワークスペース情報が Main に残り続けていた問題。ウィンドウ破棄時に解放し、開き直しに失敗した場合は従来のワークスペースを維持します。
- 本番起動時に `file://` URL を文字列連結で組み立てていた問題を `loadFile` に変更し（Windows で不正な URL になる可能性）、Renderer の画面遷移を自アプリのページ以外へ行えないよう制限しました。
- 分割したエディタグループで、非アクティブ側の競合バナーの「再読込／上書き保存」がアクティブなタブに作用していた問題。
- 同じタブの保存が重なると、自分自身の保存を「ディスクで変更された」と誤判定して競合表示になることがあった問題。
- タブを閉じた際に末尾のタブへ移動していた問題を、隣のタブへ移動するよう修正。閉じた Monaco エディタへの参照が残り続ける問題、ショートカット用イベントリスナーが再描画のたびに付け外しされていた問題もあわせて修正しました。
- Command Palette／Quick Open で候補が空のとき矢印キーで選択位置が -1 になる問題。
- `npm test` の件数など、ドキュメントの記載と実態のずれ（TESTING.md、IPC_API の `maxMatches`）。

### Security

- 検索・置換・一覧の各 IPC 引数を Main で実行時検証し、検索対象から `.git` / `node_modules` などを除外します。保存時の競合チェックにより、外部で変更されたファイルを無言で上書きしません。
- Renderer の画面遷移（`will-navigate`）を自アプリのページ以外へ行えないよう制限しました。

## [0.1.0] - 2026-10-06

### Added

- Electron / React / TypeScript / Monaco Editor の Foundation
- Renderer、Preload、Main の責務分離
- Secure workspace IPC と Workspace path boundary validation
- Workspace のオープン、直下ファイル一覧、読み込み、保存
- TypeScript strict typecheck と verification scripts
- GitHub Actions CI、Scheduled CI、Release workflow
- Dependabot と npm lockfile update workflow
- Architecture、Security、Testing、Development、Release 文書

### Security

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- Main 側での IPC 引数検証
- `path.resolve` と `realpath` による Workspace 境界検証

### Known limitations

- Terminal、Git、Language Server、Debugger、Extensions は未実装です。
- Explorer は Workspace 直下のみを表示します。
- Windows 実機の GUI と Installer は CI / Release 環境で追加検証が必要です。

[Unreleased]: https://github.com/touwa-editor/touwa-editor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/touwa-editor/touwa-editor/releases/tag/v0.1.0
