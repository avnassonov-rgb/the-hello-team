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
  meta: { ordersFileName: null, itemsFileName: null, uploadedAt: null },
  // ---- Bitrix24: локальное приложение для точной атрибуции событий ----
  bitrixApp: null, // { accessToken, refreshToken, expiresAt, domain, memberId, clientEndpoint }
  bitrixEvents: [], // [{ time, entityType, entityId, type, fromStage, toStage, actorId, actorName }]
  bitrixStageCache: {}, // "deal:123" -> текущий STAGE_ID/STATUS_ID, известный с прошлого события
};

const MAX_BITRIX_EVENTS = 5000;

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
};
