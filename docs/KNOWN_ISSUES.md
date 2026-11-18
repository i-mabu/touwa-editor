# Known Issues

## Foundation limitations

| Area            | Current limitation                                                                                                                                                                                                                                                      | Workaround / next step                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Editor Groups   | 最大2グループまで                                                                                                                                                                                                                                                       | 3グループ以上は Phase 3 以降で検討                                        |
| Watcher         | Linux ではルート＋直下ディレクトリのみ監視                                                                                                                                                                                                                              | 開いているタブは5秒ごとの stat 確認で補完し、保存時の競合検知が最終防衛線 |
| Search          | 最大2000ファイル／500件、1ファイル1MBまで、深さ12まで                                                                                                                                                                                                                   | 対象を絞って検索し直す                                                    |
| Replace         | 置換直前に外部変更があったファイルはスキップされる                                                                                                                                                                                                                      | スキップされたファイルを確認してから再実行する                            |
| Save            | 永続 Undo 未対応                                                                                                                                                                                                                                                        | 保存前に外部変更を確認                                                    |
| Developer tools | Git はステータス／ログ表示、ステージング／コミット、フェッチ／プル（FF のみ）／プッシュ対応。診断は tsc の手動再チェックのみ（保存連動・常駐型は未対応）。Tasks は実行のみ（停止ボタンなし、120秒タイムアウト）。Terminal、Language Server、Debugger、Extensions 未実装 | Roadmap の Phase 3 / 4 を参照                                             |

## Resolved in Phase 2

- Explorer は再帰ツリー（遅延読み込み）になりました。
- 複数タブ、Editor Groups、未保存変更表示、競合検知、Atomic Write を実装しました。
- Workspace Search / Replace と Monaco の Find / Replace、Multi Cursor を実装しました。

## Verification limitations

Linux Sandbox で TypeScript、静的検証、Build、Linux unpacked package を確認済みです。Windows 実機での GUI 起動、NSIS Installer、Windows 固有の `.cmd` / `.exe` 動作は未検証です。

npm audit では依存関係由来の脆弱性警告が残る場合があります。依存更新時は互換性と Electron のサポート範囲を確認し、無条件に `npm audit fix --force` を適用しません。

## Reporting

再現可能な問題は GitHub Issue Template を利用してください。セキュリティ問題は公開 Issue ではなく Private Security Advisory で報告してください。
