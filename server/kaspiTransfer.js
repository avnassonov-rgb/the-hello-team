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
  // Подтверждено живым тестом: у этого магазина почти все заказы (100+) идут
  // через доставку самого Kaspi ("KASPI_DELIVERY") — без неё в списке
  // оказывалось лишь 2-3 случайных заказа из PICKUP/DELIVERY, а нужный заказ
  // не находился вообще.
  const raw = process.env.KASPI_TRANSFER_STATES || "PICKUP,DELIVERY,KASPI_DELIVERY";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
function statusFromEnv() {
  return process.env.KASPI_TRANSFER_STATUS || "ACCEPTED_BY_MERCHANT";
}

// "Структурная единица" — точное имя реквизита в этой конфигурации 1С не
// подтверждено живым тестом, поэтому resolveRefByName (как и createRealizationDocument)
// пробует несколько вариантов названия справочника по очереди.
const ORG_CATALOG_CANDIDATES = ["Catalog_СтруктурныеЕдиницы", "Catalog_Организации"];
const ORG_NAME = process.env.KASPI_TRANSFER_ORG_NAME || "ИП Канапин А.Б.";

const CONTR_CATALOG_CANDIDATES = ["Catalog_Контрагенты"];
const CONTR_NAME = process.env.KASPI_TRANSFER_CONTR_NAME || "Розничная выручка";

const DOGOVOR_CATALOG_CANDIDATES = ["Catalog_ДоговорыКонтрагентов", "Catalog_Договоры"];
const DOGOVOR_NAME = process.env.KASPI_TRANSFER_DOGOVOR_NAME || "БД";

const SKLAD_CATALOG_CANDIDATES = ["Catalog_Склады"];
const SKLAD_NAME = process.env.KASPI_TRANSFER_SKLAD_NAME || "Основной склад (г. Костанай)";

const RESP_CATALOG_CANDIDATES = ["Catalog_Пользователи", "Catalog_ФизическиеЛица", "Catalog_Сотрудники"];
// Точное название подтверждено Александром: "Каспи Магазин" (кириллицей).
// Можно переопределить через переменную окружения, если в 1С когда-нибудь
// изменится написание.
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

// 1С-дата без таймзоны (локальное время Костаная, UTC+5 — без перевода,
// сервер Render обычно работает в UTC, поэтому считаем смещение сами).
function kostanayIsoNow() {
  const KOSTANAY_OFFSET_MIN = 5 * 60;
  const nowUtcMs = Date.now();
  const local = new Date(nowUtcMs + KOSTANAY_OFFSET_MIN * 60000);
  return local.toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS"
}

// Состав заказа: код товара (через позицию → продукт) + кол-во + фактическая
// цена за единицу (сколько реально заплатили за штуку, без скидки/с учётом —
// totalPrice уже отражает фактическую сумму по позиции).
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

// Разворачивает строки заказа Kaspi (код+кол-во+цена) в строки документа 1С
// (Ref_Key номенклатуры + кол-во + цена), используя таблицу соответствия.
// Цена за набор делится между его компонентами ПРОПОРЦИОНАЛЬНО их реальным
// ценам с листа KASPI.KZ (priceTable.js), а не поровну — подтверждено
// Александром 30.06.2026 на примере "Набор 4 в 1": продан за 3990тг, реальные
// цены компонентов 1350/1490/990/1490 (сумма 5320) → доли 25.4%/28%/18.6%/28%
// → этими долями делятся фактические 3990тг (а не поровну по 997.5).
// Само деление берётся из заказа Kaspi (ol.unitPrice), а не из 1С/прайса —
// сумма строк документа всегда равна тому, что реально заплатил покупатель.
//   priceMap — артикул Kaspi -> цена продажи (из priceTable.loadPriceTable).
//   nameToCode — название компонента в 1С -> его собственный артикул Kaspi
//   (из mappingTable.loadMappingTable, по строкам типа "товар") — нужен,
//   чтобы найти артикул компонента и по нему — его цену в priceMap.
// Если для какого-то компонента набора реальная цена не нашлась (нет в
// priceMap/nameToCode, например новый товар) — для ЭТОГО набора используется
// старое поведение (деление поровну), чтобы перенос заказа не остановился;
// причина попадает в priceBreakdown[].fallbackReason для проверки на dry-run.
function buildDocLines(orderLines, mappingMap, nomByName, unresolved, priceMap, nameToCode) {
  const docLines = [];
  const priceBreakdown = []; // только по наборам (>1 компонент) — для dry-run/диагностики
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

    // shares: comp -> { refPrice, share } — заполняется только если для
    // ВСЕХ компонентов набора нашлась реальная цена; иначе остаётся null и
    // ниже используется деление поровну (fallback).
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

    let anyMissing = false;
    // nomByName хранит {ref, unitKey} на товар (см. fetchNomenclatureByNameMap
    // в oneC.js) — unitKey нужен в строке документа, иначе 1С падает с общей
    // HTTP 500 при создании документа (нет единицы измерения).
    const lines = entry.components.map((comp) => {
      const nom = nomByName.get(norm(comp.name1C));
      if (!nom || !nom.ref) anyMissing = true;
      const price = shares && shares.has(comp) ? ol.unitPrice * shares.get(comp).share : ol.unitPrice / componentCount;
      return {
        nomKey: nom ? nom.ref : null,
        unitKey: nom ? nom.unitKey : null,
        qty: comp.qty * ol.qty,
        price,
        compName: comp.name1C,
      };
    });

    if (componentCount > 1) {
      priceBreakdown.push({
        kaspiCode: ol.code,
        kitUnitPrice: ol.unitPrice,
        usedProportionalSplit: !!shares,
        fallbackReason,
        components: entry.components.map((comp) => ({
          name: comp.name1C,
          refPrice: shares && shares.has(comp) ? shares.get(comp).refPrice : null,
          share: shares && shares.has(comp) ? shares.get(comp).share : null,
          computedPrice: shares && shares.has(comp) ? ol.unitPrice * shares.get(comp).share : ol.unitPrice / componentCount,
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

// Считает количество мест (numberOfSpace) для ASSEMBLE по данным из таблицы
// соответствия (колонка "максимальное кол-во товаров в коробке" — см.
// mappingTable.js, entry.components[].boxCapacity). Правило подтверждено
// Александром на примере "Универсальный набор спреев 4 шт" (4 разных спрея
// по 1 шт в наборе, у каждого вместимость 4): "в коробку влазит максимум 4
// единицы, в наборе ровно 4 единицы — значит это 1 полная коробка".
//   1. Каждая строка заказа (товар или набор) раскладывается на компоненты
//      из таблицы; количество единиц компонента = кол-во заказанного
//      товара × кол-во этого компонента в одном наборе.
//   2. Эти количества группируются по ВСЕМУ заказу не по конкретному
//      товару, а по значению вместимости коробки — то есть разные товары
//      с одинаковой вместимостью могут ехать в одной коробке вместе.
//   3. В каждой группе: места = округление вверх(сумма количества / вместимость).
//   4. Итог — сумма мест по всем группам (минимум 1).
// Товары без записи в таблице соответствия считаются с вместимостью по
// умолчанию 4 (см. mappingTable.DEFAULT-аналог — здесь захардкожено то же
// число для согласованности, если строка вообще не нашлась в таблице).
// detailed=true добавляет breakdown по компонентам и группам — только для
// dryRun-предпросмотра, чтобы видеть ПОЧЕМУ получилось именно такое число
// коробок (например, если вместимость у компонентов в таблице соответствия
// разная — каждая отдельная вместимость это отдельная группа, они НЕ
// объединяются между собой, даже если это компоненты одного набора).
function computeNumberOfSpace(orderLines, mappingMap, detailed) {
  const FALLBACK_CAPACITY = 4;
  const byCapacity = new Map(); // вместимость -> сумма количества
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

// options.orderId  — строка: код заказа Kaspi (то, что видно в кабинете, напр.
//                    "20013004") ИЛИ внутренний id заказа. Если задан — берём
//                    ТОЛЬКО этот заказ (даже если он уже отмечен обработанным),
//                    игнорируя остальные. Это безопасный режим теста на 1 заказе.
// options.dryRun   — true: ничего не пишем (ни в 1С, ни в Kaspi, ни в store) —
//                    только показываем, что было бы создано/отправлено.
async function runKaspiTransfer(options) {
  const opts = options || {};
  const dryRun = !!opts.dryRun;
  const onlyOrderCode = opts.orderId ? String(opts.orderId).trim() : null;

  const { map: mappingMap, problems: mappingProblems, nameToCode } = await mappingTable.loadMappingTable();
  // priceMap не критичен: если таблица цен недоступна/не настроена,
  // buildDocLines сам откатывается на деление поровну (см. её комментарий) —
  // перенос заказов не должен остановиться из-за этого.
  const { map: priceMap, problems: priceProblems } = await priceTable.loadPriceTable();

  const fixed = await resolveFixedRefs();
  if (fixed.problems.length > 0) {
    throw new Error("не удалось определить постоянные реквизиты документа: " + fixed.problems.join("; "));
  }

  const nomByName = await oneC.fetchNomenclatureByNameMap();

  const states = statesFromEnv();
  const wantedStatus = statusFromEnv();

  let candidateOrders = [];

  if (onlyOrderCode) {
    // Явный тест ОДНОГО заказа: берём его напрямую по коду (без постраничной
    // выборки по state). Так надёжнее — у магазина бывает 100+ заказов в
    // одном state (см. комментарий выше), а getOrders({state, pageSize:100})
    // отдаёт только первую страницу, поэтому конкретный заказ мог туда не попасть
    // даже если он реально существует и подходит по state/status (подтверждено
    // живым тестом на заказе 981126374: state=KASPI_DELIVERY, status=ACCEPTED_BY_MERCHANT —
    // всё совпадало, просто не попал в первые 100 заказов выборки).
    try {
      const raw = await kaspi.getOrderRawByCode(onlyOrderCode);
      if (raw.found) candidateOrders.push({ id: raw.orderId, attributes: raw.attributes });
    } catch (e) {
      // не критично — ниже всё равно будет понятная ошибка "не найден"
    }
  } else {
    // Обычный запуск по расписанию: проходим ВСЕ страницы каждого state, а не
    // только первую — иначе при 100+ заказах в state часть из них (особенно
    // новые) могла бы остаться незамеченной.
    for (const state of states) {
      let pageNumber = 0;
      const pageSize = 100;
      for (;;) {
        const list = await kaspi.getOrders({ state, pageSize, pageNumber });
        list.items.forEach((o) => candidateOrders.push(o));
        pageNumber++;
        const pageCount = list.pageCount;
        if (!list.items.length) break;
        if (pageCount != null && pageNumber >= pageCount) break;
        if (pageNumber > 30) break; // защита от бесконечного цикла, если meta некорректна
      }
    }
  }

  const newOrders = candidateOrders.filter((o) => {
    const attrs = o.attributes || {};
    if (wantedStatus && attrs.status !== wantedStatus) return false;
    if (onlyOrderCode) return true; // явный тест одного заказа — игнорируем "уже обработан"
    return !store.isKaspiOrderProcessed(o.id);
  });

  let created = 0;
  let skippedAlready = onlyOrderCode ? 0 : candidateOrders.length - newOrders.length;
  const unresolvedOrders = []; // заказы, которые не удалось перенести — НЕ отмечаются обработанными, будут повторены
  const assembleFailed = []; // 1С документ создан, но Kaspi не подтвердил продвижение — отмечены обработанными, проблема только в Kaspi
  const waybillFailed = []; // продвижение в Kaspi прошло, но накладную не удалось скачать/отправить в Telegram — не критично, накладная всё равно доступна в кабинете Kaspi вручную
  const processedThisRun = [];
  const dryRunPreview = []; // только при dryRun: что было бы создано, без записи куда-либо

  if (onlyOrderCode && newOrders.length === 0) {
    unresolvedOrders.push(
      "заказ «" + onlyOrderCode + "» не найден среди заказов в статусе(ах) " + states.join("/") +
      " со статусом " + wantedStatus + " — проверьте код/id заказа и что он ещё не продвинут дальше Упаковки"
    );
  }

  for (const order of newOrders) {
    const attrs = order.attributes || {};
    const orderCode = attrs.code || order.id;
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
        priceBreakdown, // по каждому набору: реальные цены/доли компонентов, или причина отката на деление поровну
        wouldAssembleNumberOfSpace: spaceDetail.spaces,
        numberOfSpaceBreakdown: spaceDetail.breakdown, // по каждому компоненту: вместимость коробки и кол-во
        numberOfSpaceGroups: spaceDetail.groups, // итоговые группы по вместимости: сколько коробок в каждой
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

    let assembled = false;
    try {
      await kaspi.assembleOrder(order.id, numberOfSpace);
      assembled = true;
    } catch (e) {
      assembleFailed.push("заказ №" + orderCode + ": Реализация №" + (docResult.number || "?") + " создана, но Kaspi не подтвердил продвижение (Упаковка→Передача) — " + e.message);
    }

    // Накладная: после ASSEMBLE Kaspi формирует её не всегда мгновенно —
    // пробуем несколько раз с паузой. Это дополнительный, не критичный шаг:
    // если не получится, перенос и продвижение заказа УЖЕ сделаны успешно,
    // накладную всегда можно скачать вручную в кабинете Kaspi.
    if (assembled) {
      try {
        let waybillUrl = null;
        for (let attempt = 0; attempt < 4 && !waybillUrl; attempt++) {
          if (attempt > 0) await sleep(3000);
          const raw = await kaspi.getOrderRawByCode(orderCode);
          waybillUrl = raw.found && raw.attributes && raw.attributes.kaspiDelivery && raw.attributes.kaspiDelivery.waybill;
        }
        if (waybillUrl) {
          const pdf = await kaspi.downloadWaybillPdf(waybillUrl);
          // Ищем ВСЕХ сотрудников в роли "Зав.складом" в базе сотрудников
          // (вкладка «Сотрудники» на дашборде) — если они привязаны (написали
          // боту, админ вставил их Telegram ID), накладная уходит каждому из
          // них, без необходимости менять переменные окружения на Render.
          // Если таких сотрудников пока нет — остаётся старое поведение из
          // telegram.js (TELEGRAM_WAREHOUSE_CHAT_ID, иначе TELEGRAM_CHAT_ID).
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
            waybillFailed.push(
              "заказ №" + orderCode + ": накладная скачана, но отправлена не всем получателям (" +
              failedSends.length + " из " + sendResults.length + " не удалось) — " +
              failedSends.map((r) => r.error).join("; ")
            );
          }
        } else {
          waybillFailed.push("заказ №" + orderCode + ": накладная не появилась в Kaspi за несколько попыток (попробуйте позже вручную)");
        }
      } catch (e) {
        waybillFailed.push("заказ №" + orderCode + ": не удалось скачать/отправить накладную — " + e.message);
      }
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

// options.orderId/options.dryRun — см. runKaspiTransfer(). Тестовые запуски
// (с orderId и/или dryRun) НЕ трогают lastRun-статус мониторинга и НЕ шлют
// Telegram-уведомление — чтобы тест на 1 заказе не сбивал боевой мониторинг.
async function runKaspiTransferSafe(options) {
  const opts = options || {};
  const isTest = !!(opts.orderId || opts.dryRun);
  try {
    const { summary, errorText } = await runKaspiTransfer(opts);
    console.log(
      (isTest ? "[kaspiTransfer][тест] " : "[kaspiTransfer] ") +
      "перенос завершён: всего " + summary.total +
      ", создано " + summary.created +
      ", уже было " + summary.skippedAlready +
      ", не перенесено " + summary.unresolved.length +
      ", не продвинуто в Kaspi " + summary.assembleFailed.length +
      ", накладная не отправлена " + summary.waybillFailed.length
    );
    if (!isTest) {
      store.setKaspiTransferRunMeta({
        lastRunAt: new Date().toISOString(),
        lastRunOk: true,
        lastRunError: errorText,
        lastRunSummary: summary,
      });
      telegram.notifyIfChanged(store, "kaspi_transfer", "Перенос заказов Kaspi → 1С", errorText)
        .catch((e) => console.error("[telegram] notifyIfChanged упал: " + e.message));
    }
    return { ok: true, summary, errorText };
  } catch (e) {
    console.error((isTest ? "[kaspiTransfer][тест] " : "[kaspiTransfer] ") + "перенос упал: " + e.message);
    if (!isTest) {
      store.setKaspiTransferRunMeta({
        lastRunAt: new Date().toISOString(),
        lastRunOk: false,
        lastRunError: e.message,
      });
      telegram.notifyIfChanged(store, "kaspi_transfer", "Перенос заказов Kaspi → 1С", e.message)
        .catch((te) => console.error("[telegram] notifyIfChanged упал: " + te.message));
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { runKaspiTransfer, runKaspiTransferSafe, resolveFixedRefs };
