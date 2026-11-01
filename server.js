// BUFFER 버퍼 티켓 예매 서버 — Node 22.5+ (내장 node:sqlite 사용, 외부 패키지 없음)
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch (e) { if (e && e.code !== "ENOENT") throw e; }
}

const PORT = Number(process.env.PORT || 3000);
const OPEN_AT = new Date(process.env.OPEN_AT || "2026-11-04T20:00:00+09:00").getTime();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "tickets.db");
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const BOOK_RATE_MAX = Number(process.env.BOOK_RATE_MAX || 30); // IP당 10분 내 예매 시도 한도 (공용 와이파이를 고려해 넉넉히)
const TICKET_PRICE = Number(process.env.TICKET_PRICE || 0); // 표시용 금액(원). 결제는 모의 처리라 실제 청구는 없음
const CAP = 35; // 회차당 온라인 예매석 기본값 (총 40석 중 유보석 5석 제외)
// 회차별 좌석 수: SEATS="A=35,B=30,C=35,D=28" 처럼 지정. 빠진 회차는 기본값(CAP)
const SEATS = (() => {
  const m = { A: CAP, B: CAP, C: CAP, D: CAP };
  for (const part of String(process.env.SEATS || "").split(",")) {
    const r = /^\s*([A-D])\s*=\s*(\d{1,2})\s*$/i.exec(part);
    if (r) m[r[1].toUpperCase()] = Number(r[2]);
    else if (part.trim()) { console.error(`SEATS 형식이 올바르지 않습니다: "${part}" (예: A=35,B=30,C=35,D=28)`); process.exit(1); }
  }
  return m;
})();
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(__dirname, "assets"); // 디자인 원본을 /assets/ 로 그대로 서빙

const SHOWS = [
  { id: "A", date: "11.14", dow: "SAT", dowKo: "토", time: "3PM" },
  { id: "B", date: "11.14", dow: "SAT", dowKo: "토", time: "7PM" },
  { id: "C", date: "11.15", dow: "SUN", dowKo: "일", time: "3PM" },
  { id: "D", date: "11.15", dow: "SUN", dowKo: "일", time: "7PM" },
];
const SHOW_IDS = new Set(SHOWS.map((s) => s.id));

if (!Number.isFinite(OPEN_AT)) {
  console.error("OPEN_AT 형식이 올바르지 않습니다. 예: 2026-11-04T20:00:00+09:00");
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reservations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    show_id    TEXT    NOT NULL,
    seat       INTEGER NOT NULL,
    code       TEXT    NOT NULL UNIQUE,
    name       TEXT    NOT NULL,
    phone      TEXT    NOT NULL UNIQUE,   -- 1인 1매: 전화번호당 예매 1건
    created_at TEXT    NOT NULL,
    UNIQUE (show_id, seat)
  );
`);

const q = {
  countByShow: db.prepare("SELECT show_id, COUNT(*) AS n FROM reservations GROUP BY show_id"),
  countShow: db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE show_id = ?"),
  seatsOfShow: db.prepare("SELECT seat FROM reservations WHERE show_id = ? ORDER BY seat"),
  byPhone: db.prepare("SELECT 1 FROM reservations WHERE phone = ?"),
  insert: db.prepare(
    "INSERT INTO reservations (show_id, seat, code, name, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ),
  lookup: db.prepare("SELECT show_id, seat, code, name, phone, created_at FROM reservations WHERE code = ? AND phone = ?"),
  cancel: db.prepare("DELETE FROM reservations WHERE code = ? AND phone = ?"),
  all: db.prepare("SELECT show_id, seat, code, name, phone, created_at FROM reservations ORDER BY show_id, seat"),
  adminDelete: db.prepare("DELETE FROM reservations WHERE code = ?"),
};

const pad = (n) => (n < 10 ? "0" : "") + n;
const isOpen = () => Date.now() >= OPEN_AT;

// 화면에는 남은 좌석 수를 보내지 않고 매진 여부만 보냄
function showsPublic() {
  const used = Object.fromEntries(q.countByShow.all().map((r) => [r.show_id, r.n]));
  return SHOWS.map((s) => ({ ...s, soldOut: (used[s.id] || 0) >= SEATS[s.id] }));
}

function normalizePhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  return /^01[016789]\d{7,8}$/.test(d) ? d : null;
}
function cleanName(v) {
  const s = String(v || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return s.length >= 1 && s.length <= 30 ? s : null;
}

// 예매: 한도 확인·좌석 배정·저장을 하나의 트랜잭션으로 처리
function book(showId, name, phone) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (q.byPhone.get(phone)) {
      db.exec("ROLLBACK");
      return { error: "duplicate" };
    }
    if (q.countShow.get(showId).n >= SEATS[showId]) {
      db.exec("ROLLBACK");
      return { error: "soldout" };
    }
    const used = new Set(q.seatsOfShow.all(showId).map((r) => r.seat));
    let seat = 1;
    while (used.has(seat)) seat++;
    const code = `BUF-${showId}-${pad(seat)}`;
    q.insert.run(showId, seat, code, name, phone, new Date().toISOString());
    db.exec("COMMIT");
    return { code, seat };
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch (_) {}
    throw e;
  }
}

// ---- 간단한 요청 제한 (IP당) ----
const hits = new Map();
function limited(ip, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) if (!arr.some((t) => now - t < 600000)) hits.delete(ip);
}, 60000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || "unknown";
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false;
    const chunks = [];
    req.on("data", (c) => {
      if (over) return;
      size += c.length;
      if (size > 4096) { over = true; chunks.length = 0; reject(Object.assign(new Error("too large"), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (over) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("bad json"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function adminOk(req) {
  if (!ADMIN_TOKEN) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;

async function api(req, res, url) {
  const ip = clientIp(req);
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/shows") {
    return send(res, 200, { openAt: new Date(OPEN_AT).toISOString(), now: new Date().toISOString(), open: isOpen(), price: TICKET_PRICE, shows: showsPublic() });
  }

  if (route === "POST /api/book") {
    if (limited("book:" + ip, BOOK_RATE_MAX, 600000)) return send(res, 429, { error: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
    const b = await readJson(req);
    if (!isOpen()) return send(res, 403, { error: "not_open", message: "아직 예매가 열리지 않았습니다." });
    if (b.consent !== true) return send(res, 400, { error: "consent", message: "아카이빙·트리거 워닝 안내를 확인해야 예매할 수 있습니다." });
    if (!SHOW_IDS.has(b.show)) return send(res, 400, { error: "show", message: "회차를 선택해주세요." });
    const name = cleanName(b.name);
    if (!name) return send(res, 400, { error: "name", message: "이름을 입력해주세요." });
    const phone = normalizePhone(b.phone);
    if (!phone) return send(res, 400, { error: "phone", message: "휴대전화 번호를 010-0000-0000 형식으로 입력해주세요." });
    const r = book(b.show, name, phone);
    if (r.error === "duplicate") return send(res, 409, { error: "duplicate", message: "이 전화번호로 이미 예매하셨습니다." });
    if (r.error === "soldout") return send(res, 409, { error: "soldout", message: "이 회차는 매진되었습니다. 다른 회차를 선택해주세요." });
    return send(res, 201, { code: r.code, show: b.show });
  }

  if (route === "POST /api/lookup" || route === "POST /api/cancel") {
    if (limited("lookup:" + ip, 60, 600000)) return send(res, 429, { error: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
    const b = await readJson(req);
    const phone = normalizePhone(b.phone);
    const code = String(b.code || "").trim().toUpperCase();
    const row = phone && /^BUF-[A-D]-\d{2}$/.test(code) ? q.lookup.get(code, phone) : null;
    if (!row) return send(res, 404, { error: "not_found", message: "예매 내역을 찾을 수 없습니다. 예매번호와 전화번호를 확인해주세요." });
    if (route === "POST /api/cancel") {
      q.cancel.run(code, phone);
      return send(res, 200, { ok: true });
    }
    return send(res, 200, { code: row.code, show: row.show_id, name: row.name, phone: row.phone });
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!adminOk(req)) return send(res, 401, { error: "unauthorized" });
    if (route === "GET /api/admin/reservations") {
      const rows = q.all.all();
      if (url.searchParams.get("format") === "csv") {
        const head = "회차,예매번호,이름,전화번호,예매시각\n";
        const body = rows.map((r) => {
          const s = SHOWS.find((x) => x.id === r.show_id);
          return [`${s.date} ${s.dowKo} ${s.time}`, r.code, r.name, r.phone, r.created_at].map(csvCell).join(",");
        }).join("\n");
        return send(res, 200, "﻿" + head + body + "\n", {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="buffer-reservations.csv"',
        });
      }
      return send(res, 200, { seats: SEATS, reservations: rows.map((r) => ({ show: r.show_id, seat: r.seat, code: r.code, name: r.name, phone: r.phone, createdAt: r.created_at })) });
    }
    const m = /^DELETE \/api\/admin\/reservations\/(BUF-[A-D]-\d{2})$/.exec(route);
    if (m) {
      q.adminDelete.run(m[1]);
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: "not_found" });
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  if (p === "/admin") p = "/admin.html";
  const isAsset = p.startsWith("/assets/");
  const base = isAsset ? ASSETS_DIR : PUBLIC_DIR;
  const file = path.normalize(path.join(base, isAsset ? p.slice("/assets".length) : p));
  if (!file.startsWith(base + path.sep)) return send(res, 403, "Forbidden");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": isAsset ? "public, max-age=3600" : "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(req, res, url);
  } catch (e) {
    if (e.status) return send(res, e.status, { error: "bad_request", message: "요청을 처리할 수 없습니다." }, { Connection: "close" });
    console.error(e);
    return send(res, 500, { error: "server", message: "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요." });
  }
});

server.listen(PORT, () => {
  const kstOpenStr = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(OPEN_AT));

  const statusText = isOpen()
    ? "🟢 예매 진행 중 (오픈됨)"
    : `🟡 오픈 전 (오픈 시각: ${kstOpenStr} KST)`;

  const adminText = ADMIN_TOKEN
    ? "🟢 켜짐"
    : "⚪️ 꺼짐 (.env에 ADMIN_TOKEN 설정 시 활성화)";

  const seatsInfo = SHOWS.map((x) => `${x.id}=${SEATS[x.id]}`).join(" ");

  console.log(`
  🎟️  BUFFER 티켓 예매 서버 실행 완료

  ➜  접속 주소:      http://localhost:${PORT}/
  ➜  관리자 페이지:  http://localhost:${PORT}/admin
  ➜  예매 상태:      ${statusText}
  ➜  회차별 좌석:    ${seatsInfo}
  ➜  관리자 기능:    ${adminText}
`);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(() => { db.close(); process.exit(0); }); });
