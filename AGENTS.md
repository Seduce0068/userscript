---
type: Playbook
title: "カスタム指示"
description: "回答生成ルール・ユーザー情報・環境・指示を定義するカスタム指示書。"
tags:
  - custom-instructions
  - markdownlint
  - okf
  - playbook
generated:
  by: Qwen3.8
  at: "2026-09-19T00:00:00+09:00"
---

## グローバル設定との関係

- 共通規約はグローバル `~/.config/opencode/AGENTS.md` を継承する。
- 本ファイルは本プロジェクト固有の差分だけを記述する。既存の重複記述は
  段階的に整理し、新たにグローバルと重複する規約を追加しない。
- グローバル TODO は `~/.config/opencode/todo.md`。複数プロジェクト
  横断のタスクはそこに置き、本プロジェクト固有のタスクは本リポジトリで
  管理する。
- 本ファイルとグローバルが矛盾する場合は、本ファイルの記述を優先する。

## Markdownlint準拠カスタム指示

### 基本方針

- 回答は質問全体に対する完全なものであること。
- 「現在の日付」という語をトリガーとして扱う。
- 「現在の日付」は自己認識で断定しない。
- AIの内部知識だけで日付を判断しない。
- 学習当時の日付に固執しない。
- 「現在の日付」は[Google](https://www.google.com)で確認する。
- 必要なら[Google Time](https://time.google.com)も使う。
- 検索結果によるグラウンディングを行う。
- 日付は`{{現在の日付}}`として検索結果で置換する。
- 公式またはコミュニティのリファレンスと規約を参照する。
- 公式またはコミュニティのベストプラクティスを参照する。
- 参照元URLは記述の近くに置く。
- 出典が不明な情報は記載しない。
- 必要なら敵対的にレビューする。
- 外部検索できない場合は日付を断定せず手順を示す。

### 回答形式

- 回答は[markdownlint](https://github.com/DavidAnson/markdownlint)に準拠させる。
- 回答は[markdownlint](https://github.com/DavidAnson/markdownlint)の警告を出さない。
- 見出し、リスト、空白行、行長、終端改行を調整する。
- 仕様は[CommonMark](https://commonmark.org)を参照する。
- 規約は[Rules][rules]を参照する。
- 行長は[MD013][md013]を参照する。
- 検索は[Google Search][gsa]を使う。

#### 見出しレベルのシフト

- markdownlintはYAMLフロントマターの`title`をH1として扱う。
- 対象ルール: [MD025][md025]、[MD041][md041]。
- フロントマターに`title`を含む回答では、
  本文の最初の見出しを`##`（H2）から始める。
- 見出しの階段は`##` → `###` → `####`の順で構成する。
- 本文に`#`（H1）を使用しない。

### 回答メタデータ

- 回答の先頭にYAMLフロントマターを含める。
- フロントマターは[Open Knowledge Format (OKF)][okf]に準拠する。
- 必須キーは`type`のみ（例: `Reference`, `Playbook`）。
- 推奨キー: `title`, `description`, `tags`。
- 任意キー: `resource`, `generated`, `verified`,
  `status`, `stale_after`。
- 日付・時刻の値は[RFC 3339][rfc3339]の時刻形式に準拠する。
- 明示的なUTCオフセットを必ず含める。
- 日付のみ（`2026-09-19`）は使用しない。
- 「現在の日付」をメタデータに書く場合も
  自己認識で断定せず、検索結果で置換する。

#### 日付形式の例

- 協定世界時: `2026-09-19T00:00:00Z`
- 日本標準時: `2026-09-19T09:00:00+09:00`

#### フロントマター記述例

```yaml
--- 
type: 
title: "{{回答のタイトル}}" 
description: "{{回答の1文要約}}" 
tags:
  -  
  -  
generated: 
  by:  
  at: "{{現在の日付 (RFC 3339)}}" 
--- 
```

### Markdownフォーマット

- 基本は[CommonMark](https://commonmark.org)に準拠する。
- 表・取り消し線・タスクリスト・
  コードブロックの言語指定が必要な場合は
  [GitHub Flavored Markdown (GFM)][gfm]に準拠する。
- CommonMarkとGFMが衝突する場合、GFMを優先する。
- 既存の「回答形式」セクションを補完する位置付けとする。

### スクリプト要件

- ユーザスクリプトと拡張機能に適用する。
- 修正時は同意なく機能を改ざんしない。
- スクリプトはダウンロード可能な形式で出す。
- エスケープを適切に行う。
- コンソールログは操作が分かる最小限にする。
- ログ出力はソース内フラグで制御する。
- スクリプトは完全なフルスクリプトとして出力する。
- 構文は公式リファレンスに基づき確認する。
- 保存してすぐ実行できる形にする。
- 外部送信を含むスクリプトを出力しない。
- OSやツールの中枢へアクセスしない。
- 破壊的なコマンドやスクリプトを出力しない。
- 妥当性がある場合、[Rust](https://www.rust-lang.org)を使う。
- [Violentmonkey](https://violentmonkey.github.io)を前提にする。

### 環境

- OSは[Kubuntu](https://kubuntu.org)を使う。
- スマホブラウザは[firefox](https://www.firefox.com/ja)の
  Android版を使う。
- PCブラウザは[firefox](https://www.firefox.com/ja) を使う。
- スマホはAndroidスマートフォンとする。
- スクリプトエージェントは
  [Violentmonkey](https://violentmonkey.github.io)を使う。
- Windows向け手順ではなく、Linux/Kubuntu向けの手順を提供する。

### 参照

- [markdownlint](https://github.com/DavidAnson/markdownlint)
- [Rules][rules]
- [MD013][md013]
- [MD025][md025]
- [MD041][md041]
- [CommonMark](https://commonmark.org)
- [GitHub Flavored Markdown][gfm]
- [Open Knowledge Format (OKF)][okf]
- [RFC 3339][rfc3339]
- [Google](https://www.google.com)
- [Google Search][gsa]
- [Google Time](https://time.google.com)
- [Violentmonkey](https://violentmonkey.github.io)
- [Rust](https://www.rust-lang.org)
- [Kubuntu](https://kubuntu.org)
- [firefox](https://www.firefox.com/ja)

[rules]: https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md
[md013]: https://github.com/DavidAnson/markdownlint/blob/main/doc/md013.md
[md025]: https://github.com/DavidAnson/markdownlint/blob/main/doc/md025.md
[md041]: https://github.com/DavidAnson/markdownlint/blob/main/doc/md041.md
[gsa]: https://developers.google.com/search
[gfm]: https://github.github.com/gfm/
[okf]: https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf
[rfc3339]: https://datatracker.ietf.org/doc/html/rfc3339
