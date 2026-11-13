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
const invoices = require("./invoices");
const kaspiData = require("./kaspiData");
const kaspiRequest = require("./kaspiRequest");
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
    name: "invoices_search",
    description: "Счета на оплату покупателю из 1С (без удалённых): номер, дата, сумма, контрагент, ответственный, комментарий и статус отгрузки (отгружен = есть реализация на основании счёта; даётся дата и номер реализации). Фильтры: контрагент, ответственный, часть комментария, статус (all / shipped / not_shipped), даты. Можно получить список счетов (group_by=list) или сводку по месяцам, неделям, контрагентам, ответственным, статусу.",
    inputSchema: { type: "object", properties: {
      counterparty_contains: { type: "string", description: "Часть названия контрагента, например: солнечный" },
      responsible_contains: { type: "string", description: "Часть имени ответственного: каспи, гос, офис" },
      comment_contains: { type: "string", description: "Часть комментария к счёту" },
      status: { type: "string", enum: ["all", "shipped", "not_shipped"], description: "По умолчанию all." },
      date_from: { type: "string", description: "ГГГГ-ММ-ДД. По умолчанию 1 января текущего года." },
      date_to: { type: "string", description: "ГГГГ-ММ-ДД включительно. По умолчанию сегодня." },
      group_by: { type: "string", enum: ["list", "month", "week", "day", "counterparty", "responsible", "status", "none"], description: "По умолчанию list." },
      limit: { type: "integer", description: "Максимум строк (по умолчанию 50, до 300)." },
    } },
  },
  {
    name: "kaspi_orders",
    description: "Заказы Kaspi Магазина НАПРЯМУЮ из Kaspi API за любой период (до 62 дней за запрос): число заказов и сумма, статус (state/status), город доставки, способ оплаты, способ доставки (Kaspi Доставка / самовывоз / свой курьер), плановая дата доставки. Группировка по дням, неделям, месяцам, статусам, городам, оплате, доставке или список заказов. Данные свежие (кэш 10 минут). Телефоны клиентов Kaspi скрывает; имена и адреса отдаются только при include_customer=true.",
    inputSchema: { type: "object", properties: {
      date_from: { type: "string", description: "ГГГГ-ММ-ДД. По умолчанию 6 дней назад." },
      date_to: { type: "string", description: "ГГГГ-ММ-ДД включительно. По умолчанию сегодня." },
      state: { type: "string", enum: ["NEW", "SIGN_REQUIRED", "PICKUP", "DELIVERY", "KASPI_DELIVERY", "ARCHIVE"], description: "Только заказы в этом состоянии. По умолчанию все. ARCHIVE = завершённые/отменённые, NEW = новые, KASPI_DELIVERY = доставка Kaspi." },
      status_contains: { type: "string", description: "Фильтр по статусу, например: COMPLETED, CANCELLED, RETURNED, ACCEPTED_BY_MERCHANT." },
      group_by: { type: "string", enum: ["day", "week", "month", "state", "status", "city", "payment", "delivery", "list", "none"], description: "По умолчанию day." },
      include_customer: { type: "boolean", description: "Для group_by=list: добавить имя клиента и адрес." },
      limit: { type: "integer", description: "Максимум строк (по умолчанию 50, до 300)." },
    } },
  },
  {
    name: "kaspi_order_items",
    description: "Товарный состав заказов Kaspi за период (до 31 дня): сколько штук и на какую сумму продано по каждому товару Kaspi; можно сгруппировать по дням или неделям. Состав каждого заказа читается отдельным запросом, поэтому первый вызов за большой период может быть неполным: в ответе есть «готовность» — повторите вопрос через 1–2 минуты, и данные дополнятся.",
    inputSchema: { type: "object", properties: {
      date_from: { type: "string", description: "ГГГГ-ММ-ДД. По умолчанию 6 дней назад." },
      date_to: { type: "string", description: "ГГГГ-ММ-ДД включительно. По умолчанию сегодня." },
      item_contains: { type: "string", description: "Часть названия товара." },
      status_contains: { type: "string", description: "Фильтр по статусу заказа, например COMPLETED. По умолчанию кроме отменённых." },
      include_cancelled: { type: "boolean", description: "Учитывать отменённые и возвращённые заказы. По умолчанию нет." },
      group_by: { type: "string", enum: ["item", "day", "week", "none"], description: "По умолчанию item." },
      limit: { type: "integer", description: "Максимум строк (по умолчанию 50)." },
    } },
  },
  {
    name: "kaspi_request",
    description: "Произвольный запрос к Kaspi Seller API (https://kaspi.kz/shop/api/v2/...) с токеном магазина; ответ возвращается как есть (status, contentType, body). По умолчанию разрешён только GET (чтение). Методы POST/PATCH/PUT/DELETE МЕНЯЮТ данные в Kaspi и работают, только если владелец включил KASPI_REQUEST_WRITE=1; использовать их только по прямой просьбе владельца.",
    inputSchema: { type: "object", properties: {
      endpoint: { type: "string", description: "Путь внутри /shop/api/v2/, например: orders или orders/12345/entries" },
      method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"], description: "По умолчанию GET." },
      query: { type: "object", description: "Параметры запроса объектом, например {\"filter[orders][state]\":\"NEW\",\"page[size]\":10}" },
      body: { description: "Тело запроса (объект или строка JSON) для POST/PATCH/PUT." },
    }, required: ["endpoint"] },
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
    description: "План производства: сколько каждого товара (штук и кг) нужно, чтобы отгрузить ВСЕ неотгруженные счета, по группам продукции; заказов к отгрузке, горящих; время последней синхронизации с 1С. Остатки склада не учитываются.",
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
  if (name === "invoices_search") {
    const today = kostanayNow().toISOString().slice(0, 10);
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
    const from = ok(args.date_from) ? args.date_from : today.slice(0, 4) + "-01-01";
    const to = ok(args.date_to) ? args.date_to : today;
    const y1 = parseInt(from.slice(0, 4), 10), y2 = parseInt(to.slice(0, 4), 10);
    if (y2 < y1 || y2 - y1 > 3) throw new Error("некорректный период");
    const cq = String(args.counterparty_contains || "").toLowerCase().trim();
    const rq = String(args.responsible_contains || "").toLowerCase().trim();
    const mq = String(args.comment_contains || "").toLowerCase().trim();
    const st = args.status || "all";
    const gb = args.group_by || "list";
    let all = [], upd = null;
    for (let y = y1; y <= y2; y++) { const r = await invoices.getInvoices(y); all = all.concat(r.rows); upd = r.updatedAt; }
    const rows = all.filter((x) => x.d >= from && x.d <= to
      && (!cq || x.c.toLowerCase().indexOf(cq) !== -1)
      && (!rq || x.r.toLowerCase().indexOf(rq) !== -1)
      && (!mq || x.m.toLowerCase().indexOf(mq) !== -1)
      && (st === "all" || (st === "shipped") === x.shipped));
    const shippedRows = rows.filter((x) => x.shipped);
    const head = {
      период: from + " — " + to, счетов: rows.length, сумма_тг: Math.round(rows.reduce((a, x) => a + x.s, 0)),
      отгружено_счетов: shippedRows.length, отгружено_тг: Math.round(shippedRows.reduce((a, x) => a + x.s, 0)),
      не_отгружено_счетов: rows.length - shippedRows.length,
      не_отгружено_тг: Math.round(rows.filter((x) => !x.shipped).reduce((a, x) => a + x.s, 0)),
      обновлено: upd,
    };
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 300);
    if (gb === "list") {
      const sorted = rows.slice().sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));
      const nowMs = Date.parse(today + "T00:00:00Z");
      head.счета = sorted.slice(0, limit).map((x) => {
        const o = { номер: x.n, дата: x.d, сумма_тг: Math.round(x.s), контрагент: x.c, ответственный: x.r,
          комментарий: x.m.length > 300 ? x.m.slice(0, 300) + "…" : x.m, отгружен: x.shipped ? "да" : "нет" };
        if (x.shipped) { o.дата_отгрузки = x.sd; o.реализация = x.sn; }
        else o.дней_без_отгрузки = Math.max(0, Math.round((nowMs - Date.parse(x.d + "T00:00:00Z")) / 86400000));
        return o;
      });
      if (rows.length > limit) head.примечание = "Показаны последние " + limit + " из " + rows.length + "; уточните фильтры или увеличьте limit.";
      return head;
    }
    const keyOf = (x) => {
      if (gb === "month") return x.d.slice(0, 7);
      if (gb === "day") return x.d;
      if (gb === "counterparty") return x.c || "(не указан)";
      if (gb === "responsible") return x.r || "(не указан)";
      if (gb === "status") return x.shipped ? "отгружен" : "не отгружен";
      if (gb === "week") {
        const dt = new Date(x.d + "T00:00:00Z");
        return new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
      }
      return "всего";
    };
    const g = {};
    rows.forEach((x) => {
      const o = g[keyOf(x)] || (g[keyOf(x)] = { счетов: 0, сумма_тг: 0, отгружено_счетов: 0, отгружено_тг: 0 });
      o.счетов++; o.сумма_тг += x.s;
      if (x.shipped) { o.отгружено_счетов++; o.отгружено_тг += x.s; }
    });
    let list = Object.keys(g).map((k) => ({ группа: k, счетов: g[k].счетов, сумма_тг: Math.round(g[k].сумма_тг),
      отгружено_счетов: g[k].отгружено_счетов, отгружено_тг: Math.round(g[k].отгружено_тг) }));
    if (gb === "counterparty" || gb === "responsible") { list.sort((a, b) => b.сумма_тг - a.сумма_тг); list = list.slice(0, limit); }
    else { list.sort((a, b) => (a.группа < b.группа ? -1 : 1)); if (gb === "week") list.forEach((x) => { x.группа = "неделя с " + x.группа; }); }
    head.группировка = gb; head.данные = list;
    return head;
  }
  if (name === "kaspi_orders" || name === "kaspi_order_items") {
    const today = kostanayNow().toISOString().slice(0, 10);
    const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
    const to = ok(args.date_to) ? args.date_to : today;
    const from = ok(args.date_from) ? args.date_from : new Date(Date.parse(to + "T00:00:00Z") - 6 * 86400000).toISOString().slice(0, 10);
    const span = Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000) + 1;
    const maxSpan = name === "kaspi_orders" ? 62 : 31;
    if (span < 1 || span > maxSpan) throw new Error("период должен быть от 1 до " + maxSpan + " дней (сейчас " + span + ")");
    const sq = String(args.status_contains || "").toLowerCase().trim();
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 300);
    const weekOf = (d) => {
      const dt = new Date(d + "T00:00:00Z");
      return new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
    };
    if (name === "kaspi_orders") {
      const gb = args.group_by || "day";
      let orders = await kaspiData.getOrders(from, to, args.state || null);
      if (sq) orders = orders.filter((o) => String(o.status).toLowerCase().indexOf(sq) !== -1 || String(o.state).toLowerCase().indexOf(sq) !== -1);
      const head = { период: from + " — " + to, заказов: orders.length, сумма_тг: Math.round(orders.reduce((a, o) => a + o.sum, 0)) };
      if (gb === "list") {
        head.заказы = orders.slice().sort((a, b) => b.ms - a.ms).slice(0, limit).map((o) => {
          const r = { номер: o.code, дата: o.d, состояние: o.state, статус: o.status, сумма_тг: o.sum, город: o.city, оплата: o.pay, доставка: o.deliv, kaspi_доставка: o.kd, плановая_дата_доставки: o.planned };
          if (args.include_customer) { r.клиент = o.cust; r.адрес = o.addr; }
          return r;
        });
        if (orders.length > limit) head.примечание = "Показаны последние " + limit + " из " + orders.length;
        return head;
      }
      const keyOf = (o) => {
        if (gb === "day") return o.d;
        if (gb === "week") return weekOf(o.d);
        if (gb === "month") return o.d.slice(0, 7);
        if (gb === "state") return o.state;
        if (gb === "status") return o.status || "(нет)";
        if (gb === "city") return o.city || "(не указан)";
        if (gb === "payment") return o.pay || "(не указан)";
        if (gb === "delivery") return o.deliv || "(не указан)";
        return "всего";
      };
      const g = {};
      orders.forEach((o) => { const x = g[keyOf(o)] || (g[keyOf(o)] = { заказов: 0, сумма_тг: 0 }); x.заказов++; x.сумма_тг += o.sum; });
      let list = Object.keys(g).map((k) => ({ группа: k, заказов: g[k].заказов, сумма_тг: Math.round(g[k].сумма_тг) }));
      const timeGroup = gb === "day" || gb === "week" || gb === "month";
      if (timeGroup) { list.sort((a, b) => (a.группа < b.группа ? -1 : 1)); if (gb === "week") list.forEach((x) => { x.группа = "неделя с " + x.группа; }); }
      else { list.sort((a, b) => b.заказов - a.заказов); list = list.slice(0, limit); }
      head.группировка = gb; head.данные = list;
      head.примечание = "Заказы по дате создания. Суммы — totalPrice из Kaspi (включая отменённые, если не отфильтровано по статусу).";
      return head;
    }
    // kaspi_order_items
    let orders = await kaspiData.getOrders(from, to, null);
    if (sq) orders = orders.filter((o) => String(o.status).toLowerCase().indexOf(sq) !== -1 || String(o.state).toLowerCase().indexOf(sq) !== -1);
    else if (!args.include_cancelled) orders = orders.filter((o) => !/cancel|return/i.test(o.status));
    const cacheKey = from + "|" + to;
    const prog = await kaspiData.ensureEntries(orders, cacheKey, 85000);
    const iq = String(args.item_contains || "").toLowerCase().trim();
    const gb = args.group_by || "item";
    const g = {};
    let pieces = 0, sum = 0;
    prog.ready.forEach((o) => {
      kaspiData.entriesOf(o.id).forEach((l) => {
        if (iq && l.name.toLowerCase().indexOf(iq) === -1) return;
        const k = gb === "day" ? o.d : gb === "week" ? weekOf(o.d) : gb === "none" ? "всего" : l.name;
        const x = g[k] || (g[k] = { штук: 0, сумма_тг: 0 });
        x.штук += l.q; x.сумма_тг += l.s; pieces += l.q; sum += l.s;
      });
    });
    let list = Object.keys(g).map((k) => ({ группа: gb === "week" ? "неделя с " + k : k, штук: g[k].штук, сумма_тг: Math.round(g[k].сумма_тг) }));
    if (gb === "item") { list.sort((a, b) => b.штук - a.штук); list = list.slice(0, limit); }
    else list.sort((a, b) => (a.группа < b.группа ? -1 : 1));
    return {
      период: from + " — " + to, заказов_всего: prog.total, готовность: prog.ready.length + " из " + prog.total + " заказов",
      итого_штук: pieces, итого_тг: Math.round(sum), группировка: gb, данные: list,
      примечание: prog.ready.length < prog.total ? "Данные неполные: состав остальных заказов ещё загружается. Повторите вопрос через 1–2 минуты." : "Данные полные.",
    };
  }
  if (name === "kaspi_request") {
    return await kaspiRequest.request(args);
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
    const GN = ["Твёрдая продукция (группа 1)", "Посуда (группа 2)", "Жидкая продукция (группа 3)", "Прочая продукция (группа 4)"];
    const toRow = (x) => ({ товар: x.p, штук: x.q, кг: x.kg == null ? null : Math.round(x.kg * 10) / 10 });
    return {
      итоги: c.totals,
      к_производству_по_группам: c.planGroups.map((g, i) => ({ группа: GN[i], позиций: g.length, товары: g.map(toRow) })),
      не_производится_или_прочее: c.other.map((x) => ({ товар: x.p, штук: x.q })),
      горящих_заказов: c.fires.length,
      последняя_синхронизация: st.meta && st.meta.lastSyncAt,
      примечание: "Потребность = сумма товаров во всех неотгруженных счетах. Остатки на складе и готовую продукцию НЕ учитываем — вычтите их, чтобы получить, сколько реально производить.",
    };
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
