(function () {
  "use strict";
  var state = { price: 0, shows: [], openAt: 0, offset: 0, loaded: false, failed: false };
  var mine = null; // {code, show, name, phone}
  var lookupErr = "", lookupBusy = false;
  var dlg = null, lastFocus = null;
  var STORE = "buffer-ticket";

  var isTestMode = /[?&#](test|open)(=1)?\b/i.test(window.location.search + window.location.hash) || (function () { try { return sessionStorage.getItem("buffer_test_mode") === "1"; } catch (e) { return false; } })();
  if (/[?&#](test|open)(=1)?\b/i.test(window.location.search + window.location.hash)) {
    try { sessionStorage.setItem("buffer_test_mode", "1"); } catch (e) {}
  }

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function now() { return Date.now() + state.offset; }
  function isOpen() { return isTestMode || (state.loaded && now() >= state.openAt); }
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

  /* ---- hero 선: 세로 단 계산용 폭(--hw)과 큰 제목 아래 기준선 위치(--tb) ---- */
  (function () {
    var hero = document.querySelector(".hero"), ttl = document.querySelector(".x-ttl");
    if (!hero || !ttl) return;
    function set() {
      var H = hero.getBoundingClientRect(), T = ttl.getBoundingClientRect();
      var gap = innerWidth <= 700 ? 10 : 16;
      hero.style.setProperty("--hw", hero.clientWidth + "px");
      hero.style.setProperty("--tb", Math.round(T.bottom - H.top + gap) + "px");
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(set);
    addEventListener("load", set); addEventListener("resize", set); set();
  })();

  /* ---- 모바일: 로고 창(과 기둥·점·회차 표시)을 화면 세로 정중앙에 ----
     무대(.x-stage)를 '화면 중앙' 기준으로 위아래 대칭이 되게 늘리고, 제목과 겹치는 위쪽은 잘라서 숨김.
     사파리 주소창이 접히며 생기는 높이 변화에는 반응하지 않음(스크롤 중 흔들림 방지) */
  (function () {
    var hero = document.querySelector(".hero"), stage = document.querySelector(".x-stage"), ttl = document.querySelector(".x-ttl");
    if (!hero || !stage || !ttl) return;
    var lastW = 0;
    function place(force) {
      if (!force && innerWidth === lastW) return;
      lastW = innerWidth;
      stage.style.top = stage.style.height = stage.style.bottom = stage.style.clipPath = "";
      if (innerWidth > 700) return;
      var H = hero.offsetHeight, heroTop = hero.getBoundingClientRect().top + scrollY;
      var titleBottom = ttl.getBoundingClientRect().bottom + scrollY - heroTop + 12;
      var a = stage.querySelector(".x-txt.a"), img = stage.querySelector(".x-img");
      var above = img.offsetHeight / 2 + 14 + (a ? a.offsetHeight : 0) + 8;   // 로고 창 위로 필요한 공간
      var c = innerHeight / 2 - heroTop;                                     // 화면 정중앙 (첫 화면 기준 좌표)
      c = Math.max(c, titleBottom + above);                                  // 너무 작은 화면에선 제목과 안 겹치는 만큼만 내림
      var top = 2 * c - H;
      stage.style.top = top + "px"; stage.style.bottom = "0px"; stage.style.height = "auto";
      var clip = titleBottom - top;
      if (clip > 0) stage.style.clipPath = "inset(" + clip.toFixed(1) + "px 0 0 0)";
    }
    function run() { place(true); }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(run);
    addEventListener("load", run);
    addEventListener("resize", function () { place(false); });
    addEventListener("orientationchange", function () { setTimeout(run, 300); });
    run();
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

  /* ---- 기둥 안 한 줄 글(날짜·시간 줄, "총 4회차 …" 줄): 기둥 폭에 들어가도록 글자 크기를 맞추고(최대 기본 크기), 남는 폭은 양끝 맞춤 ---- */
  (function () {
    var ps = document.querySelectorAll(".x-col .x-fit"); if (!ps.length) return;
    // 두 줄 모두 들어가는 가장 작은 크기 하나로 통일 → 같은 크기로 보이고, 남는 폭은 양끝 맞춤이 채움
    function fit() {
      var size = Infinity;
      ps.forEach(function (p) { p.style.fontSize = ""; });
      ps.forEach(function (p) {
        var t = p.querySelector(".fit"); if (!t || !p.clientWidth) return; // 숨겨진 줄(모바일의 BUFFER 버퍼 줄)은 빼고 계산
        var base = parseFloat(getComputedStyle(p).fontSize);
        var rg = document.createRange(); rg.selectNodeContents(t);
        var need = rg.getBoundingClientRect().width, have = p.clientWidth;
        size = Math.min(size, need > have ? base * have / need * 0.985 : base);
      });
      if (!isFinite(size)) return;
      ps.forEach(function (p) {
        var t = p.querySelector(".fit"); if (!t || !p.clientWidth) return;
        p.style.fontSize = size.toFixed(2) + "px";
        t.style.letterSpacing = ""; t.style.marginRight = "";
        // 남는 폭은 띄어쓰기에 몰지 않고 글자 사이에 고르게 나눔.
        // 기본 자간은 CSS에 적힌 값을 그대로 읽어 씀(자간을 바꿔도 기둥 밖으로 삐져나오지 않게)
        var ls0 = parseFloat(getComputedStyle(t).letterSpacing) || 0;
        var rg = document.createRange(); rg.selectNodeContents(t);
        var n = t.textContent.length, extra = p.clientWidth - rg.getBoundingClientRect().width;
        if (n > 1 && extra > 0.5) {
          var d = extra / (n - 1);
          t.style.letterSpacing = (ls0 + d).toFixed(3) + "px";
          t.style.marginRight = (-d).toFixed(3) + "px";
        }
      });
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
    // 개인 프로필 이름 (사진 번호 순서). 빈 칸이면 "Performer 0N"으로 표시
    var NAMES = ["최승영", "김선율", "이승환", "이봄", "김민", "임세령", "염지원", "김지민", "김수아"];
    for (var i = 1; i <= N; i++) {
      var grp = i === 10, alt = grp ? "BUFFER 버퍼 퍼포머 단체 프로필" : "BUFFER 버퍼 퍼포머 " + (NAMES[i - 1] || "프로필 " + i);
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
    d.appendChild(el("p", null, "3PM / 7PM · Presented by Team Sfumato"));

    box.appendChild(stage); box.appendChild(panel);

    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    function name(k) { return k === 9 ? "Performers · 9" : (NAMES[k] || "Performer " + pad2(k + 1)); }
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
        it.setAttribute("aria-label", (k === 9 ? "퍼포머 단체 프로필" : "퍼포머 " + (NAMES[k] || "프로필 " + (k + 1))) + (o === 0 ? " 크게 보기" : " 보기"));
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
    if (diff > 0 && !isTestMode) {
      var s = Math.floor(diff / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
      big.textContent = "D-" + d + "  " + pad(h) + ":" + pad(m) + ":" + pad(x);
      pill.textContent = "오픈 전"; pill.className = "pill";
    } else {
      big.textContent = isTestMode ? "테스트 예매 진행 중" : "예매 진행 중";
      pill.textContent = isTestMode ? "TEST OPEN" : "OPEN";
      pill.className = "pill on";
    }
    var o = isOpen();
    if (o !== wasOpen) {
      wasOpen = o;
      render();
      if (o) refresh();
    }
  }
  var pillEl = $("pill");
  if (pillEl) {
    pillEl.style.cursor = "pointer";
    pillEl.setAttribute("title", "테스트 모드 전환");
    pillEl.addEventListener("click", function () {
      isTestMode = !isTestMode;
      try {
        if (isTestMode) sessionStorage.setItem("buffer_test_mode", "1");
        else sessionStorage.removeItem("buffer_test_mode");
      } catch (e) {}
      render(); tick(); refresh();
    });
  }
  setInterval(tick, 200);

  /* ---- data ---- */
  async function refresh() {
    try {
      var t0 = Date.now();
      var r = await fetch("/api/shows" + (isTestMode ? "?test=1" : ""), { cache: "no-store" });
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

  /* ---- 회차 날짜: 요일 줄(SAT · 토요일)을 날짜 숫자(11.14)의 왼쪽·오른쪽 잉크 끝에 정확히 맞춤 ----
     글자 상자가 아니라 실제로 칠해진 부분(잉크)의 경계를 재서, 요일 줄의 글자 간격과 위치를 조절 */
  var _cv = document.createElement("canvas").getContext("2d");
  function fontOf(el) { var c = getComputedStyle(el); return c.fontStyle + " " + c.fontWeight + " " + c.fontSize + " " + c.fontFamily; }
  function ink(el) {   // 요소 글자의 잉크 왼쪽·오른쪽 (화면 좌표)
    var t = el.textContent, cs = getComputedStyle(el), ls = parseFloat(cs.letterSpacing) || 0;
    var rg = document.createRange(); rg.selectNodeContents(el); var r = rg.getBoundingClientRect();
    _cv.font = fontOf(el);
    var f = _cv.measureText(t.charAt(0)), l = _cv.measureText(t.charAt(t.length - 1));
    var lsb = -f.actualBoundingBoxLeft, rsb = l.width - l.actualBoundingBoxRight;
    return { left: r.left + lsb, right: r.right - ls - rsb, ls: ls, n: t.length };
  }
  function alignDates() {
    var rows = [];
    document.querySelectorAll("#shows .date").forEach(function (d) {
      var num = d.querySelector(".d-num"), sm = d.querySelector("small"); if (!num || !sm) return;
      sm.style.letterSpacing = sm.style.fontSize = sm.style.transform = "";
      rows.push({ num: num, sm: sm });
    });
    if (!rows.length) return;
    // 1) 모든 회차의 요일 줄을 같은 글자 크기로: 가장 넓은 줄도 자간을 너무 좁히지 않고 들어가는 크기 하나
    var base = parseFloat(getComputedStyle(rows[0].sm).fontSize), size = base;
    rows.forEach(function (r) {
      var a = ink(r.num), b = ink(r.sm), target = a.right - a.left, natural = b.right - b.left;
      var minLs = -0.08 * base;                                   // 이보다 좁히면 글자가 붙어 보임
      var widthAtMin = natural + (b.n - 1) * (minLs - b.ls);
      if (widthAtMin > target) size = Math.min(size, base * target / widthAtMin);
    });
    rows.forEach(function (r) { r.sm.style.fontSize = size.toFixed(2) + "px"; });
    // 2) 줄마다 자간만 조절해 날짜 숫자 좌우 끝에 정확히 맞춤
    rows.forEach(function (r) {
      var a = ink(r.num), b = ink(r.sm);
      var ls = b.ls + ((a.right - a.left) - (b.right - b.left)) / (b.n - 1);
      r.sm.style.letterSpacing = ls.toFixed(3) + "px";
      var b2 = ink(r.sm);
      r.sm.style.transform = "translateX(" + (a.left - b2.left).toFixed(2) + "px)";
    });
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(alignDates);
  addEventListener("resize", alignDates);

  /* ---- render ---- */
  function btnState(s) {
    if (state.failed && !state.loaded) return { label: "연결 확인 중", off: true };
    if (!state.loaded) return { label: "불러오는 중", off: true };
    if (mine) return { label: mine.show === s.id ? "예매 완료" : "이미 예매함", off: true };
    if (!isOpen()) return { label: formatOpenLabel(state.openAt), off: true };
    if (s.soldOut || s.id === "B" || s.id === "D") return { label: "매진", off: true };   // 잔여석 수는 받지도 보여주지도 않음, 매진 여부만
    return { label: "예매하기", off: false };
  }
  function render() {
    var bn = $("banner");
    bn.hidden = !state.failed;
    bn.textContent = state.failed ? "서버에 연결하지 못했습니다. 잠시 후 자동으로 다시 시도합니다." : "";
    var box = $("shows"); box.textContent = "";
    var list = state.shows.length ? state.shows : [
      { id: "A", date: "11.14", dow: "SAT", dowKo: "토", time: "3PM" },
      { id: "B", date: "11.14", dow: "SAT", dowKo: "토", time: "7PM", soldOut: true },
      { id: "C", date: "11.15", dow: "SUN", dowKo: "일", time: "3PM" },
      { id: "D", date: "11.15", dow: "SUN", dowKo: "일", time: "7PM", soldOut: true }];
    list.forEach(function (s) {
      var row = el("div", "row");
      var date = el("div", "date");
      date.appendChild(el("span", "d-num", s.date));
      date.appendChild(el("small", null, s.dow + " · " + s.dowKo + "요일"));
      var time = el("div", "time", s.time);
      var st = btnState(s);
      var btn = el("button", "btn" + (st.off ? "" : " solid"), st.label); btn.type = "button"; btn.disabled = st.off;
      btn.setAttribute("aria-label", s.date + " " + s.dowKo + "요일 " + s.time + " " + st.label);
      btn.addEventListener("click", function () { openDialog(s); });
      row.appendChild(date); row.appendChild(time); row.appendChild(btn);
      box.appendChild(row);
    });
    renderMine();
    alignDates();
  }

  function renderMine() {
    var z = $("mineZone"), box = $("mine"); z.hidden = false; box.textContent = "";
    if (!mine) {
      // 안내 문구는 입력칸 폭(420px)에 묶이지 않게 폼 밖에 두어 한 줄로
      var note = el("p", "notice", "이미 예매하셨다면 이름과 전화번호로 예매 내역을 확인할 수 있습니다.");
      note.style.maxWidth = "none"; note.style.marginTop = "0"; box.appendChild(note);
      var f = el("form"); f.style.maxWidth = "420px"; f.noValidate = true;
      function field(id, lab, ph, mode) { var l = el("label", "field"); l.htmlFor = id; l.appendChild(el("span", null, lab)); var i = el("input"); i.id = id; i.type = "text"; i.placeholder = ph; if (mode) i.inputMode = mode; l.appendChild(i); f.appendChild(l); return i; }
      var nm = field("l-name", "이름", "이름"); nm.maxLength = 30;
      var p = field("l-phone", "전화번호", "010-0000-0000", "numeric"); p.maxLength = 13;
      p.addEventListener("input", function () { p.value = fmtPhone(p.value); });
      var err = el("div", "err", lookupErr); err.setAttribute("role", "alert"); f.appendChild(err);
      var go = el("button", "btn", lookupBusy ? "확인 중" : "예매 확인"); go.type = "submit"; go.disabled = lookupBusy; go.style.marginTop = "6px";
      f.appendChild(go);
      // 예매 확인 버튼 바로 아래: 예매 취소 문의 (인스타그램)
      var cq = el("p", "cancel-q"); cq.appendChild(document.createTextNode("예매 취소는 인스타그램 문의로만 가능합니다. "));
      var cqa = el("a", null, "취소 문의하기 ↗"); cqa.href = "https://www.instagram.com/sfumato.kr/"; cqa.target = "_blank"; cqa.rel = "noopener";
      cqa.setAttribute("aria-label", "인스타그램에서 예매 취소 문의하기 (새 창)"); cq.appendChild(cqa); f.appendChild(cq);
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

    var cancelTitle = el("span", null, "예매 취소 안내");
    cancelTitle.style.fontWeight = "600";
    cancelTitle.style.fontSize = "13px";
    side.appendChild(cancelTitle);

    var cancelDesc = el("span", null, "취소는 인스타그램 DM으로 문의 바랍니다.");
    cancelDesc.style.color = "var(--mute)";
    cancelDesc.style.fontSize = "12px";
    cancelDesc.style.lineHeight = "1.4";
    side.appendChild(cancelDesc);

    var ig = el("a", "btn", "인스타그램 문의 ↗");
    ig.href = "https://www.instagram.com/sfumato.kr/";
    ig.target = "_blank";
    ig.rel = "noopener";
    ig.setAttribute("aria-label", "인스타그램에서 예매 취소 문의하기 (새 창)");
    ig.style.textAlign = "center";
    ig.style.textDecoration = "none";
    ig.style.display = "inline-block";
    ig.style.padding = "8px 12px";
    ig.style.fontSize = "12px";
    ig.style.minWidth = "0";
    side.appendChild(ig);

    var closeMine = el("button", "link", "내역 닫기");
    closeMine.type = "button";
    closeMine.style.marginTop = "6px";
    closeMine.style.fontSize = "12px";
    closeMine.style.cursor = "pointer";
    closeMine.addEventListener("click", function () { mine = null; saveMine(); renderMine(); });
    side.appendChild(closeMine);

    stub.appendChild(a); stub.appendChild(side); box.appendChild(stub);
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
          var r = await post("/api/book" + (isTestMode ? "?test=1" : ""), { show: s.id, name: name, phone: digits, consent: true, test: isTestMode });
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
      box.appendChild(el("p", null, "예매 내역 확인은 이름과 전화번호로 언제든 가능하며, 예매 취소는 인스타그램 문의로 가능합니다."));
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
