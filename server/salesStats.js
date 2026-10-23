/* Продажи по месяцам из 1С (Document_РеализацияТоваровУслуг).
   Берём ВСЕ реализации — и проведённые, и непроведённые; не берём только помеченные на удаление.
   Группировка по полю «Ответственный»: Каспи Магазин / гос.закуп / Офис-менеджер (остальное — «Другие»).
   Сумма = СуммаДокумента. Кэш: данные года живут 15 минут; загрузка идёт в фоне,
   чтобы страница не зависала на медленной 1С. */
"use strict";
const oneC = require("./oneC");

const CACHE_MS = 15 * 60 * 1000;
const cache = {}; // year -> { at, data, loading, error, promise }

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
      select: "Ref_Key,Date,DeletionMark,СуммаДокумента,Ответственный_Key",
    }, base));
  } catch (e) {
    // если какое-то имя поля в этой конфигурации отличается — берём заголовки целиком
    return await oneC.fetchEntitySet("Document_РеализацияТоваровУслуг", base);
  }
}

async function build(year) {
  const rows = await fetchRealizations(year);
  const resp = await oneC.fetchRefCatalogMap(["Catalog_Пользователи", "Catalog_ФизическиеЛица", "Catalog_Сотрудники"]);
  const months = [];
  for (let m = 1; m <= 12; m++) months.push({ m, total: 0, count: 0, kaspi: 0, gos: 0, office: 0, other: 0, kaspiCount: 0, gosCount: 0, officeCount: 0, otherCount: 0 });
  let used = 0, deleted = 0, noSum = 0;
  const respNames = {};
  rows.forEach((r) => {
    if (r.DeletionMark) { deleted++; return; }
    const d = String(r.Date || "");
    const mo = parseInt(d.slice(5, 7), 10);
    if (!(mo >= 1 && mo <= 12) || parseInt(d.slice(0, 4), 10) !== year) return;
    const sum = Number(r["СуммаДокумента"]);
    if (!isFinite(sum)) { noSum++; return; }
    const rn = r["Ответственный_Key"] ? resp.map.get(String(r["Ответственный_Key"]).toLowerCase()) : "";
    const cat = categoryOf(rn);
    respNames[rn || "(пусто)"] = (respNames[rn || "(пусто)"] || 0) + 1;
    const M = months[mo - 1];
    M.total += sum; M.count++;
    M[cat] += sum; M[cat + "Count"]++;
    used++;
  });
  months.forEach((M) => ["total", "kaspi", "gos", "office", "other"].forEach((k) => { M[k] = Math.round(M[k]); }));
  return {
    year, months,
    diag: { rows: rows.length, used, deleted, noSum, respFound: resp.rowCount, respError: resp.error, respNames },
  };
}

function start(year) {
  const c = cache[year] || (cache[year] = { at: 0, data: null, loading: false, error: null, promise: null });
  if (c.loading) return c;
  c.loading = true;
  c.promise = build(year).then((data) => {
    c.data = data; c.at = Date.now(); c.error = null;
  }).catch((e) => {
    c.error = e.message;
  }).then(() => { c.loading = false; });
  return c;
}

/* Возвращает то, что есть в кэше, сразу; если данные устарели — обновляет в фоне. */
function getMonthly(year, force) {
  const c = cache[year] || (cache[year] = { at: 0, data: null, loading: false, error: null, promise: null });
  const stale = !c.data || Date.now() - c.at > CACHE_MS;
  if ((stale || force) && !c.loading) start(year);
  return {
    loading: c.loading,
    error: c.error,
    updatedAt: c.at ? new Date(c.at).toISOString() : null,
    data: c.data,
  };
}

module.exports = { getMonthly, categoryOf };
