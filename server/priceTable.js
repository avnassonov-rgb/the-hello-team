/* Цены компонентов — справочник из листа KASPI.KZ файла "Цены | Производство
   STEP" (гугл-таблица Александра). Колонка "цена продажи" — реальная цена
   товара на Kaspi, привязанная к его СОБСТВЕННОМУ артикулу (КОД КАСПИ).

   Используется в kaspiTransfer.js (buildDocLines), чтобы делить цену набора
   между его компонентами ПРОПОРЦИОНАЛЬНО их реальным ценам, а не поровну —
   подтверждено Александром 30.06.2026 на примере: набор "4 в 1" продан за
   3990тг, реальные цены компонентов 1350/1490/990/1490 (сумма 5320) → доли
   25.4%/28%/18.6%/28% → этими же долями делим фактические 3990тг.

   Таблица соответствия (mappingTable.js) даёт название компонента в 1С, а не
   его артикул Kaspi (внутри набора компонент своего артикула не имеет — он
   "спрятан" под общим артикулом набора). Поэтому связь такая:
     название компонента в 1С
       --(mappingTable.nameToCode, по строкам типа "товар")-->
     собственный артикул Kaspi этого компонента
       --(priceMap из ЭТОГО файла, priceTable.js)-->
     реальная цена продажи.
   Сопоставление на каждом шаге идёт по артикулу/точному названию, а не по
   "похожим" строкам — так надёжнее, чем сверять название между двумя разными
   таблицами, где оно могло быть написано чуть по-разному.

   Кэш: сервер не ходит в таблицу на каждый заказ — цены загружаются один раз
   и обновляются не чаще, чем раз в REFRESH_INTERVAL_MS (по умолчанию сутки),
   как и просил Александр ("1 раз в сутки перепроверить не поменялись ли
   цены"). Если сеть/таблица временно недоступна — используется последний
   известный кэш, чтобы один сетевой сбой не остановил перенос заказов.

   Переменная окружения: PRICE_SHEET_CSV_URL — ссылка на лист KASPI.KZ,
   опубликованный ИМЕННО в формате CSV (Файл → Поделиться → Опубликовать в
   интернете → выбрать лист "KASPI.KZ" → формат "Значения, разделённые
   запятыми (.csv)"). Если переменная не задана — деление просто остаётся
   поровну (старое поведение), перенос заказов не ломается. */
"use strict";
const https = require("https");
const http = require("http");
const { URL } = require("url");
const { parseCsv } = require("./mappingTable");

function csvUrl() {
  return process.env.PRICE_SHEET_CSV_URL || "";
}

function httpGetText(fullUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(fullUrl);
    } catch (e) {
      return reject(new Error("некорректная ссылка на таблицу цен — " + fullUrl));
    }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + (u.search || ""), method: "GET", timeout: timeoutMs || 20000 },
      (res) => {
        // Google публикует CSV-ссылку с одним редиректом — обрабатываем сами.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpGetText(res.headers.location, timeoutMs).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error("HTTP " + res.statusCode + " при чтении таблицы цен — " + raw.slice(0, 200)));
          }
          resolve(raw);
        });
      }
    );
    req.on("error", (e) => reject(new Error("ошибка соединения с таблицей цен — " + e.message)));
    req.on("timeout", () => req.destroy(new Error("таймаут запроса таблицы цен")));
    req.end();
  });
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function findCol(headerRow, mustContainAll) {
  for (let i = 0; i < headerRow.length; i++) {
    const h = norm(headerRow[i]);
    if (mustContainAll.every((kw) => h.indexOf(kw) !== -1)) return i;
  }
  return -1;
}

/* Лист KASPI.KZ устроен в две секции (товары, потом отдельным заголовком
   "Наборы") — обе секции используют те же колонки "КОД КАСПИ" и "цена
   продажи". Поэтому не ищем единственную строку заголовка под все данные:
   один раз находим НОМЕРА этих двух колонок по первому подходящему
   заголовку, а дальше проходим ВСЕ строки файла и берём только те, где в
   обеих колонках реально стоят числа — так заголовки, разделы и текстовые
   пояснения под таблицей (тарифы доставки и т.п.) сами по себе пропускаются. */
function buildPriceMap(csvText) {
  const allRows = parseCsv(csvText);
  const headerIdx = allRows.findIndex((r) => r.some((c) => /код/i.test(c)) && r.some((c) => /цена/i.test(c) && /продаж/i.test(c)));
  const header = headerIdx !== -1 ? allRows[headerIdx] : [];

  const colCode = findCol(header, ["код"]);
  const colPrice = findCol(header, ["цена", "продаж"]);

  const problems = [];
  if (headerIdx === -1 || colCode === -1 || colPrice === -1) {
    problems.push("не нашёл колонки «КОД КАСПИ» и/или «цена продажи» на листе KASPI.KZ — проверьте заголовки в опубликованном файле");
    return { map: new Map(), problems };
  }

  const map = new Map(); // код Kaspi (строка) -> цена продажи (число, тг)
  allRows.forEach((r) => {
    const codeRaw = String(r[colCode] || "").trim();
    if (!/^\d+$/.test(codeRaw)) return; // не похоже на артикул — заголовок/раздел/текст, пропускаем
    const priceRaw = String(r[colPrice] || "").replace(/[^\d,.\-]/g, "").replace(",", ".");
    const price = parseFloat(priceRaw);
    if (!isFinite(price) || price <= 0) return;
    map.set(codeRaw, price);
  });

  return { map, problems };
}

let cache = { map: new Map(), fetchedAt: 0, problems: [] };
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // раз в сутки — см. комментарий в начале файла

/* force=true — игнорировать кэш и перечитать таблицу прямо сейчас (для
   ручной проверки, например через будущий диагностический маршрут). Обычные
   вызовы из kaspiTransfer.js идут без force — кэш обновляется сам не чаще
   раза в сутки. */
async function loadPriceTable(force) {
  const url = csvUrl();
  if (!url) {
    return {
      map: cache.map,
      problems: ["Не задана PRICE_SHEET_CSV_URL — деление цены набора по реальным ценам компонентов недоступно, используется деление поровну (как раньше)"],
    };
  }
  const isStale = Date.now() - cache.fetchedAt > REFRESH_INTERVAL_MS;
  if (!force && !isStale && cache.map.size > 0) {
    return { map: cache.map, problems: cache.problems };
  }
  try {
    const csvText = await httpGetText(url, 20000);
    const { map, problems } = buildPriceMap(csvText);
    cache = { map: map.size > 0 ? map : cache.map, fetchedAt: Date.now(), problems };
    return { map: cache.map, problems: cache.problems };
  } catch (e) {
    return {
      map: cache.map,
      problems: cache.problems.concat(["обновление цен из таблицы KASPI.KZ не удалось (" + e.message + "), используется последний известный кэш"]),
    };
  }
}

module.exports = { loadPriceTable, buildPriceMap };
