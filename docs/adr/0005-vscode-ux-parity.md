# ADR 0005: VS Code 風 UX の同等性

## 背景

Phase 2 でエディタの基盤はできましたが、操作感は Touwa 独自のままでした。VS Code を使い慣れたユーザーが迷わず使えるよう、ショートカット、コマンドパレット、クイックオープン、Explorer のファイル操作を VS Code に寄せることになりました。内部アーキテクチャ（Main / Preload / Renderer の境界）を変えるのが目的ではありません。

## 決定

- **Command Palette（Ctrl+Shift+P / F1）**: コマンド一覧を Renderer の配列として持ち、ファジー検索で絞り込みます。コマンドの実体は既存の App 関数を呼び出すだけで、新しい権限は追加しません。
- **Quick Open（Ctrl+P）**: ファイル名一覧は Main の `workspace:files` で取得します。Renderer がディレクトリ走査をしないため、境界は維持されます。ファジー検索は `src/renderer/state/fuzzy.ts` の純粋関数で、`node --test` で検証します。
- **Shortcuts**: グローバルショートカットは App の1箇所の keydown ハンドラに集約します。エディタ内の操作（検索、マルチカーソル、行移動・複製・削除、コメント切り替え）は Monaco 標準に任せ、自前実装しません。macOS では Ctrl を Cmd に読み替えます。
- **Explorer operations**: New File／New Folder／Rename／Delete は Main の `workspace:create`／`rename`／`delete` で行い、すべて path-security の境界検証を通します。削除は確認ダイアログ必須、Workspace ルートと `.git` は拒否します。名前変更・削除したファイルの開いているタブは `tabs.ts` の純粋関数で追従／閉じます。
- **Terminology**: タイトルバーのボタンは VS Code に合わせて「Open Folder」にします。内部の「Workspace」という概念と IPC 名は変えません。
- **Out of scope**: 統合ターミナル（Ctrl+`）、Git、拡張機能、設定画面、無題ファイル（Ctrl+N）、タブのドラッグ移動は今回やらず、`docs/KEYBOARD_SHORTCUTS.md` に未実装として明記します。

## 代替案

- VS Code の keybindings.json をそのまま読み込む: 設定基盤（Phase 4）がまだなく、検証コストが高いため却下。ショートカットは App に固定し、一覧をドキュメント化します。
- Quick Open を Renderer で走査する: Renderer にファイル走査権限を与えることになり、境界を崩すため却下。
- 無題タブを導入する: 保存先のないタブ状態と競合検知の設計が増えるため却下。Explorer の New File で空ファイルを作成する運用にします。

## 結果

- VS Code ユーザーは主要な操作を学習なしで使えます。
- ショートカットとコマンドの一覧がドキュメント化され、未実装の操作が明確になります。
- ファイル操作が増えた分、誤削除のリスクがあります。削除は確認ダイアログと境界チェックで抑えますが、ゴミ箱への移動ではなく完全削除である点はドキュメントに残します。
