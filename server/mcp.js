/* MCP-сервер дашборда THE HELLO Team (только чтение).
   Позволяет подключить дашборд к Claude как «пользовательский коннектор» и задавать вопросы по
   продажам, Kaspi, блогерам и плану производства.
   Адрес: https://<домен>/mcp/<MCP_SECRET>   (секрет задаётся переменной окружения MCP_SECRET на Render).
   Без MCP_SECRET адрес отключён (404). Протокол: MCP «Streamable HTTP», JSON-RPC 2.0 без внешних зависимостей. */
"use strict";
const crypto = require("crypto");
const store = require("./store");
const salesStats = require("./salesStats");
const bloggers = require("./bloggers");
const Engine = require("../public/js/engine.js");

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

const TOOLS = [
  {
    name: "sales_by_month",
    description: "Продажи по месяцам из 1С (все реализации, проведённые и непроведённые, без удалённых), в тенге. Разбивка по ответственному: Каспи Магазин, Гос закуп, Офис-менеджер, Другие. Для текущего месяца есть линейный прогноз.",
    inputSchema: { type: "object", properties: { year: { type: "integer", description: "Год, например 2026. По умолчанию текущий." } } },
  },
  {
    name: "sales_search",
    description: "Гибкий поиск по реализациям 1С (проведённые и непроведённые, без удалённых). Фильтры: часть названия контрагента (например «солнечный» — найдёт все точки сети «Супермаркет Солнечный …»), ответственный (каспи / гос / офис), даты. Группировка: по месяцам, неделям, дням, по контрагентам (точкам) или без группировки (итог). Суммы в тенге. Для графиков бери group_by=month.",
    inputSchema: { type: "object", properties: {
      counterparty_contains: { type: "string", description: "Часть названия контрагента, без учёта регистра. Например: солнечный" },
      responsible_contains: { type: "string", description: "Часть имени ответственного: каспи, гос, офис" },
      date_from: { type: "string", description: "Начало периода, ГГГГ-ММ-ДД. По умолчанию 1 января текущего года." },
      date_to: { type: "string", description: "Конец периода включительно, ГГГГ-ММ-ДД. По умолчанию сегодня." },
      group_by: { type: "string", enum: ["month", "week", "day", "counterparty", "none"], description: "По умолчанию month." },
      limit: { type: "integer", description: "Максимум строк в группировке по контрагентам (по умолчанию 50)." },
    } },
  },
  {
    name: "sales_items",
    description: "Продажи по товарам (номенклатуре) из реализаций 1С: штуки и суммы в тенге. Фильтры: часть названия товара (например «гель»), часть названия контрагента (например «солнечный»), ответственный, даты. Группировка: по товарам, месяцам, неделям, дням, контрагентам. Для графика по месяцам: group_by=month. Первый вызов за год может идти 1–2 минуты (читаются товарные строки из 1С).",
    inputSchema: { type: "object", properties: {
      item_contains: { type: "string", description: "Часть названия товара, без учёта регистра." },
      counterparty_contains: { type: "string", description: "Часть названия контрагента, например: солнечный" },
      responsible_contains: { type: "string", description: "каспи, гос, офис" },
      date_from: { type: "string", description: "ГГГГ-ММ-ДД. По умолчанию 1 января текущего года." },
      date_to: { type: "string", description: "ГГГГ-ММ-ДД включительно. По умолчанию сегодня." },
      group_by: { type: "string", enum: ["item", "month", "week", "day", "counterparty", "none"], description: "По умолчанию item." },
      limit: { type: "integer", description: "Максимум строк (по умолчанию 50)." },
    } },
  },
  {
    name: "find_counterparties",
    description: "Найти контрагентов (клиентов) в продажах 1С по части названия и показать суммы по каждому за период. Полезно, чтобы увидеть все точки сети (например «солнечный»), а также топ клиентов (без фильтра).",
    inputSchema: { type: "object", properties: {
      name_contains: { type: "string", description: "Часть названия, без учёта регистра. Пусто = все (топ клиентов)." },
      year: { type: "integer", description: "Год. По умолчанию текущий." },
      limit: { type: "integer", description: "Сколько показать (по умолчанию 30)." },
    } },
  },
  {
    name: "kaspi_orders_by_day",
    description: "Заказы Kaspi по дням: сколько всего и сколько повторных клиентов (данные копятся с 23.09.2026).",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "За сколько последних дней (1–90). По умолчанию 30." } } },
  },
  {
    name: "bloggers_weekly",
    description: "Отчёт по блогерам по неделям (пн–вс, по дате договорённости): сколько блогеров, сколько только гели, только спреи, и то и другое; общий бюджет (размещение + себестоимость товара) в тенге.",
    inputSchema: { type: "object", properties: { weeks: { type: "integer", description: "Сколько последних недель (1–60). По умолчанию 12." } } },
  },
  {
    name: "production_plan",
    description: "Сводка по плану производства: заказов к отгрузке, горящих, единиц к выпуску, тонн; время последней синхронизации с 1С.",
    inputSchema: { type: "object", properties: {} },
  },
];

function kostanayNow() { return new Date(Date.now() + 5 * 3600 * 1000); }

async function callTool(name, args) {
  args = args || {};
  if (name === "sales_by_month") {
    const nowY = kostanayNow().getUTCFullYear();
    const year = Math.min(Math.max(parseInt(args.year, 10) || nowY, 2020), nowY);
    const r = await salesStats.getMonthlyWait(year);
    if (!r.data) throw new Error(r.error || "данные из 1С ещё не получены, повторите через минуту");
    const now = kostanayNow();
    const curIdx = year === nowY ? now.getUTCMonth() : -1;
    const dim = new Date(Date.UTC(nowY, now.getUTCMonth() + 1, 0)).getUTCDate();
    const months = r.data.months.map((M, i) => {
      const o = {
        месяц: MONTHS[i] + " " + year,
        итого_тг: M.total, реализаций: M.count,
        каспи_магазин_тг: M.kaspi, каспи_реализаций: M.kaspiCount,
        гос_закуп_тг: M.gos, гос_реализаций: M.gosCount,
        офис_менеджер_тг: M.office, офис_реализаций: M.officeCount,
        другие_тг: M.other, другие_реализаций: M.otherCount,
      };
      if (i === curIdx) o.прогноз_месяца_итого_тг = Math.round((M.total / now.getUTCDate()) * dim);
      return o;
    });
    const total = r.data.months.reduce((a, M) => a + M.total, 0);
    return { год: year, итого_за_год_тг: total, обновлено: r.updatedAt, месяцы: months, примечание: "Месяцы без продаж — нули. Прогноз линейный по календарным дням." };
  }
  if (name === "sales_search") {
    const now = kostanayNow();
    const today = now.toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(args.date_from || "") ? args.date_from : today.slice(0, 4) + "-01-01";
    const to = /^\d{4}-\d{2}-\d{2}$/.test(args.date_to || "") ? args.date_to : today;
    const y1 = parseInt(from.slice(0, 4), 10), y2 = parseInt(to.slice(0, 4), 10);
    if (y2 < y1 || y2 - y1 > 5) throw new Error("некорректный период");
    const cq = String(args.counterparty_contains || "").toLowerCase().trim();
    const rq = String(args.responsible_contains || "").toLowerCase().trim();
    const gb = args.group_by || "month";
    let all = [], upd = null;
    for (let y = y1; y <= y2; y++) {
      const r = await salesStats.getRows(y);
      all = all.concat(r.rows); upd = r.updatedAt;
    }
    const rows = all.filter((x) => x.d >= from && x.d <= to
      && (!cq || String(x.c).toLowerCase().indexOf(cq) !== -1)
      && (!rq || String(x.r).toLowerCase().indexOf(rq) !== -1));
    const groups = {};
    const keyOf = (x) => {
      if (gb === "month") return x.d.slice(0, 7);
      if (gb === "day") return x.d;
      if (gb === "counterparty") return x.c || "(контрагент не указан)";
      if (gb === "week") {
        const dt = new Date(x.d + "T00:00:00Z");
        const wd = (dt.getUTCDay() + 6) % 7;
        return new Date(dt.getTime() - wd * 86400000).toISOString().slice(0, 10);
      }
      return "всего";
    };
    rows.forEach((x) => {
      const k = keyOf(x);
      const g = groups[k] || (groups[k] = { сумма_тг: 0, реализаций: 0 });
      g.сумма_тг += x.s; g.реализаций++;
    });
    let list = Object.keys(groups).map((k) => ({ группа: k, сумма_тг: Math.round(groups[k].сумма_тг), реализаций: groups[k].реализаций }));
    if (gb === "counterparty") {
      list.sort((a, b) => b.сумма_тг - a.сумма_тг);
      list = list.slice(0, Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 200));
    } else {
      list.sort((a, b) => (a.группа < b.группа ? -1 : 1));
      if (gb === "week") list.forEach((g) => { g.группа = "неделя с " + g.группа; });
    }
    const total = rows.reduce((a, x) => a + x.s, 0);
    const cset = {};
    if (cq) rows.forEach((x) => { cset[x.c || "(не указан)"] = 1; });
    return {
      период: from + " — " + to, итого_тг: Math.round(total), реализаций: rows.length,
      контрагентов_найдено: cq ? Object.keys(cset).length : undefined,
      группировка: gb, данные: list, обновлено: upd,
      примечание: "Месяцы/недели без продаж в списке отсутствуют (= 0).",
    };
  }
  if (name === "sales_items") {
    const today = kostanayNow().toISOString().slice(0, 10);
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
    const from = ok(args.date_from) ? args.date_from : today.slice(0, 4) + "-01-01";
    const to = ok(args.date_to) ? args.date_to : today;
    const y1 = parseInt(from.slice(0, 4), 10), y2 = parseInt(to.slice(0, 4), 10);
    if (y2 < y1 || y2 - y1 > 3) throw new Error("некорректный период");
    const iq = String(args.item_contains || "").toLowerCase().trim();
    const cq = String(args.counterparty_contains || "").toLowerCase().trim();
    const rq = String(args.responsible_contains || "").toLowerCase().trim();
    const gb = args.group_by || "item";
    let all = [], upd = null;
    for (let y = y1; y <= y2; y++) { const r = await salesStats.getItemLines(y); all = all.concat(r.lines); upd = r.updatedAt; }
    const rows = all.filter((x) => x.d >= from && x.d <= to
      && (!iq || x.n.toLowerCase().indexOf(iq) !== -1)
      && (!cq || String(x.c).toLowerCase().indexOf(cq) !== -1)
      && (!rq || String(x.r).toLowerCase().indexOf(rq) !== -1));
    const keyOf = (x) => {
      if (gb === "month") return x.d.slice(0, 7);
      if (gb === "day") return x.d;
      if (gb === "counterparty") return x.c || "(контрагент не указан)";
      if (gb === "week") {
        const dt = new Date(x.d + "T00:00:00Z");
        return new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
      }
      if (gb === "none") return "всего";
      return x.n;
    };
    const g = {};
    rows.forEach((x) => {
      const o = g[keyOf(x)] || (g[keyOf(x)] = { штук: 0, сумма_тг: 0 });
      o.штук += x.q; o.сумма_тг += x.s;
    });
    let list = Object.keys(g).map((k) => ({ группа: k, штук: Math.round(g[k].штук * 100) / 100, сумма_тг: Math.round(g[k].сумма_тг) }));
    if (gb === "item" || gb === "counterparty") {
      list.sort((a, b) => b.сумма_тг - a.сумма_тг);
      list = list.slice(0, Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 200));
    } else {
      list.sort((a, b) => (a.группа < b.группа ? -1 : 1));
      if (gb === "week") list.forEach((x) => { x.группа = "неделя с " + x.группа; });
    }
    return {
      период: from + " — " + to, итого_штук: Math.round(rows.reduce((a, x) => a + x.q, 0) * 100) / 100,
      итого_тг: Math.round(rows.reduce((a, x) => a + x.s, 0)), строк: rows.length,
      группировка: gb, данные: list, обновлено: upd,
    };
  }
  if (name === "find_counterparties") {
    const nowY = kostanayNow().getUTCFullYear();
    const year = Math.min(Math.max(parseInt(args.year, 10) || nowY, 2020), nowY);
    const q = String(args.name_contains || "").toLowerCase().trim();
    const r = await salesStats.getRows(year);
    const g = {};
    r.rows.forEach((x) => {
      const n = x.c || "(контрагент не указан)";
      if (q && n.toLowerCase().indexOf(q) === -1) return;
      const o = g[n] || (g[n] = { сумма_тг: 0, реализаций: 0 });
      o.сумма_тг += x.s; o.реализаций++;
    });
    const list = Object.keys(g).map((n) => ({ контрагент: n, сумма_тг: Math.round(g[n].сумма_тг), реализаций: g[n].реализаций }))
      .sort((a, b) => b.сумма_тг - a.сумма_тг);
    return { год: year, найдено: list.length, контрагенты: list.slice(0, Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 200)) };
  }
  if (name === "kaspi_orders_by_day") {
    const days = Math.min(Math.max(parseInt(args.days, 10) || 30, 1), 90);
    const stats = store.getKaspiDailyOrderStats();
    const todayMs = new Date(kostanayNow().toISOString().slice(0, 10) + "T00:00:00Z").getTime();
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayMs - i * 86400000).toISOString().slice(0, 10);
      const day = stats[d] || { total: 0, repeat: 0 };
      out.push({ дата: d, заказов: day.total || 0, повторных: day.repeat || 0 });
    }
    return { по_дням: out, примечание: "Kaspi скрывает телефоны клиентов, поэтому «повторные» определяются приблизительно (имя + город)." };
  }
  if (name === "bloggers_weekly") {
    const weeks = Math.min(Math.max(parseInt(args.weeks, 10) || 12, 1), 60);
    const rep = await bloggers.getReport(weeks, false);
    if (!rep.configured) throw new Error("таблица блогеров не подключена (нет BLOGGERS_SHEET_CSV_URL)");
    return {
      недели: rep.weeks.map((w) => ({
        неделя: w.start + " — " + w.end, блогеров: w.count, только_гели: w.gelCount, только_спреи: w.sprayCount,
        гели_и_спреи: w.bothCount, бюджет_тг: w.budget,
      })),
      итого: { блогеров: rep.totals.count, бюджет_тг: rep.totals.budget },
    };
  }
  if (name === "production_plan") {
    const st = store.readState();
    if (!st.ordersRaw || !st.itemsRaw || !st.ordersRaw.length) return { сообщение: "Данных пока нет (ждём синхронизацию с 1С)." };
    const settings = Object.assign({}, Engine.DEFAULT_SETTINGS, st.settings || {});
    const c = Engine.compute(st.ordersRaw, st.itemsRaw, settings, new Date());
    return { итоги: c.totals, последняя_синхронизация: st.meta && st.meta.lastSyncAt };
  }
  throw new Error("неизвестный инструмент: " + name);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("слишком большой запрос")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendRpc(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function handleMessage(msg) {
  const id = msg.id;
  const method = msg.method;
  if (method === "initialize") {
    const requested = msg.params && msg.params.protocolVersion;
    return { jsonrpc: "2.0", id, result: {
      protocolVersion: requested || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "the-hello-dashboard", version: "1.0.0" },
      instructions: "Данные дашборда THE HELLO Team (ТОО Trend Distribution, Костанай): продажи из 1С, заказы Kaspi, блогеры, план производства. Суммы в тенге. Только чтение.",
    } };
  }
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  if (method === "tools/call") {
    const p = msg.params || {};
    try {
      const data = await callTool(p.name, p.arguments);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] } };
    } catch (e) {
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "Ошибка: " + e.message }] } };
    }
  }
  if (id === undefined || id === null) return null; // уведомление — ответа не нужно
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "метод не поддерживается: " + method } };
}

function secretOk(given) {
  const secret = process.env.MCP_SECRET || "";
  if (!secret || secret.length < 16) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* true — запрос обработан этим модулем */
function handle(req, res, pathname) {
  const m = pathname.match(/^\/mcp\/([^\/]+)\/?$/);
  if (!m) return false;
  if (!secretOk(m[1])) { res.writeHead(404); res.end("Not found"); return true; }
  if (req.method === "GET") { res.writeHead(405, { Allow: "POST" }); res.end(); return true; }
  if (req.method === "DELETE") { res.writeHead(200); res.end(); return true; }
  if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return true; }
  readBody(req, 200 * 1024).then(async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) {
      return sendRpc(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "некорректный JSON" } });
    }
    if (Array.isArray(msg)) {
      const outs = (await Promise.all(msg.map(handleMessage))).filter(Boolean);
      if (!outs.length) { res.writeHead(202); return res.end(); }
      return sendRpc(res, outs);
    }
    const out = await handleMessage(msg);
    if (!out) { res.writeHead(202); return res.end(); }
    return sendRpc(res, out);
  }).catch((e) => {
    try { sendRpc(res, { jsonrpc: "2.0", id: null, error: { code: -32603, message: e.message } }); } catch (e2) { /* ignore */ }
  });
  return true;
}

module.exports = { handle };
