/* THE HELLO Team — клиент Bitrix24 REST API (через входящий вебхук).
   Без внешних зависимостей: только встроенный модуль https.
   Адрес вебхука берётся из переменной окружения BITRIX_WEBHOOK_URL
   (задаётся в настройках Render — НЕ хранится в коде/репозитории). */
"use strict";
const https = require("https");
const { URL } = require("url");
const store = require("./store");

// Костанай, Казахстан — UTC+5, без перехода на летнее время.
const TZ_OFFSET_MIN = 5 * 60;
const MAX_EVENTS_PER_MANAGER = 300;

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

function fmtLocalDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const local = new Date(d.getTime() + TZ_OFFSET_MIN * 60000);
  const p = (n) => (n < 10 ? "0" + n : "" + n);
  return p(local.getUTCDate()) + "." + p(local.getUTCMonth() + 1) + " " + p(local.getUTCHours()) + ":" + p(local.getUTCMinutes());
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

/* ---------------- человекочитаемые названия этапов ---------------- */
// Названия стадий сделок зависят от воронки (направления продаж).
// crm.status.list с ENTITY_ID="DEAL_STAGE" — стадии основной воронки,
// "DEAL_STAGE_<ID>" — стадии дополнительных воронок (crm.dealcategory.list).
async function getDealStageNames(webhookUrl) {
  const map = {};
  try {
    let categories = [];
    try {
      const catData = await callMethod(webhookUrl, "crm.dealcategory.list", {});
      categories = Array.isArray(catData.result) ? catData.result : [];
    } catch (e) {
      categories = [];
    }
    const entityIds = ["DEAL_STAGE"].concat(categories.map((c) => "DEAL_STAGE_" + c.ID));
    const lists = await Promise.all(entityIds.map((eid) =>
      callMethod(webhookUrl, "crm.status.list", { filter: { ENTITY_ID: eid } }).catch(() => ({ result: [] }))
    ));
    lists.forEach((data) => {
      (Array.isArray(data.result) ? data.result : []).forEach((s) => {
        if (s && s.STATUS_ID) map[s.STATUS_ID] = s.NAME || s.STATUS_ID;
      });
    });
  } catch (e) {
    // если что-то не получилось — просто покажем сырые коды этапов вместо названий
  }
  return map;
}

async function getLeadStatusNames(webhookUrl) {
  try {
    const data = await callMethod(webhookUrl, "crm.status.list", { filter: { ENTITY_ID: "STATUS" } });
    const map = {};
    (Array.isArray(data.result) ? data.result : []).forEach((s) => {
      if (s && s.STATUS_ID) map[s.STATUS_ID] = s.NAME || s.STATUS_ID;
    });
    return map;
  } catch (e) {
    return {};
  }
}

/* ---------------- история стадий ---------------- */
// TYPE_ID: 1 — создание, 2 — промежуточная стадия, 3 — финальная стадия, 5 — смена воронки.
async function fetchStageHistory(webhookUrl, entityTypeId, from, to) {
  const filter = { ">=CREATED_TIME": fmtBitrixDate(from), "<CREATED_TIME": fmtBitrixDate(to), "@TYPE_ID": [1, 2, 3, 5] };
  const items = await listAll(webhookUrl, "crm.stagehistory.list", {
    entityTypeId: entityTypeId,
    filter: filter,
    order: { CREATED_TIME: "ASC" },
    select: ["ID", "OWNER_ID", "TYPE_ID", "CREATED_TIME", "STAGE_ID", "STAGE_SEMANTIC_ID"],
  });
  items.sort((a, b) => new Date(a.CREATED_TIME) - new Date(b.CREATED_TIME));
  return items;
}

// Для карточек, у которых первое событие в выбранном периоде — уже перемещение
// (карточка была создана раньше), узнаём, на каком этапе она была до начала периода.
async function fetchPriorStages(webhookUrl, entityTypeId, ownerIds, beforeDate) {
  const map = {};
  for (let i = 0; i < ownerIds.length; i += 50) {
    const chunk = ownerIds.slice(i, i + 50);
    if (!chunk.length) continue;
    const items = await listAll(webhookUrl, "crm.stagehistory.list", {
      entityTypeId: entityTypeId,
      filter: { "@OWNER_ID": chunk, "<CREATED_TIME": fmtBitrixDate(beforeDate) },
      order: { CREATED_TIME: "DESC" },
      select: ["OWNER_ID", "STAGE_ID", "CREATED_TIME"],
    });
    items.forEach((it) => {
      const id = String(it.OWNER_ID);
      if (!(id in map)) map[id] = it.STAGE_ID; // первое вхождение — самая свежая запись (сортировка DESC)
    });
  }
  return map;
}

// Превращает плоскую историю стадий по карточкам в события "создал"/"переместил" с указанием from→to.
function deriveTransitions(history) {
  const byOwner = {};
  history.forEach((it) => {
    const id = String(it.OWNER_ID);
    (byOwner[id] = byOwner[id] || []).push(it);
  });
  const events = [];
  const needsPrior = []; // {ownerId, eventRef}
  Object.keys(byOwner).forEach((ownerId) => {
    const list = byOwner[ownerId];
    let prevStage = null;
    list.forEach((it, idx) => {
      if (it.TYPE_ID === 1) {
        events.push({ ownerId: ownerId, time: it.CREATED_TIME, type: "created", fromStage: null, toStage: it.STAGE_ID, semantic: it.STAGE_SEMANTIC_ID });
        prevStage = it.STAGE_ID;
      } else {
        const ev = { ownerId: ownerId, time: it.CREATED_TIME, type: "moved", fromStage: prevStage, toStage: it.STAGE_ID, semantic: it.STAGE_SEMANTIC_ID };
        if (idx === 0) needsPrior.push({ ownerId: ownerId, eventRef: ev });
        events.push(ev);
        prevStage = it.STAGE_ID;
      }
    });
  });
  return { events: events, needsPrior: needsPrior };
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

/* ---------------- сводный отчёт с лентой событий ---------------- */
async function getManagerReport(webhookUrl, period) {
  const range = periodRange(period);
  const { from, to } = range;

  const [users, dealStageNames, leadStatusNames, dealHistory, leadHistory] = await Promise.all([
    getUsers(webhookUrl),
    getDealStageNames(webhookUrl),
    getLeadStatusNames(webhookUrl),
    fetchStageHistory(webhookUrl, 2, from, to),
    fetchStageHistory(webhookUrl, 1, from, to),
  ]);

  const dealDerived = deriveTransitions(dealHistory);
  const leadDerived = deriveTransitions(leadHistory);

  const dealPriorIds = uniq(dealDerived.needsPrior.map((x) => x.ownerId));
  const leadPriorIds = uniq(leadDerived.needsPrior.map((x) => x.ownerId));
  const [dealPriorMap, leadPriorMap] = await Promise.all([
    dealPriorIds.length ? fetchPriorStages(webhookUrl, 2, dealPriorIds, from) : {},
    leadPriorIds.length ? fetchPriorStages(webhookUrl, 1, leadPriorIds, from) : {},
  ]);
  dealDerived.needsPrior.forEach((x) => { x.eventRef.fromStage = dealPriorMap[x.ownerId] || null; });
  leadDerived.needsPrior.forEach((x) => { x.eventRef.fromStage = leadPriorMap[x.ownerId] || null; });

  const dealOwnerIds = uniq(dealDerived.events.map((e) => e.ownerId));
  const leadOwnerIds = uniq(leadDerived.events.map((e) => e.ownerId));
  const [dealAssigneeMap, leadAssigneeMap] = await Promise.all([
    resolveAssignees(webhookUrl, "crm.deal.list", dealOwnerIds),
    resolveAssignees(webhookUrl, "crm.lead.list", leadOwnerIds),
  ]);

  function stageName(map, code) {
    if (code == null) return null;
    return map[code] || code;
  }

  const allEvents = [];
  dealDerived.events.forEach((e) => {
    allEvents.push({
      time: e.time,
      timeLabel: fmtLocalDateTime(e.time),
      entityType: "deal",
      entityId: e.ownerId,
      type: e.type,
      fromStage: stageName(dealStageNames, e.fromStage),
      toStage: stageName(dealStageNames, e.toStage),
      semantic: e.semantic,
      managerId: dealAssigneeMap[e.ownerId] != null ? String(dealAssigneeMap[e.ownerId]) : null,
    });
  });
  leadDerived.events.forEach((e) => {
    allEvents.push({
      time: e.time,
      timeLabel: fmtLocalDateTime(e.time),
      entityType: "lead",
      entityId: e.ownerId,
      type: e.type,
      fromStage: stageName(leadStatusNames, e.fromStage),
      toStage: stageName(leadStatusNames, e.toStage),
      semantic: e.semantic,
      managerId: leadAssigneeMap[e.ownerId] != null ? String(leadAssigneeMap[e.ownerId]) : null,
    });
  });
  // ---- точные события из локального приложения Bitrix24 (event.bind) ----
  // Для карточек, по которым уже накоплены реальные события (с момента подключения
  // приложения), берём именно их — там известен настоящий исполнитель действия,
  // а не текущий ответственный по карточке. Грубые события из crm.stagehistory.list
  // для этих же карточек за тот же период отбрасываем, чтобы не дублировать.
  const realRaw = store.getBitrixEvents().filter((e) => {
    const t = new Date(e.time);
    return t >= from && t < to;
  });
  const realKeys = new Set(realRaw.map((e) => e.entityType + ":" + e.entityId));
  const approxFiltered = allEvents.filter((e) => !realKeys.has(e.entityType + ":" + e.entityId));
  const realEvents = realRaw.map((e) => {
    const namesMap = e.entityType === "lead" ? leadStatusNames : dealStageNames;
    return {
      time: e.time,
      timeLabel: fmtLocalDateTime(e.time),
      entityType: e.entityType,
      entityId: e.entityId,
      type: e.type,
      fromStage: stageName(namesMap, e.fromStage),
      toStage: stageName(namesMap, e.toStage),
      semantic: null,
      managerId: e.actorId || null,
      managerName: e.actorName || null,
      real: true,
    };
  });
  const merged = approxFiltered.concat(realEvents);
  merged.sort((a, b) => new Date(b.time) - new Date(a.time));

  const byManager = {};
  merged.forEach((e) => {
    if (e.managerId == null) return;
    const m = (byManager[e.managerId] = byManager[e.managerId] || { events: [], createdDeals: 0, createdLeads: 0, movedDeals: 0, movedLeads: 0, name: null });
    if (m.events.length < MAX_EVENTS_PER_MANAGER) m.events.push(e);
    if (e.managerName && !m.name) m.name = e.managerName;
    if (e.type === "created" && e.entityType === "deal") m.createdDeals++;
    if (e.type === "created" && e.entityType === "lead") m.createdLeads++;
    if (e.type === "moved" && e.entityType === "deal") m.movedDeals++;
    if (e.type === "moved" && e.entityType === "lead") m.movedLeads++;
  });

  // показываем и активных сотрудников без единого события за период — так видно,
  // что у них просто не было назначенных карточек (а не что отчёт их "потерял").
  const ids = uniq(Object.keys(byManager).concat(Object.keys(users)));
  const rows = ids.map((id) => {
    const m = byManager[id] || { events: [], createdDeals: 0, createdLeads: 0, movedDeals: 0, movedLeads: 0, name: null };
    return {
      id: id,
      name: users[id] || m.name || ("Пользователь #" + id),
      createdDeals: m.createdDeals,
      createdLeads: m.createdLeads,
      created: m.createdDeals + m.createdLeads,
      movedDeals: m.movedDeals,
      movedLeads: m.movedLeads,
      moved: m.movedDeals + m.movedLeads,
      events: m.events,
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
