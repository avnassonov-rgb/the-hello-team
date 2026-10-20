/* Отчёт по блогерам из Google Таблицы (лист «$$$»), опубликованной как CSV.
   Переменная окружения: BLOGGERS_SHEET_CSV_URL (Render → Environment).
   Колонки (по порядку): A дата договорённости, B ник+ФИО, C имя, D ссылка, E город,
   F подписчики, G статус, H план. дата, I суть, J товар, K стоимость размещения,
   L себестоимость товара, M дата рилс, N дата сторис, O комментарий.
   Колонка O (там адреса и телефоны) НИКОГДА не уходит в браузер.
   Без внешних зависимостей. */
"use strict";
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { parseCsv } = require("./mappingTable");

const CACHE_MS = 10 * 60 * 1000;
let cache = { at: 0, rows: null, error: null, diag: null };

function csvUrl() { return process.env.BLOGGERS_SHEET_CSV_URL || ""; }

function getText(fullUrl, depth) {
  return new Promise((resolve, reject) => {
    if ((depth || 0) > 5) return reject(new Error("слишком много перенаправлений"));
    let u;
    try { u = new URL(fullUrl); } catch (e) { return reject(new Error("некорректная ссылка на таблицу")); }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + (u.search || ""), method: "GET", timeout: 20000 },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return getText(new URL(res.headers.location, fullUrl).toString(), (depth || 0) + 1).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error("HTTP " + res.statusCode + " при чтении таблицы блогеров"));
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      }
    );
    req.on("error", (e) => reject(new Error("ошибка соединения с таблицей — " + e.message)));
    req.on("timeout", () => req.destroy(new Error("таймаут запроса таблицы")));
    req.end();
  });
}

function pad(n) { return n < 10 ? "0" + n : "" + n; }
function isoOf(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }

// "16.06" / "22.06." / "16.06.2026" / "2026-06-16" / "16/06/26" -> Date (UTC) или null
function parseDate(s, now) {
  const t = String(s || "").trim().replace(/\u00a0/g, " ");
  let day, mon, year;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) { year = +m[1]; mon = +m[2]; day = +m[3]; }
  else {
    m = t.match(/^(\d{1,2})[./\-](\d{1,2})(?:[./\-](\d{2,4}))?\.?(?:\s.*)?$/);
    if (!m) return null;
    day = +m[1]; mon = +m[2];
    if (m[3]) { year = +m[3]; if (year < 100) year += 2000; }
  }
  if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
  if (!year) {
    year = now.getUTCFullYear();
    if (Date.UTC(year, mon - 1, day) > now.getTime() + 120 * 86400000) year -= 1;
  }
  return new Date(Date.UTC(year, mon - 1, day));
}

function mondayOf(d) {
  const wd = (d.getUTCDay() + 6) % 7; // пн=0
  return new Date(d.getTime() - wd * 86400000);
}

function money(s) {
  const digits = String(s || "").replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

function statusKind(s) {
  const t = String(s || "").toLowerCase();
  if (t.indexOf("отмен") !== -1) return "cancelled";
  if (t.indexOf("опубликов") !== -1) return "published";
  if (t.indexOf("ждем") !== -1 || t.indexOf("ждём") !== -1) return "waiting";
  return "other";
}

function parseRows(csvText, now, diag) {
  const all = parseCsv(csvText);
  if (diag) {
    diag.rawRows = all.length;
    diag.sampleA = all.slice(0, 8).map((r) => String(r[0] || "").slice(0, 20));
    diag.looksHtml = /^\s*</.test(csvText);
  }
  const out = [];
  for (const r of all) {
    const date = parseDate(r[0], now);
    if (!date) continue; // заголовки, «итого» и пустые строки пропускаем
    const nameLines = String(r[1] || "").split("\n").map((x) => x.trim()).filter(Boolean);
    const priceRaw = String(r[10] || "").trim();
    const cost = money(r[11]);
    const barter = /бартер/i.test(priceRaw);
    out.push({
      date,
      nick: nameLines[0] || "",
      fullName: nameLines.slice(1).join(" "),
      city: String(r[4] || "").trim(),
      followers: money(r[5]),
      status: String(r[6] || "").trim(),
      kind: statusKind(r[6]),
      essence: String(r[8] || "").replace(/\s+/g, " ").trim(),
      product: String(r[9] || "").replace(/\s+/g, " ").trim(),
      barter,
      price: barter ? 0 : money(priceRaw),
      cost,
    });
  }
  return out;
}

async function loadRows(force) {
  const url = csvUrl();
  if (!url) return null;
  if (!force && cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;
  try {
    const text = await getText(url, 0);
    const diag = {};
    cache = { at: Date.now(), rows: parseRows(text, new Date(), diag), error: null, diag };
  } catch (e) {
    if (cache.rows) { cache.error = e.message; return cache.rows; } // отдаём старые данные
    throw e;
  }
  return cache.rows;
}

/* Неделя считается по дате ДОГОВОРЁННОСТИ (колонка A), пн–вс.
   «Платный» = не бартер и не отмена. Бюджет = сумма стоимости размещения платных. */
function buildReport(rows, weeksCount) {
  const now = new Date();
  const todayMon = mondayOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
  const n = Math.max(1, Math.min(60, weeksCount || 12));
  const weeks = [];
  const byKey = {};
  // начало ряда: либо n недель назад, либо первая неделя с данными, если она позже
  let firstMon = new Date(todayMon.getTime() - (n - 1) * 7 * 86400000);
  const minRow = rows.reduce((a, r) => (a === null || r.date < a ? r.date : a), null);
  if (minRow && mondayOf(minRow) > firstMon) firstMon = mondayOf(minRow);
  for (let t = firstMon.getTime(); t <= todayMon.getTime(); t += 7 * 86400000) {
    const s = new Date(t), e = new Date(t + 6 * 86400000);
    const w = { start: isoOf(s), end: isoOf(e), paidCount: 0, barterCount: 0, cancelledCount: 0, waitingCount: 0, publishedCount: 0, placement: 0, costSum: 0, budget: 0, avg: 0, bloggers: [] };
    weeks.push(w);
    byKey[w.start] = w;
  }
  for (const r of rows) {
    const w = byKey[isoOf(mondayOf(r.date))];
    if (!w) continue;
    if (r.kind === "cancelled") w.cancelledCount++;
    else {
      if (r.barter) w.barterCount++; else w.paidCount++;
      w.placement += r.price; w.costSum += r.cost; w.budget += r.price + r.cost;
    }
    if (r.kind !== "cancelled") {
      if (r.kind === "waiting") w.waitingCount++;
      if (r.kind === "published") w.publishedCount++;
    }
    w.bloggers.push({
      date: isoOf(r.date), nick: r.nick, fullName: r.fullName, city: r.city, followers: r.followers,
      status: r.status, kind: r.kind, product: r.product, essence: r.essence,
      barter: r.barter, price: r.price, cost: r.cost, total: r.price + r.cost,
    });
  }
  const totals = { paidCount: 0, barterCount: 0, cancelledCount: 0, waitingCount: 0, placement: 0, costSum: 0, budget: 0, avg: 0, weeks: weeks.length };
  weeks.forEach((w) => {
    const cnt = w.paidCount + w.barterCount;
    w.avg = cnt ? Math.round(w.budget / cnt) : 0;
    w.bloggers.sort((a, b) => (a.date < b.date ? -1 : 1));
    totals.paidCount += w.paidCount; totals.barterCount += w.barterCount;
    totals.cancelledCount += w.cancelledCount; totals.waitingCount += w.waitingCount;
    totals.budget += w.budget; totals.placement += w.placement; totals.costSum += w.costSum;
  });
  const allCnt = totals.paidCount + totals.barterCount;
  totals.avg = allCnt ? Math.round(totals.budget / allCnt) : 0;
  return { weeks, totals };
}

async function getReport(weeksCount, force) {
  if (!csvUrl()) return { configured: false };
  const rows = await loadRows(force);
  const rep = buildReport(rows || [], weeksCount);
  const diag = Object.assign({ parsedRows: (rows || []).length }, cache.diag || {});
  return Object.assign({ configured: true, diag, updatedAt: new Date(cache.at).toISOString(), stale: cache.error || null }, rep);
}

module.exports = { getReport, parseRows, buildReport, parseDate };
