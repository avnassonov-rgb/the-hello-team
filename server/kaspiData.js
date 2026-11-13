/* Данные Kaspi для MCP-коннектора (только чтение): заказы за период и состав заказов.
   Kaspi API отдаёт заказы окнами не больше 14 дней, страницами до 100 штук — склеиваем сами.
   Данные кэшируются в памяти: список заказов 10 минут, состав заказа (позиции) — надолго. */
"use strict";
const kaspi = require("./kaspi");

const STATES = ["NEW", "SIGN_REQUIRED", "PICKUP", "DELIVERY", "KASPI_DELIVERY", "ARCHIVE"];
const TZ_MS = 5 * 3600 * 1000; // Костанай UTC+5
const DAY = 86400000;
const WINDOW_DAYS = 13;
const ORDERS_TTL = 10 * 60 * 1000;

const ordersCache = new Map(); // key -> { at, orders, promise }
const entryCache = new Map(); // orderId -> [{ q, s, name, code }]
const ENTRY_CACHE_MAX = 30000;
const jobs = new Map(); // key -> { total, done, promise }

function dayStartMs(dateStr) { return Date.parse(dateStr + "T00:00:00+05:00"); }
function toDay(ms) { return new Date(ms + TZ_MS).toISOString().slice(0, 10); }

function normalize(o, state) {
  const a = o.attributes || {};
  const ms = Number(a.creationDate) || 0;
  const addr = a.deliveryAddress || {};
  const c = a.customer || {};
  return {
    id: o.id, code: a.code, ms, d: ms ? toDay(ms) : "",
    state: a.state || state, status: a.status || "",
    sum: Number(a.totalPrice) || 0,
    city: addr.town || "",
    addr: addr.formattedAddress || "",
    pay: a.paymentMode || "",
    deliv: a.deliveryMode || "",
    kd: !!a.isKaspiDelivery,
    cost: Number(a.deliveryCost) || 0,
    planned: a.plannedDeliveryDate ? toDay(Number(a.plannedDeliveryDate)) : null,
    cust: c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || "",
  };
}

async function fetchState(state, fromMs, toMs, deadline) {
  const out = [];
  for (let w = fromMs; w < toMs; w += WINDOW_DAYS * DAY) {
    const until = Math.min(w + WINDOW_DAYS * DAY - 1, toMs);
    for (let page = 0; page < 500; page++) {
      if (Date.now() > deadline) throw new Error("не успели загрузить заказы из Kaspi за отведённое время");
      const r = await kaspi.getOrders({ state, sinceMs: w, untilMs: until, pageNumber: page, pageSize: 100, timeoutMs: 30000 });
      r.items.forEach((o) => out.push(normalize(o, state)));
      if (r.items.length < 100 || (r.pageCount != null && page + 1 >= r.pageCount)) break;
    }
  }
  return out;
}

/* Все заказы за период [from; to] включительно (даты ГГГГ-ММ-ДД по Костанаю), по всем статусам или одному. */
async function getOrders(from, to, state) {
  const fromMs = dayStartMs(from), toMs = dayStartMs(to) + DAY - 1;
  const states = state ? [state] : STATES;
  const key = states.join(",") + "|" + from + "|" + to;
  const c = ordersCache.get(key);
  if (c && c.orders && Date.now() - c.at < ORDERS_TTL) return c.orders;
  if (c && c.promise) return c.promise;
  const deadline = Date.now() + 100000;
  const promise = Promise.all(states.map((s) => fetchState(s, fromMs, toMs, deadline))).then((parts) => {
    const seen = new Set();
    const orders = [];
    parts.forEach((p) => p.forEach((o) => { if (!seen.has(o.id)) { seen.add(o.id); orders.push(o); } }));
    ordersCache.set(key, { at: Date.now(), orders });
    return orders;
  }).catch((e) => { ordersCache.delete(key); throw e; });
  ordersCache.set(key, { at: 0, orders: null, promise });
  return promise;
}

async function loadEntries(order) {
  if (entryCache.has(order.id)) return;
  const entries = await kaspi.getOrderEntries(order.id, 20000);
  const lines = [];
  for (const e of entries) {
    const a = e.attributes || {};
    let name = (a.offer && (a.offer.name || a.offer.code)) || "";
    let code = (a.offer && a.offer.code) || "";
    if (!name) {
      try {
        const p = await kaspi.getEntryProduct(e.id, 15000);
        const pa = (p && p.attributes) || {};
        name = pa.name || ""; code = pa.code || code;
      } catch (err) { /* имя не нашли */ }
    }
    lines.push({ q: Number(a.quantity) || 0, s: Number(a.totalPrice) || 0, name: name || (code ? "код " + code : "(товар не определён)"), code });
  }
  if (entryCache.size >= ENTRY_CACHE_MAX) entryCache.delete(entryCache.keys().next().value);
  entryCache.set(order.id, lines);
}

/* Догружает позиции заказов (в фоне), ждёт до waitMs. Возвращает статистику готовности. */
async function ensureEntries(orders, key, waitMs) {
  let job = jobs.get(key);
  const missing = orders.filter((o) => !entryCache.has(o.id));
  if (missing.length && (!job || job.finished)) {
    job = { total: missing.length, finished: false, error: null };
    let idx = 0;
    const worker = async () => {
      while (idx < missing.length) {
        const o = missing[idx++];
        try { await loadEntries(o); } catch (e) { job.error = e.message; }
      }
    };
    job.promise = Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]).then(() => { job.finished = true; });
    jobs.set(key, job);
  }
  if (job && !job.finished) await Promise.race([job.promise, new Promise((res) => setTimeout(res, waitMs))]);
  const ready = orders.filter((o) => entryCache.has(o.id));
  return { ready, total: orders.length };
}

function entriesOf(orderId) { return entryCache.get(orderId) || []; }

module.exports = { getOrders, ensureEntries, entriesOf, STATES };
