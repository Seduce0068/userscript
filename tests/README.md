---
type: Reference
title: "Open Filter 回帰テスト"
description: "openFilter.js のメタデータ検証と、Chromium/Firefox を使った機能・安全対策の回帰テスト。"
tags:
  - userscript
  - testing
  - playwright
  - ci
generated:
  by: DeepSeek Harness
  at: "2026-11-14T22:55:00+09:00"
---

## 概要

`openFilter.js` の回帰テストです。CI（`.github/workflows/userscript-tests.yml`）とローカルの両方で実行できます。

- `check-userscript.mjs`: メタデータ・`@version`と`VERSION`の一致・`@grant`/`@connect`・禁止パターンの静的検証
- `check-gas.mjs`: `gas/Code.gs` の構文・`doGet`/`doPost`・マニフェストの検証
- `run.cjs`: 歯車UI、ピッカー、ルール、エクスポートなどの機能回帰
- `safety.cjs`: データ保全、CSP、同期、保護サイト、動的追従、a11yなど安全対策の回帰

## 実行方法

```bash
npm install
npx playwright install chromium firefox
npm test
```

個別実行:

```bash
npm run test:check
npm run test:feature
npm run test:safety
```

## 注意

- テストはローカルHTTPサーバとPlaywrightのヘッドレスブラウザを使います。外部ネットワークへは接続しません。
- スクリーンショットはOSの一時ディレクトリ（`openfilter-tests`）へ保存します。
- 実機Violentmonkey固有の挙動（CSP下の`GM_addStyle`、注入モード）はこのテストの対象外です。
