---
type: Reference
title: "Open Filter 同期用 GAS スクリプト"
description: "Google Apps Script で Open Filter の設定を同期するための Web アプリ。GET互換とPOST（推奨）に対応する。"
tags:
  - gas
  - apps-script
  - clasp
  - sync
generated:
  by: DeepSeek Harness
  at: "2026-11-15T01:10:00+09:00"
---

## 概要

Open Filter の設定を Google Apps Script（GAS）で同期するためのスクリプトです。

- **POST（推奨）**: 共有キーをリクエスト本文で送信
- **GET（互換）**: 旧クライアント向け。共有キーが URL クエリに残る
- 設定値は `ScriptProperties` に 3000 文字ずつ分割して保存
- 共有キーは `OPEN_FILTER_SHARED_KEY` に保存（コードには書かない）

## セットアップ

### 1. clasp の準備

```bash
export PATH="$HOME/.local/share/mise/shims:$PATH"
clasp --version
clasp login
```

### 2. GAS プロジェクトの作成

既存の同期用プロジェクトを上書きしないよう、**新しいプロジェクト**を作ることを推奨します。

```bash
cd gas
clasp create --title "Open Filter Sync" --type webapp
```

`clasp create` が `appsscript.json` を生成した場合は、このリポジトリの内容へ戻してください。

```bash
git checkout -- appsscript.json
```

（`clasp create` が生成した `.clasp.json` はそのまま使用します。`.clasp.json` はコミットしません。）

既存プロジェクトへ追加する場合:

```bash
cp .clasp.example.json .clasp.json
# .clasp.json の scriptId を既存プロジェクトのIDに書き換える
clasp clone <ScriptID> --rootDir .
```

### 3. 共有キーの設定

1. Apps Script エディタを開く
2. 「プロジェクトの設定」→「スクリプト プロパティ」
3. 次のプロパティを追加
   - 名前: `OPEN_FILTER_SHARED_KEY`
   - 値: 16文字以上のランダムな文字列（パスワードマネージャ等で生成）

または、エディタで `setSharedKey('...')` を一度実行して保存することもできます。

### 4. デプロイ

```bash
clasp push
clasp deploy --description "Open Filter Sync v1"
```

表示された **ウェブアプリの URL**（`https://script.google.com/macros/s/.../exec`）を控えます。

### 5. ユーザースクリプト側の設定

1. Open Filter の「データ」タブ →「クラウド同期」
2. 同期方法を **Google Apps Script** に変更
3. GAS Web アプリ URL と共有キーを入力
4. 送信方式を **POST（推奨）** に変更
5. 「同期設定を保存」
6. 「アップロード」で現在の設定を保存

## 旧サーバとの互換性

- 旧クライアントは `GET /exec?key=...` を使います。`doGet` が互換対応します。
- 新クライアントで「GET（旧サーバ互換）」を選べば、旧サーバのままでも動作します。
- 新しいGASをデプロイするまでは、ユーザースクリプト側の送信方式を **GET** のままにしてください。
- 既存のGASプロジェクトを上書きすると、保存済みデータの形式が変わる可能性があります。まず新しいプロジェクトで試し、問題なければ切り替えてください。

## セキュリティ上の注意

- Web アプリのアクセスは `ANYONE_ANONYMOUS` です。**URL と共有キーの両方**が実質的な認証情報です。
- 共有キーは URL に含めない POST を推奨します。
- 共有キーをチャット・Issue・コミットに書かないでください。
- 不審なアクセスが疑われる場合は、共有キーを変更して再デプロイしてください。
