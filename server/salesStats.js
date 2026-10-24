/* Продажи из 1С (Document_РеализацияТоваровУслуг).
   Берём ВСЕ реализации — и проведённые, и непроведённые; не берём только помеченные на удаление.
   Группировка по полю «Ответственный»: Каспи Магазин / гос.закуп / Офис-менеджер (остальное — «Другие»).
   Сумма = СуммаДокумента. Данные года кэшируются в памяти на 15 минут; загрузка идёт в фоне,
   чтобы страница не зависала на медленной 1С. Вместе со сводкой по месяцам храним компактный список
   реализаций (дата, сумма, ответственный, контрагент) — по нему отвечает MCP-коннектор на любые вопросы
   (по контрагенту, периоду, дням и т.д.) без повторных запросов в 1С. */
"use strict";
const oneC = require("./oneC");

const CACHE_MS = 15 * 60 * 1000;
const cache = {}; // year -> { at, data, rows, loading, error, promise }

function categoryOf(name) {
  const t = String(name || "").toLowerCase();
  if (t.indexOf("каспи") !== -1 || t.indexOf("kaspi") !== -1) return "kaspi";
  if (t.indexOf("гос") !== -1) return "gos";
  if (t.indexOf("офис") !== -1) return "office";
  return "other";
}

async function fetchRealizations(year) {
  const from = "datetime'" + year + "-01-01T00:00:00'";
  const to = "datetime'" + (year + 1) + "-01-01T00:00:00'";
  const filter = "Date ge " + from + " and Date lt " + to;
  const base = { filter, pageSize: 1000, timeoutMs: 90000, orderby: "Ref_Key" };
  try {
    return await oneC.fetchEntitySet("Document_РеализацияТоваровУслуг", Object.assign({
      select: "Ref_Key,Date,DeletionMark,СуммаДокумента,Ответственный_Key,Контрагент_Key",
    }, base));
  } catch (e) {
    // если какое-то имя поля в этой конфигурации отличается — берём заголовки целиком
    return await oneC.fetchEntitySet("Document_РеализацияТоваровУслуг", base);
  }
}

// справочник контрагентов (названия) — кэш на час
let contrCache = { at: 0, map: null, error: null, rowCount: 0 };
async function getContragents() {
  if (contrCache.map && Date.now() - contrCache.at < 60 * 60 * 1000) return contrCache;
  const r = await oneC.fetchRefCatalogMap(["Catalog_Контрагенты"]);
  contrCache = { at: Date.now(), map: r.map, error: r.error, rowCount: r.rowCount };
  return contrCache;
}

async function build(year) {
  const rows = await fetchRealizations(year);
  const resp = await oneC.fetchRefCatalogMap(["Catalog_Пользователи", "Catalog_ФизическиеЛица", "Catalog_Сотрудники"]);
  const contr = await getContragents();
  const months = [];
  for (let m = 1; m <= 12; m++) months.push({ m, total: 0, count: 0, kaspi: 0, gos: 0, office: 0, other: 0, kaspiCount: 0, gosCount: 0, officeCount: 0, otherCount: 0 });
  let used = 0, deleted = 0, noSum = 0;
  const respNames = {};
  const compact = [];
  rows.forEach((r) => {
    if (r.DeletionMark) { deleted++; return; }
    const d = String(r.Date || "");
    const mo = parseInt(d.slice(5, 7), 10);
    if (!(mo >= 1 && mo <= 12) || parseInt(d.slice(0, 4), 10) !== year) return;
    const sum = Number(r["СуммаДокумента"]);
    if (!isFinite(sum)) { noSum++; return; }
    const rn = r["Ответственный_Key"] ? (resp.map.get(String(r["Ответственный_Key"]).toLowerCase()) || "") : "";
    const cn = r["Контрагент_Key"] ? (contr.map.get(String(r["Контрагент_Key"]).toLowerCase()) || "") : "";
    const cat = categoryOf(rn);
    respNames[rn || "(пусто)"] = (respNames[rn || "(пусто)"] || 0) + 1;
    const M = months[mo - 1];
    M.total += sum; M.count++;
    M[cat] += sum; M[cat + "Count"]++;
    compact.push({ k: String(r.Ref_Key || "").toLowerCase(), d: d.slice(0, 10), s: sum, r: rn, c: cn });
    used++;
  });
  months.forEach((M) => ["total", "kaspi", "gos", "office", "other"].forEach((k) => { M[k] = Math.round(M[k]); }));
  return {
    data: {
      year, months,
      diag: { rows: rows.length, used, deleted, noSum, respFound: resp.rowCount, respError: resp.error, contrFound: contr.rowCount, contrError: contr.error, respNames },
    },
    rows: compact,
  };
}

function entry(year) {
  return cache[year] || (cache[year] = { at: 0, data: null, rows: null, loading: false, error: null, promise: null });
}

function start(year) {
  const c = entry(year);
  if (c.loading) return c;
  c.loading = true;
  c.promise = build(year).then((res) => {
    c.data = res.data; c.rows = res.rows; c.at = Date.now(); c.error = null;
  }).catch((e) => {
    c.error = e.message;
  }).then(() => { c.loading = false; });
  return c;
}

/* Возвращает то, что есть в кэше, сразу; если данные устарели — обновляет в фоне. */
function getMonthly(year, force) {
  const c = entry(year);
  const stale = !c.data || Date.now() - c.at > CACHE_MS;
  if ((stale || force) && !c.loading) start(year);
  return {
    loading: c.loading,
    error: c.error,
    updatedAt: c.at ? new Date(c.at).toISOString() : null,
    data: c.data,
  };
}

/* То же, но ждёт окончания загрузки из 1С (для MCP-коннектора), не дольше 100 секунд. */
async function getMonthlyWait(year) {
  const r = getMonthly(year, false);
  if (!r.data) {
    const c = entry(year);
    if (c.promise) {
      await Promise.race([c.promise, new Promise((resolve) => setTimeout(resolve, 100000))]);
    }
  }
  return getMonthly(year, false);
}

/* Список реализаций за год (компактный) для запросов коннектора. */
async function getRows(year) {
  await getMonthlyWait(year);
  const c = entry(year);
  if (!c.rows) throw new Error(c.error || "данные из 1С ещё не получены, повторите через минуту");
  return { rows: c.rows, updatedAt: c.at ? new Date(c.at).toISOString() : null };
}

/* ---- Товарные строки реализаций (штуки по номенклатуре) ----
   Сначала пробуем отдельный набор данных табличной части Document_РеализацияТоваровУслуг_Товары
   (быстро, одним потоком). Если такого набора нет — читаем «Товары» у каждого документа отдельно. */
const itemsCache = {}; // year -> { at, lines, loading, error, promise, mode }

async function buildItems(year) {
  const docs = await getRows(year);
  const byKey = new Map();
  docs.rows.forEach((x) => { if (x.k) byKey.set(x.k, x); });
  const nom = await oneC.fetchRefCatalogMap(["Catalog_Номенклатура"]);
  const lines = [];
  let mode = "set";
  const push = (doc, row) => {
    const q = parseFloat(row["Количество"]) || 0;
    const s = parseFloat(row["Сумма"]) || 0;
    const nk = String(row["Номенклатура_Key"] || "").toLowerCase();
    lines.push({ d: doc.d, c: doc.c, r: doc.r, n: nom.map.get(nk) || "(товар не найден)", q, s });
  };
  try {
    const onRows = (chunk) => {
      chunk.forEach((row) => {
        const doc = byKey.get(String(row.Ref_Key || "").toLowerCase());
        if (doc) push(doc, row);
      });
    };
    try {
      await oneC.fetchEntitySet("Document_РеализацияТоваровУслуг_Товары", {
        select: "Ref_Key,LineNumber,Номенклатура_Key,Количество,Сумма",
        pageSize: 1000, timeoutMs: 120000, orderby: "Ref_Key,LineNumber", maxPages: 1000, onRows,
      });
    } catch (e0) {
      lines.length = 0;
      await oneC.fetchEntitySet("Document_РеализацияТоваровУслуг_Товары", {
        pageSize: 1000, timeoutMs: 120000, orderby: "Ref_Key,LineNumber", maxPages: 1000, onRows,
      });
    }
  } catch (e) {
    mode = "per-document";
    const list = docs.rows.filter((x) => x.k);
    let idx = 0;
    const worker = async () => {
      while (idx < list.length) {
        const doc = list[idx++];
        try {
          const rows = await oneC.fetchDocumentLines("Document_РеализацияТоваровУслуг", doc.k);
          rows.forEach((row) => push(doc, row));
        } catch (e2) { /* пропускаем документ */ }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  }
  return { lines, mode, nomFound: nom.rowCount };
}

async function getItemLines(year) {
  const c = itemsCache[year] || (itemsCache[year] = { at: 0, lines: null, loading: false, error: null, promise: null, mode: null });
  const stale = !c.lines || Date.now() - c.at > 30 * 60 * 1000;
  if (stale && !c.loading) {
    c.loading = true;
    c.promise = buildItems(year).then((r) => {
      c.lines = r.lines; c.mode = r.mode; c.at = Date.now(); c.error = null;
    }).catch((e) => { c.error = e.message; }).then(() => { c.loading = false; });
  }
  if (!c.lines && c.promise) {
    await Promise.race([c.promise, new Promise((resolve) => setTimeout(resolve, 110000))]);
  }
  if (!c.lines) throw new Error(c.error || "товарные строки ещё загружаются из 1С, повторите вопрос через 1–2 минуты");
  return { lines: c.lines, updatedAt: new Date(c.at).toISOString() };
}

module.exports = { getMonthly, getMonthlyWait, getRows, getItemLines, categoryOf };
