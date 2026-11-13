/* Универсальный запрос к Kaspi Seller API (для MCP-инструмента kaspi_request).
   База: https://kaspi.kz/shop/api/v2/ ; токен только из переменной KASPI_TOKEN.
   Endpoint — только путь внутри этой базы (без хоста, без «..»): запрос не может уйти на другой адрес.
   Ответ возвращается как есть: статус, тип и тело (JSON разобран, остальное — текстом). */
"use strict";
const https = require("https");

const HOST = "kaspi.kz";
const BASE_PATH = "/shop/api/v2/";
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const MAX_BODY_CHARS = 1000000;

function request(args) {
  args = args || {};
  const token = process.env.KASPI_TOKEN || "";
  if (!token) return Promise.reject(new Error("Не задан KASPI_TOKEN в переменных окружения Render"));

  const method = String(args.method || "GET").toUpperCase();
  if (METHODS.indexOf(method) === -1) return Promise.reject(new Error("method: допустимы " + METHODS.join(", ")));
  if (method !== "GET" && process.env.KASPI_REQUEST_WRITE !== "1") {
    return Promise.reject(new Error("Запись в Kaspi выключена: разрешён только GET. Чтобы включить POST/PATCH/PUT/DELETE, владелец должен задать KASPI_REQUEST_WRITE=1 в Render → Environment."));
  }

  const endpoint = String(args.endpoint || "").trim().replace(/^\/+/, "");
  if (!endpoint || !/^[A-Za-z0-9_\-\/.()']+$/.test(endpoint) || endpoint.indexOf("..") !== -1 || endpoint.indexOf("//") !== -1) {
    return Promise.reject(new Error("endpoint: нужен путь внутри /shop/api/v2/, например orders или orders/123/entries"));
  }

  const pairs = [];
  const q = args.query;
  if (q && typeof q === "object") {
    Object.keys(q).forEach((k) => {
      const v = q[k];
      if (v === undefined || v === null || v === "") return;
      pairs.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    });
  } else if (typeof q === "string" && q.trim()) {
    return Promise.reject(new Error("query: передайте объектом, например {\"filter[orders][state]\":\"NEW\"}"));
  }
  const path = BASE_PATH + endpoint + (pairs.length ? "?" + pairs.join("&") : "");

  let payload = null;
  if (args.body !== undefined && args.body !== null && args.body !== "") {
    if (method === "GET") return Promise.reject(new Error("у GET-запроса не бывает body"));
    payload = Buffer.from(typeof args.body === "string" ? args.body : JSON.stringify(args.body), "utf8");
  }

  const headers = { "X-Auth-Token": token, "Accept": "*/*", "Content-Type": "application/vnd.api+json" };
  if (method !== "GET") headers["X-Merchant-Uid"] = process.env.KASPI_MERCHANT_ID || "4480004";
  if (payload) headers["Content-Length"] = payload.length;

  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: HOST, path, method, headers, timeout: 30000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const ct = String(res.headers["content-type"] || "");
        const out = { status: res.statusCode, contentType: ct };
        if (/json|text|xml|html/i.test(ct) || !ct) {
          let text = buf.toString("utf8");
          if (text.length > MAX_BODY_CHARS) { out.truncated = true; text = text.slice(0, MAX_BODY_CHARS); }
          try { out.body = JSON.parse(text); } catch (e) { out.body = text; }
        } else {
          out.body = "(бинарный ответ " + buf.length + " байт, тип " + ct + " — не передаётся)";
        }
        resolve(out);
      });
    });
    req.on("error", (e) => reject(new Error("Kaspi API: ошибка соединения — " + e.message)));
    req.on("timeout", () => req.destroy(new Error("Kaspi API: таймаут запроса")));
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request };
