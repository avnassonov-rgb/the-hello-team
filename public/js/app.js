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

  /* ---------------- загрузка файлов ---------------- */
  function readWorkbookRows(file, cb) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var data = new Uint8Array(e.target.result);
        var wb = XLSX.read(data, { type: "array", cellDates: true });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
        cb(null, rows);
      } catch (err) {
        cb(err);
      }
    };
    reader.onerror = function () { cb(new Error("не удалось прочитать файл")); };
    reader.readAsArrayBuffer(file);
  }

  function uploadPatch(patch, cb) {
    fetch("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) { cb(null, j); })
      .catch(cb);
  }

  function initUploads() {
    document.getElementById("fileOrders").addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      readWorkbookRows(file, function (err, rows) {
        if (err) { alert("Ошибка чтения файла «" + file.name + "»: " + err.message); return; }
        var parsed = E.parseOrders(rows);
        if (!parsed.out.length) {
          alert("В файле «" + file.name + "» не найдено ни одной строки заказов. Проверьте, что это правильный файл («не отгруженные»).");
        }
        var ordersRaw = parsed.out.map(function (o) {
          return Object.assign({}, o, { date: o.date instanceof Date ? o.date.toISOString() : o.date });
        });
        uploadPatch({ ordersRaw: ordersRaw, ordersFileName: file.name, itemsFileName: serverState && serverState.meta ? serverState.meta.itemsFileName : null }, function (err2, res) {
          if (err2 || !res || !res.ok) { alert("Не удалось сохранить файл на сервере."); return; }
          serverState.ordersRaw = ordersRaw;
          serverState.meta = res.meta;
          afterDataChange();
        });
      });
    });

    document.getElementById("fileItems").addEventListener("change", function (e) {
      var file = e.target.files[0];
      if (!file) return;
      readWorkbookRows(file, function (err, rows) {
        if (err) { alert("Ошибка чтения файла «" + file.name + "»: " + err.message); return; }
        var parsed = E.parseItems(rows);
        if (!parsed.out.length) {
          alert("В файле «" + file.name + "» не найдено ни одной позиции. Проверьте, что это правильный файл («универсальный отчёт»).");
        }
        uploadPatch({ itemsRaw: parsed.out, itemsFileName: file.name, ordersFileName: serverState && serverState.meta ? serverState.meta.ordersFileName : null }, function (err2, res) {
          if (err2 || !res || !res.ok) { alert("Не удалось сохранить файл на сервере."); return; }
          serverState.itemsRaw = parsed.out;
          serverState.meta = res.meta;
          afterDataChange();
        });
      });
    });
  }

  function renderFilePills() {
    var meta = (serverState && serverState.meta) || {};
    var nmO = document.getElementById("nmOrders");
    var nmI = document.getElementById("nmItems");
    if (meta.ordersFileName) { nmO.textContent = meta.ordersFileName; nmO.classList.remove("empty"); }
    else { nmO.textContent = "не загружен"; nmO.classList.add("empty"); }
    if (meta.itemsFileName) { nmI.textContent = meta.itemsFileName; nmI.classList.remove("empty"); }
    else { nmI.textContent = "не загружен"; nmI.classList.add("empty"); }
    var stamp = document.getElementById("stampLine");
    stamp.textContent = meta.uploadedAt ? "Обновлено: " + fmtDateTime(meta.uploadedAt) : "";
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
      injectPageStyle("landscape");
      window.print();
    });
    document.getElementById("printAllBtn").addEventListener("click", function () {
      document.getElementById("printDate").textContent = "Дата печати: " + fmtDateTime(new Date().toISOString());
      document.body.classList.remove("print-plan");
      removePageStyle();
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
      row.appendChild(el("div", { class: "lbl" }, c.label));
      var track = el("div", { class: "bartrack" });
      var inner = el("div", { style: "display:flex;width:" + widthPct + "%;height:100%;" });
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
    html += '<table><thead><tr><th>наименование</th><th class="r">норма</th><th class="r">в плане</th><th class="f">факт</th></tr></thead><tbody>';
    if (!control.length) {
      html += '<tr><td colspan="4" class="empty-row">список пуст — добавьте позиции в настройках выше</td></tr>';
    } else {
      control.forEach(function (c) {
        var inPlan = controlMatch(c.name, allPlanFlat);
        var deficit = Math.max(0, (c.norm || 0) - inPlan);
        var planCell = E.fmtNum(inPlan) + (deficit > 0 ? ' <span style="color:var(--pink-dark);font-weight:700;">(−' + E.fmtNum(deficit) + ')</span>' : "");
        html += '<tr><td>' + E.esc(c.name) + '</td><td class="r q">' + E.fmtNum(c.norm || 0) + '</td>' +
          '<td class="r t">' + planCell + '</td><td class="f"></td></tr>';
      });
    }
    html += '</tbody></table>';
    return html;
  }

  function renderPlanGrid() {
    var grid = document.getElementById("planGrid");
    grid.innerHTML = "";
    for (var i = 0; i < 4; i++) {
      var card = el("div", { class: "card groupcard" }, groupCardHTML(i));
      grid.appendChild(card);
    }
    var ctrl = el("div", { class: "card groupcard control" }, controlCardHTML());
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
      '<div class="osum">' + E.fmtMoney(o.sum) + ' ₸</div></div>';
    if (o.contr) html += '<div class="shopname">' + E.esc(o.contr) + '</div>';
    if (items.length) {
      html += '<div class="items">';
      items.slice(0, 4).forEach(function (it) {
        html += '<div class="item"><span>' + E.esc(it.product) + '</span><span class="qty">' + E.fmtNum(it.qty) + '</span></div>';
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

  /* ---------------- инициализация ---------------- */
  function init() {
    initTabs();
    initLogout();
    initUploads();
    initControlButtons();
    initPrintButtons();

    fetch("/api/me").then(function (r) { return r.json(); }).then(function (me) {
      if (!me.authed) { window.location.href = "/login.html"; return; }
      return fetch("/api/state").then(function (r) { return r.json(); }).then(function (st) {
        serverState = st;
        settings = Object.assign({}, E.DEFAULT_SETTINGS, st.settings || {});
        control = (st.control && st.control.length) ? st.control : E.DEFAULT_CONTROL.map(function (c) { return Object.assign({}, c); });
        renderFilePills();
        renderSettingsForm();
        renderControlEditor();
        recomputeAndRender();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
