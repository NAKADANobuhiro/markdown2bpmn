// sample.js — 初期表示用サンプル Markdown
// 内容を編集することで起動時のデフォルト表示を変更できます。

const SAMPLE_MARKDOWN = `---
process_id: inquiry-handling
process_name: 問い合わせ対応プロセス
version: 1.0
author: Nobody
---

## 目的
顧客からの問い合わせを受け付け、内容に応じた担当者に振り分け、迅速に対応するプロセス。

## レーン
- **顧客** (customer): 問い合わせを行うエンドユーザー
- **受付担当者** (reception): 最初の窓口として対応
- **技術担当者** (technical): 技術的な質問を担当
- **営業担当者** (sales): 営業・価格に関する質問を担当

## フロー

1. [customer] 問い合わせフォームを送信する
2. [reception] 問い合わせを受信・確認する
3. [reception] 内容を分類する <GW: 問い合わせ種別>
   - 技術的な質問 → 4
   - 営業・価格の質問 → 5
   - (デフォルト) → 6
4. [technical] 技術的な回答を作成する → 7
5. [sales] 営業情報を提供する → 7
6. [reception] 一般的な回答を作成する
7. [reception] 顧客に回答を送信する
8. [customer] 回答を受け取る <END>
`;
