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
  // ---- Сотрудники: ФИО/телефон/роли/Telegram-ID, для бота и маршрутизации
  // уведомлений (например, кто сейчас "Зав.складом" получает накладные). ----
  employees: [], // { id, name, phone, roles: [string], telegramId: string|null, status: "active"|"inactive", updatedAt }
  employeeRoles: [
    { name: "Зав.складом", description: "Получает накладные (стикеры) по заказам Kaspi в Telegram." },
  ],
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
// Снимает отметку "уже перенесён" с ОДНОГО заказа — нужно, когда Александр
// вручную удалил/исправил документ Реализация в 1С и хочет НАМЕРЕННО
// повторить перенос того же заказа (защита от задвоения из
// project_kaspi_duplicate_realization_fix иначе всегда блокирует повтор).
// Возвращает true, если заказ действительно был отмечен и отметка снята.
function unmarkKaspiOrderProcessed(orderId) {
  const state = readState();
  const kt = Object.assign({}, DEFAULT_STATE.kaspiTransfer, state.kaspiTransfer || {});
  const idStr = String(orderId);
  const before = kt.processedOrderIds || [];
  const list = before.filter((id) => id !== idStr);
  const changed = list.length !== before.length;
  if (changed) patchState({ kaspiTransfer: Object.assign({}, kt, { processedOrderIds: list }) });
  return changed;
}

// ---- Сотрудники ----
function genEmployeeId() {
  return "emp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function getEmployees() {
  const state = readState();
  return Array.isArray(state.employees) ? state.employees : [];
}
function getEmployeeRoles() {
  const state = readState();
  return Array.isArray(state.employeeRoles) ? state.employeeRoles : DEFAULT_STATE.employeeRoles;
}
function saveEmployeeRoles(list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((r) => ({ name: String(r.name || "").trim(), description: String(r.description || "").trim() }))
    .filter((r) => r.name);
  return patchState({ employeeRoles: clean });
}
function addEmployee(emp) {
  const list = getEmployees().slice();
  const next = {
    id: genEmployeeId(),
    name: String((emp && emp.name) || "").trim(),
    phone: String((emp && emp.phone) || "").trim(),
    roles: Array.isArray(emp && emp.roles) ? emp.roles.filter(Boolean) : [],
    telegramId: (emp && emp.telegramId) ? String(emp.telegramId).trim() : null,
    status: (emp && emp.status === "inactive") ? "inactive" : "active",
    updatedAt: new Date().toISOString(),
  };
  list.push(next);
  patchState({ employees: list });
  return next;
}
function updateEmployee(id, patch) {
  const list = getEmployees().slice();
  const idx = list.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  const merged = Object.assign({}, list[idx], patch || {}, { id: list[idx].id, updatedAt: new Date().toISOString() });
  if (patch && Object.prototype.hasOwnProperty.call(patch, "roles")) {
    merged.roles = Array.isArray(patch.roles) ? patch.roles.filter(Boolean) : [];
  }
  list[idx] = merged;
  patchState({ employees: list });
  return merged;
}
function deleteEmployee(id) {
  const list = getEmployees().filter((e) => e.id !== id);
  patchState({ employees: list });
  return list;
}
// Telegram chat_id'ы активных сотрудников с данной ролью (для маршрутизации,
// например, "Зав.складом" -> кому слать накладные Kaspi).
function findEmployeeChatIdsByRole(roleName) {
  return getEmployees()
    .filter((e) => e.status !== "inactive" && Array.isArray(e.roles) && e.roles.indexOf(roleName) !== -1 && e.telegramId)
    .map((e) => e.telegramId);
}
// Ищет сотрудника по Telegram chat_id (для ответа бота при входящем сообщении).
function findEmployeeByTelegramId(telegramId) {
  const id = String(telegramId || "");
  return getEmployees().find((e) => String(e.telegramId || "") === id) || null;
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
  unmarkKaspiOrderProcessed,
  getEmployees, getEmployeeRoles, saveEmployeeRoles, addEmployee, updateEmployee, deleteEmployee,
  findEmployeeChatIdsByRole, findEmployeeByTelegramId,
};
