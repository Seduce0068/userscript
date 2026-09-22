---
name: userscript-validator
description: Userscriptの構文検証、メタデータ（@match, @grant等）の確認、およびDOM監視（MutationObserver等）のコードレビューを行う。WHEN: "validate userscript", "check script", "userscript audit", "review userscript", "メタデータ確認", "スクリプト検証".
---

# Userscript Validator & Reviewer Skill

<metadata>
- Role: Userscript Code Reviewer & Quality Engineer
- Scope: Tampermonkey / Violentmonkey Userscripts
</metadata>

## 1. 目的
ユーザーから指定された、あるいはリポジトリ内にあるUserscript（`.js`ファイル）を検査し、TampermonkeyやViolentmonkeyなどの環境で安全かつ効率的に動作するかを検証・レビューする。

## 2. 検証チェックリスト

### ① メタデータブロック (Userscript Header)
スクリプトの先頭にあるJSDoc形式のコメントブロックを確認し、以下が適切に定義されているか検証する：
- `@name`: スクリプトの識別名
- `@namespace`: 一意の名前空間
- `@match` または `@include`: 対象とするURLパターン（過剰に広すぎないか、安全か）
- `@grant`: 使用するGM API（`GM_setValue`, `GM_getValue`, `GM_xmlhttpRequest`, `GM_addStyle`, `none` 等）が明示されているか（無駄な `unsafeWindow` や `GM_*` の無断使用がないか）
- `@run-at`: 実行タイミング（`document-start`, `document-end`, `document-idle`）が適切か

### ② パフォーマンスとDOM操作
- **ポーリングの禁止:** `setInterval` による不要な要素のポーリング監視になっていないか確認する。代わりに `MutationObserver` や `requestAnimationFrame`、要素の出現を待つユーティリティ（例: `waitForElement`）が使用されているかを推奨する。
- **カプセル化:** グローバルスコープを汚染しないよう、即時関数（IIFE: `(function() { ... })();`）でラップされているか確認する。

### ③ エラーハンドリングとセキュリティ
- `GM_xmlhttpRequest` などの非同期通信において、エラーコールバック（`onerror`, `ontimeout`）が実装されているか。
- 不審な外部スクリプトの動的読み込み（`eval` や `document.createElement('script')` による外部コード実行）がないかセキュリティ面をチェックする。

## 3. 実行手順
1. 対象の `.js` ファイルを読み込む。
2. 上記のチェックリストに基づき、静的解析とコードレビューを行う。
3. 改善点（メタデータの追加、ポーリングの排除、エラーハンドリングの強化など）を具体的に提案する。
