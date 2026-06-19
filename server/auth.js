/* Простая общая аутентификация по одному паролю на всех.
   Без сторонних библиотек: подписанная cookie на базе HMAC-SHA256. */
"use strict";
const crypto = require("crypto");

const SECRET = process.env.APP_SECRET || "the-hello-team-default-secret-change-me";
const PASSWORD = process.env.APP_PASSWORD || "thehello2026";
const COOKIE_NAME = "th_session";
const MAX_AGE_MS = 30 * 24 * 3600 * 1000; // 30 дней

function sign(value) {
  const h = crypto.createHmac("sha256", SECRET).update(value).digest("hex");
  return `${value}.${h}`;
}
function verify(signed) {
  if (!signed) return null;
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const h = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", SECRET).update(value).digest("hex");
  if (h.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(expected))) return null;
  return value;
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  header.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i < 0) return;
    const k = p.slice(0, i).trim();
    const v = decodeURIComponent(p.slice(i + 1).trim());
    out[k] = v;
  });
  return out;
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  const value = verify(token);
  return value === "ok";
}

function checkPassword(pwd) {
  return typeof pwd === "string" && pwd.length > 0 && pwd === PASSWORD;
}

function loginCookieHeader() {
  const token = sign("ok");
  const expires = new Date(Date.now() + MAX_AGE_MS).toUTCString();
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires}`;
}
function logoutCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

module.exports = { isAuthed, checkPassword, loginCookieHeader, logoutCookieHeader, COOKIE_NAME };
