/* THE HELLO Team — локальное приложение Bitrix24.
   Зачем: входящий вебхук не знает, КТО именно совершил действие (создал/
   переместил/удалил карточку) — только текущего ответственного. Локальное
   приложение подписывается на события CRM (event.bind); каждое уведомление
   приходит с токеном именно того пользователя, который выполнил действие —
   это даёт точную привязку.

   Без внешних зависимостей: только встроенные модули Node.js.
   Ключи приложения (BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET) — переменные
   окружения Render, в коде/репозитории НЕ хранятся. */
"use strict";
const https = require("https");
const { URL } = require("url");
const store = require("./store");

const CLIENT_ID = process.env.BITRIX_CLIENT_ID;
const CLIENT_SECRET = process.env.BITRIX_CLIENT_SECRET;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "https://the-hello-team.onrender.com").replace(/\/+$/, "");

const EVENTS_TO_BIND = [
  "ONCRMDEALADD", "ONCRMDEALUPDATE", "ONCRMDEALDELETE",
  "ONCRMLEADADD", "ONCRMLEADUPDATE", "ONCRMLEADDELETE",
];

const ENTITY_MAP = {
  ONCRMDEALADD: { type: "deal", action: "add" },
  ONCRMDEALUPDATE: { type: "deal", action: "update" },
  ONCRMDEALDELETE: { type: "deal", action: "delete" },
  ONCRMLEADADD: { type: "lead", action: "add" },
  ONCRMLEADUPDATE: { type: "lead", action: "update" },
  ONCRMLEADDELETE: { type: "lead", action: "delete" },
};

/* ---------------- разбор form-urlencoded с вложенными ключами ---------------- */
// Bitrix24 шлёт события как data[FIELDS][ID]=123&auth[access_token]=... —
// разворачиваем это в обычный вложенный объект.
function parseFormEncoded(bodyStr) {
  const out = {};
  (bodyStr || "").split("&").forEach((pair) => {
    if (!pair) return;
    const eq = pair.indexOf("=");
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawVal = eq < 0 ? "" : pair.slice(eq + 1);
    let key, val;
    try { key = decodeURIComponent(rawKey.replace(/\+/g, " ")); } catch (e) { key = rawKey; }
    try { val = decodeURIComponent(rawVal.replace(/\+/g, " ")); } catch (e) { val = rawVal; }
    const m = key.match(/^([^\[\]]+)((?:\[[^\[\]]*\])*)$/);
    if (!m) { out[key] = val; return; }
    const parts = [m[1]];
    const re = /\[([^\[\]]*)\]/g;
    let mm;
    while ((mm = re.exec(m[2]))) parts.push(mm[1]);
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = val;
  });
  return out;
}

/* ---------------- низкоуровневые HTTP-запросы ---------------- */
function httpPostForm(targetUrl, fields) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(targetUrl); } catch (e) { return reject(new Error("Некорректный URL: " + targetUrl)); }
    const body = Object.keys(fields)
      .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(fields[k] == null ? "" : fields[k]))
      .join("&");
    const options = {
      hostname: base.hostname,
      path: base.pathname + (base.search || ""),
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) },
      timeout: 20000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch (e) { return reject(new Error("Ответ не в формате JSON")); }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Таймаут запроса к " + targetUrl)));
    req.write(body);
    req.end();
  });
}

function httpPostJSON(targetUrl, params) {
  return new Promise((resolve, reject) => {
    let base;
    try { base = new URL(targetUrl); } catch (e) { return reject(new Error("Некорректный URL: " + targetUrl)); }
    const body = JSON.stringify(params || {});
    const options = {
      hostname: base.hostname,
      path: base.pathname + (base.search || ""),
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) },
      timeout: 20000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch (e) { return reject(new Error("Ответ не в формате JSON")); }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Таймаут запроса к " + targetUrl)));
    req.write(body);
    req.end();
  });
}

/* ---------------- установка приложения / токены ---------------- */
// Bitrix24 шлёт данные установки (событие ONAPPINSTALL) в том же формате,
// что и обычные события: токен лежит во вложенном блоке fields.auth, а не
// в плоских полях AUTH_ID/REFRESH_ID — учитываем оба варианта на всякий случай.
function handleInstallPost(fields) {
  console.log("[bitrix] /bitrix/install POST fields keys=" + Object.keys(fields || {}).join(","));
  const a = (fields && fields.auth) || {};
  const accessToken = fields && (fields.AUTH_ID || a.access_token);
  if (!fields || !accessToken) {
    console.error("[bitrix] handleInstallPost: нет токена доступа в теле запроса (ни AUTH_ID, ни auth.access_token) — установка не сохранена");
    return null;
  }
  const existing = store.getBitrixApp() || {};
  const domain = fields.DOMAIN || a.domain || existing.domain;
  const clientEndpoint = a.client_endpoint || (domain ? "https://" + domain + "/rest/" : existing.clientEndpoint);
  const expiresIn = Number(fields.AUTH_EXPIRES || a.expires_in || 3600);
  const next = Object.assign({}, existing, {
    accessToken: accessToken,
    refreshToken: fields.REFRESH_ID || a.refresh_token || existing.refreshToken,
    expiresAt: Date.now() + (expiresIn - 60) * 1000,
    domain: domain,
    memberId: fields.member_id || a.member_id || existing.memberId,
    clientEndpoint: clientEndpoint,
  });
  store.setBitrixApp(next);
  console.log("[bitrix] handleInstallPost: токены сохранены, domain=" + domain + " clientEndpoint=" + clientEndpoint);
  return next;
}

async function refreshAccessToken() {
  const app = store.getBitrixApp();
  if (!app || !app.refreshToken) throw new Error("Приложение Bitrix24 не установлено (нет refresh_token)");
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("Не заданы BITRIX_CLIENT_ID / BITRIX_CLIENT_SECRET на сервере");
  const data = await httpPostForm("https://oauth.bitrix.info/oauth/token/", {
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: app.refreshToken,
  });
  if (!data || !data.access_token) {
    throw new Error("Bitrix24 OAuth: не удалось обновить токен — " + (data && (data.error_description || data.error)));
  }
  const next = Object.assign({}, app, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || app.refreshToken,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
    clientEndpoint: data.client_endpoint || app.clientEndpoint,
    domain: data.domain || app.domain,
    memberId: data.member_id || app.memberId,
  });
  store.setBitrixApp(next);
  return next;
}

async function getValidApp() {
  let app = store.getBitrixApp();
  if (!app || !app.accessToken) throw new Error("Приложение Bitrix24 не установлено");
  if (!app.expiresAt || Date.now() > app.expiresAt) app = await refreshAccessToken();
  return app;
}

async function callAppMethod(method, params) {
  const app = await getValidApp();
  const url = app.clientEndpoint + method + ".json";
  let data = await httpPostJSON(url, Object.assign({}, params, { auth: app.accessToken }));
  if (data && (data.error === "expired_token" || data.error === "invalid_token")) {
    const refreshed = await refreshAccessToken();
    data = await httpPostJSON(url, Object.assign({}, params, { auth: refreshed.accessToken }));
  }
  if (data && data.error) {
    console.error("[bitrix] callAppMethod " + method + " error: " + (data.error_description || data.error));
    throw new Error("Bitrix24 [" + method + "]: " + (data.error_description || data.error));
  }
  return data;
}

async function bindEvents() {
  const handler = PUBLIC_BASE_URL + "/bitrix/event";
  const results = [];
  for (let i = 0; i < EVENTS_TO_BIND.length; i++) {
    const evt = EVENTS_TO_BIND[i];
    try {
      const res = await callAppMethod("event.bind", { event: evt, handler: handler });
      results.push({ event: evt, ok: !(res && res.error), raw: res });
    } catch (e) {
      results.push({ event: evt, ok: false, error: e.message });
    }
  }
  console.log("[bitrix] bindEvents handler=" + handler + " results=" + JSON.stringify(results));
  return results;
}

/* ---------------- приём событий ---------------- */
async function resolveActor(authBlock) {
  if (!authBlock || !authBlock.access_token) {
    console.error("[bitrix] resolveActor: в событии нет auth.access_token — " + (authBlock ? JSON.stringify(Object.keys(authBlock)) : "auth отсутствует совсем"));
    return null;
  }
  try {
    const app = store.getBitrixApp();
    const endpoint = (app && app.clientEndpoint) || (authBlock.domain ? "https://" + authBlock.domain + "/rest/" : null);
    if (!endpoint) { console.error("[bitrix] resolveActor: не удалось определить endpoint"); return null; }
    const data = await httpPostJSON(endpoint + "user.current.json", { auth: authBlock.access_token });
    if (data && data.result) {
      const u = data.result;
      console.log("[bitrix] resolveActor: автор = " + u.ID + " " + u.NAME + " " + u.LAST_NAME);
      return { id: String(u.ID), name: ((u.NAME || "") + " " + (u.LAST_NAME || "")).trim() || ("Пользователь #" + u.ID) };
    }
    console.error("[bitrix] resolveActor: user.current вернул без result: " + JSON.stringify(data));
  } catch (e) {
    console.error("[bitrix] resolveActor: ошибка — " + e.message);
  }
  return null;
}

async function handleEvent(parsed) {
  const eventName = String((parsed && parsed.event) || "").toUpperCase();
  const meta = ENTITY_MAP[eventName];
  console.log("[bitrix] /bitrix/event получено: event=" + eventName + " hasAuth=" + !!(parsed && parsed.auth && parsed.auth.access_token));
  if (!meta) { console.error("[bitrix] handleEvent: неизвестное событие " + eventName); return { ok: false, skipped: true, reason: "unknown_event" }; }

  const entityId = parsed.data && parsed.data.FIELDS && parsed.data.FIELDS.ID;
  if (!entityId) { console.error("[bitrix] handleEvent: нет ID карточки в событии " + eventName); return { ok: false, skipped: true, reason: "no_id" }; }

  const actor = await resolveActor(parsed.auth);
  const now = new Date().toISOString();

  if (meta.action === "delete") {
    store.deleteCachedStage(meta.type, entityId);
    store.appendBitrixEvent({
      time: now, entityType: meta.type, entityId: String(entityId), type: "deleted",
      fromStage: null, toStage: null,
      actorId: actor ? actor.id : null, actorName: actor ? actor.name : null,
    });
    return { ok: true };
  }

  const stageField = meta.type === "deal" ? "STAGE_ID" : "STATUS_ID";
  let entity = null;
  try {
    const method = meta.type === "deal" ? "crm.deal.get" : "crm.lead.get";
    const data = await callAppMethod(method, { id: entityId });
    entity = data && data.result;
  } catch (e) {
    console.error("[bitrix] handleEvent: не удалось получить карточку " + meta.type + " #" + entityId + " — " + e.message);
    entity = null;
  }
  const currentStage = entity ? entity[stageField] : null;

  if (meta.action === "add") {
    if (currentStage != null) store.setCachedStage(meta.type, entityId, currentStage);
    console.log("[bitrix] handleEvent: created " + meta.type + " #" + entityId + " stage=" + currentStage + " actor=" + (actor ? actor.id + " " + actor.name : "null"));
    store.appendBitrixEvent({
      time: now, entityType: meta.type, entityId: String(entityId), type: "created",
      fromStage: null, toStage: currentStage,
      actorId: actor ? actor.id : null, actorName: actor ? actor.name : null,
    });
    return { ok: true };
  }

  // update — сравниваем с последним известным этапом, чтобы понять, было ли это перемещение
  const prevStage = store.getCachedStage(meta.type, entityId);
  console.log("[bitrix] handleEvent: update " + meta.type + " #" + entityId + " prevStage=" + prevStage + " currentStage=" + currentStage + " actor=" + (actor ? actor.id + " " + actor.name : "null"));
  if (currentStage != null && prevStage != null && String(currentStage) !== String(prevStage)) {
    store.appendBitrixEvent({
      time: now, entityType: meta.type, entityId: String(entityId), type: "moved",
      fromStage: prevStage, toStage: currentStage,
      actorId: actor ? actor.id : null, actorName: actor ? actor.name : null,
    });
  } else {
    console.log("[bitrix] handleEvent: изменений этапа не обнаружено (либо prevStage не был закэширован) — событие 'moved' не записано");
  }
  if (currentStage != null) store.setCachedStage(meta.type, entityId, currentStage);
  return { ok: true };
}

module.exports = {
  parseFormEncoded,
  handleInstallPost,
  bindEvents,
  handleEvent,
  callAppMethod,
  getValidApp,
  isConfigured: function () { return !!(CLIENT_ID && CLIENT_SECRET); },
};
