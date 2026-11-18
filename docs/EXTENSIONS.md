# 拡張機能

## 配置場所

拡張は `package.json` マニフェストを持つフォルダとして、次の2か所に配置します。

- ユーザー拡張: アプリデータ内の `extensions` フォルダ
- ワークスペース拡張: ワークスペース直下の `.touwa/extensions`

Extensions パネル（Ctrl+Shift+X）に一覧表示されます。現時点では**検出と検証のみで、拡張コードの実行には対応していません**（Extension Host は今後の Phase 4 増分です）。

## マニフェスト（package.json）

```json
{
  "name": "hello",
  "publisher": "acme",
  "version": "0.1.0",
  "displayName": "Hello",
  "description": "挨拶コマンドを追加します",
  "engines": { "touwa": "^0.1.0" },
  "main": "./out/main.js",
  "activationEvents": ["onCommand:acme.hello"],
  "capabilities": ["commands", "notifications"],
  "contributes": {
    "commands": [{ "command": "acme.hello", "title": "Hello を表示" }]
  }
}
```

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| `name` | ○ | 英数字と `-._` で始まる識別子（最大128文字） |
| `version` | ○ | `x.y.z` 形式 |
| `publisher` | | 公開者名。ID は `publisher.name` になります |
| `displayName` / `description` | | パネル表示用 |
| `engines.touwa` | | 対応する Touwa のバージョン範囲（`^x.y.z` / `x.y.z` / `*`）。解釈できない範囲は非対応として扱います |
| `main` | | エントリポイント（将来の Extension Host 用） |
| `activationEvents` | | 起動イベント（最大32件） |
| `capabilities` | | 必要な権限の宣言（下記）。未知の権限は警告として表示され、許可されません |
| `contributes.commands` | | 提供するコマンド（最大64件） |

## Capabilities（権限宣言）

拡張は必要な権限を `capabilities` で宣言します。許可されるのは次の既知の権限だけで、未知の権限はパネルに警告表示されます。

- `commands` — コマンドの登録
- `workspace.read` — ワークスペースの読み取り
- `workspace.write` — ワークスペースへの書き込み
- `notifications` — 通知の表示
- `terminal.create` — ターミナルの作成
- `debug.start` — デバッグの開始

検証は Main で行い、不正なマニフェストはエラーとしてパネルに表示されます（他の拡張の読み込みは止まりません）。
