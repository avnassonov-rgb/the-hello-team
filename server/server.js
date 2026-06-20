/* THE HELLO Team — сервер приложения «План производства».
   Без внешних зависимостей: только встроенные модули Node.js.
   Запуск: node server/server.js   (порт PORT, по умолчанию 3000) */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const store = require("./store");
const auth = require("./auth");
const bitrix = require("./bitrix");

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, headers || {}));
  res.end(body);
}
function sendJSON(res, status, obj, headers) {
  send(res, status, JSON.stringify(obj), Object.assign({ "Content-Type": "application/json; charset=utf-8" }, headers || {}));
}

function readBodyJSON(req, maxBytes, cb) {
  let total = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      cb(new Error("payload too large"));
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!chunks.length) return cb(null, {});
    try {
      cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (e) {
      cb(e);
    }
  });
  req.on("error", cb);
}

function serveStatic(req, res, pathname) {
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
  let filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err2, data) => {
      if (err2) return send(res, 500, "Server error");
      send(res, 200, data, { "Content-Type": MIME[ext] || "application/octet-stream" });
    });
  });
}

const PUBLIC_PATHS = new Set(["/login.html", "/css/brand.css", "/js/engine.js", "/js/login.js", "/favicon.ico"]);

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname);

  // ---- API ----
  if (pathname === "/api/login" && req.method === "POST") {
    return readBodyJSON(req, 1024, (err, body) => {
      if (err) return sendJSON(res, 400, { ok: false, error: "bad_request" });
      if (!auth.checkPassword(body.password)) return sendJSON(res, 401, { ok: false, error: "wrong_password" });
      sendJSON(res, 200, { ok: true }, { "Set-Cookie": auth.loginCookieHeader() });
    });
  }
  if (pathname === "/api/logout" && req.method === "POST") {
    return sendJSON(res, 200, { ok: true }, { "Set-Cookie": auth.logoutCookieHeader() });
  }
  if (pathname === "/api/me" && req.method === "GET") {
    return sendJSON(res, 200, { authed: auth.isAuthed(req) });
  }

  if (pathname.startsWith("/api/")) {
    if (!auth.isAuthed(req)) return sendJSON(res, 401, { ok: false, error: "auth_required" });

    if (pathname === "/api/state" && req.method === "GET") {
      return sendJSON(res, 200, store.readState());
    }
    if (pathname === "/api/upload" && req.method === "POST") {
      return readBodyJSON(req, 30 * 1024 * 1024, (err, body) => {
        if (err) return sendJSON(res, 400, { ok: false, error: "bad_request" });
        // Важно: загрузка файла 1 и файла 2 — это два РАЗНЫХ запроса.
        // Если в текущем запросе поле не пришло — нельзя затирать его null'ом,
        // нужно сохранить то, что уже лежит на сервере с предыдущей загрузки.
        const patch = {
          meta: {
            ordersFileName: body.ordersFileName || null,
            itemsFileName: body.itemsFileName || null,
            uploadedAt: new Date().toISOString(),
          },
        };
        if (Object.prototype.hasOwnProperty.call(body, "ordersRaw")) patch.ordersRaw = body.ordersRaw || null;
        if (Object.prototype.hasOwnProperty.call(body, "itemsRaw")) patch.itemsRaw = body.itemsRaw || null;
        const next = store.patchState(patch);
        sendJSON(res, 200, { ok: true, meta: next.meta });
      });
    }
    if (pathname === "/api/settings" && req.method === "POST") {
      return readBodyJSON(req, 1024 * 50, (err, body) => {
        if (err) return sendJSON(res, 400, { ok: false, error: "bad_request" });
        store.patchState({ settings: body });
        sendJSON(res, 200, { ok: true });
      });
    }
    if (pathname === "/api/control" && req.method === "POST") {
      return readBodyJSON(req, 1024 * 200, (err, body) => {
        if (err || !Array.isArray(body)) return sendJSON(res, 400, { ok: false, error: "bad_request" });
        store.patchState({ control: body });
        sendJSON(res, 200, { ok: true });
      });
    }
    if (pathname === "/api/bitrix/report" && req.method === "GET") {
      const webhookUrl = process.env.BITRIX_WEBHOOK_URL;
      if (!webhookUrl) {
        return sendJSON(res, 200, { ok: false, error: "no_webhook", message: "Вебхук Bitrix24 не настроен. Задайте переменную окружения BITRIX_WEBHOOK_URL в настройках Render." });
      }
      const allowedPeriods = ["today", "yesterday", "week", "month"];
      let period = parsed.query && parsed.query.period;
      if (allowedPeriods.indexOf(period) === -1) period = "today";
      return bitrix.getManagerReport(webhookUrl, period)
        .then((report) => sendJSON(res, 200, { ok: true, report: report }))
        .catch((err) => sendJSON(res, 200, { ok: false, error: "bitrix_error", message: err.message }));
    }
    return sendJSON(res, 404, { ok: false, error: "not_found" });
  }

  // ---- страницы / статика ----
  if (pathname === "/" ) {
    if (!auth.isAuthed(req)) return send(res, 302, "", { Location: "/login.html" });
    return send(res, 302, "", { Location: "/app.html" });
  }
  if (pathname === "/app.html" && !auth.isAuthed(req)) {
    return send(res, 302, "", { Location: "/login.html" });
  }
  if (pathname === "/login.html" && auth.isAuthed(req)) {
    return send(res, 302, "", { Location: "/app.html" });
  }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`THE HELLO Team — сервер запущен: http://localhost:${PORT}`);
  console.log(`Пароль входа: ${process.env.APP_PASSWORD ? "(задан в APP_PASSWORD)" : "thehello2026 (стандартный — смените перед публикацией!)"}`);
});
