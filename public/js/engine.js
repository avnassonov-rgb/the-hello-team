/* ============================================================================
   ДВИЖОК РАСЧЁТОВ — THE HELLO Team / ПЧЁЛКА
   Чистая логика без привязки к DOM (работает в браузере и в Node для тестов).
   Перенесено из dashboard.html + добавлена 4-я группа плана
   («Твёрдое мыло и сухие порошки») согласно правилам бизнеса.
   ============================================================================ */
(function (root) {
  "use strict";

  const lc = (s) => String(s == null ? "" : s).toLowerCase();
  const clean = (s) => String(s == null ? "" : s).trim();
  const keyNum = (s) => clean(s).replace(/\s+/g, "").replace(/^'+/, "");
  const esc = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  function parseNum(v) {
    if (typeof v === "number") return v;
    let s = clean(v)
      .replace(/\s/g, "")
      .replace(/ /g, "")
      .replace(",", ".")
      .replace(/[^0-9.\-]/g, "");
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  function parseDate(v) {
    if (v instanceof Date) return v;
    if (typeof v === "number") return new Date(Math.round((v - 25569) * 86400 * 1000));
    const s = clean(v),
      m = s.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }

  const fmtNum = (n) => (Math.round(n * 100) / 100).toLocaleString("ru-RU");
  const fmtT = (n) => (Math.round(n * 10) / 10).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtMoney = (n) => Math.round(n).toLocaleString("ru-RU");
  const fmtDate = (d) => (d ? d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—");
  const daysSince = (d, now) => (d ? Math.floor(((now || new Date()).getTime() - d.getTime()) / 86400000) : null);
  const cyr = (s) =>
    clean(s)
      .toUpperCase()
      .replace(/C/g, "С")
      .replace(/O/g, "О")
      .replace(/P/g, "Р")
      .replace(/H/g, "Н")
      .replace(/A/g, "А");
  const kwArr = (str) =>
    String(str || "")
      .split(",")
      .map((x) => lc(x).trim())
      .filter(Boolean);

  function findHeaderRow(rows, keywords) {
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const j = (rows[i] || []).map((c) => lc(c)).join("|");
      if (keywords.filter((k) => j.includes(k)).length >= 2) return i;
    }
    return 0;
  }
  function pickCol(head, prio) {
    for (const kw of prio) for (let i = 0; i < head.length; i++) if (lc(head[i]).includes(kw)) return i;
    return -1;
  }

  /* ---------- Парсинг строк (после SheetJS sheet_to_json(header:1)) ---------- */
  function parseOrders(rows) {
    const h = findHeaderRow(rows, ["номер", "контрагент", "сумма", "отгруз"]);
    const head = rows[h] || [];
    const c = {
      number: pickCol(head, ["номер"]),
      date: pickCol(head, ["дата"]),
      sum: pickCol(head, ["сумма"]),
      status: pickCol(head, ["отгруз"]),
      contr: pickCol(head, ["контрагент", "покупател"]),
      resp: pickCol(head, ["ответствен"]),
      com: pickCol(head, ["коммент"]),
    };
    const out = [];
    for (let i = h + 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      const number = keyNum(c.number >= 0 ? r[c.number] : "");
      if (!number) continue;
      const status = c.status >= 0 ? clean(r[c.status]) : "";
      if (/отгруж/i.test(status) && !/не\s/i.test(status) && !/частич/i.test(status)) continue;
      out.push({
        number,
        date: c.date >= 0 ? parseDate(r[c.date]) : null,
        sum: c.sum >= 0 ? parseNum(r[c.sum]) : 0,
        status,
        contr: c.contr >= 0 ? clean(r[c.contr]) : "",
        resp: c.resp >= 0 ? clean(r[c.resp]) : "",
        com: c.com >= 0 ? clean(r[c.com]) : "",
      });
    }
    return { out, diag: { headerRow: h + 1, headers: head, col: c, count: out.length } };
  }

  function parseItems(rows) {
    const re = /Сч[её]т на оплату покупателю\s+(\d+)\s+от/i;
    let cur = null,
      headers = 0;
    const out = [];
    for (const r of rows) {
      if (!r) continue;
      const a = clean(r[0]);
      if (!a) continue;
      const m = a.match(re);
      if (m) {
        cur = m[1];
        headers++;
        continue;
      }
      if (/^(номенклатура|ссылка|количество)$/i.test(a) || /^универсальный отчет/i.test(a) || /^итог/i.test(a)) continue;
      let qty = null;
      for (let k = 1; k < r.length; k++) {
        if (typeof r[k] === "number") {
          qty = r[k];
          break;
        }
        const n = parseNum(r[k]);
        if (n) {
          qty = n;
          break;
        }
      }
      if (cur && qty != null) out.push({ order: cur, product: a, qty });
    }
    return { out, diag: { headerCount: headers, lineCount: out.length } };
  }

  /* ---------- Бизнес-правила ---------- */
  function categorize(o, gosKw, ownP, tkP) {
    if (!lc(o.resp).includes(lc(gosKw))) return "other";
    const p = cyr(o.com);
    if (p.startsWith(cyr(ownP))) return "own";
    if (p.startsWith(cyr(tkP))) return "tk";
    return "tk";
  }
  const matchAny = (name, kws) => {
    const t = lc(name);
    return kws.some((k) => k && t.includes(k));
  };

  /* Порядок проверки важен: твёрдое мыло/порошки -> посуда и пол -> жидкое мыло -> прочее */
  function planGroup(name, kwSolid, kwDishes, kwLiquid) {
    if (matchAny(name, kwSolid)) return 0;
    if (matchAny(name, kwDishes)) return 1;
    if (matchAny(name, kwLiquid)) return 2;
    return 3;
  }

  function unitKg(name, density) {
    const s = String(name);
    let m;
    if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*кг(?![а-яёa-z])/i))) return parseNum(m[1]);
    if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*мл(?![а-яёa-z])/i))) return (parseNum(m[1]) / 1000) * density;
    if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*(?:гр|г)(?![а-яёa-z])/i))) return parseNum(m[1]) / 1000;
    if ((m = s.match(/(\d+(?:[.,]\d+)?)\s*л(?![а-яёa-z])/i))) return parseNum(m[1]) * density;
    return null;
  }

  const GROUP_NAMES = ["Твёрдое мыло и сухие порошки", "Посуда и пол", "Жидкое мыло", "Прочее"];

  const DEFAULT_SETTINGS = {
    gosKw: "гос",
    ownPrefix: "СД",
    tkPrefix: "ГО",
    kwSolid: "твёрд, тверд, порош, сух",
    kwDishes: "посуд, пол и стен, для пола, мытья пола",
    kwLiquid: "мыло",
    kwNonProd: "предоплата, оплата за, услуг, доставк, транспорт, возврат",
    fireDays: 15,
    density: 1,
  };

  const DEFAULT_CONTROL = [
    "Гель для стирки THE HELLO 2л - вишня / миндаль / пачули (парфюмированный)",
    "Гель для стирки THE HELLO 2л - груша / маракуя / мускус (парфюмированный)",
    "Гель для стирки THE HELLO 4л - грейпфрут / сандал / бергамот (парфюмированный)",
    "Гель для стирки THE HELLO 4л - карамель / фисташка / жасмин (парфюмированный)",
    "Средство чистящие для кухни THE HELLO - АНТИЖИР 750мл (спрей)",
    "Средство чистящие для ванной THE HELLO - АНТИНАЛЕТ 750мл (спрей)",
    "Средство чистящие THE HELLO - ДЛЯ СТЕКОЛ И ЗЕРКАЛ 750мл (спрей)",
    "Средство чистящие THE HELLO - ДЛЯ КОВРОВ И МЕБЕЛИ 750мл (спрей)",
    "Парфюмированный гель для душа HELLO 1Л CHERRY LOVE (с дозатором)",
    "Парфюмированный гель для душа HELLO 1Л THAI MANGO (с дозатором)",
    "Жидкое Мыло парфюмированное FAMILY (ZERO) 500мл - груша / маракуя / мускус",
    "Жидкое Мыло парфюмированное FAMILY (ZERO) 500мл - вишня / миндаль / пачули",
  ].map((name) => ({ name, norm: 500 }));

  /* ---------- Главный расчёт ---------- */
  function compute(ordersRaw, itemsRaw, settingsIn, now) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, settingsIn || {});
    const g1 = kwArr(settings.kwSolid),
      g2 = kwArr(settings.kwDishes),
      g3 = kwArr(settings.kwLiquid),
      nonKw = kwArr(settings.kwNonProd);
    const fireDays = Math.max(0, parseInt(settings.fireDays) || 0);
    const density = Math.max(0.1, parseNum(settings.density) || 1);

    const active = (ordersRaw || []).map((o) => {
      const date = o.date instanceof Date ? o.date : parseDate(o.date);
      const age = daysSince(date, now);
      return {
        ...o,
        date,
        age,
        fire: age != null && age >= fireDays,
        part: /частич/i.test(o.status || ""),
        cat: categorize(o, settings.gosKw, settings.ownPrefix, settings.tkPrefix),
      };
    });
    const set = new Set(active.map((o) => o.number));
    const groups = [new Map(), new Map(), new Map(), new Map()];
    const other = new Map();
    let matched = 0,
      unmatched = 0;
    (itemsRaw || []).forEach((it) => {
      if (set.has(it.order)) {
        matched++;
        if (matchAny(it.product, nonKw)) {
          other.set(it.product, (other.get(it.product) || 0) + it.qty);
        } else {
          const g = planGroup(it.product, g1, g2, g3);
          groups[g].set(it.product, (groups[g].get(it.product) || 0) + it.qty);
        }
      } else if (it.order) unmatched++;
    });
    const toArr = (m) =>
      [...m.entries()].map(([p, q]) => ({ p, q })).sort((a, b) => b.q - a.q);
    const withKg = (arr) =>
      arr.map((x) => {
        const uk = unitKg(x.p, density);
        return { ...x, kg: uk == null ? null : x.q * uk };
      });
    const planGroups = groups.map((g) => withKg(toArr(g)));
    const otherArr = toArr(other);

    const allPlan = planGroups.flat();
    const units = allPlan.reduce((s, p) => s + p.q, 0);
    const totalKg = allPlan.reduce((s, p) => s + (p.kg || 0), 0);
    const unknown = allPlan.filter((p) => p.kg == null).length;
    const fires = active.filter((o) => o.fire);

    return {
      settings,
      active,
      fires,
      planGroups,
      other: otherArr,
      matched,
      unmatched,
      totals: { units, totalKg, unknown, ordersCount: active.length, firesCount: fires.length, skus: allPlan.length },
    };
  }

  const Engine = {
    parseNum,
    parseDate,
    clean,
    lc,
    keyNum,
    esc,
    findHeaderRow,
    pickCol,
    parseOrders,
    parseItems,
    categorize,
    matchAny,
    planGroup,
    unitKg,
    cyr,
    kwArr,
    fmtNum,
    fmtT,
    fmtMoney,
    fmtDate,
    daysSince,
    compute,
    GROUP_NAMES,
    DEFAULT_SETTINGS,
    DEFAULT_CONTROL,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Engine;
  if (typeof window !== "undefined") window.Engine = Engine;
})(typeof globalThis !== "undefined" ? globalThis : this);
