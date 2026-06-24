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
function httpGetJSON(fullUrl) {
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
      timeout: 30000,
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

/* Постранично выгружает весь набор сущностей (1С может ограничивать страницу). */
async function fetchEntitySet(entityName, opts) {
  opts = opts || {};
  const pageSize = opts.pageSize || 300;
  const guardMaxPages = 100; // защита от бесконечного цикла при неожиданном ответе сервера
  let all = [];
  let skip = 0;
  for (let page = 0; page < guardMaxPages; page++) {
    const params = { "$format": "json", "$top": pageSize, "$skip": skip };
    if (opts.filter) params["$filter"] = opts.filter;
    if (opts.expand) params["$expand"] = opts.expand;
    if (opts.select) params["$select"] = opts.select;
    const full = baseUrl() + entityName + "?" + buildQuery(params);
    let json;
    try {
      json = await httpGetJSON(full);
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

/* Список счетов: пробуем получить с расшифровкой Ответственного/Контрагента (для
   категоризации "Госзакуп" и т.п.), но это не критично — если сервер откажет и тут
   (например, эти поля тоже окажутся "составными"), просто берём счета без них:
   план производства всё равно посчитается, только разбивка по категориям пострадает. */
async function fetchInvoices(filter) {
  // Сначала пробуем расширить оба поля сразу — самый быстрый путь.
  try {
    const rows = await fetchEntitySet("Document_СчетНаОплатуПокупателю", {
      filter,
      expand: "Ответственный,Контрагент",
    });
    return { rows, expandUsed: "Ответственный,Контрагент", expandError: null };
  } catch (eBoth) {
    if (!/expand/i.test(eBoth.message)) throw eBoth;
    // Не получилось расширить оба сразу — возможно, дело в одном из двух полей
    // (например, у него на этом сервере составной/нестандартный тип ссылки).
    // "Ответственный" нам важнее (от него зависит категория "Гос закуп" в
    // engine.js), поэтому пробуем его отдельно, прежде чем сдаваться полностью.
    try {
      const rows = await fetchEntitySet("Document_СчетНаОплатуПокупателю", {
        filter,
        expand: "Ответственный",
      });
      return { rows, expandUsed: "Ответственный", expandError: eBoth.message };
    } catch (eResp) {
      try {
        const rows = await fetchEntitySet("Document_СчетНаОплатуПокупателю", {
          filter,
          expand: "Контрагент",
        });
        return { rows, expandUsed: "Контрагент", expandError: eBoth.message };
      } catch (eContr) {
        const rows = await fetchEntitySet("Document_СчетНаОплатуПокупателю", { filter });
        return { rows, expandUsed: null, expandError: eBoth.message };
      }
    }
  }
}

/* Товарные позиции одного счёта — табличная часть документа недоступна через
   $expand на этом сервере (это коллекция), поэтому обращаемся к ней напрямую по
   адресу вида Document_СчетНаОплатуПокупателю(guid'...')/Товары — это стандартный
   способ OData для доступа к коллекции конкретного документа.
   Поле "Номенклатура" внутри каждой строки товара — это уже одиночная ссылка
   (не коллекция), поэтому для неё $expand работает (мы это проверили раньше на
   полях Ответственный/Контрагент счёта) — запрашиваем её сразу, чтобы получить
   название товара без отдельного похода в справочник Catalog_Номенклатура. */
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
function buildOrderAndItems(inv, tovaryRows, nomMap, charMap, diag) {
  const number = String(inv.Number || "").trim();
  const date = inv.Date ? new Date(inv.Date) : null;
  const sum = parseFloat(inv.СуммаДокумента) || 0;
  const resp = (inv.Ответственный && (inv.Ответственный.Description || inv.Ответственный.Code)) || "";
  const contr = (inv.Контрагент && (inv.Контрагент.Description || inv.Контрагент.Code)) || "";
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

  const { rows: invoicesAll, expandUsed, expandError } = await fetchInvoices(ordersFilter);
  console.log("[1C] счета получены, $expand=" + (expandUsed || "(без expand)") + ", строк: " + invoicesAll.length);

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
    const built = buildOrderAndItems(inv, rows, nomMap, charMap, diag);
    ordersRaw.push(built.order);
    itemsRaw = itemsRaw.concat(built.items);
  });

  // Диагностика категоризации "Гос закуп": engine.js относит заказ к "гос" только
  // если в поле "Ответственный" встречается ключевое слово — если расшифровка
  // Ответственного не пришла (см. expandUsed выше), это поле у всех заказов будет
  // пустым, и ВСЕ заказы провалятся в "Прочие заказы" независимо от реального
  // распределения. Считаем, у скольких заказов оно пустое, и берём пару примеров
  // непустых значений — видно по одному скриншоту, есть ли тут проблема.
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

  const meta = {
    source: "1c",
    lastSyncAt: new Date().toISOString(),
    lastSyncOk: true,
    lastSyncError: tovaryFailCount > 0 ? ("товары не получены для " + tovaryFailCount + " счёт(ов): " + firstTovaryError) : null,
    ordersCount: ordersRaw.length,
    itemsCount: itemsRaw.length,
    skippedShipped,
    expandUsed,
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
      invoiceExpandError: expandError ? String(expandError).slice(0, 300) : null,
      charCount: charRows.length,
      charFetchError: charFetchError ? String(charFetchError).slice(0, 300) : null,
      unresolvedSampleJson: diag.unresolvedSample ? JSON.stringify(diag.unresolvedSample).slice(0, 400) : null,
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
    return { ok: false, error: e.message };
  }
}

module.exports = { refresh, refreshSafe };
