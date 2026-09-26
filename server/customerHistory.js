/* THE HELLO Team — учёт клиентов Kaspi для определения повторных заказов.

   Идея: по каждому обработанному заказу Kaspi определяем "ключ клиента" —
   по номеру телефона (надёжнее всего), а если телефона нет — по связке
   "имя + город" (грубее, но лучше, чем ничего). Дальше store.js хранит
   компактную статистику (не весь список заказов, а только дату первого
   заказа на клиента + счётчики по дням) — см. store.recordKaspiCustomerOrder.

   Собирается с 2026-09-23 — раньше эти данные никуда не сохранялись, Kaspi
   API не отдаёт полный архив, поэтому статистика по прошлым месяцам
   недоступна и копится только вперёд. */
"use strict";
const store = require("./store");

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 11 && digits[0] === "8") digits = "7" + digits.slice(1);
  if (digits.length === 10) digits = "7" + digits;
  if (digits.length !== 11) return null; // не похоже на нормальный казахстанский/российский номер
  return digits;
}

function normalizeText(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Достаёт имя/телефон/город из "сырых" attributes заказа Kaspi. Поля могут
// отличаться в зависимости от типа доставки (KASPI_DELIVERY/PICKUP/DELIVERY) —
// пробуем несколько вероятных путей защитно, не падаем, если чего-то нет.
function extractCustomerInfo(attrs) {
  attrs = attrs || {};
  const customer = attrs.customer || {};
  const name = customer.name ||
    [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim() ||
    null;
  const phone = customer.cellPhone || customer.phone || null;

  const addr = attrs.deliveryAddress || (attrs.kaspiDelivery && attrs.kaspiDelivery.address) || {};
  const city = addr.town || addr.city || addr.district || null;

  return { name: name || null, phone: phone || null, city: city || null };
}

function computeCustomerKey(info) {
  const p = normalizePhone(info.phone);
  if (p) return "p:" + p;
  const n = normalizeText(info.name);
  if (!n) return null; // ни телефона, ни имени — не с чем сопоставлять
  const c = normalizeText(info.city);
  return "nc:" + n + (c ? "|" + c : "");
}

// creationDateMs — attrs.creationDate заказа (мс, время Kaspi). Приводим к
// дню по времени Костаная (UTC+5, без перевода на зиму/лето).
function dateKeyFromMs(ms) {
  const KOSTANAY_OFFSET_MS = 5 * 60 * 60 * 1000;
  const d = new Date((ms || Date.now()) + KOSTANAY_OFFSET_MS);
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD" в сдвинутых на +5ч координатах = локальный день Костаная
}

// Основная точка входа — вызывается из kaspiTransfer.js на каждый заказ,
// который реально обрабатывается (не на дубли/пропуски). Ничего не бросает —
// сбой учёта клиента не должен ронять перенос заказа.
// Возвращает { isRepeat, key, dateKey } или null, если учесть не удалось.
function recordOrder(attrs) {
  try {
    const info = extractCustomerInfo(attrs);
    const key = computeCustomerKey(info);
    const dateKey = dateKeyFromMs(attrs && attrs.creationDate);
    if (!key) {
      // Не с чем сопоставлять клиента — просто считаем заказ в "всего",
      // без учёта повторности.
      console.log("[customerHistory] заказ №" + (attrs && attrs.code) + ": нет ни телефона, ни имени — не учитываем как клиента");
      store.incrementKaspiDailyTotal(dateKey);
      return { isRepeat: false, key: null, dateKey };
    }
    const { isRepeat } = store.recordKaspiCustomerOrder(key, info, dateKey);
    return { isRepeat, key, dateKey };
  } catch (e) {
    console.warn("[customerHistory] recordOrder упал: " + e.message);
    return null;
  }
}

module.exports = { recordOrder, normalizePhone, normalizeText, computeCustomerKey, extractCustomerInfo, dateKeyFromMs };
