(function () {
  "use strict";
  var E = window.Engine;

  /* ---------------- состояние ---------------- */
  var serverState = null; // { ordersRaw, itemsRaw, settings, control, meta }
  var computed = null;
  var settings = null;
  var control = null;

  /* ---------------- утилиты ---------------- */
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }
  function fmtDateTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    function p(n) { return n < 10 ? "0" + n : "" + n; }
    return p(d.getDate()) + "." + p(d.getMonth() + 1) + "." + d.getFullYear() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ---------------- вкладки ---------------- */
  function initTabs() {
    $all(".tabbar .tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        $all(".tabbar .tab").forEach(function (b) { b.classList.remove("active"); });
        btn.classList.add("active");
        var name = btn.getAttribute("data-tab");
        $all(".tabpanel").forEach(function (p) { p.classList.add("hidden"); });
        var panel = document.getElementById("tab-" + name);
        if (panel) panel.classList.remove("hidden");
      });
    });
  }

  /* ---------------- выход ---------------- */
  function initLogout() {
    var btn = document.getElementById("logoutBtn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      fetch("/api/logout", { method: "POST" }).then(function () {
        window.location.href = "/login.html";
      });
    });
  }

  /* ---------------- синхронизация с 1С ---------------- */
  var syncing = false;
  var lastSeenSyncAt = null;

  function renderFilePills() {
    var meta = (serverState && serverState.meta) || {};
    var nm = document.getElementById("nmSync");
    var stamp = document.getElementById("stampLine");
    if (!nm) return;
    if (syncing) {
      nm.textContent = "обновление...";
      nm.classList.add("empty");
    } else if (meta.lastSyncOk === false) {
      nm.textContent = "ошибка синка";
      nm.classList.add("empty");
    } else if (meta.lastSyncAt) {
      nm.textContent = "ордеров " + (meta.ordersCount != null ? meta.ordersCount : "—");
      nm.classList.remove("empty");
    } else {
      nm.textContent = "ожидание первого синка";
      nm.classList.add("empty");
    }
    if (stamp) {
      if (meta.lastSyncAt) {
        var dbg = meta.debug;
        var dbgTxt = dbg ? (" · получено счетов: " + dbg.totalFetched + ", удалено: " + dbg.skippedDeleted + ", отгружено: " + dbg.skippedShipped + ", без номера: " + dbg.skippedNoNumber + ", реализаций: " + dbg.realizCount + ", в справочнике товаров: " + dbg.nomCount + ", в характеристиках: " + (dbg.charCount != null ? dbg.charCount : "—") + ", не распознано позиций: " + dbg.unknownItemsCount +
          " · счёт.expand: " + (dbg.expandUsed || "нет") + ", тов.expand: " + (dbg.tovaryExpand || "нет") +
          ", без ответственного: " + dbg.respEmptyCount + (dbg.respSample ? " (пример: " + dbg.respSample + ")" : "") +
          (dbg.invoiceExpandError ? (" · ошибка expand счетов: " + dbg.invoiceExpandError) : "") +
          (dbg.charFetchError ? (" · ошибка справочника характеристик: " + dbg.charFetchError) : "") +
          (dbg.unresolvedSampleJson ? (" · пример нераспознанной строки товара: " + dbg.unresolvedSampleJson) : "") +
          (dbg.directLookup ? (" · прямой запрос по GUID " + dbg.directLookup.key + ": " + (dbg.directLookup.found ? ("найден — " + dbg.directLookup.data) : ("не найден — " + dbg.directLookup.error))) : "")) : "";
        stamp.textContent = (meta.lastSyncOk === false ? "Ошибка: " + (meta.lastSyncError || "") + " · посл. попытка " : "Обновлено: ") + fmtDateTime(meta.lastSyncAt) + dbgTxt;
      } else {
        stamp.textContent = "";
      }
    }
  }

  function applyState(st) {
    serverState = st;
    afterDataChange();
  }

  function initSync() {
    var btn = document.getElementById("syncRefreshBtn");
    if (btn) {
      btn.addEventListener("click", function () {
        if (syncing) return;
        syncing = true;
        renderFilePills();
        fetch("/api/onec/refresh", { method: "POST" })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            syncing = false;
            if (j && j.state) applyState(j.state);
            else renderFilePills();
            if (j && j.ok === false) {
              alert("Не удалось обновить данные из 1С: " + (j.error || "неизвестная ошибка"));
            }
          })
          .catch(function () {
            syncing = false;
            renderFilePills();
            alert("Ошибка соединения с сервером.");
          });
      });
    }

    // Лёгкий опрос состояния — подхватывает данные, которые сервер обновил сам
    // по таймеру (каждые 5 минут), без участия пользователя.
    setInterval(function () {
      if (syncing) return;
      fetch("/api/state")
        .then(function (r) { return r.json(); })
        .then(function (st) {
          var newAt = st && st.meta && st.meta.lastSyncAt;
          if (newAt && newAt !== lastSeenSyncAt) {
            lastSeenSyncAt = newAt;
            applyState(st);
          }
        })
        .catch(function () {});
    }, 60 * 1000);
  }

  /* ---------------- настройки ---------------- */
  var SETTINGS_FIELDS = [
    { key: "gosKw", label: "Ключевое слово «гос.закуп» (поле «Ответственный»)", hint: "Заказы, где это слово встречается в ответственном — считаются гос.закупом." },
    { key: "ownPrefix", label: "Префикс «своя доставка» в комментарии", hint: "Например: СД" },
    { key: "tkPrefix", label: "Префикс «через ТК» в комментарии", hint: "Например: ГО" },
    { key: "kwSolid", label: "Ключевые слова — твёрдое мыло и сухие порошки", hint: "через запятую" },
    { key: "kwDishes", label: "Ключевые слова — посуда и пол", hint: "через запятую" },
    { key: "kwLiquid", label: "Ключевые слова — жидкое мыло", hint: "через запятую" },
    { key: "kwNonProd", label: "Ключевые слова — «прочее» (не производство)", hint: "через запятую: услуги, доставка, предоплата и т.п." },
  ];

  function renderSettingsForm() {
    var body = document.getElementById("settingsBody");
    body.innerHTML = "";
    SETTINGS_FIELDS.forEach(function (f) {
      var wrap = el("div", { class: "field" });
      wrap.appendChild(el("label", {}, f.label));
      wrap.appendChild(el("div", { class: "hint" }, f.hint));
      var input = el("input", { type: "text", "data-key": f.key });
      input.value = settings[f.key] || "";
      wrap.appendChild(input);
      body.appendChild(wrap);
    });
    var row = el("div", { class: "field", style: "display:flex;gap:24px;" });
    var w1 = el("div", {});
    w1.appendChild(el("label", {}, "«Горит», дней с даты счёта"));
    var i1 = el("input", { type: "number", "data-key": "fireDays", min: "0" });
    i1.value = settings.fireDays;
    w1.appendChild(i1);
    var w2 = el("div", {});
    w2.appendChild(el("label", {}, "Плотность (для мл→кг), г/мл"));
    var i2 = el("input", { type: "number", "data-key": "density", min: "0.1", step: "0.01" });
    i2.value = settings.density;
    w2.appendChild(i2);
    row.appendChild(w1); row.appendChild(w2);
    body.appendChild(row);
    var saveBtn = el("button", { class: "btn btn-pink", type: "button" }, "Сохранить настройки");
    saveBtn.addEventListener("click", function () {
      var next = Object.assign({}, settings);
      $all("#settingsBody input").forEach(function (inp) {
        var key = inp.getAttribute("data-key");
        next[key] = inp.type === "number" ? E.parseNum(inp.value) : inp.value;
      });
      settings = next;
      fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) })
        .then(function () { recomputeAndRender(); });
    });
    body.appendChild(saveBtn);
  }

  /* ---------------- список контроля ---------------- */
  function renderControlEditor() {
    var rowsWrap = document.getElementById("controlRows");
    rowsWrap.innerHTML = "";
    control.forEach(function (item, idx) {
      var row = el("div", { class: "crow" });
      var nameInp = el("input", { type: "text", "data-idx": idx, "data-f": "name" });
      nameInp.value = item.name || "";
      var normInp = el("input", { type: "number", "data-idx": idx, "data-f": "norm", min: "0" });
      normInp.value = item.norm != null ? item.norm : 0;
      var delBtn = el("button", { class: "cdel", type: "button", title: "Удалить" }, "✕");
      delBtn.addEventListener("click", function () { control.splice(idx, 1); renderControlEditor(); });
      row.appendChild(nameInp); row.appendChild(normInp); row.appendChild(delBtn);
      rowsWrap.appendChild(row);
    });
    document.getElementById("controlCount").textContent = control.length;
  }

  function initControlButtons() {
    document.getElementById("addControlBtn").addEventListener("click", function () {
      control.push({ name: "", norm: 0 });
      renderControlEditor();
    });
    document.getElementById("saveControlBtn").addEventListener("click", function () {
      var rowsWrap = document.getElementById("controlRows");
      var next = control.map(function (_, idx) {
        var nameInp = rowsWrap.querySelector('input[data-f="name"][data-idx="' + idx + '"]');
        var normInp = rowsWrap.querySelector('input[data-f="norm"][data-idx="' + idx + '"]');
        return { name: nameInp ? nameInp.value.trim() : "", norm: normInp ? E.parseNum(normInp.value) : 0 };
      }).filter(function (x) { return x.name; });
      control = next;
      fetch("/api/control", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(control) })
        .then(function () { renderControlEditor(); recomputeAndRender(); });
    });
  }

  /* ---------------- печать ---------------- */
  function injectPageStyle(size) {
    removePageStyle();
    var s = el("style", { id: "pgsize" }, "@page{size:" + size + ";margin:12mm;}");
    document.head.appendChild(s);
  }
  function removePageStyle() {
    var s = document.getElementById("pgsize");
    if (s) s.remove();
  }
  function initPrintButtons() {
    document.getElementById("printPlanBtn").addEventListener("click", function () {
      document.getElementById("printDate").textContent = "Дата печати: " + fmtDateTime(new Date().toISOString());
      document.body.classList.add("print-plan");
      injectPageStyle("portrait");
      window.print();
    });
    window.addEventListener("afterprint", function () {
      document.body.classList.remove("print-plan");
      removePageStyle();
    });
  }

  /* ---------------- рендер расчёта ---------------- */
  function recomputeAndRender() {
    var hasData = serverState && serverState.ordersRaw && serverState.itemsRaw &&
      serverState.ordersRaw.length && serverState.itemsRaw.length;
    document.getElementById("planEmpty").classList.toggle("hidden", !!hasData);
    document.getElementById("planContent").classList.toggle("hidden", !hasData);
    if (!hasData) return;

    computed = E.compute(serverState.ordersRaw, serverState.itemsRaw, settings, new Date());
    renderKpis();
    renderBars();
    renderPlanGrid();
    renderOther();
    renderCategoryOrders();
  }

  function renderKpis() {
    document.getElementById("kpiOrders").textContent = computed.totals.ordersCount.toLocaleString("ru-RU");
    document.getElementById("kpiFires").textContent = computed.totals.firesCount.toLocaleString("ru-RU");
    document.getElementById("kpiUnits").textContent = E.fmtNum(computed.totals.units);
    document.getElementById("kpiTons").textContent = E.fmtT(computed.totals.totalKg / 1000);
  }

  function renderBars() {
    var cats = [
      { key: "own", label: "своя доставка" },
      { key: "tk", label: "готов к отправке (через ТК)" },
      { key: "other", label: "прочие заказы" },
    ];
    var byCat = { own: [], tk: [], other: [] };
    computed.active.forEach(function (o) { byCat[o.cat] && byCat[o.cat].push(o); });
    var totals = cats.map(function (c) { return byCat[c.key].length; });
    var max = Math.max.apply(null, totals.concat([1]));
    var wrap = document.getElementById("barsWrap");
    wrap.innerHTML = "";
    cats.forEach(function (c) {
      var list = byCat[c.key];
      var total = list.length;
      var fire = list.filter(function (o) { return o.fire; }).length;
      var widthPct = total ? Math.max(8, (total / max) * 100) : 0;
      var pinkPct = total ? ((total - fire) / total) * 100 : 0;
      var darkPct = total ? (fire / total) * 100 : 0;
      var row = el("div", { class: "barrow" });
      var track = el("div", { class: "bartrack" + (total ? "" : " is-empty") });
      track.appendChild(el("div", { class: "bar-label" }, c.label));
      var inner = el("div", { class: "bar-inner", style: "width:" + widthPct + "%;" });
      if (total - fire > 0) {
        var pf = el("div", { class: "barfill pink", style: "width:" + pinkPct + "%;" });
        pf.appendChild(el("span", { class: "n" }, String(total - fire)));
        inner.appendChild(pf);
      }
      if (fire > 0) {
        var df = el("div", { class: "barfill dark", style: "width:" + darkPct + "%;" });
        df.appendChild(el("span", { class: "n" }, String(fire)));
        inner.appendChild(df);
      }
      track.appendChild(inner);
      row.appendChild(track);
      wrap.appendChild(row);
    });
  }

  function controlMatch(controlName, allPlanFlat) {
    var cn = E.lc(controlName);
    var sum = 0;
    allPlanFlat.forEach(function (x) {
      var pn = E.lc(x.p);
      if (pn.indexOf(cn) !== -1 || cn.indexOf(pn) !== -1) sum += x.q;
    });
    return sum;
  }

  function groupCardHTML(idx) {
    var name = E.GROUP_NAMES[idx];
    var arr = computed.planGroups[idx];
    var units = arr.reduce(function (s, x) { return s + x.q; }, 0);
    var kg = arr.reduce(function (s, x) { return s + (x.kg || 0); }, 0);
    var html = "";
    html += '<div class="gh"><span class="pill-tag dark">' + E.esc(name) + '</span>' +
      '<span class="pill-stat">' + arr.length + ' позиц | ' + E.fmtNum(units) + 'ед | ' + E.fmtT(kg / 1000) + 'т</span></div>';
    html += '<table><thead><tr><th>наименование</th><th class="r">кол-во</th><th class="r">тонн</th><th class="f">факт</th></tr></thead><tbody>';
    if (!arr.length) {
      html += '<tr><td colspan="4" class="empty-row">нет позиций</td></tr>';
    } else {
      arr.forEach(function (x) {
        html += '<tr><td>' + E.esc(x.p) + '</td><td class="r q">' + E.fmtNum(x.q) + '</td>' +
          '<td class="r t">' + (x.kg == null ? "—" : E.fmtT(x.kg / 1000)) + '</td><td class="f"></td></tr>';
      });
      html += '<tr class="sum"><td>Итого</td><td class="r">' + E.fmtNum(units) + '</td><td class="r">' + E.fmtT(kg / 1000) + '</td><td class="f"></td></tr>';
    }
    html += '</tbody></table>';
    return html;
  }

  function controlCardHTML() {
    var allPlanFlat = computed.planGroups.flat();
    var html = "";
    html += '<div class="gh"><span class="pill-tag pink">неснижаемый остаток (контроль)</span>' +
      '<span class="pill-stat">' + control.length + ' позиц</span></div>';
    html += '<table><thead><tr><th>наименование</th><th class="r">кол-во</th></tr></thead><tbody>';
    if (!control.length) {
      html += '<tr><td colspan="2" class="empty-row">список пуст — добавьте позиции в настройках выше</td></tr>';
    } else {
      control.forEach(function (c) {
        var inPlan = controlMatch(c.name, allPlanFlat);
        var deficit = Math.max(0, (c.norm || 0) - inPlan);
        var qtyCell = E.fmtNum(c.norm || 0) + (deficit > 0 ? ' <span style="color:var(--pink-dark);font-weight:700;">(не хватает ' + E.fmtNum(deficit) + ')</span>' : "");
        html += '<tr><td>' + E.esc(c.name) + '</td><td class="r q">' + qtyCell + '</td></tr>';
      });
    }
    html += '</tbody></table>';
    return html;
  }

  function renderPlanGrid() {
    var grid = document.getElementById("planGrid");
    grid.innerHTML = "";
    // визуальный порядок по макету: жидкое мыло, посуда и пол, прочее (1 ряд), твёрдое мыло (2 ряд)
    var order = [2, 1, 3, 0];
    order.forEach(function (i) {
      var card = el("div", { class: "groupcard" }, groupCardHTML(i));
      grid.appendChild(card);
    });
    var ctrl = el("div", { class: "groupcard control" }, controlCardHTML());
    grid.appendChild(ctrl);
  }

  function renderOther() {
    var body = document.getElementById("otherBody");
    body.innerHTML = "";
    if (!computed.other.length) {
      body.innerHTML = '<tr><td colspan="2" style="color:var(--faint);padding:8px 0;">нет позиций</td></tr>';
      return;
    }
    computed.other.forEach(function (x) {
      var tr = el("tr", {}, '<td>' + E.esc(x.p) + '</td><td class="r">' + E.fmtNum(x.q) + '</td>');
      body.appendChild(tr);
    });
  }

  function orderCardHTML(o, itemsByOrder) {
    var items = itemsByOrder[o.number] || [];
    var cls = "order" + (o.fire ? " fire" : "");
    var html = '<div class="' + cls + '">';
    html += '<div class="r1"><div><span class="onum">№' + E.esc(o.number) + '</span><span class="odate">' + E.fmtDate(o.date) + '</span></div>' +
      '<div class="osum">' + E.fmtMoney(o.sum) + '₸</div></div>';
    if (items.length) {
      html += '<div class="items">';
      items.slice(0, 4).forEach(function (it) {
        html += '<div class="item"><span>' + E.esc(it.product) + '</span><span class="qty">' + E.fmtNum(it.qty) + ' шт</span></div>';
      });
      if (items.length > 4) html += '<div class="item"><span>+' + (items.length - 4) + ' ещё позиций…</span><span></span></div>';
      html += '</div>';
    }
    if (o.fire) html += '<div class="r3"><span class="firebadge">горит — ' + (o.age == null ? "?" : o.age) + ' дн.</span></div>';
    html += '</div>';
    return html;
  }

  function renderCategoryOrders() {
    var itemsByOrder = {};
    (serverState.itemsRaw || []).forEach(function (it) {
      (itemsByOrder[it.order] = itemsByOrder[it.order] || []).push(it);
    });
    var cats = { own: [], tk: [], other: [] };
    computed.active.forEach(function (o) { cats[o.cat] && cats[o.cat].push(o); });
    [["catOwn", "own"], ["catTk", "tk"], ["catOther", "other"]].forEach(function (pair) {
      var wrap = document.getElementById(pair[0]);
      var list = cats[pair[1]].slice().sort(function (a, b) { return (b.age || 0) - (a.age || 0); });
      wrap.innerHTML = "";
      if (!list.length) {
        wrap.innerHTML = '<div class="empty-cat">нет заказов</div>';
        return;
      }
      list.forEach(function (o) {
        wrap.insertAdjacentHTML("beforeend", orderCardHTML(o, itemsByOrder));
      });
    });
  }

  function afterDataChange() {
    renderFilePills();
    recomputeAndRender();
  }

  /* ---------------- менеджеры (Bitrix24) ---------------- */
  var managersLoaded = false;
  var currentFrom = null;
  var currentTo = null;

  function mgrTodayStr() {
    var d = new Date();
    var p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  function fmtMgrNum(n) { return (n || 0).toLocaleString("ru-RU"); }

  // Палитра-заглушка для этапов, у которых Bitrix24 не вернул цвет (COLOR) —
  // не влияет на этапы, у которых цвет известен (там используется цвет как в канбане).
  var MGR_FALLBACK_PALETTE = ["#85D0F2", "#F4367F", "#594C51", "#7FD8A4", "#FFC36E", "#B6A4E8", "#FF8FA3", "#6EC6CA"];
  function mgrFallbackColor(idx) { return MGR_FALLBACK_PALETTE[idx % MGR_FALLBACK_PALETTE.length]; }

  // Подбирает чёрный/белый текст по яркости фона, чтобы цифра в цветном сегменте читалась.
  function mgrTextOn(hex) {
    var h = (hex || "").replace("#", "");
    if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return "#fff";
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.62 ? "#1F1F1F" : "#fff";
  }

  // Значок чемпиона — кубок (SVG), для самого результативного сотрудника за период.
  var MGR_TROPHY_SVG = '<svg class="icon" viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h12v2h3v2.5a4.5 4.5 0 0 1-4.04 4.478A6.01 6.01 0 0 1 13 15.92V18h3v2H8v-2h3v-2.08a6.01 6.01 0 0 1-3.96-4.942A4.5 4.5 0 0 1 3 7.5V5h3V3zm0 4H4.5v.5A2.5 2.5 0 0 0 6.6 9.94 8.6 8.6 0 0 1 6 7zm12 0a8.6 8.6 0 0 1-.6 2.94A2.5 2.5 0 0 0 19.5 7.5V7H18z"/></svg>';

  // Визуальная разбивка по этапам: каждый этап — своя цветная полоса на всю ширину,
  // цвет берётся из Bitrix24 (как в канбане), название этапа слева, количество справа.
  function mgrStageRowsHTML(items, total) {
    if (!items || !items.length || !total) {
      return '<div class="mgr-stage-empty">нет данных за период</div>';
    }
    return '<div class="mgr-stage-rows">' + items.map(function (it, i) {
      var color = it.color || mgrFallbackColor(i);
      return '<div class="mgr-stage-row" style="background:' + E.esc(color) + ';color:' + mgrTextOn(color) + ';">' +
        '<span class="lbl">' + E.esc(it.stage) + '</span>' +
        '<span class="cnt">' + fmtMgrNum(it.count) + '</span>' +
        '</div>';
    }).join("") + '</div>';
  }

  function managerCardHTML(r, isChampion) {
    var total = r.created + r.moved;
    var html = '<div class="mgr-card' + (isChampion ? " champion" : "") + '">';
    html += '<div class="mgr-card-head"><div class="mgr-card-name">' + E.esc(r.name) +
      (isChampion ? ' <span class="mgr-champion-badge">' + MGR_TROPHY_SVG + ' Чемпион</span>' : "") + '</div>' +
      '<div class="mgr-card-total">всего за период <b>' + fmtMgrNum(total) + '</b></div></div>';
    html += '<div class="mgr-card-section"><div class="mgr-section-title">Создано <b>' + fmtMgrNum(r.created) + '</b></div>' +
      mgrStageRowsHTML(r.createdByStage, r.created) + '</div>';
    html += '<div class="mgr-card-section"><div class="mgr-section-title">Перемещено <b>' + fmtMgrNum(r.moved) + '</b></div>' +
      mgrStageRowsHTML(r.movedByStage, r.moved) + '</div>';
    html += '</div>';
    return html;
  }

  function renderManagerCards(report) {
    var msg = document.getElementById("managersMsg");
    var wrap = document.getElementById("managersCards");
    wrap.innerHTML = "";
    if (!report.rows.length) {
      msg.textContent = "За выбранный период нет данных по менеджерам.";
      msg.classList.remove("hidden");
      wrap.classList.add("hidden");
      return;
    }
    wrap.classList.remove("hidden");
    // отчёт уже отсортирован по сумме (создано+перемещено) по убыванию — первый с ненулевым
    // итогом и есть самый результативный сотрудник за период, ему достаётся кубок.
    report.rows.forEach(function (r, idx) {
      var isChampion = idx === 0 && (r.created + r.moved) > 0;
      wrap.insertAdjacentHTML("beforeend", managerCardHTML(r, isChampion));
    });
    if (!report.hasUserNames) {
      msg.textContent = "Имена сотрудников не получены — у вебхука Bitrix24 нет прав «Пользователи». Показаны технические ID вместо имён.";
      msg.classList.remove("hidden");
    } else {
      msg.classList.add("hidden");
    }
  }

  function loadManagersReport(fromStr, toStr) {
    currentFrom = fromStr;
    currentTo = toStr;
    var msg = document.getElementById("managersMsg");
    var wrap = document.getElementById("managersCards");
    msg.textContent = "Загрузка данных из Bitrix24…";
    msg.classList.remove("hidden");
    wrap.classList.add("hidden");
    fetch("/api/bitrix/report?from=" + encodeURIComponent(fromStr) + "&to=" + encodeURIComponent(toStr))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) {
          msg.textContent = (j && j.message) || "Не удалось получить данные из Bitrix24.";
          msg.classList.remove("hidden");
          wrap.classList.add("hidden");
          return;
        }
        renderManagerCards(j.report);
      })
      .catch(function () {
        msg.textContent = "Ошибка соединения с сервером.";
        msg.classList.remove("hidden");
        wrap.classList.add("hidden");
      });
  }

  function initManagersTab() {
    var fromInput = document.getElementById("periodFrom");
    var toInput = document.getElementById("periodTo");
    var todayStr = mgrTodayStr();
    fromInput.value = todayStr;
    toInput.value = todayStr;
    currentFrom = todayStr;
    currentTo = todayStr;

    var applyBtn = document.getElementById("periodApplyBtn");
    applyBtn.addEventListener("click", function () {
      var f = fromInput.value || todayStr;
      var t = toInput.value || f;
      loadManagersReport(f, t);
    });
    var refreshBtn = document.getElementById("periodRefreshBtn");
    refreshBtn.addEventListener("click", function () {
      loadManagersReport(currentFrom, currentTo);
    });

    var tabBtn = document.querySelector('.tab[data-tab="managers"]');
    if (tabBtn) {
      tabBtn.addEventListener("click", function () {
        if (!managersLoaded) {
          managersLoaded = true;
          loadManagersReport(currentFrom, currentTo);
        }
      });
    }
  }

  /* ---------------- инициализация ---------------- */
  function init() {
    initTabs();
    initLogout();
    initSync();
    initControlButtons();
    initPrintButtons();
    initManagersTab();

    fetch("/api/me").then(function (r) { return r.json(); }).then(function (me) {
      if (!me.authed) { window.location.href = "/login.html"; return; }
      return fetch("/api/state").then(function (r) { return r.json(); }).then(function (st) {
        serverState = st;
        settings = Object.assign({}, E.DEFAULT_SETTINGS, st.settings || {});
        control = (st.control && st.control.length) ? st.control : E.DEFAULT_CONTROL.map(function (c) { return Object.assign({}, c); });
        lastSeenSyncAt = st && st.meta && st.meta.lastSyncAt || null;
        renderFilePills();
        renderSettingsForm();
        renderControlEditor();
        recomputeAndRender();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
