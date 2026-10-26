/* Счета на оплату покупателю из 1С (Document_СчетНаОплатуПокупателю) + статус отгрузки.
   Отгружен = существует непомеченная на удаление «Реализация», у которой ДокументОснование = этот счёт
   (проведена она или нет — неважно: склад создаёт реализацию, бухгалтерия проводит позже).
   Данные года кэшируются в памяти на 15 минут, грузятся в фоне. */
"use strict";
const oneC = require("./oneC");

const CACHE_MS = 15 * 60 * 1000;
const cache = {}; // year -> { at, rows, loading, error, promise, diag }
let maps = { at: 0, resp: null, contr: null };

async function getMaps() {
  if (maps.resp && Date.now() - maps.at < 60 * 60 * 1000) return maps;
  const resp = await oneC.fetchRefCatalogMap(["Catalog_Пользователи", "Catalog_ФизическиеЛица", "Catalog_Сотрудники"]);
  const contr = await oneC.fetchRefCatalogMap(["Catalog_Контрагенты"]);
  maps = { at: Date.now(), resp, contr };
  return maps;
}

async function build(year) {
  const filter = "Date ge datetime'" + year + "-01-01T00:00:00' and Date lt datetime'" + (year + 1) + "-01-01T00:00:00'";
  const base = { filter, pageSize: 500, timeoutMs: 90000, orderby: "Ref_Key" };
  let invoices;
  try {
    invoices = await oneC.fetchEntitySet("Document_СчетНаОплатуПокупателю", Object.assign({
      select: "Ref_Key,Number,Date,DeletionMark,СуммаДокумента,Ответственный_Key,Контрагент_Key,Комментарий",
    }, base));
  } catch (e) {
    invoices = await oneC.fetchEntitySet("Document_СчетНаОплатуПокупателю", base);
  }
  // Реализации с начала года счетов и дальше (отгрузка может быть позже счёта — берём с запасом на следующий год)
  const realFilter = "Date ge datetime'" + year + "-01-01T00:00:00'";
  let reals;
  try {
    reals = await oneC.fetchEntitySet("Document_РеализацияТоваровУслуг", {
      filter: realFilter, pageSize: 1000, timeoutMs: 90000, orderby: "Ref_Key",
      select: "Ref_Key,Number,Date,DeletionMark,ДокументОснование",
    });
  } catch (e) {
    reals = await oneC.fetchEntitySet("Document_РеализацияТоваровУслуг", {
      filter: realFilter, pageSize: 1000, timeoutMs: 90000, orderby: "Ref_Key",
    });
  }
  const shipBy = new Map(); // guid счёта -> [реализации]
  let realsUsed = 0;
  reals.forEach((r) => {
    if (r.DeletionMark || !r["ДокументОснование"]) return;
    const k = String(r["ДокументОснование"]).toLowerCase();
    const arr = shipBy.get(k) || [];
    arr.push({ n: String(r.Number || "").trim(), d: String(r.Date || "").slice(0, 10) });
    shipBy.set(k, arr);
    realsUsed++;
  });
  const m = await getMaps();
  const rows = [];
  let deleted = 0;
  invoices.forEach((inv) => {
    if (inv.DeletionMark) { deleted++; return; }
    const k = String(inv.Ref_Key || "").toLowerCase();
    const ships = shipBy.get(k) || [];
    ships.sort((a, b) => (a.d < b.d ? -1 : 1));
    rows.push({
      n: String(inv.Number || "").trim(),
      d: String(inv.Date || "").slice(0, 10),
      s: Number(inv["СуммаДокумента"]) || 0,
      r: inv["Ответственный_Key"] ? (m.resp.map.get(String(inv["Ответственный_Key"]).toLowerCase()) || "") : "",
      c: inv["Контрагент_Key"] ? (m.contr.map.get(String(inv["Контрагент_Key"]).toLowerCase()) || "") : "",
      m: String(inv["Комментарий"] || ""),
      shipped: ships.length > 0,
      sd: ships.length ? ships[0].d : null,
      sn: ships.length ? ships.map((x) => x.n).join(", ") : null,
    });
  });
  return {
    rows,
    diag: { invoices: invoices.length, deleted, realizations: reals.length, realizationsWithBase: realsUsed, respFound: m.resp.rowCount, contrFound: m.contr.rowCount },
  };
}

async function getInvoices(year) {
  const c = cache[year] || (cache[year] = { at: 0, rows: null, loading: false, error: null, promise: null, diag: null });
  const stale = !c.rows || Date.now() - c.at > CACHE_MS;
  if (stale && !c.loading) {
    c.loading = true;
    c.promise = build(year).then((r) => {
      c.rows = r.rows; c.diag = r.diag; c.at = Date.now(); c.error = null;
    }).catch((e) => { c.error = e.message; }).then(() => { c.loading = false; });
  }
  if (!c.rows && c.promise) await Promise.race([c.promise, new Promise((res) => setTimeout(res, 100000))]);
  if (!c.rows) throw new Error(c.error || "счета ещё загружаются из 1С, повторите вопрос через минуту");
  return { rows: c.rows, diag: c.diag, updatedAt: new Date(c.at).toISOString() };
}

module.exports = { getInvoices };
