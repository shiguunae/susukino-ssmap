# 入力フォーム・承認システム 設定手順

## 仕組み
- 担当営業: `/staff/` で入力 → 「承認に提出」で自動翻訳 → 管理者が `/admin/` で確認・承認 → サイトに即反映
- データはCloudflare D1（店舗）とR2（写真）に保存。`/data.js` はDBから生成されます（DBが使えないときは初期データで表示）。
- 従来の `data.js` は `legacy/data.js` に残してあります。

## 設定（初回のみ）
1. **デプロイ**: このブランチをmainにマージすると、D1（ssmap-db）とR2（ssmap-images）が自動作成されます。
2. **自動翻訳**: Cloudflare > Workers > susukino-ssmap > 設定 > 変数とシークレット に、シークレット `ANTHROPIC_API_KEY` を追加（Anthropic Consoleで発行）。
3. **ログイン（Cloudflare Access）**: Zero Trust > Access > アプリケーション > セルフホスト で、次の3つのパスを同じポリシー（担当者のメールのみ許可）で保護します。
   `susukino-ssmap.shingu-white.workers.dev/staff*` / `/admin*` / `/api/*`
   作成後、**Team domain**（例 xxx.cloudflareaccess.com）と **Application Audience (AUD) タグ** を、
   Workerの変数 `TEAM_DOMAIN` / `POLICY_AUD` に入力。
4. **担当者の登録**: `/admin/` の「担当者」で、メールと担当店舗IDを登録。

## 注意
- Accessの設定が未完了のあいだ、`/staff` `/admin` `/api` は利用できません（誰でも入れる状態にはなりません）。
- 管理者は `wrangler.jsonc` の `ADMIN_EMAILS` で指定します。
