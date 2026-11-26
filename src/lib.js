// ---- 共通ロジック（Worker内で使用） ----
export const LANGS = ["en", "zh-Hant", "ko", "th"];
export const UNKNOWN = "要確認（お問い合わせください）";

const ST_KEYS = ["heroTag","heroEyebrow","heroKana","heroTitle","heroSub","budgetValue","areaValue","seatValue",
  "couponMain","couponNote","couponExpiry","addressText","hoursText","closedText","cardText","emoneyText","qrText",
  "smokeText","halalText","tag1","tag2","tag3","tag4","tag5"];
export const JA_KEYS = ST_KEYS;

export function derive(ja, top) {
  const j = { ...ja };
  if (top.autoTags !== false) for (const k of ["tag1", "tag2", "tag3", "tag4", "tag5"]) j[k] = "";
  const isOk = (t) => /^可/.test(t || "");
  const isNg = (t) => /利用不可|非対応/.test(t || "");
  const unk = (t) => !t || /要確認/.test(t);
  if (!j.addressText) j.addressText = top.address || "";
  if (!j.areaValue) {
    const m = (j.addressText || "").match(/南\d+条[西東]\d+丁目|北\d+条[西東]\d+丁目/);
    j.areaValue = m ? "すすきの " + m[0] : "すすきの";
  }
  if (!j.tag1) {
    const parts = [];
    if (isOk(j.cardText)) parts.push("カード");
    if (isOk(j.emoneyText)) parts.push("電子マネー");
    if (isOk(j.qrText)) parts.push("QRコード");
    if (parts.length === 0) j.tag1 = [j.cardText, j.emoneyText, j.qrText].every(unk) ? UNKNOWN : "キャッシュレス非対応";
    else if (parts.length === 1) j.tag1 = parts[0] + "決済対応";
    else j.tag1 = parts.join("・") + (parts.length === 3 ? "決済対応" : "決済対応");
  }
  if (!j.tag2) j.tag2 = j.smokeText || "";
  if (!j.tag3) {
    const c = (j.closedText || "").trim();
    if (!c) j.tag3 = "";
    else if (/要確認/.test(c)) j.tag3 = c;
    else if (/無休/.test(c)) j.tag3 = "無休";
    else if (/不定休/.test(c)) j.tag3 = "不定休";
    else j.tag3 = c.replace(/曜日/g, "曜").replace(/定休日?$/, "") + (/休$/.test(c) ? "" : "休");
  }
  if (!j.tag4) {
    const m = (j.seatValue || "").match(/(\d+)/);
    j.tag4 = m ? "全" + m[1] + "席" : (j.seatValue || "");
  }
  if (!j.tag5) j.tag5 = j.privateRoom || "";
  delete j.privateRoom;
  j.menu = (j.menu || []).filter((m) => m && (m.name || "").trim()).map((m) => {
    const o = { name: m.name.trim(), price: (m.price || "").trim() };
    if ((m.desc || "").trim()) o.desc = m.desc.trim();
    return o;
  });
  return j;
}

export function mapDest(draft) {
  const title = (draft.ja.heroTitle || "").trim();
  const addr = (draft.address || "").replace(/[（(][^）)]*[）)]/g, "").trim();
  return addr ? (title + " " + addr).trim() : "";
}

// 入力データ(draft) → サイトが読む店舗オブジェクト
export function toStore(draft, translations) {
  const top = {
    heroImage: draft.heroImage || "", menuImage: draft.menuImage || "", interiorImage: draft.interiorImage || "",
    tel: draft.tel || "", address: draft.address || "", accessNote: draft.accessNote || false, is24h: !!draft.is24h,
  };
  for (const k of ["heroImage", "menuImage", "interiorImage"]) if (!top[k]) delete top[k];
  const md = draft.mapDestination || mapDest(draft);
  if (md) top.mapDestination = md;
  const ja = derive(draft.ja, draft);
  return { ...top, i18n: { ja, ...(translations || draft.i18n || {}) } };
}

export function validateForSubmit(draft) {
  const j = draft.ja || {};
  const need = [["heroTag","ジャンル"],["heroKana","ふりがな"],["heroTitle","店名"],["heroSub","紹介文"],["budgetValue","予算目安"],
    ["seatValue","席数"],["hoursText","営業時間"],["closedText","定休日"]];
  const miss = need.filter(([k]) => !(j[k] || "").trim()).map(([, l]) => l);
  if (!(draft.address || "").trim()) miss.push("住所");
  return miss;
}

export function diffJa(a, b) {
  const out = [];
  const keys = new Set([...JA_KEYS, "menu"]);
  for (const k of keys) {
    const x = k === "menu" ? JSON.stringify((a && a.menu) || []) : (a && a[k]) || "";
    const y = k === "menu" ? JSON.stringify((b && b.menu) || []) : (b && b[k]) || "";
    if (x !== y) out.push(k);
  }
  return out;
}

// ---- 自動翻訳（Claude API） ----
const GUIDE = `あなたは日本の繁華街「すすきの」の飲食店ガイドの翻訳者です。日本語の店舗情報(JSON)を、英語(en)・繁体字中国語(zh-Hant)・韓国語(ko)・タイ語(th)に翻訳します。

ルール:
- 出力はJSONのみ。形式は {"en":{...},"zh-Hant":{...},"ko":{...},"th":{...}}。各言語のオブジェクトは、入力と同じキーを全て持つこと。menuは入力と同じ件数・同じ順序の配列で、各要素は {name, price} (入力にdescがあれば desc も) 。
- 値が空文字のキーは空文字のまま返す。「要確認（お問い合わせください）」は、en: "Please inquire directly" / zh-Hant: "請直接洽詢店家" / ko: "매장에 직접 문의해 주세요" / th: "กรุณาสอบถามร้านโดยตรง" とする。
- 価格は「¥1,200」形式。「1,200円～」は en "From ¥1,200" / zh-Hant "¥1,200起" / ko "¥1,200~" / th "เริ่มต้น ¥1,200"。範囲は en "¥4,000–5,000" / zh-Hant "4,000～5,000円" / ko "4,000엔~5,000엔" / th "¥4,000-5,000"。
- heroKana(ふりがな): en/zh-Hant/th はローマ字(例 "Wadaidokoro Yashiki")、ko はハングル。店名(heroTitle)は、英数字の屋号はそのまま、日本語の屋号は en=ローマ字(または自然な英訳)、zh-Hant=漢字を繁体字に、ko=ハングル表記、th=タイ文字表記。支店名(すすきの本店 等)も翻訳する。
- areaValue: "すすきの 南3条西6丁目" → en "Susukino, Minami 3 Nishi 6" / zh-Hant "薄野 南3條西6丁目" / ko "스스키노 미나미3조니시6초메" / th "ซูซูกิโนะ มินามิ3 นิชิ6"。
- addressText は各言語の住所表記に翻訳(建物名・階を含む)。電話番号や数字はそのまま。
- 営業時間は 24時間表記。ラストオーダーは en "LO 23:00" / zh-Hant "最後點餐23:00" / ko "라스트오더 23:00" / th "สั่งสุดท้าย 23:00"。
- 喫煙: 禁煙=en "No smoking"(tag は "No Smoking")/zh-Hant 禁菸/ko 금연/th ห้ามสูบบุหรี่。決済不可: en "Not accepted"/zh-Hant 無法使用/ko 이용 불가/th ไม่รับ。tag1 の「キャッシュレス非対応」は en "Cash Only"/zh-Hant 僅收現金/ko 현금만 가능/th รับเฉพาะเงินสด。
- カードブランドは、en/ko では VISA・Mastercard・JCB・American Express・Diners Club・UnionPay 等の標準表記、zh-Hant は 銀聯 等。
- tag1〜tag5 は短いラベル(例 en "Cards Accepted", "Closed Sundays", "22 Seats", "No Private Room"; zh-Hant "可使用信用卡", "週日公休", "共22席", "無包廂"; ko "카드 결제 가능", "일요일 휴무", "전 22석", "개인실 없음"; th "รับบัตรเครดิต", "ปิดวันอาทิตย์", "22 ที่นั่ง", "ไม่มีห้องส่วนตัว")。
- 紹介文(heroSub)は自然で魅力的な文章にする。改行(\\n)は保持する。メニュー名は料理が伝わる訳にし、ko は読みを添える場合は「가쓰네기(돼지 위 파무침)」のように括弧で補足する。
- 事実を足したり変えたりしない。`;

export async function translate(env, ja) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY が設定されていません（自動翻訳ができません）");
  const payload = {};
  for (const k of JA_KEYS) payload[k] = ja[k] || "";
  payload.menu = ja.menu || [];
  const body = {
    model: env.TRANSLATE_MODEL || "claude-sonnet-5-5",
    max_tokens: 12000,
    system: GUIDE,
    messages: [{ role: "user", content: "次の店舗情報を翻訳してください。\n" + JSON.stringify(payload) }],
  };
  const r = await fetch((env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("翻訳APIエラー " + r.status + ": " + (await r.text()).slice(0, 300));
  const res = await r.json();
  const text = (res.content || []).map((c) => c.text || "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("翻訳結果を読み取れませんでした");
  return checkTranslation(JSON.parse(m[0]), payload);
}

export function checkTranslation(out, ja) {
  if (!out || typeof out !== "object") throw new Error("翻訳の形式が正しくありません");
  const payload = { menu: ja.menu || [] };
  for (const l of LANGS) {
    if (!out[l]) throw new Error("翻訳結果に " + l + " がありません");
    for (const k of JA_KEYS) if (typeof out[l][k] !== "string") out[l][k] = "";
    const mm = Array.isArray(out[l].menu) ? out[l].menu : [];
    if (mm.length !== payload.menu.length) throw new Error(l + " のメニュー件数が一致しません");
    out[l].menu = mm.map((x, i) => {
      const o = { name: String(x.name || ""), price: String(x.price || "") };
      if (payload.menu[i].desc) o.desc = String(x.desc || "");
      return o;
    });
    for (const k of Object.keys(out[l])) if (k !== "menu" && !JA_KEYS.includes(k)) delete out[l][k];
  }
  return { en: out.en, "zh-Hant": out["zh-Hant"], ko: out.ko, th: out.th };
}

export function requestText(items) {
  // items: { 店舗ID: 日本語データ }
  const o = {};
  for (const [id, ja] of Object.entries(items)) {
    const p = {};
    for (const k of JA_KEYS) p[k] = ja[k] || "";
    p.menu = ja.menu || [];
    o[id] = p;
  }
  return GUIDE.replace("出力はJSONのみ。形式は", "出力はJSONのみ（説明文は不要）。店舗IDをキーにした外側のオブジェクトで、各店舗の値の形式は") +
    "\n\n次の店舗情報（店舗IDごと）を翻訳してください。\n" + JSON.stringify(o);
}
