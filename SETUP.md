# 入力フォーム・承認システム 設定手順

## 仕組み
- 担当営業: `/staff/` で入力 → 「承認に提出」で自動翻訳 → 管理者が `/admin/` で確認・承認 → サイトに即反映
- ログインは メールアドレス＋パスワード（管理者がパスワードを発行）。
- データは Cloudflare D1（店舗）と R2（写真）。`/data.js` はDBから生成（DBが使えないときは初期データで表示）。
- 従来の `data.js` は `legacy/data.js` に残してあります。

## 初回設定（Cloudflareの画面で、シークレットを3つ追加）
Workers & Pages > susukino-ssmap > 設定 > 変数とシークレット > 追加（種類は「シークレット」）
| 名前 | 値 |
|---|---|
| ANTHROPIC_API_KEY | Anthropic Consoleで発行したAPIキー（自動翻訳用） |
| SESSION_SECRET | 長いランダムな文字列（32文字以上。ログインの署名用） |
| ADMIN_PASSWORD | 管理者（shingu.white@gmail.com）のログインパスワード |

## 担当者の追加
`/admin/` > 担当者 で、メール・名前・担当店舗ID・パスワード（8文字以上）を登録し、本人に伝えます。
