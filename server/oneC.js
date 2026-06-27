/* THE HELLO Team — клиент 1С OData (1С:Бухгалтерия для Казахстана, ред 3.0, uchet.kz).
   Без внешних зависимостей: только встроенный модуль https.
   Заменяет ручную загрузку двух xls-файлов — данные берутся прямо из 1С по расписанию.

   Источники данных (точные имена взяты из $metadata):
   - Document_СчетНаОплатуПокупателю   — заказы (= старый файл "не отгруженные").
   - Товарные позиции каждого счёта — этот сервис 1С НЕ разрешает забирать через
     $expand=Товары (сервер явно отвечает 501: "в опции $expand допустимы только
     ссылочные реквизиты" — то есть только одиночные ссылки типа Ответственный/
     Контрагент, но не табличные части/коллекции). Поэтому товары запрашиваются
     отдельно для каждого счёта стандартным способом OData — обращением к его
     табличной части по адресу вида:
       Document_СчетНаОплатуПокупателю(guid'...')/Товары
     Запросы идут с ограниченной параллельностью (см. mapWithConcurrency), чтобы
     не перегружать сервер 1С большим числом одновременных соединений.
   - Document_РеализацияТоваровУслуг   — отгрузки; поле "ДокументОснование" содержит
     Ref_Key счёта, на основании которого сделана отгрузка. Если такой счёт нашёлся —
     значит он уже отгружен, в план производства его включать не нужно.
   - Catalog_Номенклатура               — справочник товаров, для имени позиции, если
     его не отдал сервер внутри строки товара (запасной путь).

   ЛОГИКА РАСЧЁТА (engine.js) НЕ ЗАТРАГИВАЕТСЯ — этот модуль только готовит
   ordersRaw/itemsRaw в том же формате, что раньше присылал браузер после
   разбора xls-файлов (см. Engine.parseOrders / Engine.parseItems).

   Переменные окружения (задаются в Render, никогда не хранятся в коде/чате):
   - ONEC_PASSWORD   — пароль пользователя odata.user (ОБЯЗАТЕЛЬНО)
   - ONEC_USER       — логин (необязательно, по умолчанию "odata.user")
   - ONEC_BASE_URL   — базовый адрес сервиса OData (необязательно, есть разумный
                        default ниже — адрес из инструкции, которую дал Александр) */
"use strict";
const https = require("https");
const { URL } = require("url");
const store = require("./store");
const telegram = require("./telegram");

const DEFAULT_BASE_URL = "https://buh.uchet.kz/Y2baelrail1163/odata/standard.odata/";

function baseUrl() {
  let u = process.env.ONEC_BASE_URL || DEFAULT_BASE_URL;
  if (!u.endsWith("/")) u += "/";
  return u;
}
function oneCUser() {
  return process.env.ONEC_USER || "odata.user";
}
function oneCPassword() {
  return process.env.ONEC_PASSWORD || "";
}

/* ---------------- низкоуровневый GET с Basic Auth ---------------- */
function httpGetJSON(fullUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(fullUrl);
    } catch (e) {
      return reject(new Error("некорректный адрес — " + fullUrl));
    }
    const auth = Buffer.from(oneCUser() + ":" + oneCPassword()).toString("base64");
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ""),
      method: "GET",
      headers: {
        Authorization: "Basic " + auth,
        Accept: "application/json",
      },
      timeout: timeoutMs || 30000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error("доступ запрещён (" + res.statusCode + ") — проверьте ONEC_USER/ONEC_PASSWORD"));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("HTTP " + res.statusCode + ": " + raw.slice(0, 300)));
        }
        const looksHtml = /^\s*<(!DOCTYPE|html)/i.test(raw);
        if (looksHtml) {
          return reject(new Error("сервис 1С вернул HTML-страницу вместо данных (адрес/набор сущностей не найден или не опубликован для OData)"));
        }
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("ответ не в формате JSON: " + raw.slice(0, 200)));
        }
      });
    });
    req.on("error", (e) => reject(new Error(e.message)));
    req.on("timeout", () => req.destroy(new Error("таймаут запроса")));
    req.end();
  });
}

// 1С отдаёт массив либо как {value:[...]}, либо как {d:{results:[...]}}, либо как {d:[...]}
// — поддерживаем все варианты, чтобы не зависеть от точной версии протокола OData.
function extractArray(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.value)) return json.value;
  if (json && json.d) {
    if (Array.isArray(json.d)) return json.d;
    if (Array.isArray(json.d.results)) return json.d.results;
  }
  return [];
}

function buildQuery(params) {
  return Object.keys(params)
    .filter((k) => params[k] != null && params[k] !== "")
    .map((k) => k + "=" + encodeURIComponent(params[k]))
    .join("&");
}

/* Постранично выгружает весь набор сущностей (1С может ограничивать страницу).
   ВАЖНО: без явного $orderby сервер 1С не гарантирует одинаковый порядок строк
   между соседними страницами ($top/$skip) — порядок может быть нестабильным,
   и часть записей "проваливается" между страницами, не попадая ни в одну из
   них. Это объясняет, почему конкретные товары отсутствовали в выгруженном
   справочнике, хотя точно существуют (подтверждено прямым запросом по GUID).
   Сортируем по Ref_Key — он у каждой записи уникален и не меняется, поэтому
   порядок страниц становится стабильным и предсказуемым. */
async function fetchEntitySet(entityName, opts) {
  opts = opts || {};
  const pageSize = opts.pageSize || 300;
  const guardMaxPages = 100; // защита от бесконечного цикла при неожиданном ответе сервера
  let all = [];
  let skip = 0;
  for (let page = 0; page < guardMaxPages; page++) {
    const params = { "$format": "json", "$top": pageSize, "$skip": skip, "$orderby": opts.orderby || "Ref_Key" };
    if (opts.filter) params["$filter"] = opts.filter;
    if (opts.expand) params["$expand"] = opts.expand;
    if (opts.select) params["$select"] = opts.select;
    const full = baseUrl() + entityName + "?" + buildQuery(params);
    let json;
    try {
      json = await httpGetJSON(full, opts.timeoutMs);
    } catch (e) {
      throw new Error("[" + entityName + (opts.expand ? " $expand=" + opts.expand : "") + "] " + e.message);
    }
    const chunk = extractArray(json);
    all = all.concat(chunk);
    if (chunk.length < pageSize) break;
    skip += pageSize;
  }
  return all;
}

/* Список счетов — БЕЗ расшифровки Ответственного/Контрагента в массовом запросе.
   Раньше пробовали $expand=Ответственный,Контрагент сразу на всех ~2670 счетах —
   даже с уменьшенными страницами (100) и увеличенным таймаутом (60 сек) сервер
   1С не успевал ответить ("таймаут запроса"). Расшифровка нужна только для
   активных (не отгруженных/не удалённых) счетов, и делается она теперь без
   $expand вообще — см. fetchRefCatalogMap() и его использование в refresh(). */
async function fetchInvoices(filter) {
  const rows = await fetchEntitySet("Document_СчетНаОплатуПокупателю", { filter, pageSize: 300 });
  return { rows };
}

/* Расшифровка Ответственного/Контрагента БЕЗ $expand.
   Этот сервер 1С отвечает "HTTP 501: Опция $expand не поддерживается при
   запросе одиночных сущностей" даже при запросе ОДНОГО счёта по GUID — то есть
   $expand тут не работает вообще никак (ни массово, ни по одному), это не
   таймаут и не временный сбой, а особенность конкретной публикации OData.
   Поэтому расшифровку делаем иначе, тем же надёжным способом, который уже
   работает для товаров (см. nomMap ниже): 1С всегда отдаёт рядом со ссылочным
   полем его обычный GUID с суффиксом "_Key" (Ответственный_Key, Контрагент_Key)
   — даже без $expand. Достаточно один раз выгрузить справочник целиком
   (Catalog_Пользователи / Catalog_Контрагенты) и сопоставить по этому GUID —
   без единого дополнительного запроса на каждый счёт, без риска таймаута. */
async function fetchRefCatalogMap(candidateEntityNames, selectFields) {
  let lastError = null;
  for (const entityName of candidateEntityNames) {
    try {
      const rows = await fetchEntitySet(entityName, {
        select: selectFields || "Ref_Key,Description",
        pageSize: 1000,
      });
      const map = new Map();
      rows.forEach((r) => {
        if (r.Ref_Key) map.set(String(r.Ref_Key).toLowerCase(), r.Description || r.Code || "");
      });
      return { map, usedEntity: entityName, rowCount: rows.length, error: null };
    } catch (e) {
      lastError = "[" + entityName + "] " + e.message;
    }
  }
  return {
    map: new Map(),
    usedEntity: null,
    rowCount: 0,
    error: candidateEntityNames.length > 1
      ? "ни один справочник не сработал (" + candidateEntityNames.join(", ") + "): " + lastError
      : lastError,
  };
}

/* Товарные позиции одного счёта — табличная часть документа недоступна через
   $expand на этом сервере (это коллекция), поэтому обращаемся к ней напрямую по
   адресу вида Document_СчетНаОплатуПокупателю(guid'...')/Товары — это стандартный
   способ OData для доступа к коллекции конкретного документа.
   Поле "Номенклатура" внутри каждой строки товара — это уже одиночная ссылка
   (не коллекция), поэтому для неё $expand работает — запрашиваем её сразу,
   чтобы получить название товара без отдельного похода в справочник
   Catalog_Номенклатура. */
async function fetchTovaryForInvoice(refKey, expand) {
  const params = { "$format": "json" };
  if (expand) params["$expand"] = expand;
  const url =
    baseUrl() +
    "Document_СчетНаОплатуПокупателю(guid'" + refKey + "')/Товары?" +
    buildQuery(params);
  let json;
  try {
    json = await httpGetJSON(url);
  } catch (e) {
    throw new Error("[Товары счёта " + refKey + "] " + e.message);
  }
  return extractArray(json);
}

/* Проверяем один раз (на первом активном счёте), можно ли расширить строку товара
   ссылкой на Номенклатуру — если сервер ответит ошибкой про $expand, дальше для
   всех счетов запрашиваем без него (и используем только справочник как раньше). */
async function detectTovaryExpand(sampleRefKey) {
  if (!sampleRefKey) return null;
  try {
    await fetchTovaryForInvoice(sampleRefKey, "Номенклатура");
    return "Номенклатура";
  } catch (e) {
    return null;
  }
}

/* Справочник "Характеристики номенклатуры" — отдельный каталог для вариантов
   товара (вкус/объём и т.п.), стандартный для конфигураций 1С с включёнными
   характеристиками. Строка товара в счёте может ссылаться именно на
   характеристику, а не на сам товар — тогда ни Catalog_Номенклатура, ни
   $expand=Номенклатура для такой строки ничего не находят (это ссылка на
   другой тип объекта). Пробуем получить этот справочник отдельно; если его на
   этом сервере нет/он называется иначе — просто продолжаем без него, это
   запасной путь, а не обязательный шаг. */
async function fetchCharacteristics() {
  try {
    const rows = await fetchEntitySet("Catalog_ХарактеристикиНоменклатуры", {
      select: "Ref_Key,Description,Владелец_Key",
      pageSize: 500,
    });
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: e.message };
  }
}

/* Прямой запрос одной записи справочника по её GUID — самый надёжный способ
   проверить, существует ли запись вообще и под каким именно набором сущностей
   она видна. Используем как диагностику для "необъяснимых" GUID товаров, у
   которых не сработали ни $expand, ни поиск по справочнику Catalog_Номенклатура. */
async function fetchSingleEntity(entityName, key) {
  if (!key) return { found: false, error: "пустой ключ" };
  const url = baseUrl() + entityName + "(guid'" + key + "')?" + buildQuery({ "$format": "json" });
  try {
    const json = await httpGetJSON(url, 15000);
    return { found: true, data: json, error: null };
  } catch (e) {
    return { found: false, data: null, error: e.message };
  }
}

/* Параллельная обработка с ограничением одновременных запросов — чтобы не
   перегружать сервер 1С при большом числе счетов. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
    }
  }
  const workers = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/* ---------------- преобразование счёта в order + items (формат engine.js) ---------------- */
function buildOrderAndItems(inv, tovaryRows, nomMap, charMap, respMap, contrMap, diag) {
  const number = String(inv.Number || "").trim();
  const date = inv.Date ? new Date(inv.Date) : null;
  const sum = parseFloat(inv.СуммаДокумента) || 0;
  // Сначала смотрим на расширенный объект (на случай если когда-нибудь $expand
  // заработает), а если его нет — берём имя из справочника по "_Key"-полю,
  // которое 1С отдаёт всегда, независимо от $expand (см. fetchRefCatalogMap).
  const resp =
    (inv.Ответственный && (inv.Ответственный.Description || inv.Ответственный.Code)) ||
    (inv.Ответственный_Key ? respMap.get(String(inv.Ответственный_Key).toLowerCase()) : "") ||
    "";
  const contr =
    (inv.Контрагент && (inv.Контрагент.Description || inv.Контрагент.Code)) ||
    (inv.Контрагент_Key ? contrMap.get(String(inv.Контрагент_Key).toLowerCase()) : "") ||
    "";
  const com = inv.Комментарий || "";

  const order = {
    number,
    date: date ? date.toISOString() : null,
    sum,
    status: "", // отгруженные счета уже отфильтрованы выше — этот заказ активен
    contr,
    resp,
    com,
  };

  const items = [];
  const rows = Array.isArray(tovaryRows) ? tovaryRows : [];
  rows.forEach((row) => {
    const qty = parseFloat(row.Количество) || 0;
    if (!qty) return;
    let name = (row.Номенклатура && row.Номенклатура.Description) || "";
    // Сравниваем GUID без учёта регистра букв — 1С не всегда отдаёт их в одном
    // и том же регистре в разных наборах данных (справочник vs табличная часть).
    if (!name && row.Номенклатура_Key) name = nomMap.get(String(row.Номенклатура_Key).toLowerCase()) || "";
    // Запасной путь: строка может ссылаться на характеристику (вариант товара),
    // а не на сам товар — пробуем найти имя там (см. fetchCharacteristics выше).
    if (!name && row.Номенклатура_Key) name = charMap.get(String(row.Номенклатура_Key).toLowerCase()) || "";
    if (!name) {
      name = "Неизвестная позиция (" + (row.Номенклатура_Key || "?") + ")";
      // Запоминаем "живой" пример нераспознанной строки (один раз) — чтобы по
      // одному скриншоту понять, как именно 1С называет это поле на самом деле
      // (вдруг это не Номенклатура, а Характеристика/другой тип ссылки).
      if (diag && !diag.unresolvedSample) diag.unresolvedSample = row;
    }
    items.push({ order: number, product: name, qty });
  });

  return { order, items };
}

/* ---------------- основной синк ---------------- */
async function refresh() {
  if (!oneCPassword()) {
    throw new Error("Не задан пароль 1С: установите переменную окружения ONEC_PASSWORD в настройках Render");
  }

  const year = new Date().getFullYear();
  const dateFrom = "datetime'" + year + "-01-01T00:00:00'";
  // У Александра склад делает отгрузку и сразу создаёт документ "Реализация",
  // но НЕ проводит его — бухгалтерия проводит реализации позже, пост-фактум,
  // при закрытии месяца. Значит факт отгрузки = существование документа
  // "Реализация" с такой-то датой/основанием, а не его статус Posted.
  // Поэтому ни для счетов, ни для реализаций мы не фильтруем по Posted —
  // только по дате.
  const ordersFilter = "Date ge " + dateFrom;
  const realizFilter = "Date ge " + dateFrom;

  const { rows: invoicesAll } = await fetchInvoices(ordersFilter);
  console.log("[1C] счета получены, строк: " + invoicesAll.length);

  const realizations = await fetchEntitySet("Document_РеализацияТоваровУслуг", {
    filter: realizFilter,
    select: "ДокументОснование,ДокументОснование_Type",
  });

  const nomRows = await fetchEntitySet("Catalog_Номенклатура", {
    select: "Ref_Key,Description",
    pageSize: 500,
  });

  const nomMap = new Map();
  nomRows.forEach((r) => { if (r.Ref_Key) nomMap.set(String(r.Ref_Key).toLowerCase(), r.Description || ""); });

  // Запасной справочник для строк товара, которые ссылаются на характеристику
  // (вариант товара), а не на сам товар напрямую — см. fetchCharacteristics().
  const { rows: charRows, error: charFetchError } = await fetchCharacteristics();
  const charMap = new Map();
  charRows.forEach((r) => {
    if (!r.Ref_Key) return;
    const ownerName = r.Владелец_Key ? nomMap.get(String(r.Владелец_Key).toLowerCase()) : "";
    const desc = r.Description || "";
    const full = ownerName ? ownerName + " - " + desc : desc;
    if (full) charMap.set(String(r.Ref_Key).toLowerCase(), full);
  });

  // Множество Ref_Key счетов, на основании которых уже сделана отгрузка (Реализация),
  // независимо от того, проведена ли реализация — см. комментарий выше про dateFrom.
  const shippedSet = new Set();
  realizations.forEach((r) => { if (r.ДокументОснование) shippedSet.add(String(r.ДокументОснование)); });

  // Активные (не удалённые, не отгруженные) счета — только для них имеет смысл
  // тянуть товарные позиции отдельным запросом. Считаем причины отсева отдельно —
  // это видно в статусе синхронизации и помогает понять, на каком шаге пропали заказы.
  let skippedDeleted = 0;
  let skippedShipped = 0;
  let skippedNoNumber = 0;
  const activeInvoices = invoicesAll.filter((inv) => {
    if (inv.DeletionMark) { skippedDeleted++; return false; }
    if (inv.Ref_Key && shippedSet.has(String(inv.Ref_Key))) { skippedShipped++; return false; }
    if (!String(inv.Number || "").trim()) { skippedNoNumber++; return false; }
    return true;
  });

  // Расшифровка Ответственного/Контрагента — через справочники, без $expand
  // (см. комментарий в fetchRefCatalogMap выше: $expand на этом сервере не
  // работает даже по одному счёту). Без неё engine.js не сможет определить
  // категорию "Гос закуп" (она зависит от поля "Ответственный").
  // "Пользователи" — стандартный системный справочник почти в любой конфигурации
  // 1С, поэтому он первый кандидат; "ФизическиеЛица"/"Сотрудники" — запасные
  // варианты на случай, если "Ответственный" в этой конфигурации ссылается на
  // другой тип справочника.
  const respCatalog = await fetchRefCatalogMap(["Catalog_Пользователи", "Catalog_ФизическиеЛица", "Catalog_Сотрудники"]);
  // "Контрагенты" — стандартный справочник для покупателей/поставщиков, должен
  // быть в любой конфигурации 1С:Бухгалтерия.
  const contrCatalog = await fetchRefCatalogMap(["Catalog_Контрагенты"]);

  const tovaryExpand = await detectTovaryExpand(activeInvoices[0] && activeInvoices[0].Ref_Key);

  const tovaryResults = await mapWithConcurrency(activeInvoices, 4, (inv) =>
    fetchTovaryForInvoice(inv.Ref_Key, tovaryExpand)
  );

  let tovaryFailCount = 0;
  let firstTovaryError = null;
  const ordersRaw = [];
  let itemsRaw = [];
  const diag = { unresolvedSample: null };

  activeInvoices.forEach((inv, i) => {
    const res = tovaryResults[i];
    let rows = [];
    if (res.ok) {
      rows = res.value;
    } else {
      tovaryFailCount++;
      if (!firstTovaryError) firstTovaryError = res.error.message;
    }
    const built = buildOrderAndItems(inv, rows, nomMap, charMap, respCatalog.map, contrCatalog.map, diag);
    ordersRaw.push(built.order);
    itemsRaw = itemsRaw.concat(built.items);
  });

  // Диагностика категоризации "Гос закуп": engine.js относит заказ к "гос" только
  // если в поле "Ответственный" встречается ключевое слово — если расшифровка
  // Ответственного не пришла, это поле у всех заказов будет пустым, и ВСЕ заказы
  // провалятся в "Прочие заказы" независимо от реального распределения. Считаем,
  // у скольких заказов оно пустое, и берём пару примеров непустых значений —
  // видно по одному скриншоту, есть ли тут проблема.
  const respEmptyCount = ordersRaw.filter((o) => !o.resp).length;
  const respSample = ordersRaw.filter((o) => o.resp).slice(0, 2).map((o) => o.resp).join(" | ");

  // Если товары не удалось получить ВООБЩЕ ни для одного счёта — это не частный
  // сбой, а системная проблема (например, и этот способ доступа недоступен на
  // сервере) — план производства без единиц товара бессмысленен, поэтому в этом
  // случае явно сообщаем об ошибке, а не сохраняем "пустой" план молча.
  if (activeInvoices.length > 0 && tovaryFailCount === activeInvoices.length) {
    throw new Error("не удалось получить товары ни для одного счёта — последняя ошибка: " + firstTovaryError);
  }

  const unknownItemsCount = itemsRaw.filter((it) => /^Неизвестная позиция/.test(it.product)).length;

  // Точечная диагностика: пробуем прямым запросом по GUID найти ровно тот
  // товар, который не нашёлся ни через $expand, ни через справочник —
  // ответ сервера (найден/не найден/ошибка) даёт точный ответ, а не догадку.
  let directLookup = null;
  if (diag.unresolvedSample && diag.unresolvedSample.Номенклатура_Key) {
    const key = diag.unresolvedSample.Номенклатура_Key;
    const res = await fetchSingleEntity("Catalog_Номенклатура", key);
    directLookup = {
      key,
      found: res.found,
      error: res.error ? String(res.error).slice(0, 300) : null,
      data: res.data ? JSON.stringify(res.data).slice(0, 600) : null,
    };
  }

  const meta = {
    source: "1c",
    lastSyncAt: new Date().toISOString(),
    lastSyncOk: true,
    lastSyncError: tovaryFailCount > 0 ? ("товары не получены для " + tovaryFailCount + " счёт(ов): " + firstTovaryError) : null,
    ordersCount: ordersRaw.length,
    itemsCount: itemsRaw.length,
    skippedShipped,
    expandUsed: respCatalog.usedEntity,
    // диагностика — чтобы по одному скриншоту понять, на каком шаге пропали заказы
    // или не распознались наименования товаров
    debug: {
      totalFetched: invoicesAll.length,
      skippedDeleted,
      skippedShipped,
      skippedNoNumber,
      realizCount: realizations.length,
      shippedSetSize: shippedSet.size,
      filter: ordersFilter,
      nomCount: nomRows.length,
      unknownItemsCount,
      tovaryExpand,
      respEmptyCount,
      respSample,
      respCatalogUsed: respCatalog.usedEntity,
      respCatalogSize: respCatalog.rowCount,
      respCatalogError: respCatalog.error ? String(respCatalog.error).slice(0, 300) : null,
      contrCatalogUsed: contrCatalog.usedEntity,
      contrCatalogSize: contrCatalog.rowCount,
      contrCatalogError: contrCatalog.error ? String(contrCatalog.error).slice(0, 300) : null,
      charCount: charRows.length,
      charFetchError: charFetchError ? String(charFetchError).slice(0, 300) : null,
      unresolvedSampleJson: diag.unresolvedSample ? JSON.stringify(diag.unresolvedSample).slice(0, 400) : null,
      directLookup,
    },
  };

  store.patchState({ ordersRaw, itemsRaw, meta });
  return meta;
}

/* Обёртка, которая никогда не выбрасывает исключение наружу — чтобы плановый
   запуск по таймеру не мог уронить сервер, а ошибку видно через /api/state.meta. */
async function refreshSafe() {
  try {
    const meta = await refresh();
    console.log("[1C] синк ок: заказов " + meta.ordersCount + ", позиций " + meta.itemsCount + (meta.skippedShipped ? (", уже отгружено " + meta.skippedShipped) : ""));
    telegram.notifyIfChanged(store, "onec", "План производства (1С)", meta.lastSyncError || null)
      .catch((e) => console.error("[telegram] notifyIfChanged упал: " + e.message));
    return { ok: true, meta };
  } catch (e) {
    console.error("[1C] синк упал: " + e.message);
    const prevMeta = store.readState().meta || {};
    const meta = Object.assign({}, prevMeta, {
      source: "1c",
      lastSyncAt: new Date().toISOString(),
      lastSyncOk: false,
      lastSyncError: e.message,
    });
    store.patchState({ meta });
    telegram.notifyIfChanged(store, "onec", "План производства (1С)", e.message)
      .catch((te) => console.error("[telegram] notifyIfChanged упал: " + te.message));
    return { ok: false, error: e.message };
  }
}

/* ---------------- запись (создание Реализации для заказов Kaspi) ----------------
   Стандартный OData 1С поддерживает создание записи через POST на сам набор
   сущностей (Document_РеализацияТоваровУслуг) с телом нового документа —
   сервер возвращает созданную запись (Ref_Key, Number).
   Названия некоторых реквизитов в этой конфигурации не подтверждены живым
   тестом (в песочнице нет сети до uchet.kz) — поэтому там, где есть
   неопределённость (поле "Структурная единица"), пробуем по очереди несколько
   вариантов имени и ориентируемся на ответ сервера. Остальные поля
   (Контрагент_Key/Договор_Key/Склад_Key/Комментарий/табличная часть "Товары")
   — стандартные для этого типа документа в любой конфигурации 1С:Бухгалтерия. */
function httpWriteJSON(method, fullUrl, bodyObj, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(fullUrl);
    } catch (e) {
      return reject(new Error("некорректный адрес — " + fullUrl));
    }
    const payload = Buffer.from(JSON.stringify(bodyObj), "utf8");
    const auth = Buffer.from(oneCUser() + ":" + oneCPassword()).toString("base64");
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ""),
      method: method,
      headers: {
        Authorization: "Basic " + auth,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": payload.length,
      },
      timeout: timeoutMs || 30000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error("доступ запрещён (" + res.statusCode + ") — проверьте ONEC_USER/ONEC_PASSWORD"));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("HTTP " + res.statusCode + ": " + raw.slice(0, 500)));
        }
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error("ответ не в формате JSON: " + raw.slice(0, 300)));
        }
      });
    });
    req.on("error", (e) => reject(new Error(e.message)));
    req.on("timeout", () => req.destroy(new Error("таймаут запроса")));
    req.write(payload);
    req.end();
  });
}

/* Диагностика: сырой $metadata (XML) — чтобы один раз посмотреть настоящие
   имена реквизитов документа, а не угадывать их. Без модуля для разбора XML —
   ищем регулярным выражением (формат $metadata предсказуем по структуре тегов). */
function httpGetTextWithAuth(fullUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(fullUrl);
    } catch (e) {
      return reject(new Error("некорректный адрес — " + fullUrl));
    }
    const auth = Buffer.from(oneCUser() + ":" + oneCPassword()).toString("base64");
    const options = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ""),
      method: "GET",
      headers: { Authorization: "Basic " + auth, Accept: "application/xml" },
      timeout: timeoutMs || 30000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("HTTP " + res.statusCode + ": " + raw.slice(0, 300)));
        }
        resolve(raw);
      });
    });
    req.on("error", (e) => reject(new Error(e.message)));
    req.on("timeout", () => req.destroy(new Error("таймаут запроса")));
    req.end();
  });
}

async function fetchMetadataFragment(entityTypeNameSubstring, maxLen) {
  const xml = await httpGetTextWithAuth(baseUrl() + "$metadata", 30000);
  const re = new RegExp("<EntityType Name=\"[^\"]*" + entityTypeNameSubstring + "[^\"]*\"[\\s\\S]*?</EntityType>", "i");
  const m = xml.match(re);
  if (!m) return { found: false, fragment: null, propertyNames: [] };
  const fragment = m[0];
  const propRe = /<(?:Property|NavigationProperty) Name="([^"]+)"/g;
  const names = [];
  let pm;
  while ((pm = propRe.exec(fragment))) names.push(pm[1]);
  return { found: true, fragment: fragment.slice(0, maxLen || 6000), propertyNames: names };
}

function norm1C(s) {
  return String(s || "").trim().toLowerCase();
}

/* Поиск элемента справочника по точному названию (Description) — без GUID,
   заданных вручную. Перебирает несколько вариантов имени набора сущностей,
   как и fetchRefCatalogMap. Если задан ownerKeyFilter — среди совпадений по
   названию предпочитает строку с этим Владелец_Key (нужно для "Договор",
   который ищется внутри конкретного контрагента). */
async function resolveRefByName(candidateEntityNames, targetName, opts) {
  opts = opts || {};
  const wanted = norm1C(targetName);
  let lastError = null;
  for (const entityName of candidateEntityNames) {
    try {
      const rows = await fetchEntitySet(entityName, {
        select: opts.selectFields || "Ref_Key,Description,Владелец_Key",
        pageSize: 1000,
      });
      const matches = rows.filter((r) => norm1C(r.Description) === wanted);
      if (matches.length === 0) {
        lastError = "[" + entityName + "] нет записи с названием «" + targetName + "» (всего строк: " + rows.length + ")";
        continue;
      }
      let row = matches[0];
      if (opts.ownerKeyFilter && matches.length > 1) {
        const preferred = matches.find(
          (r) => r.Владелец_Key && String(r.Владелец_Key).toLowerCase() === String(opts.ownerKeyFilter).toLowerCase()
        );
        if (preferred) row = preferred;
      }
      return { ref: row.Ref_Key, usedEntity: entityName, matchCount: matches.length, error: null };
    } catch (e) {
      lastError = "[" + entityName + "] " + e.message;
    }
  }
  return { ref: null, usedEntity: null, matchCount: 0, error: lastError };
}

// Карта "название товара в 1С" -> Ref_Key — чтобы переносить заказы Kaspi,
// сопоставляя по точному названию из таблицы соответствия (mappingTable.js),
// без необходимости вручную прописывать GUID каждого товара.
async function fetchNomenclatureByNameMap() {
  const rows = await fetchEntitySet("Catalog_Номенклатура", { select: "Ref_Key,Description", pageSize: 500 });
  const map = new Map();
  rows.forEach((r) => {
    if (r.Ref_Key && r.Description) map.set(norm1C(r.Description), r.Ref_Key);
  });
  return map;
}

/* Создаёт документ "Реализация товаров и услуг" по заказу Kaspi.
   Структурная единица/Контрагент/Договор/Склад/Ответственный — одинаковые для
   всех заказов Kaspi (подтверждено Александром), их Ref_Key резолвятся один
   раз за весь запуск переноса (см. kaspiTransfer.js) и передаются сюда готовыми.
   tryPost=true: сначала пробуем создать СРАЗУ проведённым (как Александр делает
   вручную). Если 1С откажется проводить (например, не хватает остатка товара
   на складе) — создаём тот же документ непроведённым: это ожидаемая, штатная
   ситуация, бухгалтерия проведёт вручную позже (подтверждено Александром). */
const ORG_FIELD_CANDIDATES = ["СтруктурнаяЕдиница_Key", "Организация_Key"];

function looksLikeUnknownFieldError(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.indexOf("не найдено свойство") !== -1 ||
    m.indexOf("свойство не найдено") !== -1 ||
    m.indexOf("не существует свойств") !== -1 ||
    m.indexOf("invalid property") !== -1 ||
    m.indexOf("unknown property") !== -1 ||
    m.indexOf("http 400") !== -1
  );
}

async function createRealizationDocument(opts) {
  if (!oneCPassword()) {
    throw new Error("Не задан пароль 1С: установите переменную окружения ONEC_PASSWORD в настройках Render");
  }
  const { orgRef, contrRef, dogovorRef, skladRef, respRef, comment, dateIso, lines, tryPost } = opts;

  function buildBody(orgFieldName, posted) {
    const body = {
      Date: dateIso,
      Комментарий: comment || "",
      Контрагент_Key: contrRef,
      Договор_Key: dogovorRef,
      Склад_Key: skladRef,
      Ответственный_Key: respRef,
      Posted: !!posted,
      Товары: (lines || []).map((l) => ({
        Номенклатура_Key: l.nomKey,
        Количество: l.qty,
        Цена: l.price,
        Сумма: Math.round(l.qty * l.price * 100) / 100,
      })),
    };
    body[orgFieldName] = orgRef;
    return body;
  }

  async function attempt(posted) {
    let lastErr = null;
    for (const fieldName of ORG_FIELD_CANDIDATES) {
      const body = buildBody(fieldName, posted);
      try {
        const json = await httpWriteJSON("POST", baseUrl() + "Document_РеализацияТоваровУслуг", body, 30000);
        return { raw: json, orgFieldUsed: fieldName };
      } catch (e) {
        lastErr = e;
        if (!looksLikeUnknownFieldError(e.message)) throw e; // другая проблема — дальше не перебираем
      }
    }
    throw lastErr || new Error("не удалось создать документ — нет подходящего варианта имени поля");
  }

  if (tryPost) {
    try {
      const res = await attempt(true);
      return {
        posted: true,
        ref: res.raw && res.raw.Ref_Key,
        number: res.raw && res.raw.Number,
        orgFieldUsed: res.orgFieldUsed,
        fallback: false,
      };
    } catch (e) {
      console.warn("[1C] не удалось создать Реализацию проведённой (" + e.message + ") — пробуем непроведённой");
    }
  }

  const res2 = await attempt(false);
  return {
    posted: false,
    ref: res2.raw && res2.raw.Ref_Key,
    number: res2.raw && res2.raw.Number,
    orgFieldUsed: res2.orgFieldUsed,
    fallback: !!tryPost,
  };
}

module.exports = {
  refresh,
  refreshSafe,
  fetchMetadataFragment,
  resolveRefByName,
  fetchNomenclatureByNameMap,
  createRealizationDocument,
};
