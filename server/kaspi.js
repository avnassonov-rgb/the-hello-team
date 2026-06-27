/* Клиент Kaspi Seller API (kaspi.kz/shop/api/v2).
   Без внешних зависимостей: только встроенный модуль https.
   Токен ТОЛЬКО из переменной окружения KASPI_TOKEN — никогда не хранить в файлах. */
"use strict";
const https = require("https");

const HOST = "kaspi.kz";
const BASE_PATH = "/shop/api/v2/";

function token() {
  return process.env.KASPI_TOKEN || "";
}

function buildQuery(pairs) {
  return pairs
    .filter((p) => p[1] !== undefined && p[1] !== null && p[1] !== "")
    .map((p) => encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1]))
    .join("&");
}

function httpGetJSON(pathAndQuery, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      path: BASE_PATH + pathAndQuery,
      method: "GET",
      headers: {
        "X-Auth-Token": token(),
        "Accept": "*/*",
        "Content-Type": "application/vnd.api+json",
      },
      timeout: timeoutMs || 20000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("Kaspi API [" + res.statusCode + "]: " + raw.slice(0, 500)));
        }
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("Kaspi API: ответ не в формате JSON — " + raw.slice(0, 200)));
        }
      });
    });
    req.on("error", (e) => reject(new Error("Kaspi API: ошибка соединения — " + e.message)));
    req.on("timeout", () => req.destroy(new Error("Kaspi API: таймаут запроса")));
    req.end();
  });
}

// Список заказов. state — обязательный фильтр Kaspi (NEW/SIGN_REQUIRED/PICKUP/DELIVERY/KASPI_DELIVERY/ARCHIVE).
async function getOrders(opts) {
  opts = opts || {};
  const state = opts.state || "NEW";
  const sinceMs = opts.sinceMs || (Date.now() - 13 * 24 * 60 * 60 * 1000); // Kaspi разрешает не больше 14 дней за раз
  const q = buildQuery([
    ["page[number]", opts.pageNumber || 0],
    ["page[size]", opts.pageSize || 20],
    ["filter[orders][state]", state],
    ["filter[orders][creationDate][$ge]", sinceMs],
  ]);
  const json = await httpGetJSON("orders?" + q, opts.timeoutMs);
  return {
    items: (json && json.data) || [],
    pageCount: json && json.meta && json.meta.pageCount,
    totalCount: json && json.meta && json.meta.totalCount,
  };
}

// Состав заказа (позиции).
async function getOrderEntries(orderId, timeoutMs) {
  const json = await httpGetJSON("orders/" + encodeURIComponent(orderId) + "/entries", timeoutMs);
  return (json && json.data) || [];
}

// Товар по конкретной позиции заказа (код/название для сопоставления с 1С).
async function getEntryProduct(entryId, timeoutMs) {
  const json = await httpGetJSON("orderentries/" + encodeURIComponent(entryId) + "/product", timeoutMs);
  return (json && json.data) || null;
}

// Диагностика: берём несколько последних заказов в заданном состоянии и
// расшифровываем состав каждого — чтобы один раз увидеть реальный формат
// данных (коды товаров, цены, наборы), не вызывая ничего другого.
async function debugSample(opts) {
  opts = opts || {};
  if (!token()) {
    throw new Error("Не задан KASPI_TOKEN — добавьте переменную окружения в настройках Render (Environment) и перезапустите сервис.");
  }
  const state = opts.state || "NEW";
  const maxOrders = Math.min(opts.maxOrders || 5, 20);
  const list = await getOrders({ state: state, pageSize: maxOrders });
  const sample = [];
  for (const o of list.items.slice(0, maxOrders)) {
    const attrs = o.attributes || {};
    const entries = await getOrderEntries(o.id);
    const items = [];
    for (const e of entries) {
      const ea = e.attributes || {};
      let product = null;
      let productError = null;
      try {
        product = await getEntryProduct(e.id);
      } catch (err) {
        productError = err.message;
      }
      const pa = (product && product.attributes) || {};
      items.push({
        entryId: e.id,
        qty: ea.quantity,
        totalPrice: ea.totalPrice,
        basePrice: ea.basePrice,
        productCode: pa.code || null,
        productName: pa.name || null,
        productError: productError,
      });
    }
    sample.push({
      orderId: o.id,
      code: attrs.code,
      state: attrs.state,
      status: attrs.status,
      totalPrice: attrs.totalPrice,
      creationDate: attrs.creationDate ? new Date(attrs.creationDate).toISOString() : null,
      customerName: attrs.customer && attrs.customer.name,
      items: items,
    });
  }
  return { state: state, ordersFound: list.totalCount != null ? list.totalCount : list.items.length, sample: sample };
}

// Запускает несколько асинхронных задач параллельно (с ограничением), чтобы не
// делать сотни запросов строго по одному и не перегружать сервер Kaspi.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (e) {
        results[idx] = null;
      }
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// Собирает список уникальных товаров (код + название) по последним заказам —
// чтобы было проще и быстрее заполнять таблицу соответствия Kaspi↔1С.
// Помечает похожие на наборы по словам в названии (набор/комплект/2в1 и т.п.).
async function listDistinctProducts(opts) {
  opts = opts || {};
  if (!token()) {
    throw new Error("Не задан KASPI_TOKEN — добавьте переменную окружения в настройках Render (Environment) и перезапустите сервис.");
  }
  const state = opts.state || "ARCHIVE";
  const maxOrders = Math.min(opts.maxOrders || 40, 100);
  const list = await getOrders({ state: state, pageSize: maxOrders, timeoutMs: opts.timeoutMs });
  const orders = list.items.slice(0, maxOrders);

  const productMap = new Map(); // code -> { name, count }
  await mapWithConcurrency(orders, 5, async (o) => {
    let entries;
    try {
      entries = await getOrderEntries(o.id, 15000);
    } catch (e) {
      return;
    }
    for (const e of entries) {
      let product;
      try {
        product = await getEntryProduct(e.id, 15000);
      } catch (err) {
        continue;
      }
      const pa = (product && product.attributes) || {};
      if (!pa.code) continue;
      if (!productMap.has(pa.code)) productMap.set(pa.code, { name: pa.name || null, count: 0 });
      productMap.get(pa.code).count++;
    }
  });

  const KIT_HINTS = ["набор", "комплект", "2в1", "3в1", "4в1", "увлажн"];
  const products = Array.from(productMap.entries()).map(([code, v]) => ({
    code: code,
    name: v.name,
    seenInOrders: v.count,
    looksLikeKit: KIT_HINTS.some((h) => (v.name || "").toLowerCase().includes(h)),
  }));
  products.sort((a, b) => (a.looksLikeKit === b.looksLikeKit ? 0 : a.looksLikeKit ? -1 : 1));

  return { state: state, ordersScanned: orders.length, distinctProducts: products.length, products: products };
}

// Лёгкая проверка связи/токена Kaspi — для фонового мониторинга (Telegram-уведомления).
// Один минимальный запрос (1 заказ), не тянет позиции/товары. Бросает исключение при сбое.
async function healthCheck() {
  if (!token()) {
    throw new Error("Не задан KASPI_TOKEN — добавьте переменную окружения в настройках Render (Environment) и перезапустите сервис.");
  }
  await getOrders({ state: "ARCHIVE", pageSize: 1, timeoutMs: 15000 });
}

module.exports = { getOrders, getOrderEntries, getEntryProduct, debugSample, listDistinctProducts, healthCheck };
