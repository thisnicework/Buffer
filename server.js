// BUFFER 버퍼 티켓 예매 서버 — Node 22.5+ (Vite HMR + Supabase Cloud + 내장 node:sqlite 폴백)
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { createClient } = require("@supabase/supabase-js");

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch (e) { if (e && e.code !== "ENOENT") throw e; }
}

function parseOpenAt(v) {
  const str = String(v || "2026-11-04T20:00:00+09:00").trim();
  const hasTz = /([+-]\d{2}:?\d{2}|Z)$/i.test(str);
  const normalized = hasTz ? str : str.replace(" ", "T") + "+09:00";
  const t = new Date(normalized).getTime();
  return Number.isFinite(t) ? t : new Date("2026-11-04T20:00:00+09:00").getTime();
}

const PORT = Number(process.env.PORT || 3000);
const OPEN_AT = parseOpenAt(process.env.OPEN_AT);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "tickets.db");
const TRUST_PROXY = process.env.TRUST_PROXY === "1";
const BOOK_RATE_MAX = Number(process.env.BOOK_RATE_MAX || 30); // IP당 10분 내 예매 시도 한도 (공용 와이파이를 고려해 넉넉히)
const TICKET_PRICE = Number(process.env.TICKET_PRICE || 0); // 표시용 금액(원). 결제는 모의 처리라 실제 청구는 없음
const CAP = 35; // 회차당 온라인 예매석 기본값 (총 40석 중 유보석 5석 제외)

// Supabase 연동 설정
const SUPABASE_URL = process.env.SUPABASE_URL || "https://qatrsegoqwandtsasunp.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_9f9-AydwUAdKgQ9UuQl83Q_flyWWDL3";
const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_KEY);
const supabase = hasSupabase
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

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

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(__dirname, "dist");
const PUBLIC_DIR = path.join(__dirname, "public");
const ASSETS_DIR = path.join(__dirname, "public", "assets");

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

// 로컬 SQLite 백업/폴백 저장소 초기화
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const sqliteDb = new DatabaseSync(DB_PATH);
sqliteDb.exec(`
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

const sqliteQueries = {
  countByShow: sqliteDb.prepare("SELECT show_id, COUNT(*) AS n FROM reservations GROUP BY show_id"),
  countShow: sqliteDb.prepare("SELECT COUNT(*) AS n FROM reservations WHERE show_id = ?"),
  seatsOfShow: sqliteDb.prepare("SELECT seat FROM reservations WHERE show_id = ? ORDER BY seat"),
  byPhone: sqliteDb.prepare("SELECT 1 FROM reservations WHERE phone = ?"),
  insert: sqliteDb.prepare("INSERT INTO reservations (show_id, seat, code, name, phone, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
  lookup: sqliteDb.prepare("SELECT show_id, seat, code, name, phone, created_at FROM reservations WHERE code = ? AND phone = ?"),
  cancel: sqliteDb.prepare("DELETE FROM reservations WHERE code = ? AND phone = ?"),
  all: sqliteDb.prepare("SELECT show_id, seat, code, name, phone, created_at FROM reservations ORDER BY show_id, seat"),
  adminDelete: sqliteDb.prepare("DELETE FROM reservations WHERE code = ?"),
};

const pad = (n) => (n < 10 ? "0" : "") + n;
const isOpen = () => Date.now() >= OPEN_AT;

function normalizePhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  return /^01[016789]\d{7,8}$/.test(d) ? d : null;
}
function cleanName(v) {
  const s = String(v || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return s.length >= 1 && s.length <= 30 ? s : null;
}

// ---- Supabase / SQLite 통합 데이터 계층 ----

// 1. 회차별 예매 수 집계
async function dbGetCountsByShow() {
  if (supabase) {
    try {
      const { data, error } = await supabase.from("reservations").select("show_id");
      if (!error && Array.isArray(data)) {
        const counts = { A: 0, B: 0, C: 0, D: 0 };
        for (const r of data) {
          if (counts[r.show_id] !== undefined) counts[r.show_id]++;
        }
        return counts;
      }
      if (error && error.code === "PGRST205") {
        console.warn("⚠️  [Supabase] reservations 테이블이 아직 생성되지 않았습니다. supabase-schema.sql을 실행해주세요.");
      }
    } catch (e) {
      console.warn("⚠️  [Supabase] 집계 조회 중 에러, 로컬 DB로 임시 폴백:", e.message);
    }
  }
  return Object.fromEntries(sqliteQueries.countByShow.all().map((r) => [r.show_id, r.n]));
}

// 2. 공개 회차 정보 (매진 여부만 반환)
async function showsPublic() {
  const used = await dbGetCountsByShow();
  return SHOWS.map((s) => ({ ...s, soldOut: (used[s.id] || 0) >= SEATS[s.id] }));
}

// 3. SQLite 예매 트랜잭션 (폴백용)
function bookSqlite(showId, name, phone) {
  sqliteDb.exec("BEGIN IMMEDIATE");
  try {
    if (sqliteQueries.byPhone.get(phone)) {
      sqliteDb.exec("ROLLBACK");
      return { error: "duplicate" };
    }
    if (sqliteQueries.countShow.get(showId).n >= SEATS[showId]) {
      sqliteDb.exec("ROLLBACK");
      return { error: "soldout" };
    }
    const used = new Set(sqliteQueries.seatsOfShow.all(showId).map((r) => r.seat));
    let seat = 1;
    while (used.has(seat)) seat++;
    const code = `BUF-${showId}-${pad(seat)}`;
    sqliteQueries.insert.run(showId, seat, code, name, phone, new Date().toISOString());
    sqliteDb.exec("COMMIT");
    return { code, seat, show: showId };
  } catch (e) {
    try { sqliteDb.exec("ROLLBACK"); } catch (_) {}
    throw e;
  }
}

// 4. 예매 처리 (Supabase RPC 원자적 락 우선, 테이블 쿼리 폴백, SQLite 폴백)
async function dbBook(showId, name, phone) {
  if (supabase) {
    try {
      // 1순위: 분산 락(advisory lock)이 적용된 RPC book_ticket 호출
      const { data, error } = await supabase.rpc("book_ticket", {
        p_show_id: showId,
        p_name: name,
        p_phone: phone,
        p_cap: SEATS[showId] || CAP,
      });

      if (!error && data) {
        return data; // { code, seat, show } or { error: "duplicate" } or { error: "soldout" }
      }

      // 2순위: RPC 미배포 시 Supabase 테이블 직접 처리
      if (!error || error.code !== "PGRST205") {
        // 전화번호 중복 체크
        const { data: dup } = await supabase
          .from("reservations")
          .select("id")
          .eq("phone", phone)
          .maybeSingle();
        if (dup) return { error: "duplicate" };

        // 회차 좌석 확인
        const { data: rows, error: rErr } = await supabase
          .from("reservations")
          .select("seat")
          .eq("show_id", showId)
          .order("seat");
        if (rErr) throw rErr;

        if ((rows || []).length >= (SEATS[showId] || CAP)) {
          return { error: "soldout" };
        }

        const used = new Set((rows || []).map((r) => r.seat));
        let seat = 1;
        while (used.has(seat)) seat++;
        const code = `BUF-${showId}-${pad(seat)}`;

        const { error: insErr } = await supabase.from("reservations").insert({
          show_id: showId,
          seat: seat,
          code: code,
          name: name,
          phone: phone,
          created_at: new Date().toISOString(),
        });

        if (insErr) {
          if (insErr.code === "23505") return { error: "duplicate" };
          throw insErr;
        }

        return { code, seat, show: showId };
      }
    } catch (e) {
      console.warn("⚠️  [Supabase] 예매 중 에러 발생, 로컬 DB로 처리합니다:", e.message);
    }
  }

  return bookSqlite(showId, name, phone);
}

// 5. 예매 내역 조회 (전화번호 및 이름/코드)
async function dbLookup(phone, name, code) {
  if (supabase) {
    try {
      let query = supabase
        .from("reservations")
        .select("show_id, seat, code, name, phone, created_at")
        .eq("phone", phone);
      if (code && /^BUF-[A-D]-\d{2}$/.test(code)) {
        query = query.eq("code", code);
      }
      const { data, error } = await query.maybeSingle();
      if (!error && data) {
        if (!name || cleanName(data.name) === name) return data;
      }
    } catch (e) {
      console.warn("⚠️  [Supabase] 조회 중 에러:", e.message);
    }
  }
  const row = sqliteDb.prepare("SELECT show_id, seat, code, name, phone, created_at FROM reservations WHERE phone = ?").get(phone);
  if (row) {
    if (code && row.code !== code) return null;
    if (name && cleanName(row.name) !== name) return null;
    return row;
  }
  return null;
}

// 6. 예매 취소
async function dbCancel(phone) {
  if (supabase) {
    try {
      await supabase.from("reservations").delete().eq("phone", phone);
      return true;
    } catch (e) {
      console.warn("⚠️  [Supabase] 취소 중 에러:", e.message);
    }
  }
  sqliteDb.prepare("DELETE FROM reservations WHERE phone = ?").run(phone);
  return true;
}

// 7. 관리자 전체 목록 조회
async function dbGetAll() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("reservations")
        .select("show_id, seat, code, name, phone, created_at")
        .order("show_id", { ascending: true })
        .order("seat", { ascending: true });
      if (!error && Array.isArray(data)) return data;
    } catch (e) {
      console.warn("⚠️  [Supabase] 관리자 목록 조회 중 에러:", e.message);
    }
  }
  return sqliteQueries.all.all();
}

// 8. 관리자 예매 단건 삭제
async function dbAdminDelete(code) {
  if (supabase) {
    try {
      const { error } = await supabase.from("reservations").delete().eq("code", code);
      if (!error) return true;
    } catch (e) {
      console.warn("⚠️  [Supabase] 관리자 삭제 중 에러:", e.message);
    }
  }
  sqliteQueries.adminDelete.run(code);
  return true;
}

// ---- 요청 제한 (IP당) ----
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
    const shows = await showsPublic();
    const serverNow = Date.now();
    return send(res, 200, {
      openAt: new Date(OPEN_AT).toISOString(),
      openAtMs: OPEN_AT,
      now: new Date(serverNow).toISOString(),
      nowMs: serverNow,
      open: serverNow >= OPEN_AT,
      price: TICKET_PRICE,
      shows,
    });
  }

  if (route === "POST /api/book") {
    if (limited("book:" + ip, BOOK_RATE_MAX, 600000)) {
      return send(res, 429, { error: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
    }
    const b = await readJson(req);
    if (!isOpen()) return send(res, 403, { error: "not_open", message: "아직 예매가 열리지 않았습니다." });
    if (b.consent !== true) return send(res, 400, { error: "consent", message: "아카이빙·트리거 워닝 안내를 확인해야 예매할 수 있습니다." });
    if (!SHOW_IDS.has(b.show)) return send(res, 400, { error: "show", message: "회차를 선택해주세요." });
    const name = cleanName(b.name);
    if (!name) return send(res, 400, { error: "name", message: "이름을 입력해주세요." });
    const phone = normalizePhone(b.phone);
    if (!phone) return send(res, 400, { error: "phone", message: "휴대전화 번호를 010-0000-0000 형식으로 입력해주세요." });

    const r = await dbBook(b.show, name, phone);
    if (r.error === "duplicate") return send(res, 409, { error: "duplicate", message: "이 전화번호로 이미 예매하셨습니다." });
    if (r.error === "soldout") return send(res, 409, { error: "soldout", message: "이 회차는 매진되었습니다. 다른 회차를 선택해주세요." });
    if (r.error === "seat_conflict") return send(res, 409, { error: "soldout", message: "선택하신 좌석이 마감되었습니다. 다시 시도해주세요." });
    return send(res, 201, { code: r.code, show: b.show });
  }

  if (route === "POST /api/lookup" || route === "POST /api/cancel") {
    if (limited("lookup:" + ip, 60, 600000)) {
      return send(res, 429, { error: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
    }
    const b = await readJson(req);
    const phone = normalizePhone(b.phone);
    const name = cleanName(b.name);
    const code = String(b.code || "").trim().toUpperCase();
    if (!phone) {
      return send(res, 400, { error: "bad_request", message: "전화번호를 올바르게 입력해주세요." });
    }
    const row = await dbLookup(phone, name, code);
    if (!row) return send(res, 404, { error: "not_found", message: "예매 내역을 찾을 수 없습니다. 이름과 전화번호를 확인해주세요." });

    if (route === "POST /api/cancel") {
      await dbCancel(phone);
      return send(res, 200, { ok: true });
    }
    return send(res, 200, { code: row.code, show: row.show_id, name: row.name, phone: row.phone });
  }

  if (url.pathname.startsWith("/api/admin/")) {
    if (!adminOk(req)) return send(res, 401, { error: "unauthorized" });

    if (route === "GET /api/admin/reservations") {
      const rows = await dbGetAll();
      if (url.searchParams.get("format") === "csv") {
        const head = "회차,예매번호,이름,전화번호,예매시각\n";
        const body = rows.map((r) => {
          const s = SHOWS.find((x) => x.id === r.show_id);
          return [`${s.date} ${s.dowKo} ${s.time}`, r.code, r.name, r.phone, r.created_at].map(csvCell).join(",");
        }).join("\n");
        return send(res, 200, "\uFEFF" + head + body + "\n", {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="buffer-reservations.csv"',
        });
      }
      return send(res, 200, {
        db: supabase ? "supabase" : "sqlite",
        supabaseUrl: supabase ? SUPABASE_URL : null,
        seats: SEATS,
        reservations: rows.map((r) => ({
          show: r.show_id,
          seat: r.seat,
          code: r.code,
          name: r.name,
          phone: r.phone,
          createdAt: r.created_at,
        })),
      });
    }

    const m = /^DELETE \/api\/admin\/reservations\/(BUF-[A-D]-\d{2})$/.exec(route);
    if (m) {
      await dbAdminDelete(m[1]);
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: "not_found" });
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const BLOCKED_FILES = new Set([
  "server.js",
  "package.json",
  "package-lock.json",
  "supabase-schema.sql",
  "vite.config.js",
  "vite.config.mjs",
]);

function isForbiddenPath(relPath) {
  const normalized = path.normalize(relPath).replace(/^[/\\]+/, "");
  // Block any hidden file or path (.env, .git, etc.)
  if (normalized.split(/[/\\]/).some((part) => part.startsWith("."))) return true;
  // Block server/backend files
  const baseName = path.basename(normalized);
  if (BLOCKED_FILES.has(baseName)) return true;
  if (baseName.endsWith(".db") || baseName.endsWith(".db-wal") || baseName.endsWith(".db-shm")) return true;
  return false;
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  if (p === "/admin") p = "/admin.html";

  if (isForbiddenPath(p)) return send(res, 403, "Forbidden");

  const candidates = [
    path.join(DIST_DIR, p),
    path.join(ROOT_DIR, p),
    path.join(PUBLIC_DIR, p),
    p.startsWith("/assets/") ? path.join(ASSETS_DIR, p.slice("/assets".length)) : null,
  ].filter(Boolean);

  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) {
          const isAsset = p.startsWith("/assets/") || p.startsWith("/fonts/");
          res.writeHead(200, {
            "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
            "Cache-Control": isAsset ? "public, max-age=3600" : "no-cache",
          });
          fs.createReadStream(file).pipe(res);
          return;
        }
      } catch (_) {}
    }
  }

  return send(res, 404, "Not found");
}

async function startServer() {
  let vite = null;
  const isDev = process.env.NODE_ENV !== "production";

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    try {
      const url = new URL(req.url, "http://localhost");
      if (isForbiddenPath(url.pathname)) return send(res, 403, "Forbidden");
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

      if (vite) {
        if (url.pathname === "/admin") req.url = "/admin.html";
        return vite.middlewares(req, res, () => serveStatic(req, res, url));
      }

      return serveStatic(req, res, url);
    } catch (e) {
      if (e.status) return send(res, e.status, { error: "bad_request", message: "요청을 처리할 수 없습니다." }, { Connection: "close" });
      console.error(e);
      return send(res, 500, { error: "server", message: "서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요." });
    }
  });

  if (isDev) {
    try {
      const { createServer: createViteServer } = await import("vite");
      vite = await createViteServer({
        server: {
          middlewareMode: true,
          ws: { server },
        },
        appType: "spa",
      });
    } catch (e) {
      console.warn("⚠️  Vite dev middleware 미사용 (정적 파일 서빙으로 대체):", e.message);
    }
  }

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

    const dbText = supabase
      ? `🟢 Supabase 연동 (${SUPABASE_URL})`
      : `⚪️ SQLite 로컬 모드 (${DB_PATH})`;

    const viteText = vite
      ? "🟢 Vite HMR 개발 모드 활성화"
      : "⚪️ 정적 번들 모드";

    const seatsInfo = SHOWS.map((x) => `${x.id}=${SEATS[x.id]}`).join(" ");

    console.log(`
  🎟️  BUFFER 티켓 예매 서버 실행 완료

  ➜  접속 주소:      http://localhost:${PORT}/
  ➜  관리자 페이지:  http://localhost:${PORT}/admin
  ➜  프론트엔드:      ${viteText}
  ➜  데이터베이스:    ${dbText}
  ➜  예매 상태:      ${statusText}
  ➜  회차별 좌석:    ${seatsInfo}
  ➜  관리자 기능:    ${adminText}
`);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      server.close(async () => {
        if (vite) {
          try { await vite.close(); } catch (_) {}
        }
        try { sqliteDb.close(); } catch (_) {}
        process.exit(0);
      });
    });
  }
}

startServer();
