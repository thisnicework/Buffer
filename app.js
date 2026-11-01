(function () {
  "use strict";
  var state = { price: 0, shows: [], openAt: 0, offset: 0, loaded: false, failed: false };
  var mine = null; // {code, show, name, phone}
  var confirmCancel = false, cancelBusy = false, lookupErr = "", lookupBusy = false;
  var dlg = null, lastFocus = null;
  var STORE = "buffer-ticket";

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function now() { return Date.now() + state.offset; }
  function isOpen() { return state.loaded && now() >= state.openAt; }
  function showById(id) { return state.shows.filter(function (s) { return s.id === id; })[0]; }
  function say(m) { $("live").textContent = m; }
  function maskPhone(p) { var d = String(p).replace(/\D/g, ""); return d.length >= 8 ? d.slice(0, 3) + "-****-" + d.slice(-4) : d; }
  function fmtPhone(v) {
    var d = v.replace(/\D/g, "").slice(0, 11);
    if (d.length > 7) return d.slice(0, 3) + "-" + d.slice(3, d.length - 4) + "-" + d.slice(-4);
    if (d.length > 3) return d.slice(0, 3) + "-" + d.slice(3);
    return d;
  }
  function saveMine() { try { if (mine) localStorage.setItem(STORE, JSON.stringify({ name: mine.name, phone: mine.phone, code: mine.code })); else localStorage.removeItem(STORE); } catch (e) {} }

  async function post(url, body) {
    var r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    var data = {}; try { data = await r.json(); } catch (e) {}
    if (!r.ok) { var err = new Error(data.message || "요청을 처리하지 못했습니다."); err.code = data.error; err.status = r.status; throw err; }
    return data;
  }

  /* ---- hero: 점 격자 ---- */
  (function () {
    // 점 4열 × 12행. 위치는 기둥 너비/창 높이에 비례 (CSS에서 계산)
    var xs = [-0.93, -0.31, 0.31, 0.93], box = $("xdots");
    for (var r = 0; r < 12; r++) for (var c = 0; c < 4; c++) {
      var d = el("i", "c" + c + (Math.abs(-1.55 + r * 0.282) < 0.62 ? " band" : ""));
      d.style.setProperty("--cx", xs[c]); d.style.setProperty("--cy", (-1.55 + r * 0.282).toFixed(3));
      d.style.setProperty("--dl", (r * 0.3).toFixed(1) + "s");   // 위에서 아래로 차례로 깜빡
      box.appendChild(d);
    }
    // 기둥 세로선 3개(왼쪽·가운데·오른쪽)를 따라 작은 블록이 위에서 아래로 흐름. 버퍼링되는 데이터처럼
    var col = document.querySelector(".x-col"), spine = document.querySelector(".x-spine");
    [[col, "l", [[7.5, 0], [11, -6]]], [col, "r", [[9, -3], [13, -9.5]]], [spine, "s", [[4.2, -1], [5.6, -3.8]]]].forEach(function (lane) {
      var f = el("div", "x-flow " + lane[1]); f.setAttribute("aria-hidden", "true");
      lane[2].forEach(function (t, k) {
        var b = el("b");
        b.style.setProperty("--d", t[0] + "s"); b.style.setProperty("--dl", t[1] + "s");
        b.style.setProperty("--h", (k ? 14 : 34) + "px");
        f.appendChild(b);
      });
      lane[0].appendChild(f);
    });
  })();

  /* ---- 큰 제목 크기 맞춤: 컴퓨터에선 BUFFER·11.14–15가 가운데 기둥에 닿지 않게, 모바일에선 화면 폭 안에 ---- */
  (function () {
    var hero = document.querySelector(".hero"), col = document.querySelector(".x-col"), bs = document.querySelectorAll(".x-ttl b");
    if (!hero || !col || !bs.length) return;
    function fit() {
      bs.forEach(function (b) { b.style.fontSize = ""; });
      var mobile = innerWidth <= 700, H = hero.getBoundingClientRect(), C = col.getBoundingClientRect();
      var room = mobile ? H.width - 28 : Math.min(C.left - H.left, H.right - C.right) - 16 - 28;
      var worst = 1;
      bs.forEach(function (b) {
        var rg = document.createRange(); rg.selectNodeContents(b);
        var w = rg.getBoundingClientRect().width; if (w > 0) worst = Math.min(worst, room / w);
      });
      if (worst < 1) bs.forEach(function (b) { b.style.fontSize = (parseFloat(getComputedStyle(b).fontSize) * worst).toFixed(1) + "px"; });
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    addEventListener("resize", fit); fit();
  })();

  /* ---- 기둥 안 "총 4회차 …" 줄: 기둥 폭에 들어가도록 글자 크기를 맞추고(최대 기본 크기), 남는 폭은 양끝 맞춤 ---- */
  (function () {
    var p = $("xfit"); if (!p) return;
    var t = p.querySelector(".fit");
    function fit() {
      p.style.fontSize = "";
      var base = parseFloat(getComputedStyle(p).fontSize);
      var rg = document.createRange(); rg.selectNodeContents(t);
      var need = rg.getBoundingClientRect().width, have = p.clientWidth;
      if (need > have) p.style.fontSize = (base * have / need * 0.985).toFixed(2) + "px";
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    addEventListener("resize", fit); fit();
  })();

  /* ---- gallery + lightbox ---- */
  var PROFILE = function (i) { return "/assets/profile/Buffer_Profile_v1027-" + i + ".jpg"; };
  var GALLERY = [];
  var lb = null;
  function zoomBtn(src, alt, w, h, idx) {
    var b = el("button", "zoom"); b.type = "button"; b.setAttribute("aria-label", alt + " 크게 보기");
    var im = el("img"); im.src = src; im.alt = alt; im.loading = "lazy"; im.decoding = "async"; im.width = w; im.height = h;
    b.appendChild(im); b.addEventListener("click", function () { openLb(idx); });
    return b;
  }
  /* 퍼포머 슬라이드: 가운데 1장 + 양옆 걸침, 화살표·스와이프·키보드·패널의 − / + 로 전환 */
  (function () {
    // 1~9: 개인 프로필(세로 4:5), 10: 단체 프로필(가로, 원래 비율 그대로)
    var N = 10, cur = 0, box = $("profiles"), stage = el("div", "pf-stage"), items = [], AR = [];
    for (var i = 1; i <= N; i++) {
      var grp = i === 10, alt = grp ? "BUFFER 버퍼 퍼포머 단체 프로필" : "BUFFER 버퍼 퍼포머 프로필 " + i;
      GALLERY.push({ src: PROFILE(i), alt: alt });
      AR.push(grp ? 14408 / 7707 : 4 / 5);
      var it = el("button", "pf-item"); it.type = "button";
      var im = el("img"); im.src = PROFILE(i); im.alt = alt; im.loading = "lazy"; im.decoding = "async"; im.width = grp ? 14408 : 4800; im.height = grp ? 7707 : 6000;
      it.appendChild(im);
      (function (k) { it.addEventListener("click", function () { if (k === cur) openLb(k); else go(k); }); })(i - 1);
      stage.appendChild(it); items.push(it);
    }
    var prev = el("button", "pf-nav", "‹"), next = el("button", "pf-nav", "›");
    prev.type = next.type = "button"; prev.setAttribute("aria-label", "이전 퍼포머"); next.setAttribute("aria-label", "다음 퍼포머");
    prev.addEventListener("click", function () { go(cur - 1); }); next.addEventListener("click", function () { go(cur + 1); });
    stage.appendChild(prev); stage.appendChild(next);

    // 오른쪽 패널 (내용은 사이트에 이미 있는 정보)
    var panel = el("div", "pf-panel");
    function row(cls) { var r = el("div", "pf-row" + (cls ? " " + cls : "")); panel.appendChild(r); return r; }
    var r1 = row(); r1.appendChild(el("div", "pf-k", "PERFORMERS")); var num = el("div", "pf-n"); r1.appendChild(num);
    var title = el("div", "pf-title"); row("one").appendChild(title);
    var r3 = row(); r3.appendChild(el("div", null, "BUFFER 버퍼"));
    var zoom = el("button", "pf-btn", "크게 보기"); zoom.type = "button"; zoom.addEventListener("click", function () { openLb(cur); }); r3.appendChild(zoom);
    var r4 = row(), c1 = el("div"), c2 = el("div");
    c1.appendChild(el("div", "pf-k", "공연")); c1.appendChild(el("div", null, "2026.11.14 – 11.15"));
    c2.appendChild(el("div", "pf-k", "퍼포머"));
    var step = el("div", "pf-step"), minus = el("button", null, "−"), val = el("span"), plus = el("button", null, "+");
    minus.type = plus.type = "button"; minus.setAttribute("aria-label", "이전 퍼포머"); plus.setAttribute("aria-label", "다음 퍼포머");
    minus.addEventListener("click", function () { go(cur - 1); }); plus.addEventListener("click", function () { go(cur + 1); });
    step.appendChild(minus); step.appendChild(val); step.appendChild(plus); c2.appendChild(step);
    r4.appendChild(c1); r4.appendChild(c2);
    var d = el("div", "pf-desc"); row("one").appendChild(d);
    d.appendChild(el("p", null, "퍼포머 · 김민 김선율 김수아 김지민 염지원 이봄 이승환 임세령 최승영"));
    d.appendChild(el("p", null, "Space Padong · 3PM / 7PM · Presented by Team Sfumato"));

    box.appendChild(stage); box.appendChild(panel);

    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    function name(k) { return k === 9 ? "Performers · 9" : "Performer " + pad2(k + 1); }
    function layout() {
      var W = stage.clientWidth, mobile = W < 640, S = 0.82;
      var w = mobile ? W * 0.66 : Math.min(360, W * 0.34), H = w * 1.25, cx0 = mobile ? W / 2 : W * 0.31, gap = w * 0.27;
      // 가로 사진(단체)은 패널 왼쪽 빈 공간에 화살표까지 들어가도록 폭을 제한
      var panelLeft = W - Math.min(W * 0.44, 440), maxW = mobile ? W * 0.92 : panelLeft - 124;
      stage.style.height = Math.round(H) + "px";
      function size(k) { var fw = Math.min(H * AR[k], maxW); return { w: fw, h: fw / AR[k] }; }
      // 가운데 사진 기준으로 오른쪽·왼쪽으로 차례로 붙여 나감
      var c = size(cur); if (!mobile && c.w > w) cx0 = 62 + c.w / 2;
      var pos = {}; pos[cur] = { x: cx0, s: 1 };
      var right = cx0 + c.w / 2, left = cx0 - c.w / 2;
      for (var o = 1; o <= N / 2; o++) {
        var kr = (cur + o) % N, kl = (cur - o + N) % N, sr = size(kr), sl = size(kl);
        if (!pos[kr]) { pos[kr] = { x: right + gap + sr.w * S / 2, s: S, o: o }; right += gap + sr.w * S; }
        if (!pos[kl]) { pos[kl] = { x: left - gap - sl.w * S / 2, s: S, o: -o }; left -= gap + sl.w * S; }
      }
      items.forEach(function (it, k) {
        var z = size(k), p = pos[k], o = k === cur ? 0 : p.o, show = Math.abs(o) <= 2;
        it.style.width = z.w + "px"; it.style.height = z.h + "px"; it.style.top = Math.round((H - z.h) / 2) + "px";
        it.style.transform = "translateX(" + Math.round(p.x - z.w / 2) + "px) scale(" + p.s + ")";
        it.style.opacity = show ? 1 : 0; it.style.visibility = show ? "visible" : "hidden";
        it.style.zIndex = 5 - Math.abs(o);
        it.classList.toggle("on", o === 0); it.tabIndex = o === 0 ? 0 : -1;
        it.setAttribute("aria-label", (k === 9 ? "퍼포머 단체 프로필" : "퍼포머 프로필 " + (k + 1)) + (o === 0 ? " 크게 보기" : " 보기"));
      });
      prev.style.top = next.style.top = Math.round(H / 2) + "px";
      if (mobile) { prev.style.left = "0px"; next.style.left = (W - 44) + "px"; }
      else { prev.style.left = Math.max(0, Math.round(cx0 - c.w / 2 - 60)) + "px"; next.style.left = Math.min(W - 44, Math.round(cx0 + c.w / 2 + 16)) + "px"; }
      num.textContent = pad2(cur + 1) + " / " + pad2(N);
      title.textContent = name(cur);
      val.textContent = pad2(cur + 1);
    }
    function go(k) { cur = (k + N) % N; layout(); say(name(cur) + ", " + (cur + 1) + " / " + N); }
    addEventListener("resize", layout);
    box.addEventListener("keydown", function (e) {
      if (lb) return;
      if (e.key === "ArrowLeft") { go(cur - 1); e.preventDefault(); } else if (e.key === "ArrowRight") { go(cur + 1); e.preventDefault(); }
    });
    var sx = null;   // 스와이프
    stage.addEventListener("pointerdown", function (e) { sx = e.clientX; });
    stage.addEventListener("pointerup", function (e) { if (sx === null) return; var dx = e.clientX - sx; sx = null; if (Math.abs(dx) > 40) go(cur + (dx < 0 ? 1 : -1)); });
    layout();
  })();
  (function () {
  })();
  function openLb(i) { lb = { i: i, last: document.activeElement }; renderLb(); }
  function closeLb() { var l = lb; lb = null; $("lightbox").textContent = ""; if (l && l.last && l.last.focus) l.last.focus(); }
  function stepLb(d) { lb.i = (lb.i + d + GALLERY.length) % GALLERY.length; renderLb(); }
  function renderLb() {
    var root = $("lightbox"); root.textContent = ""; if (!lb) return;
    var g = GALLERY[lb.i], v = el("div", "lb"); v.setAttribute("role", "dialog"); v.setAttribute("aria-modal", "true"); v.setAttribute("aria-label", g.alt);
    var im = el("img"); im.src = g.src; im.alt = g.alt;
    function btn(c, t, l, f) { var b = el("button", c, t); b.type = "button"; b.setAttribute("aria-label", l); b.addEventListener("click", function (e) { e.stopPropagation(); f(); }); return b; }
    var x = btn("x", "✕", "닫기", closeLb);
    v.appendChild(im); v.appendChild(x); v.appendChild(btn("pv", "←", "이전", function () { stepLb(-1); })); v.appendChild(btn("nx", "→", "다음", function () { stepLb(1); }));
    v.appendChild(el("div", "n", (lb.i + 1) + " / " + GALLERY.length));
    v.addEventListener("click", closeLb); root.appendChild(v); x.focus();
  }
  document.addEventListener("keydown", function (e) {
    if (!lb) return;
    if (e.key === "Escape") closeLb(); else if (e.key === "ArrowLeft") stepLb(-1); else if (e.key === "ArrowRight") stepLb(1);
  });

  /* ---- countdown ---- */
  var wasOpen = false;
  function formatOpenLabel(ts) {
    if (!ts) return "오픈 전";
    var d = new Date(ts);
    var kst = new Date(d.getTime() + 9 * 3600000);
    var m = pad(kst.getUTCMonth() + 1);
    var day = pad(kst.getUTCDate());
    var h = pad(kst.getUTCHours());
    var min = pad(kst.getUTCMinutes());
    return m + "." + day + " " + h + ":" + min + " 오픈";
  }

  function tick() {
    var big = $("big"), pill = $("pill");
    if (!state.loaded) { big.textContent = "—"; pill.textContent = "—"; pill.className = "pill"; return; }
    var diff = state.openAt - now();
    if (diff > 0) {
      var s = Math.floor(diff / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
      big.textContent = "D-" + d + "  " + pad(h) + ":" + pad(m) + ":" + pad(x);
      pill.textContent = "오픈 전"; pill.className = "pill";
    } else {
      big.textContent = "예매 진행 중"; pill.textContent = "OPEN"; pill.className = "pill on";
    }
    var o = isOpen();
    if (o !== wasOpen) {
      wasOpen = o;
      render();
      if (o) refresh();
    }
  }
  setInterval(tick, 200);

  /* ---- data ---- */
  async function refresh() {
    try {
      var t0 = Date.now();
      var r = await fetch("/api/shows", { cache: "no-store" });
      var t1 = Date.now();
      if (!r.ok) throw new Error("bad status");
      var d = await r.json();
      var rtt = Math.max(0, t1 - t0);
      var serverNow = typeof d.nowMs === "number" ? d.nowMs : new Date(d.now).getTime();
      state.shows = d.shows || [];
      state.price = d.price || 0;
      state.openAt = typeof d.openAtMs === "number" ? d.openAtMs : new Date(d.openAt).getTime();
      state.offset = (serverNow + Math.round(rtt / 2)) - t1;
      state.loaded = true;
      state.failed = false;
    } catch (e) { state.failed = true; }
    tick(); render();
  }
  setInterval(function () { if (!document.hidden && !dlg) refresh(); }, 8000);

  /* ---- render ---- */
  function btnState(s) {
    if (state.failed && !state.loaded) return { label: "연결 확인 중", off: true };
    if (!state.loaded) return { label: "불러오는 중", off: true };
    if (mine) return { label: mine.show === s.id ? "예매 완료" : "이미 예매함", off: true };
    if (!isOpen()) return { label: formatOpenLabel(state.openAt), off: true };
    if (s.soldOut) return { label: "매진", off: true };
    return { label: "예매하기", off: false };
  }
  function render() {
    var bn = $("banner");
    bn.hidden = !state.failed;
    bn.textContent = state.failed ? "서버에 연결하지 못했습니다. 잠시 후 자동으로 다시 시도합니다." : "";
    var box = $("shows"); box.textContent = "";
    var list = state.shows.length ? state.shows : [
      { id: "A", date: "11.14", dow: "SAT", dowKo: "토", time: "3PM" }, { id: "B", date: "11.14", dow: "SAT", dowKo: "토", time: "7PM" },
      { id: "C", date: "11.15", dow: "SUN", dowKo: "일", time: "3PM" }, { id: "D", date: "11.15", dow: "SUN", dowKo: "일", time: "7PM" }];
    list.forEach(function (s) {
      var row = el("div", "row");
      var date = el("div", "date", s.date); date.appendChild(el("small", null, s.dow + " · " + s.dowKo + "요일"));
      var time = el("div", "time", s.time);
      var st = btnState(s);
      var btn = el("button", "btn" + (st.off ? "" : " solid"), st.label); btn.type = "button"; btn.disabled = st.off;
      btn.setAttribute("aria-label", s.date + " " + s.dowKo + "요일 " + s.time + " " + st.label);
      btn.addEventListener("click", function () { openDialog(s); });
      row.appendChild(date); row.appendChild(time); row.appendChild(btn);
      box.appendChild(row);
    });
    renderMine();
  }

  function renderMine() {
    var z = $("mineZone"), box = $("mine"); z.hidden = false; box.textContent = "";
    if (!mine) {
      // 안내 문구는 입력칸 폭(420px)에 묶이지 않게 폼 밖에 두어 한 줄로
      var note = el("p", "notice", "이미 예매하셨다면 이름과 전화번호로 내역을 확인하거나 취소할 수 있습니다.");
      note.style.maxWidth = "none"; note.style.marginTop = "0"; box.appendChild(note);
      var f = el("form"); f.style.maxWidth = "420px"; f.noValidate = true;
      function field(id, lab, ph, mode) { var l = el("label", "field"); l.htmlFor = id; l.appendChild(el("span", null, lab)); var i = el("input"); i.id = id; i.type = "text"; i.placeholder = ph; if (mode) i.inputMode = mode; l.appendChild(i); f.appendChild(l); return i; }
      var nm = field("l-name", "이름", "이름"); nm.maxLength = 30;
      var p = field("l-phone", "전화번호", "010-0000-0000", "numeric"); p.maxLength = 13;
      p.addEventListener("input", function () { p.value = fmtPhone(p.value); });
      var err = el("div", "err", lookupErr); err.setAttribute("role", "alert"); f.appendChild(err);
      var go = el("button", "btn", lookupBusy ? "확인 중" : "예매 확인"); go.type = "submit"; go.disabled = lookupBusy; go.style.marginTop = "6px";
      f.appendChild(go);
      f.addEventListener("submit", async function (e) {
        e.preventDefault(); if (lookupBusy) return;
        var nameVal = nm.value.trim();
        var phoneVal = p.value.replace(/\D/g, "");
        if (!nameVal) { lookupErr = "이름을 입력해주세요."; render(); return; }
        if (!/^01[016789]\d{7,8}$/.test(phoneVal)) { lookupErr = "휴대전화 번호를 010-0000-0000 형식으로 입력해주세요."; render(); return; }
        lookupBusy = true; lookupErr = ""; go.disabled = true; go.textContent = "확인 중";
        try {
          var r = await post("/api/lookup", { name: nameVal, phone: phoneVal });
          mine = { code: r.code, show: r.show, name: r.name, phone: r.phone }; saveMine();
        } catch (ex) { lookupErr = ex.message; }
        lookupBusy = false; render();
      });
      box.appendChild(f); return;
    }
    var s = showById(mine.show) || { date: "", dowKo: "", time: "" };
    var stub = el("div", "stub"), a = el("div"), side = el("div", "side");
    a.appendChild(el("div", "label", "TICKET"));
    a.appendChild(el("div", "code", s.date + " " + s.time));
    var meta = el("div", "meta");
    meta.appendChild(el("span", null, s.date + " (" + s.dowKo + "요일) " + s.time));
    meta.appendChild(el("span", null, mine.name + " · " + maskPhone(mine.phone)));
    a.appendChild(meta);
    if (!confirmCancel) {
      var cb = el("button", "link warn", "예매 취소"); cb.type = "button";
      cb.addEventListener("click", function () { confirmCancel = true; renderMine(); });
      side.appendChild(cb);
    } else {
      side.appendChild(el("span", null, "예매를 취소할까요? 취소하면 자리가 반환됩니다."));
      var y = el("button", "btn solid", cancelBusy ? "처리 중" : "취소 확정"); y.type = "button"; y.disabled = cancelBusy;
      y.addEventListener("click", cancelBooking);
      var n = el("button", "link", "돌아가기"); n.type = "button"; n.disabled = cancelBusy;
      n.addEventListener("click", function () { confirmCancel = false; renderMine(); });
      side.appendChild(y); side.appendChild(n);
    }
    stub.appendChild(a); stub.appendChild(side); box.appendChild(stub);
  }

  async function cancelBooking() {
    if (!mine || cancelBusy) return;
    cancelBusy = true; renderMine();
    try {
      await post("/api/cancel", { name: mine.name, phone: mine.phone, code: mine.code });
      mine = null; saveMine(); confirmCancel = false; say("예매가 취소되었습니다.");
    } catch (e) { say("취소하지 못했습니다. 잠시 후 다시 시도해주세요."); }
    cancelBusy = false; await refresh();
  }

  /* ---- dialog ---- */
  function openDialog(s) { lastFocus = document.activeElement; dlg = { show: s, step: 1, busy: false, error: "", code: "" }; renderDlg(); }
  function closeDlg() { dlg = null; $("overlay").textContent = ""; if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus(); refresh(); }
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && dlg && !dlg.busy) closeDlg(); });

  function renderDlg() {
    var root = $("overlay"); root.textContent = "";
    if (!dlg) return;
    var s = dlg.show;
    var veil = el("div", "veil"), box = el("div", "dlg");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-labelledby", "dt");
    veil.addEventListener("mousedown", function (e) { if (e.target === veil && !dlg.busy) closeDlg(); });
    var h = el("h2", null, ""); h.id = "dt"; h.tabIndex = -1;
    var which = el("div", "which", s.date + " (" + s.dowKo + ") " + s.time);
    var focusEl = null;

    if (dlg.step === 1) {
      // 1단계: 아카이빙 · 트리거 워닝 안내 → 확인하고 넘기면 2단계
      h.textContent = "아카이빙 · 트리거 워닝"; box.appendChild(h); box.appendChild(which);
      box.appendChild(el("h3", null, "아카이빙 안내"));
      box.appendChild(el("p", null, "11.14(토) 7PM / 11.15(일) 7PM 공연 중 사진 및 영상 촬영이 예정되어 있습니다. 관객의 얼굴이 포함될 수 있으며 추후 SNS 및 보도자료에 활용될 예정이오니 예매에 참고 바랍니다. 티켓 예매 시 본 아카이빙 안내사항에 동의한 것으로 간주됩니다."));
      box.appendChild(el("h3", null, "트리거 워닝"));
      box.appendChild(el("p", null, "본 공연에는 연출상 레이저, 섬광 조명, 헤이저 연무가 사용됩니다. 해당 요소에 민감한 관객께서는 예매 및 관람에 참고해 주시기 바랍니다."));
      var act = el("div", "actions");
      var no = el("button", "btn", "닫기"); no.type = "button"; no.addEventListener("click", closeDlg);
      var ok = el("button", "btn solid", "확인하고 계속"); ok.type = "button"; ok.addEventListener("click", function () { dlg.step = 2; renderDlg(); });
      act.appendChild(no); act.appendChild(ok); box.appendChild(act); focusEl = ok;
    } else if (dlg.step === 2) {
      // 2단계: 이름, 이름확인, 번호, 번호확인 입력 → 예매 확정
      h.textContent = "예매자 정보 입력"; box.appendChild(h); box.appendChild(which);
      var f = el("form"); f.noValidate = true;
      function field(id, lab, type, ph) { var l = el("label", "field"); l.htmlFor = id; l.appendChild(el("span", null, lab)); var i = el("input"); i.id = id; i.type = type; if (ph) i.placeholder = ph; l.appendChild(i); f.appendChild(l); return i; }
      var nm = field("f-name", "이름", "text", "이름"); nm.autocomplete = "name"; nm.maxLength = 30;
      var nmConf = field("f-name-confirm", "이름 확인", "text", "이름 다시 입력"); nmConf.maxLength = 30;
      var ph = field("f-phone", "전화번호", "tel", "010-0000-0000"); ph.autocomplete = "tel"; ph.inputMode = "numeric"; ph.maxLength = 13;
      var phConf = field("f-phone-confirm", "전화번호 확인", "tel", "010-0000-0000"); phConf.inputMode = "numeric"; phConf.maxLength = 13;
      var err = el("div", "err", dlg.error); err.setAttribute("role", "alert"); f.appendChild(err);
      var act2 = el("div", "actions");
      var back = el("button", "btn", "이전"); back.type = "button"; back.disabled = dlg.busy; back.addEventListener("click", function () { dlg.step = 1; dlg.error = ""; renderDlg(); });
      var go = el("button", "btn solid", dlg.busy ? "처리 중" : "예매하기"); go.type = "submit"; go.disabled = dlg.busy;
      act2.appendChild(back); act2.appendChild(go); f.appendChild(act2);
      ph.addEventListener("input", function () { ph.value = fmtPhone(ph.value); });
      phConf.addEventListener("input", function () { phConf.value = fmtPhone(phConf.value); });
      f.addEventListener("submit", async function (e) {
        e.preventDefault(); if (dlg.busy) return;
        var name = nm.value.trim(), nameConf = nmConf.value.trim();
        var digits = ph.value.replace(/\D/g, ""), digitsConf = phConf.value.replace(/\D/g, "");
        if (!name) { err.textContent = "이름을 입력해주세요."; nm.focus(); return; }
        if (!nameConf) { err.textContent = "이름 확인을 입력해주세요."; nmConf.focus(); return; }
        if (name !== nameConf) { err.textContent = "입력하신 이름이 일치하지 않습니다."; nmConf.focus(); return; }
        if (!/^01[016789]\d{7,8}$/.test(digits)) { err.textContent = "휴대전화 번호를 010-0000-0000 형식으로 입력해주세요."; ph.focus(); return; }
        if (!digitsConf) { err.textContent = "전화번호 확인을 입력해주세요."; phConf.focus(); return; }
        if (digits !== digitsConf) { err.textContent = "입력하신 전화번호가 일치하지 않습니다."; phConf.focus(); return; }
        dlg.name = name; dlg.phone = digits; dlg.error = "";
        dlg.busy = true; go.disabled = true; back.disabled = true; go.textContent = "처리 중";
        try {
          var r = await post("/api/book", { show: s.id, name: name, phone: digits, consent: true });
          mine = { code: r.code, show: s.id, name: name, phone: digits }; saveMine();
          dlg.busy = false; dlg.step = 3; dlg.code = r.code; say("예매가 완료되었습니다."); renderDlg();
        } catch (ex) {
          dlg.busy = false;
          dlg.error = ex.status ? ex.message : "연결에 실패했습니다. 잠시 후 다시 시도해주세요.";
          if (ex.code === "soldout") refresh();
          renderDlg();
        }
      });
      if (dlg.name) { nm.value = dlg.name; nmConf.value = dlg.name; }
      if (dlg.phone) { ph.value = fmtPhone(dlg.phone); phConf.value = fmtPhone(dlg.phone); }
      box.appendChild(f); focusEl = nm;
    } else {
      h.textContent = "예매가 완료되었습니다"; box.appendChild(h); box.appendChild(which);
      var metaBox = el("div", "meta");
      metaBox.style.margin = "20px 0";
      metaBox.style.fontSize = "15px";
      metaBox.style.lineHeight = "1.6";
      metaBox.appendChild(el("p", null, dlg.name + " 님 (" + maskPhone(dlg.phone) + ")"));
      metaBox.appendChild(el("p", null, "정상적으로 예매가 완료되었습니다."));
      box.appendChild(metaBox);
      box.appendChild(el("p", null, "예매 내역 확인이나 취소는 이름과 전화번호로 언제든 가능합니다."));
      var act3 = el("div", "actions"); var done = el("button", "btn solid", "확인"); done.type = "button"; done.addEventListener("click", closeDlg);
      act3.appendChild(done); box.appendChild(act3); focusEl = done;
    }
    veil.appendChild(box); root.appendChild(veil);
    if (focusEl) focusEl.focus(); else h.focus();
  }

  /* ---- boot ---- */
  render(); tick();
  (async function () {
    try {
      var saved = JSON.parse(localStorage.getItem(STORE) || "null");
      if (saved && saved.phone) {
        try { var r = await post("/api/lookup", { name: saved.name, phone: saved.phone, code: saved.code }); mine = { code: r.code, show: r.show, name: r.name, phone: r.phone }; }
        catch (e) { if (e.status === 404) { mine = null; saveMine(); } }
      }
    } catch (e) {}
    refresh();
  })();
})();
