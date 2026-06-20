/* THE HELLO Team — клиент Bitrix24 REST API (через входящий вебхук).
   Без внешних зависимостей: только встроенный модуль https.
   Адрес вебхука берётся из переменной окружения BITRIX_WEBHOOK_URL
   (задаётся в настройках Render — НЕ хранится в коде/репозитории). */
"use strict";
const https = require("https");
const { URL } = require("url");

// Костанай, Казахстан — UTC+5, без перехода на летнее время.
const TZ_OFFSET_MIN = 5 * 60;

/* ---------------- низкоуровневый вызов метода ---------------- */
function callMethod(webhookUrl, method, params) {
  return new Promise((resolve, reject) => {
    let base;
    try {
      base = new URL(webhookUrl);
    } catch (e) {
      return reject(new Error("Некорректный адрес вебхука Bitrix24"));
    }
    let pathname = base.pathname;
    if (!pathname.endsWith("/")) pathname += "/";
    const body = JSON.stringify(params || {});
    const options = {
      hostname: base.hostname,
      path: pathname + method + ".json",
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 20000,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let data;
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (e) {
          return reject(new Error("Bitrix24 [" + method + "]: ответ не в формате JSON"));
        }
        if (data && data.error) {
          return reject(new Error("Bitrix24 [" + method + "]: " + (data.error_description || data.error)));
        }
        resolve(data);
      });
    });
    req.on("error", (e) => reject(new Error("Bitrix24 [" + method + "]: " + e.message)));
    req.on("timeout", () => req.destroy(new Error("Bitrix24 [" + method + "]: таймаут запроса")));
    req.write(body);
    req.end();
  });
}

// Собирает все страницы list-метода (Bitrix24 отдаёт максимум 50 записей за раз).
async function listAll(webhookUrl, method, params) {
  let start = 0;
  let out = [];
  for (;;) {
    const data = await callMethod(webhookUrl, method, Object.assign({}, params, { start: start }));
    let chunk = [];
    if (Array.isArray(data.result)) chunk = data.result;
    else if (data.result && Array.isArray(data.result.items)) chunk = data.result.items;
    out = out.concat(chunk);
    if (data.next == null || !chunk.length) break;
    start = data.next;
    if (out.length > 20000) break; // защита от бесконечного цикла на аномально больших выборках
  }
  return out;
}

/* ---------------- даты: границы периодов по времени Костанай ---------------- */
function localMidnightToUTC(y, m, d) {
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - TZ_OFFSET_MIN * 60000);
}

function periodRange(period, now) {
  now = now || new Date();
  const localNow = new Date(now.getTime() + TZ_OFFSET_MIN * 60000);
  const y = localNow.getUTCFullYear();
  const m = localNow.getUTCMonth();
  const d = localNow.getUTCDate();

  let fromD = d, toD = d + 1;
  if (period === "yesterday") {
    fromD = d - 1; toD = d;
  } else if (period === "week") {
    const dow = new Date(Date.UTC(y, m, d)).getUTCDay(); // 0=вс..6=сб
    const mondayOffset = dow === 0 ? 6 : dow - 1;
    fromD = d - mondayOffset; toD = d + 1;
  } else if (period === "month") {
    fromD = 1; toD = d + 1;
  }
  return {
    from: localMidnightToUTC(y, m, fromD),
    to: localMidnightToUTC(y, m, toD),
  };
}

function fmtBitrixDate(d) {
  const local = new Date(d.getTime() + TZ_OFFSET_MIN * 60000);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return local.getUTCFullYear() + "-" + p(local.getUTCMonth() + 1) + "-" + p(local.getUTCDate()) +
    "T" + p(local.getUTCHours()) + ":" + p(local.getUTCMinutes()) + ":" + p(local.getUTCSeconds()) + "+05:00";
}

function uniq(arr) {
  return Array.from(new Set(arr.filter((x) => x != null).map(String)));
}

/* ---------------- сотрудники ---------------- */
// Требует у вебхука право "Пользователи" (user/user_brief/user_basic).
// Если права нет — просто показываем "Пользователь #ID" вместо имени.
async function getUsers(webhookUrl) {
  try {
    const data = await callMethod(webhookUrl, "user.get", { FILTER: { ACTIVE: true } });
    const list = Array.isArray(data.result) ? data.result : [];
    const map = {};
    list.forEach((u) => {
      const name = ((u.NAME || "") + " " + (u.LAST_NAME || "")).trim();
      map[String(u.ID)] = name || ("Пользователь #" + u.ID);
    });
    return map;
  } catch (e) {
    return {};
  }
}

/* ---------------- подсчёт по менеджерам ---------------- */
function bump(map, managerId, field) {
  if (managerId == null) return;
  const id = String(managerId);
  if (!map[id]) map[id] = { deals: 0, leads: 0, movedDeals: 0, movedLeads: 0 };
  map[id][field]++;
}

async function countCreated(webhookUrl, from, to) {
  const filter = { ">=DATE_CREATE": fmtBitrixDate(from), "<DATE_CREATE": fmtBitrixDate(to) };
  const [deals, leads] = await Promise.all([
    listAll(webhookUrl, "crm.deal.list", { select: ["ID", "ASSIGNED_BY_ID"], filter: filter }),
    listAll(webhookUrl, "crm.lead.list", { select: ["ID", "ASSIGNED_BY_ID"], filter: filter }),
  ]);
  const out = {};
  deals.forEach((d) => bump(out, d.ASSIGNED_BY_ID, "deals"));
  leads.forEach((l) => bump(out, l.ASSIGNED_BY_ID, "leads"));
  return out;
}

async function resolveAssignees(webhookUrl, method, ids) {
  const map = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (!chunk.length) continue;
    const data = await callMethod(webhookUrl, method, { select: ["ID", "ASSIGNED_BY_ID"], filter: { "@ID": chunk } });
    (Array.isArray(data.result) ? data.result : []).forEach((r) => { map[String(r.ID)] = r.ASSIGNED_BY_ID; });
  }
  return map;
}

// "Перемещено" — переход на промежуточную/финальную стадию или смена воронки.
// TYPE_ID: 1 — создание (не считаем как перемещение), 2 — промежуточная стадия,
// 3 — финальная стадия, 5 — смена воронки.
async function countMoved(webhookUrl, from, to) {
  const filter = { ">=CREATED_TIME": fmtBitrixDate(from), "<CREATED_TIME": fmtBitrixDate(to), "@TYPE_ID": [2, 3, 5] };
  const [dealMoves, leadMoves] = await Promise.all([
    listAll(webhookUrl, "crm.stagehistory.list", { entityTypeId: 2, filter: filter, select: ["ID", "OWNER_ID", "TYPE_ID"] }),
    listAll(webhookUrl, "crm.stagehistory.list", { entityTypeId: 1, filter: filter, select: ["ID", "OWNER_ID", "TYPE_ID"] }),
  ]);
  const dealOwnerIds = uniq(dealMoves.map((m) => m.OWNER_ID));
  const leadOwnerIds = uniq(leadMoves.map((m) => m.OWNER_ID));
  const [dealOwnerMap, leadOwnerMap] = await Promise.all([
    resolveAssignees(webhookUrl, "crm.deal.list", dealOwnerIds),
    resolveAssignees(webhookUrl, "crm.lead.list", leadOwnerIds),
  ]);
  const out = {};
  dealMoves.forEach((m) => bump(out, dealOwnerMap[String(m.OWNER_ID)], "movedDeals"));
  leadMoves.forEach((m) => bump(out, leadOwnerMap[String(m.OWNER_ID)], "movedLeads"));
  return out;
}

/* ---------------- сводный отчёт ---------------- */
async function getManagerReport(webhookUrl, period) {
  const range = periodRange(period);
  const [users, created, moved] = await Promise.all([
    getUsers(webhookUrl),
    countCreated(webhookUrl, range.from, range.to),
    countMoved(webhookUrl, range.from, range.to),
  ]);
  const ids = uniq(Object.keys(created).concat(Object.keys(moved)));
  const rows = ids.map((id) => {
    const c = created[id] || { deals: 0, leads: 0 };
    const m = moved[id] || { movedDeals: 0, movedLeads: 0 };
    return {
      id: id,
      name: users[id] || ("Пользователь #" + id),
      createdDeals: c.deals,
      createdLeads: c.leads,
      created: c.deals + c.leads,
      movedDeals: m.movedDeals,
      movedLeads: m.movedLeads,
      moved: m.movedDeals + m.movedLeads,
    };
  });
  rows.sort((a, b) => (b.created + b.moved) - (a.created + a.moved));
  return {
    period: period,
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    rows: rows,
    hasUserNames: Object.keys(users).length > 0,
  };
}

module.exports = { getManagerReport, periodRange };
