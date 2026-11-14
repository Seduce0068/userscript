---
type: Reference
title: "Open Filter 配布手順"
description: "openFilter.js を公開Gistで配布し、Violentmonkeyのインストール・自動更新を提供する手順。"
tags:
  - userscript
  - distribution
  - gist
  - violentmonkey
generated:
  by: DeepSeek Harness
  at: "2026-11-15T02:08:00+09:00"
---

## 配布先

- Gist: <https://gist.github.com/Seduce0068/e4c597b30b872dc1fb247f1843825009>
- インストール/更新URL:
  <https://gist.githubusercontent.com/Seduce0068/e4c597b30b872dc1fb247f1843825009/raw/openFilter.user.js>

`openFilter.js` の `@updateURL` / `@downloadURL` は上記raw URLを指しています。ViolentmonkeyはこのURLを定期的に確認し、`@version` が上がっていれば更新します。

## リリース手順

1. `openFilter.js` を変更する
2. `@version` と `const VERSION` を同じ値に更新する
3. テストを実行する
   ```bash
   npm test
   ```
4. Gistへ公開する
   ```bash
   scripts/publish-openfilter-gist.sh
   ```

`scripts/openfilter-gist-id.txt` にGist IDを保持しています。Gistを削除・作り直した場合は更新してください。

## 注意

- Gistは**公開**です。`openFilter.js` に秘密情報（トークン、共有キー、個人情報）を含めないでください。
- 既存のユーザーは、Gistの内容と `@version` が更新されると自動更新できます。
- インストールは上記URLを開くか、Violentmonkeyの「URLからインストール」に貼り付けます。
