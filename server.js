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

// 회차별 좌석 수: 기본값 1·2회차(A·B) 26매, 3회차(C) 32매, 4회차(D) 31매(기존 25매 + 추가 6매). SEATS="A=26,B=26,C=32,D=31" 처럼 환경변수로도 지정 가능
const DEFAULT_SEATS = { A: 26, B: 26, C: 32, D: 31 };
const SEATS = (() => {
  const m = { ...DEFAULT_SEATS };
  for (const part of String(process.env.SEATS || "").split(",")) {
    const r = /^\s*([A-D])\s*=\s*(\d{1,2})\s*$/i.exec(part);
    if (r) m[r[1].toUpperCase()] = Number(r[2]);
    else if (part.trim()) { console.error(`SEATS 형식이 올바르지 않습니다: "${part}" (예: A=26,B=26,C=32,D=32)`); process.exit(1); }
  }
  m.D = 31; // 4회차(11.15 일 7PM): 기존 25매 + 추가 6매 = 총 31매 한정 오픈
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
const SOLD_OUT_SHOWS = new Set(["B", "C"]); // 2회차(11.14 토 7PM), 3회차(11.15 일 3PM) 매진 처리

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
  CREATE TABLE IF NOT EXISTS show_state (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    mode             INTEGER NOT NULL DEFAULT 1,
    timer_started_at TEXT,
    updated_at       TEXT    NOT NULL
  );
  CREATE TABLE IF NOT EXISTS show_claims (
    num        INTEGER PRIMARY KEY CHECK (num BETWEEN 1 AND 40),
    client_id  TEXT    NOT NULL UNIQUE,
    updated_at TEXT    NOT NULL
  );
`);
sqliteDb.prepare("INSERT OR IGNORE INTO show_state (id, mode, timer_started_at, updated_at) VALUES (1, 1, NULL, ?)").run(new Date().toISOString());

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
  getState: sqliteDb.prepare("SELECT mode, timer_started_at, updated_at FROM show_state WHERE id = 1"),
  setState: sqliteDb.prepare("UPDATE show_state SET mode = ?, timer_started_at = ?, updated_at = ? WHERE id = 1"),
  getClaims: sqliteDb.prepare("SELECT num, client_id FROM show_claims ORDER BY num ASC"),
  getClaimOwner: sqliteDb.prepare("SELECT client_id FROM show_claims WHERE num = ?"),
  deleteClientOtherClaim: sqliteDb.prepare("DELETE FROM show_claims WHERE client_id = ? AND num <> ?"),
  upsertClaim: sqliteDb.prepare("INSERT INTO show_claims (num, client_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(num) DO UPDATE SET client_id = excluded.client_id, updated_at = excluded.updated_at"),
  clearClaims: sqliteDb.prepare("DELETE FROM show_claims"),
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

// 2. 공개 회차 정보 (잔여 좌석 수·정원은 보내지 않고 매진 여부만)
async function showsPublic() {
  const used = await dbGetCountsByShow();
  return SHOWS.map((s) => {
    const cap = SEATS[s.id];
    const count = used[s.id] || 0;
    return {
      ...s,
      soldOut: SOLD_OUT_SHOWS.has(s.id) || count >= cap,
    };
  });
}

// 3. SQLite 예매 트랜잭션 (폴백용)
function bookSqlite(showId, name, phone) {
  if (SOLD_OUT_SHOWS.has(showId)) return { error: "soldout" };
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
    try { sqliteDb.exec("ROLLBACK"); } catch (_) { }
    throw e;
  }
}

// 4. 예매 처리 (Supabase RPC 원자적 락 우선, 테이블 쿼리 폴백, SQLite 폴백)
async function dbBook(showId, name, phone) {
  if (SOLD_OUT_SHOWS.has(showId)) return { error: "soldout" };
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
        .in("show_id", ["A", "B", "C", "D"]) // skip the /tx "번호 선택 모드" switch row (show_id PICK)
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

// ---- DEVICE 공연 상태 & 관객 개인번호 1~40 (/tx 가 바꾸고 /rx 가 따라감) ----
// Supabase show_state / show_claims 가 원본. 테이블이 아직 없거나 SHOW_STATE=local 이면 로컬 SQLite 로 폴백 동작
const TIMER_SECONDS = 800;
const SHOW_SECRET = ADMIN_TOKEN || "admin1234";
const STATE_LOCAL = String(process.env.SHOW_STATE || "").toLowerCase() === "local";
const validClient = (v) => typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);

function statePayload(row) {
  const ms = (v) => (v ? new Date(v).getTime() : null);
  return {
    mode: row.mode,
    timerStartedAtMs: ms(row.timer_started_at),
    updatedAtMs: ms(row.updated_at),
    timerSeconds: TIMER_SECONDS,
    step: mode7StepLocal, // 모드 7 단계 (dbGetStep 이 최신값으로 갱신)
    nowMs: Date.now(),
  };
}

let stateWarned = false;
function warnStateOnce(msg) {
  if (stateWarned) return;
  stateWarned = true;
  console.warn(`⚠️  [Supabase] show_state 를 쓸 수 없어 로컬 DB로 모드를 저장합니다 (${msg}). supabase-schema.sql 5~11번을 실행하면 사라집니다.`);
}

let claimsWarned = false;
function warnClaimsOnce(msg) {
  if (claimsWarned) return;
  claimsWarned = true;
  console.warn(`⚠️  [Supabase] show_claims 를 쓸 수 없어 로컬 DB로 관객 번호를 저장합니다 (${msg}). supabase-schema.sql 5~11번을 실행하면 사라집니다.`);
}

async function dbGetState() {
  if (supabase && !STATE_LOCAL) {
    try {
      const { data, error } = await supabase.from("show_state").select("mode, timer_started_at, updated_at").eq("id", 1).maybeSingle();
      if (!error && data) {
        const normalized = (data.mode === 9 && !data.timer_started_at) ? { ...data, mode: 10 } : data;
        sqliteQueries.setState.run(normalized.mode, normalized.timer_started_at || null, normalized.updated_at);
        return normalized;
      }
      if (error) warnStateOnce(error.message);
    } catch (e) {
      warnStateOnce(e.message);
    }
  }
  return sqliteQueries.getState.get() || { mode: 1, timer_started_at: null, updated_at: new Date().toISOString() };
}

// 같은 규칙을 Supabase 함수 set_show_mode 와 로컬 SQLite 폴백 양쪽에 적용
async function dbSetMode(mode) {
  if (supabase && !STATE_LOCAL) {
    try {
      let { data, error } = await supabase.rpc("set_show_mode", { p_mode: mode, p_secret: SHOW_SECRET });
      if (mode === 9 && !error && data && !data.error && !data.timer_started_at) {
        await supabase.rpc("set_show_mode", { p_mode: 3, p_secret: SHOW_SECRET });
        const r9 = await supabase.rpc("set_show_mode", { p_mode: 9, p_secret: SHOW_SECRET });
        if (!r9.error && r9.data && !r9.data.error) data = r9.data;
      } else if (mode === 10 && ((data && data.error === "bad_mode") || error)) {
        await supabase.rpc("set_show_mode", { p_mode: 1, p_secret: SHOW_SECRET });
        const r10 = await supabase.rpc("set_show_mode", { p_mode: 9, p_secret: SHOW_SECRET });
        if (!r10.error && r10.data && !r10.data.error) {
          error = null;
          data = { ...r10.data, mode: 10 };
        }
      }
      if (!error && data && !data.error) {
        sqliteQueries.setState.run(data.mode, data.timer_started_at || null, data.updated_at);
        return data;
      }
      if (data && data.error) return { error: data.error };
      warnStateOnce(error && error.message);
    } catch (e) {
      warnStateOnce(e.message);
    }
  }
  const cur = sqliteQueries.getState.get() || { mode: 1, timer_started_at: null };
  const prev = cur.mode;
  const nowIso = new Date().toISOString();
  let timer = cur.timer_started_at || null;
  if (mode === 1 || mode === 2) timer = null;
  else if (mode === 3 && prev !== 3) timer = nowIso;
  else if (mode === 4 && !timer) timer = nowIso;
  sqliteQueries.setState.run(mode, timer, nowIso);
  return { mode, timer_started_at: timer, updated_at: nowIso };
}

function sqliteClaimsSnapshot(client) {
  const rows = sqliteQueries.getClaims.all();
  const taken = rows.map((r) => r.num);
  const mineRow = validClient(client) ? rows.find((r) => r.client_id === client) : null;
  return { taken, mine: mineRow ? mineRow.num : null };
}

async function dbGetClaims(client) {
  if (supabase && !STATE_LOCAL) {
    try {
      const { data, error } = await supabase
        .from("show_claims")
        .select("num, client_id")
        .order("num", { ascending: true });
      if (!error && Array.isArray(data)) {
        const taken = data.map((r) => r.num);
        const mineRow = validClient(client) ? data.find((r) => r.client_id === client) : null;
        return { taken, mine: mineRow ? mineRow.num : null };
      }
      if (error) warnClaimsOnce(error.message);
    } catch (e) {
      warnClaimsOnce(e.message);
    }
  }
  return sqliteClaimsSnapshot(client);
}

async function dbClaimNumber(client, number) {
  if (supabase && !STATE_LOCAL) {
    try {
      const { data, error } = await supabase.rpc("claim_show_number", {
        p_client: client,
        p_number: number,
      });
      if (!error && data) {
        if (data.error === "taken") return { error: "taken", taken: data.taken || [] };
        if (data.error) return { error: data.error };
        sqliteQueries.deleteClientOtherClaim.run(client, number);
        sqliteQueries.upsertClaim.run(number, client, new Date().toISOString());
        return { number: data.number, taken: data.taken || [] };
      }
      warnClaimsOnce(error && error.message);
    } catch (e) {
      warnClaimsOnce(e.message);
    }
  }

  sqliteDb.exec("BEGIN IMMEDIATE");
  try {
    const owner = sqliteQueries.getClaimOwner.get(number);
    if (owner && owner.client_id !== client) {
      sqliteDb.exec("ROLLBACK");
      return { error: "taken", taken: sqliteClaimsSnapshot(null).taken };
    }
    sqliteQueries.deleteClientOtherClaim.run(client, number);
    sqliteQueries.upsertClaim.run(number, client, new Date().toISOString());
    sqliteDb.exec("COMMIT");
    return { number, taken: sqliteClaimsSnapshot(null).taken };
  } catch (e) {
    try { sqliteDb.exec("ROLLBACK"); } catch (_) { }
    throw e;
  }
}

async function dbResetClaims() {
  if (supabase && !STATE_LOCAL) {
    try {
      const { data, error } = await supabase.rpc("reset_show_claims", { p_secret: SHOW_SECRET });
      if (!error && data) {
        if (data.error) return { error: data.error };
        sqliteQueries.clearClaims.run();
        return { taken: [] };
      }
      warnClaimsOnce(error && error.message);
    } catch (e) {
      warnClaimsOnce(e.message);
    }
  }
  sqliteQueries.clearClaims.run();
  return { taken: [] };
}

// ---- /tx "번호 선택 모드": ON = 관객이 /rx 에서 번호를 직접 고름, OFF = 선착순 자동 배정 ----
// Supabase 스키마를 바꾸지 않도록, 켜져 있는 동안 reservations 에 표시용 행 하나(show_id PICK, code PICK-MODE)를 둔다.
// (예매 집계·관리자 목록은 A~D 회차만 보므로 영향 없음.) SHOW_STATE=local 이면 메모리에만 둔다.
const PICK_ROW = { show_id: "PICK", seat: 0, code: "PICK-MODE", name: "번호선택모드", phone: "pick-mode" };
let pickModeLocal = false;
async function dbGetPickMode() {
  if (supabase && !STATE_LOCAL) {
    try {
      const { data, error } = await supabase.from("reservations").select("id").eq("code", PICK_ROW.code).maybeSingle();
      if (!error) return (pickModeLocal = !!data);
    } catch (_) {}
  }
  return pickModeLocal;
}
async function dbSetPickMode(on) {
  if (supabase && !STATE_LOCAL) {
    try {
      const { error } = on
        ? await supabase.from("reservations").insert({ ...PICK_ROW, created_at: new Date().toISOString() })
        : await supabase.from("reservations").delete().eq("code", PICK_ROW.code);
      if (error && error.code !== "23505") return { error: error.message }; // 23505: already on
    } catch (e) { return { error: e.message }; }
  }
  pickModeLocal = !!on;
  return { pickMode: pickModeLocal };
}

// ---- 모드 7 단계: 무대 모니터 숫자를 따라 소리 낼 번호를 하나씩 연다 ----
// 0 아무도, 1: 17, 2: +32, 3: +11, 4: +31, 5: +10, 6: 전체. 모드 7로 들어올 때 0으로 돌아감.
// 번호 선택 모드와 같은 방식으로 reservations 의 표시용 행(show_id STEP, seat = 단계)에 둔다.
const STEP_ROW = { show_id: "STEP", code: "MODE7-STEP", name: "모드7단계", phone: "mode7-step" };
let mode7StepLocal = 0;
async function dbGetStep() {
  if (supabase && !STATE_LOCAL) {
    try {
      const { data, error } = await supabase.from("reservations").select("seat").eq("code", STEP_ROW.code).maybeSingle();
      if (!error) return (mode7StepLocal = data ? data.seat : 0);
    } catch (_) {}
  }
  return mode7StepLocal;
}
async function dbSetStep(step) {
  if (supabase && !STATE_LOCAL) {
    try {
      const { data, error } = await supabase.from("reservations").update({ seat: step }).eq("code", STEP_ROW.code).select("id");
      if (error) return { error: error.message };
      if (!data || !data.length) {
        const ins = await supabase.from("reservations").insert({ ...STEP_ROW, seat: step, created_at: new Date().toISOString() });
        if (ins.error) return { error: ins.error.message };
      }
    } catch (e) { return { error: e.message }; }
  }
  mode7StepLocal = step;
  return { step };
}

// open /api/stream connections (Server-Sent Events)
const streams = new Set();
function broadcastState(row) {
  const msg = `data: ${JSON.stringify(statePayload(row))}\n\n`;
  for (const res of streams) res.write(msg);
}
function broadcastClaims(taken) {
  const msg = `event: claims\ndata: ${JSON.stringify({ taken, pickMode: pickModeLocal })}\n\n`;
  for (const res of streams) res.write(msg);
}

// keep idle connections from being dropped by phones / proxies
setInterval(() => { for (const res of streams) res.write(": ping\n\n"); }, 20000).unref();

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
    const isTest = url.searchParams.get("test") === "1" || url.searchParams.get("open") === "1";
    const shows = await showsPublic();
    const serverNow = Date.now();
    return send(res, 200, {
      openAt: new Date(OPEN_AT).toISOString(),
      openAtMs: OPEN_AT,
      now: new Date(serverNow).toISOString(),
      nowMs: serverNow,
      open: isTest || serverNow >= OPEN_AT,
      price: TICKET_PRICE,
      shows,
    });
  }

  if (route === "POST /api/book") {
    if (limited("book:" + ip, BOOK_RATE_MAX, 600000)) {
      return send(res, 429, { error: "rate_limited", message: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." });
    }
    const b = await readJson(req);
    const isTest = (url && (url.searchParams.get("test") === "1" || url.searchParams.get("open") === "1")) || (b && b.test === true);
    if (!isOpen() && !isTest) return send(res, 403, { error: "not_open", message: "아직 예매가 열리지 않았습니다." });
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

  if (route === "GET /api/state") {
    const [row] = await Promise.all([dbGetState(), dbGetStep()]);
    return send(res, 200, statePayload(row));
  }

  if (route === "POST /api/step") {
    const b = await readJson(req);
    const step = Number(b.step);
    if (!Number.isInteger(step) || step < 0 || step > 6) return send(res, 400, { error: "bad_step", message: "단계는 0~6 이어야 합니다." });
    const r = await dbSetStep(step);
    if (r.error) return send(res, 503, { error: "step", message: `모드 7 단계를 바꾸지 못했습니다: ${r.error}` });
    const row = await dbGetState();
    broadcastState(row);
    return send(res, 200, statePayload(row));
  }

  // live push to /rx: each phone holds this open and gets the new state the moment /tx changes it
  if (route === "GET /api/stream") {
    const [curState, curClaims] = await Promise.all([dbGetState(), dbGetClaims(null), dbGetStep()]);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`retry: 2000\ndata: ${JSON.stringify(statePayload(curState))}\n\n`);
    res.write(`event: claims\ndata: ${JSON.stringify({ taken: curClaims.taken, pickMode: await dbGetPickMode() })}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }

  if (route === "GET /api/claims") {
    const client = url.searchParams.get("client");
    const [claims, pickMode] = await Promise.all([dbGetClaims(client), dbGetPickMode()]);
    return send(res, 200, { ...claims, pickMode });
  }

  if (route === "GET /api/pickmode") {
    return send(res, 200, { pickMode: await dbGetPickMode() });
  }
  if (route === "POST /api/pickmode") {
    const b = await readJson(req);
    const r = await dbSetPickMode(b.on === true);
    if (r.error) return send(res, 503, { error: "pickmode", message: `번호 선택 모드를 바꾸지 못했습니다: ${r.error}` });
    broadcastClaims((await dbGetClaims(null)).taken);
    return send(res, 200, r);
  }

  if (route === "POST /api/claim") {
    const b = await readJson(req);
    const number = Number(b.number);
    if (!validClient(b.client)) return send(res, 400, { error: "client" });
    if (!Number.isInteger(number) || number < 1 || number > 40) {
      return send(res, 400, { error: "number", message: "번호는 1~40 중 하나여야 합니다." });
    }
    const r = await dbClaimNumber(b.client, number);
    if (r.error === "taken") {
      return send(res, 409, { error: "taken", message: "이미 선택된 번호예요.", taken: r.taken });
    }
    if (r.error) return send(res, 400, { error: r.error });
    broadcastClaims(r.taken);
    return send(res, 200, { number: r.number, taken: r.taken });
  }

  // first come, first served: a phone that arrives gets the lowest free number (1, 2, 3 … 40).
  // The same phone (same client id) always gets its number back.
  if (route === "POST /api/claim/auto") {
    const b = await readJson(req);
    if (!validClient(b.client)) return send(res, 400, { error: "client" });
    let snap = await dbGetClaims(b.client);
    if (snap.mine) return send(res, 200, { number: snap.mine, taken: snap.taken });
    for (let n = 1; n <= 40; n++) {
      if (snap.taken.includes(n)) continue;
      const r = await dbClaimNumber(b.client, n);
      if (!r.error) {
        broadcastClaims(r.taken);
        return send(res, 200, { number: r.number, taken: r.taken });
      }
      if (r.error !== "taken") return send(res, 400, { error: r.error });
      snap = await dbGetClaims(b.client); // someone took it a moment earlier: look again
      n = 0;
    }
    return send(res, 409, { error: "full", message: "40명이 모두 들어왔어요.", taken: snap.taken });
  }

  if (route === "POST /api/claims/reset") {
    const r = await dbResetClaims();
    if (r.error === "unauthorized") {
      return send(res, 500, { error: "secret_mismatch", message: "Supabase show_control 비밀번호가 ADMIN_TOKEN 과 다릅니다." });
    }
    if (r.error) return send(res, 400, { error: r.error });
    broadcastClaims([]);
    return send(res, 200, { taken: [] });
  }

  // /tx 는 비밀번호 없이 모드를 바꾼다 (운영자 요청). Supabase 쓰기 비밀번호는 서버의 ADMIN_TOKEN 이 대신 넣는다
  if (route === "POST /api/state") {
    const b = await readJson(req);
    const mode = Number(b.mode);
    if (!Number.isInteger(mode) || mode < 1 || mode > 10) {
      return send(res, 400, { error: "bad_mode", message: "모드는 1~10 중 하나여야 합니다." });
    }
    const r = await dbSetMode(mode);
    if (mode === 7 && !r.error) await dbSetStep(0); // entering mode 7: every number starts muted
    if (r.error === "unauthorized") {
      return send(res, 500, { error: "secret_mismatch", message: "Supabase show_control 비밀번호가 ADMIN_TOKEN 과 다릅니다." });
    }
    if (r.error) return send(res, 400, { error: r.error });
    broadcastState(r);
    return send(res, 200, statePayload(r));
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
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
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
  if (p === "/rx") p = "/rx.html";
  if (p === "/tx") p = "/tx.html";
  if (p === "/split") p = "/split.html";

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
      } catch (_) { }
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
    res.setHeader("X-Frame-Options", "SAMEORIGIN"); // /split frames /tx and /rx from this same site
    try {
      const url = new URL(req.url, "http://localhost");
      if (isForbiddenPath(url.pathname)) return send(res, 403, "Forbidden");
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

      if (vite) {
        if (url.pathname === "/admin") req.url = "/admin.html" + url.search;
        if (url.pathname === "/rx") req.url = "/rx.html" + url.search;
        if (url.pathname === "/tx") req.url = "/tx.html" + url.search;
        if (url.pathname === "/split") req.url = "/split.html" + url.search;
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
  🎟️  BUFFER 티켓 예매 & 공연 제어 서버 실행 완료

  ➜  예매 페이지:    http://localhost:${PORT}/
  ➜  관리자 페이지:  http://localhost:${PORT}/admin
  ➜  공연 송출(TX):  http://localhost:${PORT}/tx
  ➜  관객 화면(RX):  http://localhost:${PORT}/rx
  ➜  분할 리허설:    http://localhost:${PORT}/split
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
          try { await vite.close(); } catch (_) { }
        }
        try { sqliteDb.close(); } catch (_) { }
        process.exit(0);
      });
    });
  }
}

startServer();
