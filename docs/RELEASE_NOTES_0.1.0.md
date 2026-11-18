# Touwa Editor 0.1.0 リリースノート

## 概要

Touwa Editor Foundation の初回リリースです。将来のコード編集機能を安全に追加できる Electron アプリケーション基盤を提供します。

## 追加内容

- Electron Main / Preload / Renderer アーキテクチャ
- React UI シェル
- Monaco Editor
- Workspace を開く操作とファイルの読み書き
- 型付き IPC ブリッジ
- Workspace パスの境界検証
- TypeScript の strict 型チェック
- 検証スクリプト
- GitHub Actions CI、スケジュール CI、リリースワークフロー
- Dependabot と npm lockfile 更新ワークフロー
- 開発、アーキテクチャ、セキュリティ、テスト、リリースのドキュメント

## 検証

- `npm ci --ignore-scripts`
- `npm run typecheck`
- `npm run verify:all`
- `npm run build`
- `npm run package`

## 既知の問題

Terminal、Git、Language Server、Debugger、Extensions、再帰 Explorer、複数 Tabs は未実装です。詳細は [KNOWN_ISSUES.md](KNOWN_ISSUES.md) を参照してください。
