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
};

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

module.exports = { readState, writeState, patchState, DATA_DIR, STATE_FILE };
