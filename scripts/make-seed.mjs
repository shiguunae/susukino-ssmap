// legacy/data.js（従来の店舗データ）から src/seed.json を作ります。
// 初回のデータ移行用です（DBが空のときに自動で取り込まれます）。
import fs from "node:fs";
const s = fs.readFileSync(new URL("../legacy/data.js", import.meta.url), "utf8");
const STORES = new Function(s + ";return STORES;")();
fs.writeFileSync(new URL("../src/seed.json", import.meta.url), JSON.stringify(STORES));
console.log(Object.keys(STORES).length + " stores");
