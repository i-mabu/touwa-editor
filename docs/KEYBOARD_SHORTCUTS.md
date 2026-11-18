# Keyboard Shortcuts

Touwa Editor のショートカットは、VS Code の使い方に寄せています。macOS では Ctrl を Cmd に読み替えてください。

## Touwa Editor のショートカット

| Shortcut                  | Action                          |
| ------------------------- | ------------------------------- |
| Ctrl+Shift+P / F1         | Command Palette を開く          |
| Ctrl+P                    | Quick Open（ファイル名で開く）  |
| Ctrl+Shift+E              | Explorer を表示する             |
| Ctrl+Shift+F              | Search を表示する               |
| Ctrl+Shift+G              | Source Control（Git）を表示する |
| Ctrl+Shift+M              | Problems（診断）を表示する      |
| Ctrl+`                    | Terminal を表示する             |
| Ctrl+B                    | サイドバーの表示／非表示        |
| Ctrl+S                    | 保存                            |
| Ctrl+Shift+S              | すべて保存                      |
| Ctrl+W                    | アクティブなタブを閉じる        |
| Ctrl+Tab / Ctrl+Shift+Tab | タブを次／前へ切り替える        |
| Ctrl+G                    | 行へ移動                        |

## Monaco Editor のショートカット（エディタ内で有効）

| Shortcut                     | Action                     |
| ---------------------------- | -------------------------- |
| Ctrl+F                       | エディタ内検索             |
| Ctrl+H                       | エディタ内置換             |
| Ctrl+D                       | 次の一致箇所を選択に追加   |
| Ctrl+Shift+L                 | すべての一致箇所を選択     |
| Ctrl+/                       | 行コメントの切り替え       |
| Alt+Up / Alt+Down            | 行を上下に移動             |
| Shift+Alt+Down               | 行を下へ複製               |
| Ctrl+Shift+K                 | 行を削除                   |
| Ctrl+クリック / Alt+クリック | マルチカーソルを追加       |
| Ctrl+Home / Ctrl+End         | ファイルの先頭／末尾へ移動 |

## VS Code との違い（未実装）

| VS Code の操作                                | Touwa Editor の現状                                                   |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Ctrl+`（統合ターミナル）                      | 実装済み（Terminal パネル、Phase 3。ただしパイプ接続で PTY ではない） |
| Ctrl+Shift+G（ソース管理）                    | 実装済み（Git パネル、Phase 3）                                       |
| Ctrl+Shift+M（問題パネル）                    | 実装済み（tsc 診断、Phase 3）                                         |
| Ctrl+Shift+X（拡張機能）                      | 未実装（Phase 4）                                                     |
| Ctrl+,（設定）                                | 未実装（Phase 4、Settings）                                           |
| Ctrl+N（新規無題ファイル）                    | Explorer の New File で空ファイルを作成する                           |
| F2（名前変更）                                | Explorer の右クリック → Rename                                        |
| Ctrl+K Ctrl+S（キーボードショートカット一覧） | このドキュメントを参照する                                            |
| ドラッグ＆ドロップでのタブ移動                | 未対応（Split Right／Close Group でグループを操作する）               |

## マウス操作

| 操作                       | Action                               |
| -------------------------- | ------------------------------------ |
| タブのミドルクリック       | タブを閉じる                         |
| Explorer の右クリック      | New File／New Folder／Rename／Delete |
| Explorer 上部の ＋🗎 ／ ＋🗀 | ルートに新規ファイル／フォルダを作成 |
