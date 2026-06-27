/* THE HELLO Team — отправка уведомлений об ошибках в Telegram.
   Без внешних зависимостей: только встроенный модуль https.
   Токен бота и chat_id — ТОЛЬКО переменные окружения Render
   (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID), никогда не в коде/чате. */
"use strict";
const https = require("https");

function token() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}
function chatId() {
  return process.env.TELEGRAM_CHAT_ID || "";
}

function isConfigured() {
  return !!(token() && chatId());
}

// Отправляет одно сообщение. Никогда не выбрасывает исключение — ошибка
// отправки в Telegram не должна ронять фоновые проверки/синки.
function send(text) {
  return new Promise((resolve) => {
    if (!isConfigured()) {
      console.log("[telegram] не настроен (нет TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) — сообщение не отправлено:\n" + text);
      return resolve({ ok: false, error: "not_configured" });
    }
    const body = JSON.stringify({ chat_id: chatId(), text: text });
    const options = {
      hostname: "api.telegram.org",
      path: "/bot" + token() + "/sendMessage",
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error("[telegram] sendMessage HTTP " + res.statusCode + ": " + raw.slice(0, 300));
          return resolve({ ok: false, error: "Telegram API [" + res.statusCode + "]: " + raw.slice(0, 300) });
        }
        resolve({ ok: true });
      });
    });
    req.on("error", (e) => {
      console.error("[telegram] ошибка соединения: " + e.message);
      resolve({ ok: false, error: e.message });
    });
    req.on("timeout", () => {
      req.destroy();
      console.error("[telegram] таймаут запроса");
      resolve({ ok: false, error: "таймаут запроса" });
    });
    req.write(body);
    req.end();
  });
}

// Шлёт сообщение только тогда, когда состояние ошибки ИЗМЕНИЛОСЬ с прошлой
// проверки — иначе при фоновой проверке каждые 5-15 минут одно и то же
// сообщение прилетало бы снова и снова, пока проблема не устранена.
// store — модуль server/store.js (передаётся снаружи, чтобы не делать
// круговую зависимость telegram.js <-> store.js).
async function notifyIfChanged(store, key, label, currentError) {
  const state = store.readState();
  const notifyState = Object.assign({}, state.notifyState || {});
  const prev = Object.prototype.hasOwnProperty.call(notifyState, key) ? notifyState[key] : null;
  const curr = currentError || null;
  if (prev === curr) return; // ничего не изменилось — не шлём повторно

  notifyState[key] = curr;
  store.patchState({ notifyState: notifyState });

  if (curr) {
    await send("⚠️ " + label + " — ошибка:\n" + curr);
  } else if (prev) {
    await send("✅ " + label + " — ошибка устранена, работает снова.");
  }
}

module.exports = { send, notifyIfChanged, isConfigured };
