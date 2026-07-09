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
// Отдельный чат для зав.складом (накладные/стикеры) — если не задан,
// используем тот же чат, что и для обычных уведомлений об ошибках.
function warehouseChatId() {
  return process.env.TELEGRAM_WAREHOUSE_CHAT_ID || chatId();
}

function isConfigured() {
  return !!(token() && chatId());
}

// Отправляет сообщение в произвольный chat_id — используется и обычными
// уведомлениями (на дефолтный chatId()), и ответами бота входящим (chat_id
// того, кто написал боту, см. handleIncomingUpdate). Никогда не выбрасывает
// исключение — ошибка отправки в Telegram не должна ронять фоновые проверки.
function sendTo(targetChatId, text) {
  return new Promise((resolve) => {
    if (!token() || !targetChatId) {
      console.log("[telegram] не настроен (нет TELEGRAM_BOT_TOKEN или chat_id) — сообщение не отправлено:\n" + text);
      return resolve({ ok: false, error: "not_configured" });
    }
    const body = JSON.stringify({ chat_id: targetChatId, text: text });
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

// Отправляет одно сообщение в основной чат уведомлений (TELEGRAM_CHAT_ID).
function send(text) {
  if (!isConfigured()) {
    console.log("[telegram] не настроен (нет TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID) — сообщение не отправлено:\n" + text);
    return Promise.resolve({ ok: false, error: "not_configured" });
  }
  return sendTo(chatId(), text);
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

// Отправляет файл (PDF накладной) как документ — отдельным multipart-запросом
// (sendDocument умеет принимать ссылку на файл, но только если Telegram сам
// может её скачать без авторизации; ссылка Kaspi требует наш X-Auth-Token,
// поэтому файл сначала скачивается на сервере — см. kaspi.downloadWaybillPdf —
// а сюда передаётся уже готовый Buffer). Без внешних библиотек multipart
// собирается вручную. Никогда не выбрасывает исключение.
function sendDocument(buffer, filename, caption, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const targetChatId = opts.chatId || warehouseChatId();
    if (!token() || !targetChatId) {
      console.log("[telegram] не настроен (нет TELEGRAM_BOT_TOKEN или chat_id) — документ не отправлен: " + filename);
      return resolve({ ok: false, error: "not_configured" });
    }
    const boundary = "----THEHELLOBoundary" + Date.now().toString(16) + Math.random().toString(16).slice(2);
    const parts = [];
    function pushField(name, value) {
      parts.push(Buffer.from(
        "--" + boundary + "\r\n" +
        "Content-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" +
        value + "\r\n",
        "utf8"
      ));
    }
    pushField("chat_id", String(targetChatId));
    if (caption) pushField("caption", caption);
    parts.push(Buffer.from(
      "--" + boundary + "\r\n" +
      "Content-Disposition: form-data; name=\"document\"; filename=\"" + filename + "\"\r\n" +
      "Content-Type: application/pdf\r\n\r\n",
      "utf8"
    ));
    parts.push(buffer);
    parts.push(Buffer.from("\r\n--" + boundary + "--\r\n", "utf8"));
    const payload = Buffer.concat(parts);

    const options = {
      hostname: "api.telegram.org",
      path: "/bot" + token() + "/sendDocument",
      method: "POST",
      headers: {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": payload.length,
      },
      timeout: 300000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error("[telegram] sendDocument HTTP " + res.statusCode + ": " + raw.slice(0, 300));
          return resolve({ ok: false, error: "Telegram API [" + res.statusCode + "]: " + raw.slice(0, 300) });
        }
        resolve({ ok: true });
      });
    });
    req.on("error", (e) => {
      console.error("[telegram] sendDocument ошибка соединения: " + e.message);
      resolve({ ok: false, error: e.message });
    });
    req.on("timeout", () => {
      req.destroy();
      console.error("[telegram] sendDocument таймаут запроса");
      resolve({ ok: false, error: "таймаут запроса" });
    });
    req.write(payload);
    req.end();
  });
}

// ---- Приём входящих сообщений (вебхук /telegram/webhook в server.js) ----
// Когда сотрудник пишет боту в первый раз, бот не знает, кто это — он не
// видит номер телефона (Telegram его не передаёт), только свой внутренний
// chat_id. Поэтому бот присылает этот chat_id в ответ и просит передать его
// администратору, который сам впишет его нужному сотруднику на дашборде
// (вкладка «Сотрудники»). Если chat_id уже привязан к сотруднику — бот
// просто подтверждает, что узнал его.
const BOT_NAME = "Наталья";

function registrationMessage(chatId) {
  return "Здравствуйте! Я бот «" + BOT_NAME + "».\n\n" +
    "Ваш Telegram ID: " + chatId + "\n\n" +
    "Пожалуйста, передайте этот номер администратору — он добавит вас в систему " +
    "(вкладка «Сотрудники» на дашборде). После этого я смогу присылать вам нужные " +
    "сообщения (например, накладные по заказам).";
}
function knownContactMessage(employee) {
  const roles = Array.isArray(employee.roles) && employee.roles.length ? employee.roles.join(", ") : "без роли";
  return "Здравствуйте, " + (employee.name || "коллега") + "! Я бот «" + BOT_NAME + "», уже узнал вас (" + roles + "). " +
    "Дальше всё будет приходить сюда автоматически.";
}

// store — модуль server/store.js (передаётся снаружи, как и в notifyIfChanged,
// чтобы не делать круговую зависимость telegram.js <-> store.js).
async function handleIncomingUpdate(update, store) {
  try {
    const msg = update && (update.message || update.edited_message);
    const chat = msg && msg.chat;
    if (!chat || chat.id == null) return; // не текстовое сообщение от пользователя — игнорируем молча

    const chatIdStr = String(chat.id);
    const employee = store.findEmployeeByTelegramId(chatIdStr);
    if (employee) {
      await sendTo(chatIdStr, knownContactMessage(employee));
    } else {
      await sendTo(chatIdStr, registrationMessage(chatIdStr));
    }
  } catch (e) {
    console.error("[telegram] handleIncomingUpdate упал: " + e.message);
  }
}

// ---- Регистрация вебхука у Telegram (один раз при старте сервера) ----
// baseUrl — публичный адрес нашего сервера (Render даёт его автоматически
// в переменной RENDER_EXTERNAL_URL; если её нет — берём PUBLIC_BASE_URL,
// которую можно задать вручную). Без него зарегистрировать вебхук нельзя —
// тогда бот продолжит работать на отправку, просто не будет принимать
// сообщения от сотрудников (и /telegram/webhook не настроен).
function ensureWebhook(baseUrl) {
  return new Promise((resolve) => {
    if (!token()) return resolve({ ok: false, error: "no_token" });
    if (!baseUrl) return resolve({ ok: false, error: "no_base_url" });
    const webhookUrl = baseUrl.replace(/\/$/, "") + "/telegram/webhook";
    const payload = { url: webhookUrl };
    if (process.env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token = process.env.TELEGRAM_WEBHOOK_SECRET;
    const body = JSON.stringify(payload);
    const options = {
      hostname: "api.telegram.org",
      path: "/bot" + token() + "/setWebhook",
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) },
      timeout: 10000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return resolve({ ok: false, error: "Telegram API [" + res.statusCode + "]: " + raw.slice(0, 300) });
        }
        resolve({ ok: true, url: webhookUrl });
      });
    });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "таймаут запроса" }); });
    req.write(body);
    req.end();
  });
}

module.exports = { send, sendTo, sendDocument, notifyIfChanged, isConfigured, handleIncomingUpdate, ensureWebhook };
