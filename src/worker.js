import seed from "./seed.json";
import { toStore, validateForSubmit, diffJa, translate, checkTranslation, requestText, JA_KEYS } from "./lib.js";

const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h } });
const js = (code, h = {}) => new Response(code, { headers: { "content-type": "application/javascript; charset=utf-8", ...h } });
const now = () => new Date().toISOString();
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,60}$/;

// ---------- 認証（メール＋パスワード、署名付きクッキー） ----------
const enc = new TextEncoder();
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function hmac(env, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toB64u(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
async function safeEq(env, a, b) { return (await hmac(env, "eq:" + a)) === (await hmac(env, "eq:" + b)); }
async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return toB64u(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, k, 256));
}
async function hashPw(pw) { const salt = crypto.getRandomValues(new Uint8Array(16)); return toB64u(salt) + ":" + (await pbkdf2(pw, salt)); }
async function checkPw(pw, stored) { const [s, h] = (stored || "").split(":"); if (!s || !h) return false; return (await pbkdf2(pw, fromB64u(s))) === h; }
async function makeSession(env, email) {
  const body = toB64u(enc.encode(JSON.stringify({ e: email, x: Date.now() + 12 * 3600e3 })));
  return body + "." + (await hmac(env, body));
}
async function authUser(env, req) {
  if (!env.SESSION_SECRET) return { error: "ログイン設定（SESSION_SECRET）がまだ完了していません。" };
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)ssmap_session=([^;]+)/);
  if (!m) return { error: "ログインが必要です。" };
  const [body, sig] = m[1].split(".");
  if (!sig || (await hmac(env, body)) !== sig) return { error: "ログインが必要です。" };
  try {
    const o = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    if (o.x < Date.now()) return { error: "ログインの有効期限が切れました。" };
    return String(o.e).toLowerCase();
  } catch { return { error: "ログインが必要です。" }; }
}
async function login(env, req) {
  if (!env.SESSION_SECRET) return json({ error: "ログイン設定がまだ完了していません。" }, 503);
  await init(env);
  const b = await req.json().catch(() => ({}));
  const email = String(b.email || "").trim().toLowerCase(), pw = String(b.password || "");
  const at = await env.DB.prepare("SELECT n, at FROM attempts WHERE email=?").bind(email).first();
  if (at && at.n >= 5 && Date.now() - at.at < 15 * 60e3) return json({ error: "失敗が続いたため、15分ほどお待ちください。" }, 429);
  let ok = false;
  if (admins(env).includes(email)) ok = !!env.ADMIN_PASSWORD && (await safeEq(env, pw, env.ADMIN_PASSWORD));
  if (!ok) { const s = await env.DB.prepare("SELECT pw FROM staff WHERE email=?").bind(email).first(); ok = !!(s && s.pw && (await checkPw(pw, s.pw))); }
  if (!ok) {
    await env.DB.prepare("INSERT INTO attempts (email,n,at) VALUES (?,1,?) ON CONFLICT(email) DO UPDATE SET n=CASE WHEN ?-at>900000 THEN 1 ELSE n+1 END, at=?").bind(email, Date.now(), Date.now(), Date.now()).run();
    return json({ error: "メールアドレスまたはパスワードが違います。" }, 401);
  }
  await env.DB.prepare("DELETE FROM attempts WHERE email=?").bind(email).run();
  return json({ ok: true }, 200, { "set-cookie": `ssmap_session=${await makeSession(env, email)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200` });
}
const admins = (env) => (env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// ---------- DB ----------
let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, sort INTEGER, published TEXT, draft TEXT, status TEXT DEFAULT 'none', note TEXT, updated_by TEXT, updated_at TEXT, submitted_by TEXT, submitted_at TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS staff (email TEXT PRIMARY KEY, stores TEXT DEFAULT '', name TEXT DEFAULT '', pw TEXT DEFAULT '')"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, data TEXT, created_at TEXT)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS attempts (email TEXT PRIMARY KEY, n INTEGER, at INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT, action TEXT, actor TEXT, at TEXT, detail TEXT)"),
  ]);
  try { await env.DB.prepare("ALTER TABLE staff ADD COLUMN pw TEXT DEFAULT ''").run(); } catch (e) { /* すでにある */ }
  const c = await env.DB.prepare("SELECT COUNT(*) n FROM stores").first();
  if (!c.n) {
    const ids = Object.keys(seed);
    const stmts = ids.map((id, i) => env.DB.prepare("INSERT OR IGNORE INTO stores (id,sort,published,status,updated_at) VALUES (?,?,?,'none',?)").bind(id, i, JSON.stringify(seed[id]), now()));
    for (let i = 0; i < stmts.length; i += 25) await env.DB.batch(stmts.slice(i, i + 25));
  }
  ready = true;
}
const log = (env, id, action, actor, detail) => env.DB.prepare("INSERT INTO history (store_id,action,actor,at,detail) VALUES (?,?,?,?,?)").bind(id, action, actor, now(), detail || "").run();

// 入力フォーム用の初期データ（公開中の店舗データ → 入力データ）
function formFromStore(s) {
  const ja = { ...s.i18n.ja };
  const j = { ...ja, privateRoom: ja.tag5 || "" };
  return { tel: s.tel || "", address: s.address || "", heroImage: s.heroImage || "", menuImage: s.menuImage || "", interiorImage: s.interiorImage || "", accessNote: s.accessNote || false, is24h: !!s.is24h, mapDestination: s.mapDestination || "", ja: j };
}

async function canEdit(env, user, id) {
  if (admins(env).includes(user)) return true;
  const r = await env.DB.prepare("SELECT stores FROM staff WHERE email=?").bind(user).first();
  if (!r) return false;
  const l = (r.stores || "").split(",").map((s) => s.trim());
  return l.includes("*") || l.includes(id);
}

// ---------- ルーティング ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/data.js") return await publicData(env);
      if (p.startsWith("/images/")) {
        if (env.DB && /_\d{13}\.jpg$/.test(p)) {
          await init(env);
          const o = await env.DB.prepare("SELECT data FROM images WHERE key=?").bind(p.slice(1)).first();
          if (o) return new Response(Uint8Array.from(atob(o.data), (c) => c.charCodeAt(0)), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
        }
        return env.ASSETS.fetch(req);
      }
      // ログインが必要なのは /staff /admin /api だけ。それ以外（存在しないアドレスを含む）は通常どおり配信する
      const guarded = p === "/staff" || p.startsWith("/staff/") || p === "/admin" || p.startsWith("/admin/") || p.startsWith("/api/");
      if (!guarded) return env.ASSETS.fetch(req);
      if (!env.DB && (p === "/api/login" || p.startsWith("/staff") || p.startsWith("/admin") || p.startsWith("/api/"))) return json({ error: "データベースが未設定です。" }, 503);
      if (p === "/api/login" && req.method === "POST") return await login(env, req);
      if (p === "/api/logout") return json({ ok: true }, 200, { "set-cookie": "ssmap_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
      // 以降はログインが必要
      const user = await authUser(env, req);
      if (typeof user !== "string") return p.startsWith("/api/") ? json({ error: user.error }, 401) : Response.redirect(url.origin + "/login/?next=" + encodeURIComponent(p), 302);
      await init(env);
      const isAdmin = admins(env).includes(user);
      if (!p.startsWith("/api/")) {
        if (p.startsWith("/admin") && !isAdmin) return new Response("管理者のみ利用できます。", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
        return env.ASSETS.fetch(req);
      }
      if (p.startsWith("/api/admin/") && !isAdmin) return json({ error: "管理者のみ利用できます。" }, 403);
      return await api(req, env, url, user, isAdmin);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

async function publicData(env) {
  let stores = seed;
  try {
    if (env.DB) {
      await init(env);
      const rs = await env.DB.prepare("SELECT id, published FROM stores WHERE published IS NOT NULL ORDER BY sort, id").all();
      if (rs.results.length) { stores = {}; for (const r of rs.results) stores[r.id] = JSON.parse(r.published); }
    }
  } catch (e) { /* DBが使えないときは初期データで表示 */ }
  return js("const STORES = " + JSON.stringify(stores) + ";", { "cache-control": "public, max-age=20" });
}

async function api(req, env, url, user, isAdmin) {
  const p = url.pathname, m = req.method;
  let x;
  if (p === "/api/me") {
    const mine = isAdmin ? "*" : ((await env.DB.prepare("SELECT stores FROM staff WHERE email=?").bind(user).first()) || { stores: "" }).stores;
    const l = (mine || "").split(",").map((s) => s.trim()).filter(Boolean);
    const rs = await env.DB.prepare("SELECT id, published, draft, status, note, updated_at FROM stores ORDER BY sort, id").all();
    const stores = rs.results.filter((r) => l.includes("*") || l.includes(r.id)).map((r) => {
      const pub = r.published ? JSON.parse(r.published) : null, d = r.draft ? JSON.parse(r.draft) : null;
      return { id: r.id, title: (d?.ja?.heroTitle) || pub?.i18n?.ja?.heroTitle || r.id, status: r.status, note: r.note || "", updated_at: r.updated_at, hasPublished: !!pub };
    });
    return json({ email: user, isAdmin, stores });
  }
  if ((x = p.match(/^\/api\/store\/([^/]+)$/)) && m === "GET") {
    const id = x[1];
    if (!(await canEdit(env, user, id))) return json({ error: "この店舗の編集権限がありません。" }, 403);
    const r = await env.DB.prepare("SELECT * FROM stores WHERE id=?").bind(id).first();
    if (!r) return json({ error: "店舗が見つかりません。" }, 404);
    const pub = r.published ? JSON.parse(r.published) : null, d = r.draft ? JSON.parse(r.draft) : null;
    return json({ id, status: r.status, note: r.note || "", published: pub, draft: d, form: d || (pub ? formFromStore(pub) : { ja: { menu: [] } }) });
  }
  if ((x = p.match(/^\/api\/store\/([^/]+)$/)) && m === "PUT") {
    const id = x[1];
    if (!(await canEdit(env, user, id))) return json({ error: "この店舗の編集権限がありません。" }, 403);
    const r = await env.DB.prepare("SELECT status, draft FROM stores WHERE id=?").bind(id).first();
    if (!r) return json({ error: "店舗が見つかりません。" }, 404);
    if (r.status === "pending" && !isAdmin) return json({ error: "承認待ちのため編集できません。管理者の確認をお待ちください。" }, 409);
    const body = await req.json();
    const old = r.draft ? JSON.parse(r.draft) : {};
    const draft = sanitize(body, old);
    await env.DB.prepare("UPDATE stores SET draft=?, status='draft', note='', updated_by=?, updated_at=? WHERE id=?").bind(JSON.stringify(draft), user, now(), id).run();
    await log(env, id, "下書き保存", user);
    return json({ ok: true, status: "draft" });
  }
  if ((x = p.match(/^\/api\/store\/([^/]+)\/submit$/)) && m === "POST") {
    const id = x[1];
    if (!(await canEdit(env, user, id))) return json({ error: "この店舗の編集権限がありません。" }, 403);
    const r = await env.DB.prepare("SELECT draft, status FROM stores WHERE id=?").bind(id).first();
    if (!r || !r.draft) return json({ error: "先に保存してください。" }, 400);
    const draft = JSON.parse(r.draft);
    const miss = validateForSubmit(draft);
    if (miss.length) return json({ error: "未入力の項目があります: " + miss.join("、") }, 400);
    if (env.ANTHROPIC_API_KEY) draft.i18n = await translate(env, toStore(draft, {}).i18n.ja);
    await env.DB.prepare("UPDATE stores SET draft=?, status='pending', note='', submitted_by=?, submitted_at=?, updated_at=? WHERE id=?").bind(JSON.stringify(draft), user, now(), now(), id).run();
    await log(env, id, "承認に提出", user);
    return json({ ok: true, status: "pending" });
  }
  if ((x = p.match(/^\/api\/draft\.js$/))) {
    const id = url.searchParams.get("id") || "";
    if (!(await canEdit(env, user, id))) return js("var STORES={};", {});
    const r = await env.DB.prepare("SELECT draft, published FROM stores WHERE id=?").bind(id).first();
    let o = {};
    if (r && r.draft) {
      const d = JSON.parse(r.draft);
      const pub = r.published ? JSON.parse(r.published) : null;
      // 翻訳が未作成のときは、公開中の翻訳(または日本語)で代用して表示
      const tr = d.i18n || (pub ? Object.fromEntries(["en", "zh-Hant", "ko", "th"].map((l) => [l, pub.i18n[l]])) : null);
      const s = toStore(d, tr || {});
      if (!tr) for (const l of ["en", "zh-Hant", "ko", "th"]) s.i18n[l] = s.i18n.ja;
      o[id] = s;
    } else if (r && r.published) o[id] = JSON.parse(r.published);
    return js("const STORES = " + JSON.stringify(o) + ";", { "cache-control": "no-store" });
  }
  if (p === "/api/upload" && m === "POST") {
    const id = url.searchParams.get("store") || "", kind = url.searchParams.get("kind") || "";
    if (!(await canEdit(env, user, id)) || !["hero", "menu", "interior"].includes(kind)) return json({ error: "アップロードできません。" }, 403);
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 1400 * 1024) return json({ error: "画像が大きすぎます。別の写真でお試しください。" }, 413);
    const key = `images/${id}_${kind}_${Date.now()}.jpg`;
    let bin = ""; const u8 = new Uint8Array(buf); for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode(...u8.subarray(i, i + 8192));
    await env.DB.prepare("INSERT INTO images (key,data,created_at) VALUES (?,?,?)").bind(key, btoa(bin), now()).run();
    return json({ ok: true, path: key });
  }

  // ----- 管理者 -----
  if (p === "/api/admin/overview") {
    const rs = await env.DB.prepare("SELECT id, published, draft, status, note, submitted_by, submitted_at, updated_by, updated_at FROM stores ORDER BY sort, id").all();
    return json({ stores: rs.results.map((r) => {
      const pub = r.published ? JSON.parse(r.published) : null, d = r.draft ? JSON.parse(r.draft) : null;
      return { id: r.id, title: d?.ja?.heroTitle || pub?.i18n?.ja?.heroTitle || r.id, status: r.status, submitted_by: r.submitted_by, submitted_at: r.submitted_at, updated_by: r.updated_by, updated_at: r.updated_at };
    }) });
  }
  if ((x = p.match(/^\/api\/admin\/review\/([^/]+)$/))) {
    const r = await env.DB.prepare("SELECT * FROM stores WHERE id=?").bind(x[1]).first();
    if (!r || !r.draft) return json({ error: "下書きがありません。" }, 404);
    const pub = r.published ? JSON.parse(r.published) : null, d = JSON.parse(r.draft);
    const ns = toStore(d, d.i18n || {});
    return json({ id: r.id, status: r.status, submitted_by: r.submitted_by, submitted_at: r.submitted_at, published: pub, next: ns, changed: diffJa(pub?.i18n?.ja, ns.i18n.ja), topChanged: ["tel", "address", "heroImage", "menuImage", "interiorImage"].filter((k) => (pub?.[k] || "") !== (ns[k] || "")), draft: d });
  }
  if ((x = p.match(/^\/api\/admin\/approve\/([^/]+)$/)) && m === "POST") {
    const id = x[1];
    const r = await env.DB.prepare("SELECT draft, published FROM stores WHERE id=?").bind(id).first();
    if (!r || !r.draft) return json({ error: "下書きがありません。" }, 404);
    const body = await req.json().catch(() => ({}));
    const d = JSON.parse(r.draft);
    if (body.i18n) d.i18n = body.i18n; // 翻訳の手直しを反映
    if (!d.i18n && r.published) {
      const pub = JSON.parse(r.published);
      if (JSON.stringify(toStore(d, {}).i18n.ja) === JSON.stringify(pub.i18n.ja)) d.i18n = Object.fromEntries(["en", "zh-Hant", "ko", "th"].map((l) => [l, pub.i18n[l]]));
    }
    if (!d.i18n) return json({ error: "翻訳が未作成です。先に翻訳を取り込んでください。" }, 400);
    const ns = toStore(d, d.i18n);
    await env.DB.prepare("UPDATE stores SET published=?, draft=NULL, status='none', note='', updated_by=?, updated_at=? WHERE id=?").bind(JSON.stringify(ns), user, now(), id).run();
    await log(env, id, "承認・公開", user);
    return json({ ok: true });
  }
  if ((x = p.match(/^\/api\/admin\/reject\/([^/]+)$/)) && m === "POST") {
    const body = await req.json().catch(() => ({}));
    await env.DB.prepare("UPDATE stores SET status='rejected', note=?, updated_at=? WHERE id=?").bind(String(body.note || "").slice(0, 1000), now(), x[1]).run();
    await log(env, x[1], "差し戻し", user, body.note);
    return json({ ok: true });
  }
  if ((x = p.match(/^\/api\/admin\/translate\/([^/]+)$/)) && m === "POST") {
    const r = await env.DB.prepare("SELECT draft FROM stores WHERE id=?").bind(x[1]).first();
    if (!r || !r.draft) return json({ error: "下書きがありません。" }, 404);
    const d = JSON.parse(r.draft);
    d.i18n = await translate(env, toStore(d, {}).i18n.ja);
    await env.DB.prepare("UPDATE stores SET draft=? WHERE id=?").bind(JSON.stringify(d), x[1]).run();
    return json({ ok: true });
  }
  if (p === "/api/admin/translation-request") {
    const rs = await env.DB.prepare("SELECT id, draft, published FROM stores WHERE draft IS NOT NULL ORDER BY sort, id").all();
    const items = {};
    for (const r of rs.results) {
      const d = JSON.parse(r.draft);
      if (d.i18n) continue;
      const ja = toStore(d, {}).i18n.ja;
      if (r.published && JSON.stringify(ja) === JSON.stringify(JSON.parse(r.published).i18n.ja)) continue; // 日本語に変更なし
      items[r.id] = ja;
    }
    const ids = Object.keys(items);
    return json({ ids, text: ids.length ? requestText(items) : "" });
  }
  if (p === "/api/admin/import-translations" && m === "POST") {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object") return json({ error: "貼り付けた内容を読み取れませんでした。" }, 400);
    const done = [], bad = [];
    for (const [id, tr] of Object.entries(b)) {
      const r = await env.DB.prepare("SELECT draft FROM stores WHERE id=?").bind(id).first();
      if (!r || !r.draft) { bad.push(id + "（下書きがありません）"); continue; }
      try {
        const d = JSON.parse(r.draft);
        const ja = toStore(d, {}).i18n.ja;
        d.i18n = checkTranslation(tr, ja);
        await env.DB.prepare("UPDATE stores SET draft=? WHERE id=?").bind(JSON.stringify(d), id).run();
        await log(env, id, "翻訳を取り込み", user);
        done.push(id);
      } catch (e) { bad.push(id + "（" + e.message + "）"); }
    }
    return json({ ok: true, done, bad });
  }
  if (p === "/api/admin/staff" && m === "GET") {
    const rs = await env.DB.prepare("SELECT email, stores, name, (pw != '') AS hasPw FROM staff ORDER BY email").all();
    return json({ staff: rs.results, admins: admins(env) });
  }
  if (p === "/api/admin/staff" && m === "PUT") {
    const b = await req.json();
    const email = String(b.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "メールアドレスが正しくありません。" }, 400);
    await env.DB.prepare("INSERT INTO staff (email, stores, name) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET stores=excluded.stores, name=excluded.name").bind(email, String(b.stores || "").trim(), String(b.name || "").trim()).run();
    if (b.password) {
      if (String(b.password).length < 8) return json({ error: "パスワードは8文字以上にしてください。" }, 400);
      await env.DB.prepare("UPDATE staff SET pw=? WHERE email=?").bind(await hashPw(String(b.password)), email).run();
    }
    return json({ ok: true });
  }
  if (p === "/api/admin/staff" && m === "DELETE") {
    await env.DB.prepare("DELETE FROM staff WHERE email=?").bind(String(url.searchParams.get("email") || "").toLowerCase()).run();
    return json({ ok: true });
  }
  if (p === "/api/admin/store" && m === "POST") {
    const b = await req.json();
    const id = String(b.id || "").trim();
    if (!ID_RE.test(id)) return json({ error: "IDは半角の英小文字・数字・ハイフン・アンダーバーで入力してください。" }, 400);
    if (await env.DB.prepare("SELECT 1 FROM stores WHERE id=?").bind(id).first()) return json({ error: "そのIDはすでにあります。" }, 409);
    const mx = await env.DB.prepare("SELECT COALESCE(MAX(sort),0)+1 n FROM stores").first();
    await env.DB.prepare("INSERT INTO stores (id,sort,status,updated_at,updated_by) VALUES (?,?,'none',?,?)").bind(id, mx.n, now(), user).run();
    await log(env, id, "店舗を追加", user);
    return json({ ok: true });
  }
  if ((x = p.match(/^\/api\/admin\/history\/([^/]+)$/))) {
    const rs = await env.DB.prepare("SELECT action, actor, at, detail FROM history WHERE store_id=? ORDER BY id DESC LIMIT 50").bind(x[1]).all();
    return json({ history: rs.results });
  }
  return json({ error: "not found" }, 404);
}

function sanitize(b, old) {
  const str = (v, n = 4000) => String(v == null ? "" : v).slice(0, n);
  const ja = {};
  const src = b.ja || {};
  for (const k of [...JA_KEYS, "privateRoom"]) ja[k] = str(src[k]);
  ja.menu = (Array.isArray(src.menu) ? src.menu : []).slice(0, 12).map((m) => ({ name: str(m.name, 200), price: str(m.price, 100), desc: str(m.desc, 300) }));
  const img = (v) => (/^images\/[A-Za-z0-9_\-.]+$/.test(v || "") ? v : "");
  return {
    tel: str(b.tel, 40), address: str(b.address, 300), mapDestination: str(b.mapDestination, 300),
    heroImage: img(b.heroImage), menuImage: img(b.menuImage), interiorImage: img(b.interiorImage),
    accessNote: b.accessNote || false, is24h: !!b.is24h, autoTags: b.autoTags !== false, ja,
    i18n: old && old.i18n && JSON.stringify(old.ja) === JSON.stringify(ja) ? old.i18n : undefined,
  };
}
