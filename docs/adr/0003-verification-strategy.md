# ADR 0003: 検証戦略

## 背景

Electron の Main、Preload、Renderer は実行環境が異なるため、単一のテストだけではセキュリティ境界や Build の破損を検出できません。

## 決定

`typecheck`、静的な security / workspace / Electron verification、Electron Vite build、electron-builder package を段階的に実行します。CI では `npm ci` による lockfile 再現性も必須とします。

## 代替案

- 手動起動確認だけに依存する: 再現性と自動回帰検出が不足するため却下。
- Build のみ実行する: IPC と境界ルールの欠落を検出できないため却下。
- npm を入れ子で起動する verification: Windows でのプロセス差異が増えるため却下。

## 結果

変更ごとの検証コストは増えますが、失敗箇所を特定しやすくなり、Pull Request の品質を安定させられます。
