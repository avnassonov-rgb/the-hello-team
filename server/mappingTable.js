/* Таблица соответствия Kaspi → 1С (набор/товар → компоненты в 1С).
   Источник — Google Таблица, опубликованная как CSV (Файл → Поделиться →
   Опубликовать в интернете → CSV). Сервер читает эту ссылку перед каждым
   переносом заказов — любые правки в таблице подхватываются автоматически,
   без переразвёртывания (redeploy).

   Без внешних зависимостей: только встроенный модуль https + свой CSV-парсер
   (нужен, потому что названия товаров Kaspi сами содержат запятые — Google
   оборачивает такие поля в кавычки, обычный split(",") их сломает).

   Ожидаемые колонки (порядок не важен, ищем по заголовку, см. matchHeader):
   - Kaspi: артикул/код
   - Kaspi: название (для проверки глазами) — не используется в логике
   - Тип — "товар" или "набор"
   - Компонент в 1С (название) — точное название из Catalog_Номенклатура
   - Кол-во компонента в наборе — сколько единиц ЭТОГО компонента в одном
     наборе (для простых "товар"-строк не используется, считается 1)
   - максимальное кол-во товаров в коробке (заголовок должен содержать
     слово "коробк" — само название можно менять, например "Максимальное
     количество в коробке") — число: сколько единиц ЭТОГО компонента
     максимум помещается в одну коробку. Используется для расчёта
     numberOfSpace при продвижении заказа в Kaspi (см. kaspiTransfer.js,
     computeNumberOfSpace) — товары/компоненты с одинаковой вместимостью
     могут ехать в одной коробке вместе, даже если это разные товары
     (подтверждено Александром на примере "Универсальный набор спреев 4шт":
     4 разных спрея по 1 шт, у каждого вместимость 4 → это 1 полная коробка).
     Если у строки нет числа в этой колонке (пустая ячейка или колонки нет
     в таблице вообще) — берётся значение по умолчанию 4.

   Переменная окружения: MAPPING_SHEET_CSV_URL — постоянная ссылка на
   опубликованный CSV (задаётся в Render). */
"use strict";
const https = require("https");
const http = require("http");
const { URL } = require("url");

function csvUrl() {
  return process.env.MAPPING_SHEET_CSV_URL || "";
}

function httpGetText(fullUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(fullUrl);
    } catch (e) {
      return reject(new Error("некорректная ссылка на таблицу — " + fullUrl));
    }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + (u.search || ""), method: "GET", timeout: timeoutMs || 20000 },
      (res) => {
        // Google публикует CSV-ссылку с одним редиректом (docs.google.com -> ...) — обрабатываем сами.
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpGetText(res.headers.location, timeoutMs).then(resolve, reject);
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error("HTTP " + res.statusCode + " при чтении таблицы — " + raw.slice(0, 200)));
          }
          resolve(raw);
        });
      }
    );
    req.on("error", (e) => reject(new Error("ошибка соединения с таблицей — " + e.message)));
    req.on("timeout", () => req.destroy(new Error("таймаут запроса таблицы")));
    req.end();
  });
}

/* Простой RFC4180-парсер: поддерживает запятые и переводы строк внутри
   "кавычек", и удвоенные кавычки "" как экранирование одной кавычки. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ""));
}

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

// Находит индекс колонки по ключевым словам, которые должны встретиться в заголовке.
function findCol(headerRow, mustContainAll) {
  for (let i = 0; i < headerRow.length; i++) {
    const h = norm(headerRow[i]);
    if (mustContainAll.every((kw) => h.indexOf(kw) !== -1)) return i;
  }
  return -1;
}

const DEFAULT_BOX_CAPACITY = 4;

/* Разбирает текст CSV в карту: Kaspi-код -> { type: "товар"|"набор",
   components: [{ name1C, qty, boxCapacity }] }.
   qty — кол-во компонента в одном наборе (для "товар" всегда 1).
   boxCapacity — максимальное кол-во ЭТОГО компонента в одной коробке
   (из колонки "максимальное кол-во товаров в коробке", по умолчанию 4). */
function buildMappingMap(csvText) {
  const allRows = parseCsv(csvText);
  // Заголовок — первая строка, где хотя бы одна ячейка похожа на "код"/"тип"/"компонент".
  let headerIdx = allRows.findIndex((r) => r.some((c) => /код|тип|компонент/i.test(c)));
  if (headerIdx === -1) headerIdx = 0;
  const header = allRows[headerIdx];
  const dataRows = allRows.slice(headerIdx + 1);

  const colCode = findCol(header, ["kaspi", "код"]) !== -1 ? findCol(header, ["kaspi", "код"]) : findCol(header, ["код"]);
  const colType = findCol(header, ["тип"]);
  const colComponent = findCol(header, ["компонент"]);
  const colQty = findCol(header, ["кол", "набор"]) !== -1 ? findCol(header, ["кол", "набор"]) : findCol(header, ["кол"]);
  // Колонка вместимости коробки — ищем по слову "коробк" в заголовке (не
  // путать с colQty выше — там "кол-во... в наборе", здесь "...в коробке").
  // Если колонки нет — findCol вернёт -1, и все строки получат вместимость
  // по умолчанию (DEFAULT_BOX_CAPACITY).
  const colCapacity = findCol(header, ["коробк"]);

  const problems = [];
  if (colCode === -1 || colType === -1 || colComponent === -1) {
    problems.push("не нашёл нужные колонки в заголовке таблицы (код/тип/компонент) — проверьте, что в первой строке есть эти заголовки");
  }
  if (colCapacity === -1) {
    problems.push("не нашёл колонку «максимальное кол-во товаров в коробке» (заголовок должен содержать слово «коробк») — все товары посчитаны с вместимостью по умолчанию " + DEFAULT_BOX_CAPACITY);
  }

  const map = new Map(); // code -> { type, components: [{name1C, qty, boxCapacity}] }
  dataRows.forEach((r, i) => {
    const code = String(r[colCode] || "").trim();
    if (!code) return;
    const type = norm(r[colType]);
    const name1C = String(r[colComponent] || "").trim();
    if (!name1C) {
      problems.push("строка " + (headerIdx + i + 2) + ": код " + code + " — пустой 'Компонент в 1С', строка пропущена");
      return;
    }
    let qty = colQty !== -1 ? parseFloat(String(r[colQty]).replace(",", ".")) : 1;
    if (!qty || qty <= 0) qty = 1;
    let boxCapacity = colCapacity !== -1 ? parseFloat(String(r[colCapacity]).replace(",", ".")) : NaN;
    if (!boxCapacity || boxCapacity <= 0) {
      if (colCapacity !== -1) {
        problems.push("строка " + (headerIdx + i + 2) + ": код " + code + " — нет числа в колонке вместимости коробки, взято значение по умолчанию " + DEFAULT_BOX_CAPACITY);
      }
      boxCapacity = DEFAULT_BOX_CAPACITY;
    }
    if (!map.has(code)) map.set(code, { type: type || "товар", components: [] });
    map.get(code).components.push({ name1C, qty, boxCapacity });
  });

  return { map, problems, rowCount: dataRows.length };
}

async function loadMappingTable() {
  const url = csvUrl();
  if (!url) {
    throw new Error("Не задана MAPPING_SHEET_CSV_URL — добавьте переменную окружения со ссылкой на опубликованный CSV таблицы соответствия (Render → Environment).");
  }
  const csvText = await httpGetText(url, 20000);
  const { map, problems, rowCount } = buildMappingMap(csvText);
  if (map.size === 0) {
    throw new Error("таблица соответствия прочитана, но не нашлось ни одной строки с кодом — проверьте ссылку/формат");
  }
  return { map, problems, rowCount };
}

module.exports = { loadMappingTable, buildMappingMap, parseCsv };
