(function () {
  "use strict";
  var form = document.getElementById("loginForm");
  var pwInput = document.getElementById("password");
  var errBox = document.getElementById("err");
  var btn = document.getElementById("loginBtn");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    errBox.classList.remove("show");
    btn.disabled = true;
    btn.textContent = "Входим...";
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pwInput.value }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j && res.j.ok) {
          window.location.href = "/app.html";
        } else {
          errBox.classList.add("show");
          btn.disabled = false;
          btn.textContent = "Войти";
          pwInput.value = "";
          pwInput.focus();
        }
      })
      .catch(function () {
        errBox.textContent = "Не удалось связаться с сервером. Проверьте подключение.";
        errBox.classList.add("show");
        btn.disabled = false;
        btn.textContent = "Войти";
      });
  });
})();
