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
const store = require("./store");
const telegram = require("./telegram");

function norm(s) {
  return String(s || "").trim().toLowerCase();
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
// Для "набор" — цена за набор делится поровну между его компонентами
// (подтверждено Александром: цена берётся из заказа Kaspi, а не из 1С).
function buildDocLines(orderLines, mappingMap, nomByName, unresolved) {
  const docLines = [];
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
    const priceShare = ol.unitPrice / componentCount;
    let anyMissing = false;
    const lines = entry.components.map((comp) => {
      const nomKey = nomByName.get(norm(comp.name1C));
      if (!nomKey) anyMissing = true;
      return {
        nomKey,
        qty: comp.qty * ol.qty,
        price: priceShare,
        compName: comp.name1C,
      };
    });
    if (anyMissing) {
      const missingNames = lines.filter((l) => !l.nomKey).map((l) => l.compName);
      unresolved.push("код " + ol.code + ": компонент(ы) не найдены в 1С — " + missingNames.join(", "));
      continue;
    }
    lines.forEach((l) => docLines.push({ nomKey: l.nomKey, qty: l.qty, price: l.price }));
  }
  return docLines;
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
function computeNumberOfSpace(orderLines, mappingMap) {
  const FALLBACK_CAPACITY = 4;
  const byCapacity = new Map(); // вместимость -> сумма количества
  for (const ol of orderLines) {
    if (ol.error || !ol.code) continue;
    const entry = mappingMap.get(ol.code);
    if (entry && entry.components && entry.components.length) {
      for (const comp of entry.components) {
        const capacity = comp.boxCapacity > 0 ? comp.boxCapacity : FALLBACK_CAPACITY;
        const qty = ol.qty * (comp.qty || 1);
        byCapacity.set(capacity, (byCapacity.get(capacity) || 0) + qty);
      }
    } else {
      byCapacity.set(FALLBACK_CAPACITY, (byCapacity.get(FALLBACK_CAPACITY) || 0) + ol.qty);
    }
  }
  let spaces = 0;
  for (const [capacity, qty] of byCapacity) {
    spaces += Math.ceil(qty / capacity);
  }
  return spaces > 0 ? spaces : 1;
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

  const { map: mappingMap, problems: mappingProblems } = await mappingTable.loadMappingTable();

  const fixed = await resolveFixedRefs();
  if (fixed.problems.length > 0) {
    throw new Error("не удалось определить постоянные реквизиты документа: " + fixed.problems.join("; "));
  }

  const nomByName = await oneC.fetchNomenclatureByNameMap();

  const states = statesFromEnv();
  const wantedStatus = statusFromEnv();

  let candidateOrders = [];
  for (const state of states) {
    const list = await kaspi.getOrders({ state, pageSize: 100 });
    list.items.forEach((o) => candidateOrders.push(o));
  }

  if (onlyOrderCode) {
    candidateOrders = candidateOrders.filter((o) => {
      const attrs = o.attributes || {};
      return String(o.id) === onlyOrderCode || String(attrs.code) === onlyOrderCode;
    });
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
    const docLines = buildDocLines(orderLines, mappingMap, nomByName, unresolved);
    if (unresolved.length > 0 || docLines.length === 0) {
      unresolvedOrders.push("заказ №" + orderCode + ": " + (unresolved.join("; ") || "не удалось собрать ни одной строки"));
      continue;
    }

    const numberOfSpace = computeNumberOfSpace(orderLines, mappingMap);

    if (dryRun) {
      dryRunPreview.push({
        orderCode,
        orderId: order.id,
        wouldCreateRealizationLines: docLines.map((l) => ({ nomKey: l.nomKey, qty: l.qty, price: l.price })),
        wouldAssembleNumberOfSpace: numberOfSpace,
      });
      continue;
    }

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

    try {
      await kaspi.assembleOrder(order.id, numberOfSpace);
    } catch (e) {
      assembleFailed.push("заказ №" + orderCode + ": Реализация №" + (docResult.number || "?") + " создана, но Kaspi не подтвердил продвижение (Упаковка→Передача) — " + e.message);
    }
  }

  if (!dryRun && processedThisRun.length > 0) store.markKaspiOrdersProcessed(processedThisRun);

  const summary = {
    total: candidateOrders.length,
    created,
    skippedAlready,
    unresolved: unresolvedOrders,
    assembleFailed,
    mappingProblems,
  };
  if (dryRun) summary.dryRunPreview = dryRunPreview;

  const errorParts = [];
  if (unresolvedOrders.length > 0) errorParts.push(unresolvedOrders.length + " заказ(ов) не перенесено: " + unresolvedOrders.slice(0, 5).join(" | "));
  if (assembleFailed.length > 0) errorParts.push(assembleFailed.length + " заказ(ов) создано в 1С, но не продвинуто в Kaspi: " + assembleFailed.slice(0, 5).join(" | "));

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
      ", не продвинуто в Kaspi " + summary.assembleFailed.length
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
