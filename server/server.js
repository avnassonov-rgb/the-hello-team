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
const bitrixApp = require("./bitrixApp");
const oneC = require("./oneC");
const kaspi = require("./kaspi");
const telegram = require("./telegram");
const kaspiTransfer = require("./kaspiTransfer");

const INSTALL_HTML = "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
  "<title>THE HELLO — установка приложения</title></head>" +
  "<body style=\"font-family:sans-serif;padding:40px;text-align:center;color:#1F1F1F;\">" +
  "<p id=\"thStatus\">Подключение приложения...</p>" +
  "<script src=\"//api.bitrix24.com/api/v1/\"></script>" +
  "<script>" +
  "try{if(window.BX24){BX24.init(function(){BX24.installFinish();document.getElementById('thStatus').textContent='Готово. Можно закрыть это окно.';});}" +
  "else{document.getElementById('thStatus').textContent='Готово. Можно закрыть это окно.';}}" +
  "catch(e){document.getElementById('thStatus').textContent='Готово. Можно закрыть это окно.';}" +
  "</script></body></html>";

function readBodyForm(req, maxBytes, cb) {
  let total = 0;
  const chunks = [];
  req.on("data", (chunk) => {
    total += chunk.length;
    if (total > maxBytes) { req.destroy(); return cb(new Error("payload too large")); }
    chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      cb(null, bitrixApp.parseFormEncoded(Buffer.concat(chunks).toString("utf8")));
    } catch (e) {
      cb(e);
    }
  });
  req.on("error", cb);
}

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

  // ---- Bitrix24: установка локального приложения и приём событий ----
  // Эти запросы шлёт сам Bitrix24, без нашей куки авторизации — поэтому
  // они вынесены за пределы блока /api/, где требуется логин.
  if (pathname === "/bitrix/install" && (req.method === "GET" || req.method === "POST")) {
    console.log("[bitrix] /bitrix/install " + req.method + " получен");
    if (req.method === "POST") {
      return readBodyForm(req, 1024 * 50, (err, fields) => {
        if (err) { console.error("[bitrix] /bitrix/install: ошибка разбора тела — " + err.message); }
        const hasToken = !err && fields && (fields.AUTH_ID || (fields.auth && fields.auth.access_token));
        if (hasToken) {
          bitrixApp.handleInstallPost(fields);
          bitrixApp.bindEvents().catch((e) => console.error("[bitrix] bindEvents упал: " + e.message));
        } else if (!err) {
          console.error("[bitrix] /bitrix/install POST без токена доступа, поля: " + JSON.stringify(fields));
        }
        send(res, 200, INSTALL_HTML, { "Content-Type": "text/html; charset=utf-8" });
      });
    }
    return send(res, 200, INSTALL_HTML, { "Content-Type": "text/html; charset=utf-8" });
  }
  if (pathname === "/bitrix/event" && req.method === "POST") {
    return readBodyForm(req, 1024 * 100, (err, fields) => {
      if (err) {
        console.error("[bitrix] /bitrix/event: ошибка разбора тела — " + err.message);
      } else if (fields) {
        bitrixApp.handleEvent(fields).catch((e) => console.error("[bitrix] handleEvent упал: " + e.message));
      }
      send(res, 200, "ok"); // всегда 200, иначе Bitrix24 будет повторять доставку
    });
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
    if (pathname === "/api/onec/refresh" && req.method === "POST") {
      return oneC.refreshSafe().then((result) => {
        sendJSON(res, 200, { ok: result.ok, error: result.error || null, state: store.readState() });
      });
    }
    if (pathname === "/api/kaspi/debug" && req.method === "GET") {
      const q = parsed.query || {};
      const allowedStates = ["NEW", "SIGN_REQUIRED", "PICKUP", "DELIVERY", "KASPI_DELIVERY", "ARCHIVE"];
      const state = allowedStates.indexOf(q.state) !== -1 ? q.state : "NEW";
      const maxOrders = Math.min(parseInt(q.n, 10) || 5, 20);
      return kaspi.debugSample({ state: state, maxOrders: maxOrders })
        .then((result) => sendJSON(res, 200, { ok: true, result: result }))
        .catch((err) => sendJSON(res, 200, { ok: false, error: "kaspi_error", message: err.message }));
    }
    if (pathname === "/api/kaspi/products" && req.method === "GET") {
      const q = parsed.query || {};
      const allowedStates = ["NEW", "SIGN_REQUIRED", "PICKUP", "DELIVERY", "KASPI_DELIVERY", "ARCHIVE"];
      const state = allowedStates.indexOf(q.state) !== -1 ? q.state : "ARCHIVE";
      const maxOrders = Math.min(parseInt(q.n, 10) || 40, 100);
      return kaspi.listDistinctProducts({ state: state, maxOrders: maxOrders })
        .then((result) => sendJSON(res, 200, { ok: true, result: result }))
        .catch((err) => sendJSON(res, 200, { ok: false, error: "kaspi_error", message: err.message }));
    }
    if (pathname === "/api/kaspi/order-raw" && req.method === "GET") {
      const q = parsed.query || {};
      if (!q.code) return sendJSON(res, 200, { ok: false, error: "bad_request", message: "укажите ?code=<номер заказа>" });
      return kaspi.getOrderRawByCode(q.code)
        .then((result) => sendJSON(res, 200, { ok: true, result: result }))
        .catch((err) => sendJSON(res, 200, { ok: false, error: "kaspi_error", message: err.message }));
    }
    if (pathname === "/api/kaspi-transfer/run" && req.method === "POST") {
      const q = parsed.query || {};
      const options = {};
      if (q.orderId) options.orderId = q.orderId;
      if (q.dryRun === "1" || q.dryRun === "true") options.dryRun = true;
      return kaspiTransfer.runKaspiTransferSafe(options).then((result) => {
        sendJSON(res, 200, { ok: result.ok, error: result.error || null, summary: result.summary || null, state: store.getKaspiTransferState() });
      });
    }
    if (pathname === "/api/kaspi-transfer/status" && req.method === "GET") {
      return sendJSON(res, 200, { ok: true, state: store.getKaspiTransferState() });
    }
    if (pathname === "/api/onec/metadata" && req.method === "GET") {
      const q = parsed.query || {};
      const substr = q.entity || "РеализацияТоваровУслуг";
      return oneC.fetchMetadataFragment(substr, 8000)
        .then((result) => sendJSON(res, 200, { ok: true, result: result }))
        .catch((err) => sendJSON(res, 200, { ok: false, error: "onec_error", message: err.message }));
    }
    if (pathname === "/api/telegram/test" && req.method === "GET") {
      return telegram.send("✅ Тестовое сообщение от дашборда THE HELLO Team — бот настроен правильно.")
        .then((result) => sendJSON(res, 200, result));
    }
    if (pathname === "/api/bitrix/report" && req.method === "GET") {
      const webhookUrl = process.env.BITRIX_WEBHOOK_URL;
      if (!webhookUrl) {
        return sendJSON(res, 200, { ok: false, error: "no_webhook", message: "Вебхук Bitrix24 не настроен. Задайте переменную окружения BITRIX_WEBHOOK_URL в настройках Render." });
      }
      const q = parsed.query || {};
      let range = q.from ? bitrix.customRange(q.from, q.to || q.from) : null;
      if (!range) {
        const allowedPeriods = ["today", "yesterday", "week", "month"];
        const period = allowedPeriods.indexOf(q.period) !== -1 ? q.period : "today";
        range = bitrix.periodRange(period);
      }
      return bitrix.getManagerReport(webhookUrl, range)
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

  // ---- автосинк с 1С: план производства теперь обновляется сам, без ручной загрузки файлов ----
  const ONE_C_INTERVAL_MS = 5 * 60 * 1000;
  if (process.env.ONEC_PASSWORD) {
    console.log("[1C] автосинк включён — обновление каждые 5 минут");
    setTimeout(() => { oneC.refreshSafe(); }, 3000); // первый запуск чуть после старта
    setInterval(() => { oneC.refreshSafe(); }, ONE_C_INTERVAL_MS);
  } else {
    console.log("[1C] автосинк выключен — не задана переменная окружения ONEC_PASSWORD");
  }

  // ---- фоновая проверка связи с Bitrix24 (для вкладки «Менеджеры»): раз в 10 минут,
  // отдельно от обычных запросов отчёта — чтобы ловить сбой даже если никто не
  // открывал вкладку. При смене состояния (ошибка появилась/пропала) — Telegram. ----
  const BITRIX_CHECK_INTERVAL_MS = 10 * 60 * 1000;
  function checkBitrixHealth() {
    const webhookUrl = process.env.BITRIX_WEBHOOK_URL;
    if (!webhookUrl) return;
    bitrix.healthCheck(webhookUrl)
      .then(() => telegram.notifyIfChanged(store, "bitrix", "Менеджеры (Bitrix24)", null))
      .catch((e) => telegram.notifyIfChanged(store, "bitrix", "Менеджеры (Bitrix24)", e.message))
      .catch((te) => console.error("[telegram] notifyIfChanged упал: " + te.message));
  }
  if (process.env.BITRIX_WEBHOOK_URL) {
    console.log("[bitrix] фоновая проверка связи включена — каждые 10 минут");
    setTimeout(checkBitrixHealth, 5000);
    setInterval(checkBitrixHealth, BITRIX_CHECK_INTERVAL_MS);
  } else {
    console.log("[bitrix] фоновая проверка выключена — не задана переменная BITRIX_WEBHOOK_URL");
  }

  // ---- фоновая проверка связи/токена Kaspi: раз в 15 минут. Пока это только
  // диагностика (сам перенос заказов Kaspi → 1С ещё не реализован) — но как
  // только он появится, эта же проверка будет страховать и его. ----
  const KASPI_CHECK_INTERVAL_MS = 15 * 60 * 1000;
  function checkKaspiHealth() {
    kaspi.healthCheck()
      .then(() => telegram.notifyIfChanged(store, "kaspi", "Kaspi API", null))
      .catch((e) => telegram.notifyIfChanged(store, "kaspi", "Kaspi API", e.message))
      .catch((te) => console.error("[telegram] notifyIfChanged упал: " + te.message));
  }
  if (process.env.KASPI_TOKEN) {
    console.log("[kaspi] фоновая проверка связи включена — каждые 15 минут");
    setTimeout(checkKaspiHealth, 7000);
    setInterval(checkKaspiHealth, KASPI_CHECK_INTERVAL_MS);
  } else {
    console.log("[kaspi] фоновая проверка выключена — не задана переменная KASPI_TOKEN");
  }

  // ---- перенос заказов Kaspi → 1С: запускается строго 2 раза в день, в 08:00
  // и 13:10 по времени Костаная (UTC+5, без перевода времени на зиму/лето —
  // поэтому это ровно 03:00 и 08:10 по UTC, без исключений). НЕ постоянный
  // цикл — раз запущено в нужный момент, следующий запуск планируется через
  // ровно 24 часа (смещение Костаная фиксированное, поэтому 24 часа = снова
  // то же самое время суток в Костанае, без накопления ошибки). ----
  function msUntilNextUtcTime(hourUtc, minuteUtc) {
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, minuteUtc, 0, 0));
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }
  function scheduleDailyKaspiTransfer(hourUtc, minuteUtc, label) {
    const delayMs = msUntilNextUtcTime(hourUtc, minuteUtc);
    console.log("[kaspiTransfer] запуск \"" + label + "\" запланирован через " + Math.round(delayMs / 60000) + " мин.");
    setTimeout(function fireAndRepeat() {
      console.log("[kaspiTransfer] запуск \"" + label + "\" (по расписанию)");
      kaspiTransfer.runKaspiTransferSafe();
      setInterval(() => {
        console.log("[kaspiTransfer] запуск \"" + label + "\" (по расписанию)");
        kaspiTransfer.runKaspiTransferSafe();
      }, 24 * 60 * 60 * 1000);
    }, delayMs);
  }
  const kaspiTransferReady = process.env.ONEC_PASSWORD && process.env.KASPI_TOKEN && process.env.MAPPING_SHEET_CSV_URL;
  if (kaspiTransferReady) {
    console.log("[kaspiTransfer] расписание включено — запуск в 08:00 и 13:10 по Костанаю");
    scheduleDailyKaspiTransfer(3, 0, "08:00 Костанай");
    scheduleDailyKaspiTransfer(8, 10, "13:10 Костанай");
  } else {
    const missing = [];
    if (!process.env.ONEC_PASSWORD) missing.push("ONEC_PASSWORD");
    if (!process.env.KASPI_TOKEN) missing.push("KASPI_TOKEN");
    if (!process.env.MAPPING_SHEET_CSV_URL) missing.push("MAPPING_SHEET_CSV_URL");
    console.log("[kaspiTransfer] расписание выключено — не заданы переменные: " + missing.join(", "));
  }
});
