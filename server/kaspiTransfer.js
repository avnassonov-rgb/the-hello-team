/* THE HELLO Team — перенос заказов Kaspi в 1С (Реализация) + продвижение
   заказа в Kaspi (Упаковка → Передача).

   Запускается планировщиком из server.js ровно в 08:00 и 13:10 по Костанаю
   (UTC+5) — НЕ постоянно (см. server.js). Можно запускать вручную через
   /api/kaspi-transfer/run.

   Что делает один запуск:
   1. Грузит таблицу соответствия Kaspi-код → товар(ы) 1С (mappingTable.js).
   2. Один раз резолвит 4 постоянных реквизита документа "Реализация"
      (Структурная единица/Контрагент/Договор/Склад) + Ответственного —
      они одинаковые для всех заказов Kaspi (подтверждено Александром).
   3. Берёт из Kaspi заказы в стадии "Упаковка" (см. KASPI_TRANSFER_STATES),
      пропускает уже обработанные (store.isKaspiOrderProcessed).
   4. Для каждого нового заказа: состав → коды товаров → таблица соответствия
      → название(я) в 1С → Ref_Key через справочник номенклатуры → создаёт
      Реализацию (сразу проведённую, если получится; иначе непроведённую —
      это нормально, бухгалтерия проведёт вручную позже).
   5. Если документ создан — продвигает заказ в Kaspi (ASSEMBLE), отмечает
      заказ обработанным (чтобы не создать вторую Реализацию при следующем
      запуске), даже если продвижение в Kaspi не получилось (это отдельная
      проблема — она видна в summary/Telegram, но не должна приводить к
      задвоению Реализации).
   Любая ошибка по конкретному заказу не останавливает обработку остальных —
   накопленный список проблем сохраняется в store и уходит в Telegram, если
   изменился относительно предыдущего запуска. */
"use strict";
const kaspi = require("./kaspi");
const oneC = require("./oneC");
const mappingTable = require("./mappingTable");
const priceTable = require("./priceTable");
const store = require("./store");
const telegram = require("./telegram");

function norm(s) {
  return String(s || "").trim().toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statesFromEnv() {
  const raw = process.env.KASPI_TRANSFER_STATES || "PICKUP,DELIVERY,KASPI_DELIVERY";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function statusFromEnv() {
  return process.env.KASPI_TRANSFER_STATUS || "ACCEPTED_BY_MERCHANT";
}

const ORG_CATALOG_CANDIDATES = ["Catalog_СтруктурныеЕдиницы", "Catalog_Организации"];
const ORG_NAME = process.env.KASPI_TRANSFER_ORG_NAME || "ИП Канапин А.Б.";

const CONTR_CATALOG_CANDIDATES = ["Catalog_Контрагенты"];
const CONTR_NAME = process.env.KASPI_TRANSFER_CONTR_NAME || "Розничная выручка";

const DOGOVOR_CATALOG_CANDIDATES = ["Catalog_ДоговорыКонтрагентов", "Catalog_Договоры"];
const DOGOVOR_NAME = process.env.KASPI_TRANSFER_DOGOVOR_NAME || "БД";

const SKLAD_CATALOG_CANDIDATES = ["Catalog_Склады"];
const SKLAD_NAME = process.env.KASPI_TRANSFER_SKLAD_NAME || "Основной склад (г. Костанай)";

const RESP_CATALOG_CANDIDATES = ["Catalog_Пользователи", "Catalog_ФизическиеЛица", "Catalog_Сотрудники"];
const RESP_NAME_CANDIDATES = process.env.KASPI_TRANSFER_RESP_NAME
  ? [process.env.KASPI_TRANSFER_RESP_NAME]
  : ["Каспи Магазин"];

async function resolveFixedRefs() {
  const problems = [];

  const org = await oneC.resolveRefByName(ORG_CATALOG_CANDIDATES, ORG_NAME);
  if (!org.ref) problems.push("Структурная единица «" + ORG_NAME + "» не найдена: " + org.error);

  const contr = await oneC.resolveRefByName(CONTR_CATALOG_CANDIDATES, CONTR_NAME);
  if (!contr.ref) problems.push("Контрагент «" + CONTR_NAME + "» не найден: " + contr.error);

  const dogovor = await oneC.resolveRefByName(DOGOVOR_CATALOG_CANDIDATES, DOGOVOR_NAME, {
    ownerKeyFilter: contr.ref || null,
  });
  if (!dogovor.ref) problems.push("Договор «" + DOGOVOR_NAME + "» не найден: " + dogovor.error);

  const sklad = await oneC.resolveRefByName(SKLAD_CATALOG_CANDIDATES, SKLAD_NAME);
  if (!sklad.ref) problems.push("Склад «" + SKLAD_NAME + "» не найден: " + sklad.error);

  let resp = { ref: null, error: null };
  for (const name of RESP_NAME_CANDIDATES) {
    resp = await oneC.resolveRefByName(RESP_CATALOG_CANDIDATES, name);
    if (resp.ref) break;
  }
  if (!resp.ref) problems.push("Ответственный «" + RESP_NAME_CANDIDATES.join(" / ") + "» не найден: " + resp.error);

  return {
    orgRef: org.ref,
    contrRef: contr.ref,
    dogovorRef: dogovor.ref,
    skladRef: sklad.ref,
    respRef: resp.ref,
    problems,
  };
}

function kostanayIsoNow() {
  const KOSTANAY_OFFSET_MIN = 5 * 60;
  const nowUtcMs = Date.now();
  const local = new Date(nowUtcMs + KOSTANAY_OFFSET_MIN * 60000);
  return local.toISOString().slice(0, 19);
}

async function loadOrderLines(orderId) {
  const entries = await kaspi.getOrderEntries(orderId);
  const lines = [];
  for (const e of entries) {
    const ea = e.attributes || {};
    const qty = parseFloat(ea.quantity) || 0;
    if (!qty) continue;
    const totalPrice = parseFloat(ea.totalPrice);
    const basePrice = parseFloat(ea.basePrice);
    const unitPrice = isFinite(totalPrice) && totalPrice > 0 ? totalPrice / qty : (isFinite(basePrice) ? basePrice : 0);
    let product = null;
    try {
      product = await kaspi.getEntryProduct(e.id);
    } catch (err) {
      lines.push({ code: null, qty, unitPrice, error: "не удалось получить товар позиции: " + err.message });
      continue;
    }
    const pa = (product && product.attributes) || {};
    lines.push({ code: pa.code || null, name: pa.name || null, qty, unitPrice, error: pa.code ? null : "у позиции нет кода товара" });
  }
  return lines;
}

function roundToIntegerSum(rawValues, target) {
  const targetInt = Math.round(target);
  const floors = rawValues.map(function (v) { return Math.floor(v); });
  let remainder = targetInt - floors.reduce(function (s, v) { return s + v; }, 0);
  const order = rawValues
    .map(function (v, i) { return { i: i, frac: v - floors[i] }; })
    .sort(function (a, b) { return b.frac - a.frac; });
  const result = floors.slice();
  for (let k = 0; k < order.length && remainder > 0; k++) {
    result[order[k].i] += 1;
    remainder--;
  }
  for (let k = order.length - 1; k >= 0 && remainder < 0; k--) {
    result[order[k].i] -= 1;
    remainder++;
  }
  return result;
}

function buildDocLines(orderLines, mappingMap, nomByName, unresolved, priceMap, nameToCode) {
  const docLines = [];
  const priceBreakdown = [];
  for (const ol of orderLines) {
    if (ol.error || !ol.code) {
      unresolved.push((ol.code ? "код " + ol.code : "позиция без кода") + ": " + (ol.error || "нет кода товара"));
      continue;
    }
    const entry = mappingMap.get(ol.code);
    if (!entry || !entry.components || entry.components.length === 0) {
      unresolved.push("код " + ol.code + " (" + (ol.name || "?") + "): нет в таблице соответствия Kaspi↔1С");
      continue;
    }
    const componentCount = entry.components.length;

    let shares = null;
    let fallbackReason = null;
    if (componentCount > 1 && priceMap && nameToCode) {
      const refPrices = entry.components.map((comp) => {
        const code = nameToCode.get(norm(comp.name1C));
        const price = code ? priceMap.get(code) : null;
        return { comp, code, price };
      });
      const missing = refPrices.filter((rp) => !(rp.price > 0));
      if (missing.length === 0) {
        const sum = refPrices.reduce((s, rp) => s + rp.price, 0);
        if (sum > 0) {
          shares = new Map();
          refPrices.forEach((rp) => shares.set(rp.comp, { refPrice: rp.price, share: rp.price / sum }));
        } else {
          fallbackReason = "сумма реальных цен компонентов равна 0";
        }
      } else {
        fallbackReason = "нет реальной цены (лист KASPI.KZ) для: " + missing.map((rp) => rp.comp.name1C).join(", ");
      }
    }

    const rawPrices = entry.components.map((comp) =>
      shares && shares.has(comp) ? ol.unitPrice * shares.get(comp).share : ol.unitPrice / componentCount
    );
    const roundedPrices = roundToIntegerSum(rawPrices, ol.unitPrice);

    let anyMissing = false;
    const lines = entry.components.map((comp, idx) => {
      const nom = nomByName.get(norm(comp.name1C));
      if (!nom || !nom.ref) anyMissing = true;
      return {
        nomKey: nom ? nom.ref : null,
        unitKey: nom ? nom.unitKey : null,
        qty: comp.qty * ol.qty,
        price: roundedPrices[idx],
        compName: comp.name1C,
      };
    });

    if (componentCount > 1) {
      priceBreakdown.push({
        kaspiCode: ol.code,
        kitUnitPrice: ol.unitPrice,
        usedProportionalSplit: !!shares,
        fallbackReason,
        components: entry.components.map((comp, idx) => ({
          name: comp.name1C,
          refPrice: shares && shares.has(comp) ? shares.get(comp).refPrice : null,
          share: shares && shares.has(comp) ? shares.get(comp).share : null,
          computedPrice: roundedPrices[idx],
        })),
      });
    }

    if (anyMissing) {
      const missingNames = lines.filter((l) => !l.nomKey).map((l) => l.compName);
      unresolved.push("код " + ol.code + ": компонент(ы) не найдены в 1С — " + missingNames.join(", "));
      continue;
    }
    lines.forEach((l) => docLines.push({ nomKey: l.nomKey, qty: l.qty, price: l.price, unitKey: l.unitKey }));
  }
  return { docLines, priceBreakdown };
}

async function fetchAndSendWaybillInBackground(orderCode, numberOfSpace) {
  const MAX_ATTEMPTS = 13;
  const DELAY_MS = 30000;
  let waybillUrl = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !waybillUrl; attempt++) {
    if (attempt > 0) await sleep(DELAY_MS);
    try {
      const raw = await kaspi.getOrderRawByCode(orderCode);
      waybillUrl = raw.found && raw.attributes && raw.attributes.kaspiDelivery && raw.attributes.kaspiDelivery.waybill;
    } catch (e) {
      // временная ошибка — пробуем ещё раз
    }
  }
  if (!waybillUrl) {
    const msg = "⚠️ Заказ №" + orderCode + ": накладная не появилась в Kaspi за " +
      Math.round((MAX_ATTEMPTS * DELAY_MS) / 60000) + " мин. Скачайте её вручную в кабинете Kaspi.";
    console.error("[kaspiTransfer] " + msg);
    await telegram.send(msg);
    return;
  }

  let pdf;
  try {
    pdf = await kaspi.downloadWaybillPdf(waybillUrl);
  } catch (e) {
    const msg = "⚠️ Заказ №" + orderCode + ": накладная найдена в Kaspi, но не скачалась (" + e.message + "). Скачайте вручную в кабинете Kaspi.";
    console.error("[kaspiTransfer] " + msg);
    await telegram.send(msg);
    return;
  }

  const warehouseChatIds = store.findEmployeeChatIdsByRole("Зав.складом");
  const caption = "Накладная — заказ №" + orderCode + ", мест: " + numberOfSpace;
  let sendResults;
  if (warehouseChatIds.length) {
    sendResults = await Promise.all(
      warehouseChatIds.map(function (chatId) {
        return telegram.sendDocument(pdf.buffer, "Накладная_" + orderCode + ".pdf", caption, { chatId: chatId });
      })
    );
  } else {
    sendResults = [await telegram.sendDocument(pdf.buffer, "Накладная_" + orderCode + ".pdf", caption)];
  }
  const failedSends = sendResults.filter((r) => !r.ok);
  if (failedSends.length) {
    console.error(
      "[kaspiTransfer] заказ №" + orderCode + ": накладная скачана, но отправлена не всем получателям (" +
      failedSends.length + " из " + sendResults.length + " не удалось) — " +
      failedSends.map((r) => r.error).join("; ")
    );
  }
  if (failedSends.length === sendResults.length) {
    await telegram.send(
      "⚠️ Заказ №" + orderCode + ": накладная скачана из Kaspi, но НЕ доставлена в Telegram (" +
      ((failedSends[0] && failedSends[0].error) || "неизвестная ошибка") +
      "). Скачайте вручную в кабинете Kaspi."
    );
  }
}

function computeNumberOfSpace(orderLines, mappingMap, detailed) {
  const FALLBACK_CAPACITY = 4;
  const byCapacity = new Map();
  const breakdown = [];
  for (const ol of orderLines) {
    if (ol.error || !ol.code) continue;
    const entry = mappingMap.get(ol.code);
    if (entry && entry.components && entry.components.length) {
      for (const comp of entry.components) {
        const capacity = comp.boxCapacity > 0 ? comp.boxCapacity : FALLBACK_CAPACITY;
        const qty = ol.qty * (comp.qty || 1);
        byCapacity.set(capacity, (byCapacity.get(capacity) || 0) + qty);
        if (detailed) breakdown.push({ component: comp.name1C, boxCapacity: capacity, qty });
      }
    } else {
      byCapacity.set(FALLBACK_CAPACITY, (byCapacity.get(FALLBACK_CAPACITY) || 0) + ol.qty);
      if (detailed) breakdown.push({ component: ol.code, boxCapacity: FALLBACK_CAPACITY, qty: ol.qty, note: "нет в таблице соответствия — вместимость по умолчанию" });
    }
  }
  let spaces = 0;
  const groups = [];
  for (const [capacity, qty] of byCapacity) {
    const groupSpaces = Math.ceil(qty / capacity);
    spaces += groupSpaces;
    if (detailed) groups.push({ boxCapacity: capacity, totalQty: qty, spaces: groupSpaces });
  }
  spaces = spaces > 0 ? spaces : 1;
  return detailed ? { spaces, breakdown, groups } : spaces;
}

async function runKaspiTransfer(options) {
  const opts = options || {};
  const dryRun = !!opts.dryRun;
  const onlyOrderCode = opts.orderId ? String(opts.orderId).trim() : null;

  const { map: mappingMap, problems: mappingProblems, nameToCode } = await mappingTable.loadMappingTable();
  const { map: priceMap, problems: priceProblems } = await priceTable.loadPriceTable();

  const fixed = await resolveFixedRefs();
  if (fixed.problems.length > 0) {
    throw new Error("не удалось определить постоянные реквизиты документа: " + fixed.problems.join("; "));
  }

  const nomByName = await oneC.fetchNomenclatureByNameMap();

  const states = statesFromEnv();
  const wantedStatus = statusFromEnv();

  let candidateOrders = [];

  // Обёртка с повторами для запросов к Kaspi: если таймаут или обрыв
  // соединения — ждём 60 сек и повторяем (до 3 попыток суммарно).
  async function kaspiWithRetry(fn) {
    const MAX_ATTEMPTS = 3;
    const RETRY_PAUSE_MS = 60 * 1000;
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        const isConnErr = /таймаут|соединени|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(e.message);
        if (!isConnErr || attempt === MAX_ATTEMPTS - 1) throw e;
        console.warn("[kaspiTransfer] Kaspi API недоступен (попытка " + (attempt + 1) + "), ждём 60 сек...");
        await sleep(RETRY_PAUSE_MS);
      }
    }
    throw lastErr;
  }

  if (onlyOrderCode) {
    try {
      const raw = await kaspiWithRetry(() => kaspi.getOrderRawByCode(onlyOrderCode));
      if (raw.found) candidateOrders.push({ id: raw.orderId, attributes: raw.attributes });
    } catch (e) {
      // не критично
    }
  } else {
    // Для автозапуска берём только последние 3 дня — предотвращает навал
    // старых заказов после паузы/редеплоя. Проверка 1С отсеет дубли.
    const scheduledSinceMs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    for (const state of states) {
      let pageNumber = 0;
      const pageSize = 100;
      for (;;) {
        const list = await kaspiWithRetry(() => kaspi.getOrders({ state, pageSize, pageNumber, sinceMs: scheduledSinceMs }));
        // Тегируем заказ состоянием очереди, из которой он пришёл.
        // Kaspi не всегда возвращает state в атрибутах — полагаемся на параметр фильтра.
        list.items.forEach((o) => candidateOrders.push(Object.assign({ _fromState: state }, o)));
        pageNumber++;
        const pageCount = list.pageCount;
        if (!list.items.length) break;
        if (pageCount != null && pageNumber >= pageCount) break;
        if (pageNumber > 30) break;
      }
    }
  }

  // Дедубликация: при постраничном обходе Kaspi один и тот же заказ может
  // попасть на две страницы (API сдвигает страницы пока идут запросы) —
  // убираем дубли по id ДО любой обработки.
  {
    const seenIds = new Set();
    candidateOrders = candidateOrders.filter((o) => {
      if (seenIds.has(o.id)) return false;
      seenIds.add(o.id);
      return true;
    });
  }

  const newOrders = candidateOrders.filter((o) => {
    const attrs = o.attributes || {};
    if (wantedStatus && attrs.status !== wantedStatus) return false;
    if (onlyOrderCode && dryRun) return true;
    return !store.isKaspiOrderProcessed(o.id);
  });

  let created = 0;
  let skippedAlready = onlyOrderCode ? 0 : candidateOrders.length - newOrders.length;
  const unresolvedOrders = [];
  const assembleFailed = [];
  const waybillFailed = [];
  const processedThisRun = [];
  const dryRunPreview = [];
  // Пауза между заказами — защита от rate limit Kaspi.
  // 4 сек x 100 заказов = ~7 мин; при 10-15 заказов/день = ~40 сек.
  const INTER_ORDER_PAUSE_MS = 4000;
  let orderIndex = 0;

  // ── Повторный ASSEMBLE для заказов из предыдущих запусков ──────────────────
  // Когда первый ASSEMBLE падает с 404, заказ уже помечен обработанным (Реализация
  // создана) и в следующие запуски не попадает в newOrders. Очередь assemblyPending
  // хранит такие заказы и позволяет повторить ASSEMBLE при следующем запуске.
  // Здесь мы пробуем повторить ТОЛЬКО если это не ручной запуск одного заказа.
  if (!onlyOrderCode && !dryRun) {
    const assemblyPending = store.getKaspiAssemblyPending();
    const pendingIds = new Set(newOrders.map((o) => o.id)); // не повторяем то, что уже в этом запуске
    for (const p of assemblyPending) {
      if (pendingIds.has(p.orderId)) continue;
      await sleep(INTER_ORDER_PAUSE_MS);
      try {
        // Проверяем, что заказ ещё в статусе "Упаковка" (ACCEPTED_BY_MERCHANT).
        // Если пользователь уже продвинул его вручную — убираем из очереди.
        const raw = await kaspiWithRetry(() => kaspi.getOrderRawByCode(p.orderCode));
        if (!raw.found) {
          store.removeFromKaspiAssemblyPending(p.orderId);
          console.log("[kaspiTransfer] повтор ASSEMBLE: заказ №" + p.orderCode + " не найден в Kaspi → убираем из очереди");
          continue;
        }
        const curStatus = raw.attributes && raw.attributes.status;
        if (curStatus !== "ACCEPTED_BY_MERCHANT") {
          store.removeFromKaspiAssemblyPending(p.orderId);
          console.log("[kaspiTransfer] повтор ASSEMBLE: заказ №" + p.orderCode + " уже в статусе «" + curStatus + "» → убираем из очереди");
          continue;
        }
        // Используем свежий orderId из поиска по коду (может отличаться от batch API).
        // Логируем сравнение — поможет найти причину 404.
        const freshOrderId = raw.orderId || p.orderId;
        if (freshOrderId !== p.orderId) {
          console.log("[kaspiTransfer][diag] orderId DIFF заказ №" + p.orderCode + " batch=" + p.orderId + " search=" + freshOrderId);
        } else {
          console.log("[kaspiTransfer][diag] orderId SAME заказ №" + p.orderCode + " id=" + freshOrderId);
        }
        // Пробуем собрать ещё раз (стандартный Seller API)
        await sleep(1000);
        let retryAssembled = false;
        let retryErr = null;
        try {
          await kaspi.assembleOrder(freshOrderId, p.orderCode, p.numberOfSpace);
          retryAssembled = true;
        } catch (e) {
          retryErr = e;
        }

        // Fallback на внутренний API кабинета при 404
        if (!retryAssembled && retryErr && /\[404\]/.test(retryErr.message)) {
          try {
            await kaspi.assembleCargoOrder(p.orderCode, p.numberOfSpace);
            retryAssembled = true;
            console.log("[kaspiTransfer] cargo-fallback (повтор) assembled заказ №" + p.orderCode);
          } catch (cargoErr) {
            retryErr = cargoErr;
            console.warn("[kaspiTransfer] cargo-fallback (повтор) failed заказ №" + p.orderCode + " err=" + cargoErr.message);
          }
        }

        if (!retryAssembled) {
          throw retryErr;
        }

        store.removeFromKaspiAssemblyPending(p.orderId);
        console.log("[kaspiTransfer] повтор ASSEMBLE успешен: заказ №" + p.orderCode);
        // Отправляем накладную в фоне
        fetchAndSendWaybillInBackground(p.orderCode, p.numberOfSpace).catch((e) =>
          console.error("[kaspiTransfer] фоновая отправка накладной (повтор) №" + p.orderCode + ": " + e.message)
        );
      } catch (e) {
        console.warn("[kaspiTransfer] повтор ASSEMBLE не удался: заказ №" + p.orderCode + " err=" + e.message);
        // Оставляем в очереди — попробуем в следующий запуск
      }
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  if (onlyOrderCode && newOrders.length === 0) {
    const wasAlreadyProcessed = !dryRun && candidateOrders.some((o) => store.isKaspiOrderProcessed(o.id));
    if (wasAlreadyProcessed) {
      unresolvedOrders.push(
        "заказ «" + onlyOrderCode + "» уже был перенесён в 1С ранее — повторный перенос пропущен (защита от " +
        "задвоения Реализации). Если нужно перенести его снова намеренно, сообщите разработчику."
      );
    } else {
      unresolvedOrders.push(
        "заказ «" + onlyOrderCode + "» не найден среди заказов в статусе(ах) " + states.join("/") +
        " со статусом " + wantedStatus + " — проверьте код/id заказа и что он ещё не продвинут дальше Упаковки"
      );
    }
  }

  for (const order of newOrders) {
    // Пауза перед каждым заказом кроме первого
    if (!dryRun && orderIndex > 0) await sleep(INTER_ORDER_PAUSE_MS);
    orderIndex++;

    const attrs = order.attributes || {};
    const orderCode = attrs.code || order.id;
    const orderState = order._fromState || (attrs.state) || "KASPI_DELIVERY";

    // Страховка внутри цикла: если тот же заказ каким-то образом прошёл
    // дедубликацию выше, не создаём вторую Реализацию.
    if (!dryRun && processedThisRun.includes(order.id)) {
      skippedAlready++;
      continue;
    }

    // Проверка в 1С: есть ли уже активная (не помеченная на удаление) Реализация.
    // Основная защита от дублей — работает даже после редеплоя (processedOrderIds
    // сбрасывается, а 1С — постоянное хранилище). Если помечена на удаление — создаём новую.
    if (!dryRun) {
      const existingDoc = await oneC.findActiveRealizationByOrderCode(orderCode);
      if (existingDoc.found) {
        console.log("[kaspiTransfer] заказ №" + orderCode + " — Реализация №" + existingDoc.number + " уже есть в 1С, пропускаем");
        skippedAlready++;
        processedThisRun.push(order.id);
        continue;
      }
    }

    let orderLines;
    try {
      orderLines = await loadOrderLines(order.id);
    } catch (e) {
      unresolvedOrders.push("заказ №" + orderCode + ": не удалось получить состав — " + e.message);
      continue;
    }

    const unresolved = [];
    const { docLines, priceBreakdown } = buildDocLines(orderLines, mappingMap, nomByName, unresolved, priceMap, nameToCode);
    if (unresolved.length > 0 || docLines.length === 0) {
      unresolvedOrders.push("заказ №" + orderCode + ": " + (unresolved.join("; ") || "не удалось собрать ни одной строки"));
      continue;
    }

    if (dryRun) {
      const spaceDetail = computeNumberOfSpace(orderLines, mappingMap, true);
      dryRunPreview.push({
        orderCode,
        orderId: order.id,
        wouldCreateRealizationLines: docLines.map((l) => ({ nomKey: l.nomKey, qty: l.qty, price: l.price, unitKey: l.unitKey })),
        priceBreakdown,
        wouldAssembleNumberOfSpace: spaceDetail.spaces,
        numberOfSpaceBreakdown: spaceDetail.breakdown,
        numberOfSpaceGroups: spaceDetail.groups,
      });
      continue;
    }

    const numberOfSpace = computeNumberOfSpace(orderLines, mappingMap);

    let docResult;
    try {
      docResult = await oneC.createRealizationDocument({
        orgRef: fixed.orgRef,
        contrRef: fixed.contrRef,
        dogovorRef: fixed.dogovorRef,
        skladRef: fixed.skladRef,
        respRef: fixed.respRef,
        comment: "Заказ №" + orderCode,
        dateIso: kostanayIsoNow(),
        lines: docLines,
        tryPost: true,
      });
    } catch (e) {
      unresolvedOrders.push("заказ №" + orderCode + ": ошибка создания Реализации в 1С — " + e.message);
      continue;
    }

    created++;
    processedThisRun.push(order.id);

    // Дополнительная пауза перед ASSEMBLE — снижаем нагрузку на Kaspi API
    await sleep(1000);

    // Диагностический лог перед каждым ASSEMBLE — помогает найти причину 404.
    // Видно в Render Logs. Убрать после того как причина 404 установлена.
    const _kd = attrs.kaspiDelivery || {};
    console.log(
      "[kaspiTransfer][diag] ASSEMBLE заказ №" + orderCode +
      " orderId=" + order.id +
      " state=" + orderState +
      " status=" + (attrs.status || "null") +
      " spaces=" + numberOfSpace +
      " planDate=" + (_kd.courierTransmissionPlanningDate || "null") +
      " waybill=" + (_kd.waybill ? "yes" : "null")
    );

    let assembled = false;
    let assembleErrorMessage = null;
    const ASSEMBLE_RETRY_ATTEMPTS = 3;
    const ASSEMBLE_RETRY_DELAY_MS = 5000;
    for (let attempt = 0; attempt < ASSEMBLE_RETRY_ATTEMPTS && !assembled; attempt++) {
      if (attempt > 0) await sleep(ASSEMBLE_RETRY_DELAY_MS);
      try {
        await kaspi.assembleOrder(order.id, orderCode, numberOfSpace);
        assembled = true;
      } catch (e) {
        assembleErrorMessage = e.message;
        if (/\[404\]/.test(e.message)) break; // повтор бесполезен — выходим сразу
      }
    }

    // Fallback: если стандартный Seller API вернул 404 — пробуем внутренний
    // API кабинета (mc.shop.kaspi.kz/mc/api/order/cargo/assembled).
    // Требует KASPI_MERCHANT_ID + KASPI_MC_SESSION в Render → Environment.
    if (!assembled && /\[404\]/.test(assembleErrorMessage || "")) {
      try {
        await kaspi.assembleCargoOrder(orderCode, numberOfSpace);
        assembled = true;
        assembleErrorMessage = null;
        console.log("[kaspiTransfer] cargo-fallback assembled заказ №" + orderCode);
      } catch (cargoErr) {
        assembleErrorMessage = cargoErr.message;
        console.warn("[kaspiTransfer] cargo-fallback failed заказ №" + orderCode + " err=" + cargoErr.message);
      }
    }

    if (!assembled) {
      let statusNote = "";
      try {
        const recheck = await kaspi.getOrderRawByCode(orderCode);
        if (recheck.found) {
          // Сравниваем orderId из batch-запроса vs поиска по коду — ключевая диагностика 404.
          if (recheck.orderId && recheck.orderId !== order.id) {
            console.log("[kaspiTransfer][diag] orderId DIFF (первый fail) заказ №" + orderCode + " batch=" + order.id + " search=" + recheck.orderId);
          }
        }
        if (recheck.found && recheck.attributes) {
          const curStatus = recheck.attributes.status;
          if (curStatus && curStatus !== attrs.status) {
            statusNote = " — статус заказа в Kaspi изменился с \"" + attrs.status + "\" на \"" + curStatus +
              "\" за время обработки. ПРОВЕРЬТЕ заказ в личном кабинете Kaspi и созданную Реализацию в 1С №" + (docResult.number || "?") + " — она может быть ошибочной.";
          } else {
            statusNote = " — добавлен в очередь авто-повтора: следующий запуск (08:45 или 13:15) попробует снова. " +
              "Если нужно срочно — продвиньте вручную в кабинете Kaspi (Упаковка → Передача, мест: " + numberOfSpace + "). " +
              "Реализация №" + (docResult.number || "?") + " в 1С верная, трогать не нужно.";
          }
        }
      } catch (e) {
        // диагностика необязательна
      }
      console.warn("[kaspiTransfer] assembleFailed заказ №" + orderCode + " orderState=" + orderState + " err=" + assembleErrorMessage);
      assembleFailed.push("заказ №" + orderCode + ": Реализация №" + (docResult.number || "?") + " создана, но не продвинута в Kaspi — " + assembleErrorMessage + statusNote);
      // Добавляем в очередь авто-повтора — следующий запуск попробует снова
      store.addToKaspiAssemblyPending({ orderId: order.id, orderCode, numberOfSpace });
    }

    if (assembled) {
      store.removeFromKaspiAssemblyPending(order.id); // на случай если был в очереди с прошлого запуска
      fetchAndSendWaybillInBackground(orderCode, numberOfSpace).catch((e) =>
        console.error("[kaspiTransfer] фоновая отправка накладной для заказа №" + orderCode + " упала: " + e.message)
      );
    }
  }

  if (!dryRun && processedThisRun.length > 0) store.markKaspiOrdersProcessed(processedThisRun);

  const summary = {
    total: candidateOrders.length,
    created,
    skippedAlready,
    unresolved: unresolvedOrders,
    assembleFailed,
    waybillFailed,
    mappingProblems,
    priceProblems,
  };
  if (dryRun) summary.dryRunPreview = dryRunPreview;

  const errorParts = [];
  if (unresolvedOrders.length > 0) errorParts.push(unresolvedOrders.length + " заказ(ов) не перенесено: " + unresolvedOrders.slice(0, 5).join(" | "));
  if (assembleFailed.length > 0) errorParts.push(assembleFailed.length + " заказ(ов) создано в 1С, но не продвинуто в Kaspi: " + assembleFailed.slice(0, 5).join(" | "));
  if (waybillFailed.length > 0) errorParts.push(waybillFailed.length + " накладная(ых) не отправлена(о) в Telegram: " + waybillFailed.slice(0, 5).join(" | "));

  return { summary, errorText: errorParts.length > 0 ? errorParts.join(" || ") : null };
}

let transferInProgress = false;

async function runKaspiTransferSafe(options) {
  const opts = options || {};
  const isTest = !!(opts.orderId || opts.dryRun);

  if (transferInProgress) {
    const busyMsg = "Перенос уже выполняется — подождите, пока текущий запуск закончится (обычно несколько секунд), и попробуйте снова. Это защита от случайного двойного переноса одного заказа.";
    console.log("[kaspiTransfer] " + (isTest ? "[тест] " : "") + "отказ — уже выполняется другой перенос");
    return { ok: false, error: busyMsg, busy: true };
  }
  transferInProgress = true;
  try {
    const { summary, errorText } = await runKaspiTransfer(opts);
    return { ok: true, summary, errorText };
  } catch (err) {
    console.error('[kaspiTransfer] runKaspiTransferSafe error:', err);
    return { ok: false, error: err.message };
  } finally {
    transferInProgress = false;
  }
}

module.exports = { runKaspiTransferSafe };
