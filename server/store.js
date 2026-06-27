/* Простое файловое хранилище — без БД и внешних зависимостей.
   Хранит: загруженные данные (заказы/товары), настройки, неснижаемый остаток.
   Один файл data/state.json — общий для всех, кто открывает ссылку. */
"use strict";
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DEFAULT_STATE = {
  ordersRaw: null,
  itemsRaw: null,
  settings: null, // null => клиент возьмёт Engine.DEFAULT_SETTINGS
  control: null, // null => клиент возьмёт Engine.DEFAULT_CONTROL
  meta: {
    ordersFileName: null, itemsFileName: null, uploadedAt: null, // старые поля (ручная загрузка, оставлены для совместимости)
    source: null, lastSyncAt: null, lastSyncOk: null, lastSyncError: null, ordersCount: null, itemsCount: null, // автосинк с 1С
  },
  // ---- Bitrix24: локальное приложение для точной атрибуции событий ----
  bitrixApp: null, // { accessToken, refreshToken, expiresAt, domain, memberId, clientEndpoint }
  bitrixEvents: [], // [{ time, entityType, entityId, type, fromStage, toStage, actorId, actorName }]
  bitrixStageCache: {}, // "deal:123" -> текущий STAGE_ID/STATUS_ID, известный с прошлого события
  notifyState: {}, // "onec"/"bitrix"/"kaspi" -> текст последней отправленной в Telegram ошибки (или null)
  // ---- Kaspi → 1С перенос заказов (Реализация) ----
  kaspiTransfer: {
    processedOrderIds: [], // Kaspi orderId, уже превращённые в Реализацию — защита от повторов при двух запусках в день
    lastRunAt: null,
    lastRunOk: null,
    lastRunError: null,
    lastRunSummary: null, // { total, created, skippedAlready, unresolved: [...] }
  },
};

const MAX_BITRIX_EVENTS = 5000;
const MAX_PROCESSED_KASPI_ORDERS = 5000;

function bitrixCacheKey(entityType, entityId) {
  return entityType + ":" + entityId;
}

function getBitrixApp() {
  return readState().bitrixApp || null;
}
function setBitrixApp(data) {
  return patchState({ bitrixApp: data });
}

function appendBitrixEvent(ev) {
  const state = readState();
  const list = Array.isArray(state.bitrixEvents) ? state.bitrixEvents.slice() : [];
  list.push(ev);
  while (list.length > MAX_BITRIX_EVENTS) list.shift();
  return patchState({ bitrixEvents: list });
}
function getBitrixEvents() {
  const state = readState();
  return Array.isArray(state.bitrixEvents) ? state.bitrixEvents : [];
}

function getCachedStage(entityType, entityId) {
  const state = readState();
  const cache = state.bitrixStageCache || {};
  const v = cache[bitrixCacheKey(entityType, entityId)];
  return v == null ? null : v;
}
function setCachedStage(entityType, entityId, stageId) {
  const state = readState();
  const cache = Object.assign({}, state.bitrixStageCache || {});
  cache[bitrixCacheKey(entityType, entityId)] = stageId;
  return patchState({ bitrixStageCache: cache });
}
function deleteCachedStage(entityType, entityId) {
  const state = readState();
  const cache = Object.assign({}, state.bitrixStageCache || {});
  delete cache[bitrixCacheKey(entityType, entityId)];
  return patchState({ bitrixStageCache: cache });
}

// ---- Kaspi → 1С перенос: дедупликация и статус последнего запуска ----
function getKaspiTransferState() {
  const state = readState();
  return state.kaspiTransfer || DEFAULT_STATE.kaspiTransfer;
}
function isKaspiOrderProcessed(orderId) {
  const kt = getKaspiTransferState();
  return Array.isArray(kt.processedOrderIds) && kt.processedOrderIds.indexOf(String(orderId)) !== -1;
}
function markKaspiOrdersProcessed(orderIds) {
  const state = readState();
  const kt = Object.assign({}, DEFAULT_STATE.kaspiTransfer, state.kaspiTransfer || {});
  const set = new Set((kt.processedOrderIds || []).map(String));
  (orderIds || []).forEach((id) => set.add(String(id)));
  let list = Array.from(set);
  while (list.length > MAX_PROCESSED_KASPI_ORDERS) list.shift();
  return patchState({ kaspiTransfer: Object.assign({}, kt, { processedOrderIds: list }) });
}
function setKaspiTransferRunMeta(patch) {
  const state = readState();
  const kt = Object.assign({}, DEFAULT_STATE.kaspiTransfer, state.kaspiTransfer || {}, patch);
  return patchState({ kaspiTransfer: kt });
}

function readState() {
  ensureDir();
  if (!fs.existsSync(STATE_FILE)) return Object.assign({}, DEFAULT_STATE);
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Object.assign({}, DEFAULT_STATE, parsed);
  } catch (e) {
    return Object.assign({}, DEFAULT_STATE);
  }
}

function writeState(state) {
  ensureDir();
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

function patchState(patch) {
  const state = readState();
  const next = Object.assign({}, state, patch);
  writeState(next);
  return next;
}

module.exports = {
  readState, writeState, patchState, DATA_DIR, STATE_FILE,
  getBitrixApp, setBitrixApp,
  appendBitrixEvent, getBitrixEvents,
  getCachedStage, setCachedStage, deleteCachedStage,
  getKaspiTransferState, isKaspiOrderProcessed, markKaspiOrdersProcessed, setKaspiTransferRunMeta,
};
