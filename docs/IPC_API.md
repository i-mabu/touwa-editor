# IPC API Reference

## Boundary

Renderer は Node.js API を直接利用しません。Preload が `window.touwa` として最小限の API を公開し、Main が IPC の実装と入力検証を担当します。

## Shared types

```ts
export type FileEntry = {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size?: number;
  mtimeMs?: number;
};

export type FileSnapshot = {
  content: string;
  mtimeMs: number;
  size: number;
  hash: string; // SHA-256 of the UTF-8 content
};

export type SearchOptions = {
  caseSensitive?: boolean;
  regex?: boolean;
  maxMatches?: number;
};

export type SearchMatch = {
  relativePath: string;
  line: number;
  column: number;
  lineText: string;
};
```

## Workspace API

### `workspace.open`

OS のディレクトリ選択ダイアログを開きます。引数はなく、戻り値は `{ root, entries }` またはキャンセル時の `null` です。開いた Workspace の Watcher を開始し、外部変更を `workspace:changed` で Renderer へ送ります。

### `workspace.list`

現在の Renderer に割り当てられた Workspace の直下エントリを取得します。引数はなく、戻り値は `FileEntry[]` です。

### `workspace.listDir(relativeDir)`

指定ディレクトリの直下エントリを取得します。Explorer の遅延読み込み用です。`relativeDir` は Workspace 相対パスで、空文字はルートを表します。ディレクトリ以外や Workspace 外は拒否します。

### `workspace.search(query, options?)`

Workspace 内をテキスト検索します。`query` は1〜200文字、`options` は `caseSensitive` / `regex` / `maxMatches`（1〜500に丸めて適用）です。`.git` / `node_modules` / `out` / `dist` / `release` と隠しファイル、1MBを超えるファイル、バイナリは除外します。最大2000ファイル／500件までで、戻り値は `{ matches, truncated, filesSearched }` です。

### `workspace.replace(query, replacement, options?)`

検索に一致した箇所をすべて置換します（検索結果の上限500件には制限されません。対象ファイルの上限は検索と同じ2000ファイル／1MBまで）。各ファイルは読み直し→置換→競合チェック付き Atomic Write で保存します。置換直前に外部変更があったファイルはスキップされ、戻り値の `skipped` に入ります。プレーンテキスト置換では置換文字列はリテラルとして扱い、`$` の置換パターンが有効なのは正規表現モードだけです。戻り値は `{ filesChanged, totalReplacements, perFile, skipped }` です。

### `workspace.files`

Workspace 内のファイルの相対パス一覧を取得します。Quick Open 用で、最大2000件、`.git` / `node_modules` などを除外します。

### `workspace.create(relativePath, kind)`

空のファイルまたはディレクトリを作成します。`kind` は `'file'` / `'directory'` です。既存の名前、Workspace 外、`.git` への作成は拒否します。

### `workspace.rename(oldRelativePath, newRelativePath)`

Workspace 内でファイル／ディレクトリの名前を変更・移動します。移動先が既存の場合、Workspace 外の場合、`.git` に関わる場合は拒否します。

### `workspace.delete(relativePath)`

ファイルまたはディレクトリを削除します。ディレクトリは中身ごと削除します。Workspace ルートと `.git` の削除は拒否します。

### `workspace.onChanged(listener)`

Main の Watcher からの外部変更通知を受け取ります。`{ relativePath, kind }` が渡され、戻り値は購読解除関数です。Renderer は通知を受けたら `file.stat` で確認し、開いているタブに外部変更フラグを立てます。

## File API

### `file.read(relativePath)`

Workspace 相対パスのファイルを UTF-8 で読み込みます。絶対パス、Workspace 外、symlink による境界脱出、ディレクトリの読み込みは拒否します。戻り値は `FileSnapshot`（内容＋mtime＋サイズ＋SHA-256）です。

### `file.stat(relativePath)`

ファイルの mtime・サイズ・SHA-256 ハッシュを取得します。外部変更の確認用で、内容は返しません。

### `file.write(relativePath, content, expectedMtimeMs?)`

Workspace 相対パスへ UTF-8 で保存します。パス境界、親ディレクトリ境界、コンテンツサイズを Main で検証します。保存は同一ディレクトリの一時ファイルへの書き込み＋rename による Atomic Write です。`expectedMtimeMs` を渡すと、ディスクの mtime がそれと異なる場合に保存を拒否し、外部変更の無言上書きを防ぎます。明示的な上書き保存のときだけ省略します。戻り値は保存後の `FileSnapshot` です。

```ts
const snapshot = await window.touwa.file.read("src/index.ts");
const saved = await window.touwa.file.write(
  "src/index.ts",
  content,
  snapshot.mtimeMs,
);
```

## Git API（Phase 3）

### `git.status()`

開いている Workspace に対して `git status --porcelain=v2 --branch` を Main の共通プロセス実行サービス（`src/main/process/process-runner.ts`、`shell: false`、argv 分離、timeout、出力上限）経由で実行し、パース結果を返します。戻り値は `GitStatus`（リポジトリかどうか、ブランチ、upstream との ahead/behind、変更エントリ一覧）です。パスは Workspace ルートからの相対パスです。Git が無い、またはリポジトリでない場合は例外にせず `isRepository: false` を返します。Renderer からコマンドや引数を指定することはできません。

### `git.log(limit?)`

最近のコミットを最大100件（既定30件）返します。戻り値は `GitCommit[]`（ハッシュ、短縮ハッシュ、件名、作者、日時）です。リポジトリでない、またはコミットが無い場合は空配列を返します。`limit` は Main で型と範囲を検証します。

### `git.stage(paths)` / `git.unstage(paths)` / `git.discard(paths)`

指定した Workspace 相対パス（最大200件）をステージ、ステージ取り消し、作業ツリー変更の破棄します。パスは Main で件数・型を検証したうえで、Workspace 境界内であることを再検証し、`--` の後ろに個別の argv として渡します。ステージ取り消しはコミットがまだ無いリポジトリでは `git rm --cached` に切り替えます。いずれも実行後の `GitStatus` を返します。破棄は Renderer 側で確認ダイアログを出してから呼びます。

### `git.commit(message)`

ステージ済みの変更をコミットします。メッセージは Main で空でないことと長さ上限を検証し、`-m` の argv としてそのまま渡します。実行後の `GitStatus` を返します。

### `git.fetch()` / `git.pull()` / `git.push()`

リモートとの同期を行い、実行後の `GitStatus` を返します。プルは fast-forward のみ（分岐した場合はエラーとして報告し、自動マージしません）。プッシュは upstream が無いブランチでは `origin` へ upstream を設定して送ります。ネットワーク操作のため timeout は60秒、`GIT_TERMINAL_PROMPT=0` で資格情報プロンプトを即時失敗させます。認証はユーザーの Git 設定（SSH 鍵、資格情報ヘルパー）に委ね、エディタが資格情報を扱うことはありません。

## Diagnostics API（Phase 3）

### `diagnostics.run()`

ワークスペースの TypeScript で型チェック（`tsc --noEmit --pretty false`）を実行し、結果を `DiagnosticsResult`（利用可否、理由、`Diagnostic[]`、上限超過フラグ）で返します。tsc はワークスペース自身の `node_modules/typescript` を node で実行します。`tsconfig.json` が無い、または TypeScript が未インストールの場合は例外にせず `available: false` と理由を返します。診断はファイル相対パス・行・列・重要度・コード（TSxxxx）・メッセージを持ち、最大500件です。

## Tasks API（Phase 3）

### `tasks.list()`

`.touwa/tasks.json` を読み、検証済みのタスク定義を返します。戻り値は `TasksListResult`（`TaskDef[]` とエラー文字列）。ファイルが無い場合は空リスト（エラーなし）、書式が不正な場合は理由をエラーとして返し、タスクは読み込みません。

### `tasks.run(label)`

ラベルで指定したタスクを実行し、`TaskRunResult`（終了コード、シグナル、タイムアウト有無、stdout / stderr、所要時間）を返します。Renderer から送れるのはラベルのみで、コマンドや引数は Main が実行直前にファイルを読み直して決めます。実行はユーザーがパネルで実行ボタンを押したときに限ります。書式は `docs/TASKS.md` を参照してください。

## Terminal API（Phase 3）

### `terminal.start()` / `terminal.write(id, data)` / `terminal.kill(id)`

ワークスペースを cwd としてシェル（Windows は PowerShell、なければ cmd／その他は $SHELL、なければ sh）を常駐セッションとして起動します。セッションは開始したウィンドウが所有し、出力はそのウィンドウにだけ `terminal:data` イベント（`{id, stream, text}`）で、終了は `terminal:exit` イベント（`{id, exitCode, signal}`）で届きます。他ウィンドウのセッションへの書き込み・終了は拒否し、ウィンドウ破棄時とアプリ終了時にセッションを終了します。

これはパイプ接続のコンソールであり、PTY ではありません。TTY を必要とする全画面プログラムや生キー入力を読むプロンプトは正しく動作しません（制限は KNOWN_ISSUES と ROADMAP に明記）。

## Error policy

Renderer にはユーザーが対処できるメッセージを返し、内部パスや秘密情報を不要に露出させません。Main では原因を開発者向けログに記録しますが、token、password、環境変数の値は記録しません。

## Adding a new channel

1. Preload に型付きメソッドを追加する。
2. Main の `registerIpc` に明示的な channel を登録する。
3. すべての引数を Main で実行時検証する。
4. `verify:all` に関連する検証を追加する。
5. Renderer へ Node.js API や任意 channel 呼び出し API を公開しない。
6. API の変更を CHANGELOG と必要な ADR に記載する。
