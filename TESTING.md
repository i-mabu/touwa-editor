# テストガイド

Touwa Editor のテストは、型、静的な境界検証、Build、Package を段階的に確認します。各段階は後続の失敗原因を切り分けやすくするため、独立して実行可能にします。

## テストコマンド

| コマンド                   | 目的                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`        | TypeScript の strict チェック                                                                                                                      |
| `npm test`                 | Node テスト: workspace service / watcher と tab / group model、VS Code 風 UX（21件）。Node 22.18 以降が必要（TypeScript ソースを直接実行するため） |
| `npm run verify:security`  | Electron のセキュリティ設定チェック                                                                                                                |
| `npm run verify:workspace` | Workspace 境界の実装チェック                                                                                                                       |
| `npm run verify:electron`  | Main / Preload / Renderer 基盤チェック                                                                                                             |
| `npm run verify:phase2`    | Phase 2（Tabs / Search / Watcher / Atomic Write）の静的検証                                                                                        |
| `npm run verify:all`       | 上記 verification の一括実行                                                                                                                       |
| `npm run build`            | Electron Vite の production ビルド                                                                                                                 |
| `npm run package`          | electron-builder の package スモークテスト                                                                                                         |

## 標準の検証手順

```bash
npm ci
npm run typecheck
npm test
npm run verify:all
npm run build
```

リリース候補では Package まで実行します。

```bash
npm run package
```

## Workspace セキュリティのケース

| ケース                     | 期待結果 |
| -------------------------- | -------- |
| `src/index.ts` の読み込み  | 成功     |
| `../outside.txt`           | 拒否     |
| `/absolute/path`           | 拒否     |
| Workspace 外を指す symlink | 拒否     |
| ディレクトリの file read   | 拒否     |
| 20 MB を超える保存内容     | 拒否     |

境界チェックは `path.resolve` と `realpath` の両方を使用します。

```ts
const candidate = path.resolve(root, relativePath);
if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
  throw new Error("Path is outside the workspace.");
}
```

## 手動スモークテスト

1. アプリケーションが起動する。
2. Open Workspace でディレクトリを選択できる。
3. Explorer にファイルが表示され、ディレクトリを展開できる。
4. ファイルを開いて内容を編集できる。複数タブを開き、Split Right で2グループに分けられる。
5. Save 後にディスク上の内容が更新される。未保存のタブには ● が付く。
6. 外部で変更したファイルを開いたタブに ⚠ とバナーが出て、再読込／上書き保存が選べる。
7. 検索パネルで Workspace 検索ができ、結果クリックで該当行に移動できる。
8. Renderer から Node.js API を直接利用していない。

## Phase 2 のケース

| ケース                             | 期待結果                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------- |
| 2ファイルをタブで開く              | 両方のタブが表示され、切り替えできる                                      |
| Split Right                        | アクティブタブが右グループに移動する                                      |
| 未保存でタブを閉じる               | 確認ダイアログが出る                                                      |
| 外部変更後に保存                   | 保存が拒否され、競合バナーが出る                                          |
| 外部変更後に再読込                 | ディスクの内容が表示され、⚠ が消える                                      |
| 検索（正規表現・大文字小文字区別） | 一致した行が表示され、クリックで移動できる                                |
| すべて置換                         | 一致箇所が置換され、開いているタブが再読込される                          |
| Ctrl+Shift+P / Ctrl+P              | コマンドパレット／クイックオープンが開き、絞り込みと Enter で実行／開ける |
| Ctrl+Tab / Ctrl+W / Ctrl+B         | タブ切り替え／タブを閉じる／サイドバー切り替えができる                    |
| Explorer の右クリック              | New File／Rename／Delete ができ、開いているタブが追従／閉じる             |

Windows 実機では、`.cmd` / `.exe` の扱い、Installer、権限差、パス区切り文字も確認します。

## 失敗時の報告

失敗時は、実行コマンド、OS、Node.js / npm バージョン、期待結果、実際のエラー、再現手順を記録します。ログに秘密情報や個人情報を含めないでください。
