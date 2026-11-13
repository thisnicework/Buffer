// BUFFER 버퍼 티켓 예매 API - Vercel Serverless Function (Supabase 연동)
"use strict";
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");

function parseOpenAt(v) {
  const str = String(v || "2026-11-04T20:00:00+09:00").trim();
  const hasTz = /([+-]\d{2}:?\d{2}|Z)$/i.test(str);
  const normalized = hasTz ? str : str.replace(" ", "T") + "+09:00";
  const t = new Date(normalized).getTime();
  return Number.isFinite(t) ? t : new Date("2026-11-04T20:00:00+09:00").getTime();
}

const OPEN_AT = parseOpenAt(process.env.OPEN_AT);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin1234";
const TICKET_PRICE = Number(process.env.TICKET_PRICE || 0);
const CAP = 35;

const SUPABASE_URL = process.env.SUPABASE_URL || "https://qatrsegoqwandtsasunp.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "sb_publishable_9f9-AydwUAdKgQ9UuQl83Q_flyWWDL3";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

const DEFAULT_SEATS = { A: 26, B: 26, C: 32, D: 31 };
const SEATS = (() => {
  const m = { ...DEFAULT_SEATS };
  for (const part of String(process.env.SEATS || "").split(",")) {
    const r = /^\s*([A-D])\s*=\s*(\d{1,2})\s*$/i.exec(part);
    if (r) m[r[1].toUpperCase()] = Number(r[2]);
  }
  m.D = 31; // 4회차(11.15 일 7PM): 기존 25매 + 추가 6매 = 총 31매 한정 오픈
  return m;
})();

const SHOWS = [
  { id: "A", date: "11.14", dow: "SAT", dowKo: "토", time: "3PM" },
  { id: "B", date: "11.14", dow: "SAT", dowKo: "토", time: "7PM" },
  { id: "C", date: "11.15", dow: "SUN", dowKo: "일", time: "3PM" },
  { id: "D", date: "11.15", dow: "SUN", dowKo: "일", time: "7PM" },
];
const SHOW_IDS = new Set(SHOWS.map((s) => s.id));
const SOLD_OUT_SHOWS = new Set(["B", "C"]); // 2회차(11.14 토 7PM), 3회차(11.15 일 3PM) 매진 처리

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

function adminOk(req) {
  if (!ADMIN_TOKEN) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  const payload = isObj ? JSON.stringify(body) : body;
  res.writeHead(status, {
    "Content-Type": isObj ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(payload);
}

async function getJson(req) {
  if (req.body) {
    if (typeof req.body === "object") return req.body;
    if (typeof req.body === "string") {
      try { return JSON.parse(req.body); } catch (_) { return {}; }
    }
  }
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

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;

// DEVICE 공연 상태 & 관객 개인번호 (1~40): Supabase show_state / show_claims (supabase-schema.sql 5~11번)
const TIMER_SECONDS = 800;
const SHOW_SECRET = ADMIN_TOKEN || "admin1234";
const validClient = (v) => typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);

// SHOW_STATE=local 명시 시에만 메모리 모드로 동작 (로컬/자동화 테스트용). Vercel 운영 환경에서는 항상 Supabase 사용.
const isStateLocal = () => String(process.env.SHOW_STATE || "").toLowerCase() === "local";
const memState = { mode: 1, timer_started_at: null, updated_at: new Date().toISOString() };
const memClaimByNum = new Map();
const memClaimByClient = new Map();
const memTakenList = () => [...memClaimByNum.keys()].sort((a, b) => a - b);

// /tx "번호 선택 모드": ON = 관객이 /rx 에서 번호를 직접 고름, OFF = 선착순 자동 배정.
// Supabase 스키마를 바꾸지 않도록, 켜져 있는 동안 reservations 에 표시용 행 하나(show_id PICK, code PICK-MODE)를 둔다.
// 예매 집계·관리자 목록은 A~D 회차만 보므로 영향 없음.
const PICK_ROW = { show_id: "PICK", seat: 0, code: "PICK-MODE", name: "번호선택모드", phone: "pick-mode" };
let memPickMode = false;
async function getPickMode() {
  if (isStateLocal()) return memPickMode;
  const { data, error } = await supabase.from("reservations").select("id").eq("code", PICK_ROW.code).maybeSingle();
  return !error && !!data;
}
async function setPickMode(on) {
  if (isStateLocal()) { memPickMode = !!on; return { pickMode: memPickMode }; }
  const { error } = on
    ? await supabase.from("reservations").insert({ ...PICK_ROW, created_at: new Date().toISOString() })
    : await supabase.from("reservations").delete().eq("code", PICK_ROW.code);
  if (error && error.code !== "23505") return { error: error.message }; // 23505: already on
  return { pickMode: !!on };
}

function statePayload(row, step) {
  const ms = (v) => (v ? new Date(v).getTime() : null);
  return {
    mode: row.mode,
    timerStartedAtMs: ms(row.timer_started_at),
    updatedAtMs: ms(row.updated_at),
    timerSeconds: TIMER_SECONDS,
    open7: typeof step === "number" ? step : 0, // 모드 7 에서 소리가 열린 번호 (비트 묶음)
    nowMs: Date.now(),
  };
}

// 모드 7 단계: 무대 모니터 숫자를 따라 소리 낼 번호를 하나씩 연다.
// 0 아무도, 1: 17, 2: +32, 3: +11, 4: +31, 5: +10, 6: 전체. 모드 7로 들어올 때 0으로 돌아감.
// 이제는 /tx 에서 번호를 눌러 하나씩 켜고 끈다: 비트 0~4 = 17, 32, 11, 31, 10, 비트 5 = 전체 (0~63).
// 번호 선택 모드와 같은 방식으로 reservations 의 표시용 행(show_id OPEN7, seat = 비트 묶음)에 둔다.
// (show_id 를 예전 단계 행(STEP)과 나눠야 (show_id, seat) 중복 제약에 걸리지 않는다. 예전 행은 쓸 때 지운다.)
const STEP_ROW = { show_id: "OPEN7", code: "MODE7-OPEN", name: "모드7열림", phone: "mode7-open" };
let memStep = 0;
async function getStep() {
  if (isStateLocal()) return memStep;
  const { data, error } = await supabase.from("reservations").select("seat").eq("code", STEP_ROW.code).maybeSingle();
  return !error && data ? data.seat : 0;
}
async function setStep(step) {
  if (isStateLocal()) { memStep = step; return { step }; }
  await supabase.from("reservations").delete().eq("code", "MODE7-STEP"); // old step row
  const { data, error } = await supabase.from("reservations").update({ seat: step, show_id: STEP_ROW.show_id }).eq("code", STEP_ROW.code).select("id");
  if (error) return { error: error.message };
  if (!data || !data.length) {
    const ins = await supabase.from("reservations").insert({ ...STEP_ROW, seat: step, created_at: new Date().toISOString() });
    if (ins.error) return { error: ins.error.message };
  }
  return { step };
}

// 모드는 1~15. Supabase show_state 의 mode 칸은 오래된 제약(1~9)이 남아 있을 수 있어서, 실제 모드 번호는
// reservations 의 표시용 행(show_id MODE, seat = 모드)에 두고, show_state 에는 타이머 규칙이 같은 1~8 값을 쓴다
// (5 이상은 타이머를 그대로 두므로 9~15 는 8로 저장). show_state 갱신이 Realtime 으로 폰을 깨우는 역할은 그대로.
const MODE_MAX = 15;
const MODE_ROW = { show_id: "MODE", code: "SHOW-MODE", name: "공연모드", phone: "show-mode" };
async function getModeRow() {
  const { data, error } = await supabase.from("reservations").select("seat").eq("code", MODE_ROW.code).maybeSingle();
  return !error && data ? data.seat : null;
}
async function setModeRow(mode) {
  const { data, error } = await supabase.from("reservations").update({ seat: mode }).eq("code", MODE_ROW.code).select("id");
  if (error) return error.message;
  if (!data || !data.length) {
    const ins = await supabase.from("reservations").insert({ ...MODE_ROW, seat: mode, created_at: new Date().toISOString() });
    if (ins.error) return ins.error.message;
  }
  return null;
}

async function readState(res) {
  if (isStateLocal()) return memState;
  const [{ data, error }, rowMode] = await Promise.all([
    supabase.from("show_state").select("mode, timer_started_at, updated_at").eq("id", 1).maybeSingle(),
    getModeRow(),
  ]);
  if (error || !data) {
    send(res, 503, { error: "no_state", message: "show_state 테이블이 없습니다. supabase-schema.sql 을 실행해주세요." });
    return null;
  }
  if (rowMode) return { ...data, mode: rowMode };
  // 표시용 행이 생기기 전 값: 예전 9(메인사운드)=새 14, 예전 10(띵동, mode 9 + 타이머 없음으로 저장)=새 15
  if (data.mode === 9) return { ...data, mode: data.timer_started_at ? 14 : 15 };
  if (data.mode === 10) return { ...data, mode: 15 };
  return data;
}

async function handler(req, res) {
  try {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  // 1. GET /api/shows
  if (route === "GET /api/shows") {
    const { data: rows } = await supabase.from("reservations").select("show_id");
    const counts = { A: 0, B: 0, C: 0, D: 0 };
    for (const r of rows || []) {
      if (counts[r.show_id] !== undefined) counts[r.show_id]++;
    }
    const shows = SHOWS.map((s) => {
      const cap = SEATS[s.id];
      const count = counts[s.id] || 0;
      return {
        ...s,
        soldOut: SOLD_OUT_SHOWS.has(s.id) || count >= cap,
      };
    });
    const isTest = url.searchParams.get("test") === "1" || url.searchParams.get("open") === "1";
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

  // 2. POST /api/book
  if (route === "POST /api/book") {
    const b = await getJson(req);
    const isTest = (url && (url.searchParams.get("test") === "1" || url.searchParams.get("open") === "1")) || (b && b.test === true);
    if (!isOpen() && !isTest) return send(res, 403, { error: "not_open", message: "아직 예매가 열리지 않았습니다." });
    if (b.consent !== true) return send(res, 400, { error: "consent", message: "아카이빙·트리거 워닝 안내를 확인해야 예매할 수 있습니다." });
    if (!SHOW_IDS.has(b.show)) return send(res, 400, { error: "show", message: "회차를 선택해주세요." });
    if (SOLD_OUT_SHOWS.has(b.show)) return send(res, 409, { error: "soldout", message: "이 회차는 매진되었습니다. 다른 회차를 선택해주세요." });
    const name = cleanName(b.name);
    if (!name) return send(res, 400, { error: "name", message: "이름을 입력해주세요." });
    const phone = normalizePhone(b.phone);
    if (!phone) return send(res, 400, { error: "phone", message: "휴대전화 번호를 010-0000-0000 형식으로 입력해주세요." });

    const maxCap = SEATS[b.show] || CAP;

    // Supabase RPC book_ticket 호출 (분산 락 보장)
    const { data: rpcRes, error: rpcErr } = await supabase.rpc("book_ticket", {
      p_show_id: b.show,
      p_name: name,
      p_phone: phone,
      p_cap: maxCap,
    });

    if (!rpcErr && rpcRes) {
      if (rpcRes.error === "duplicate") return send(res, 409, { error: "duplicate", message: "이 전화번호로 이미 예매하셨습니다." });
      if (rpcRes.error === "soldout") return send(res, 409, { error: "soldout", message: "이 회차는 매진되었습니다. 다른 회차를 선택해주세요." });
      if (rpcRes.error === "seat_conflict") return send(res, 409, { error: "soldout", message: "선택하신 좌석이 마감되었습니다. 다시 시도해주세요." });
      return send(res, 201, { code: rpcRes.code, show: b.show });
    }

    // 테이블 직접 쿼리 폴백
    const { data: dup } = await supabase.from("reservations").select("id").eq("phone", phone).maybeSingle();
    if (dup) return send(res, 409, { error: "duplicate", message: "이 전화번호로 이미 예매하셨습니다." });

    const { data: showRows } = await supabase.from("reservations").select("seat").eq("show_id", b.show).order("seat");
    if ((showRows || []).length >= maxCap) {
      return send(res, 409, { error: "soldout", message: "이 회차는 매진되었습니다. 다른 회차를 선택해주세요." });
    }

    const used = new Set((showRows || []).map((x) => x.seat));
    let seat = 1;
    while (used.has(seat)) seat++;
    if (seat > maxCap) {
      return send(res, 409, { error: "soldout", message: "이 회차는 매진되었습니다. 다른 회차를 선택해주세요." });
    }
    const code = `BUF-${b.show}-${pad(seat)}`;

    const { error: insErr } = await supabase.from("reservations").insert({
      show_id: b.show,
      seat: seat,
      code: code,
      name: name,
      phone: phone,
      created_at: new Date().toISOString(),
    });

    if (insErr) {
      if (insErr.code === "23505") {
        const msg = String(insErr.message || "").toLowerCase();
        if (msg.includes("uq_show_seat") || msg.includes("seat")) {
          return send(res, 409, { error: "soldout", message: "선택하신 좌석이 마감되었습니다. 다시 시도해주세요." });
        }
        return send(res, 409, { error: "duplicate", message: "이 전화번호로 이미 예매하셨습니다." });
      }
      console.error(insErr);
      return send(res, 500, { error: "server", message: "예매 처리 중 오류가 발생했습니다." });
    }

    return send(res, 201, { code, show: b.show });
  }

  // 3. POST /api/lookup & POST /api/cancel
  if (route === "POST /api/lookup" || route === "POST /api/cancel") {
    const b = await getJson(req);
    const phone = normalizePhone(b.phone);
    const name = cleanName(b.name);
    const code = String(b.code || "").trim().toUpperCase();

    if (!phone) {
      return send(res, 400, { error: "bad_request", message: "전화번호를 올바르게 입력해주세요." });
    }

    let query = supabase
      .from("reservations")
      .select("show_id, seat, code, name, phone, created_at")
      .eq("phone", phone);

    if (code && /^BUF-[A-D]-\d{2}$/.test(code)) {
      query = query.eq("code", code);
    }

    const { data: row } = await query.maybeSingle();

    if (!row) {
      return send(res, 404, { error: "not_found", message: "예매 내역을 찾을 수 없습니다. 이름과 전화번호를 확인해주세요." });
    }

    if (name && cleanName(row.name) !== name) {
      return send(res, 404, { error: "not_found", message: "예매 내역을 찾을 수 없습니다. 이름과 전화번호를 확인해주세요." });
    }

    if (route === "POST /api/cancel") {
      await supabase.from("reservations").delete().eq("phone", phone);
      return send(res, 200, { ok: true });
    }
    return send(res, 200, { code: row.code, show: row.show_id, name: row.name, phone: row.phone });
  }

  // 4. DEVICE 공연 상태 & 관객 개인번호 (/tx 운영 콘솔 · /rx 관객 휴대폰)
  if (route === "GET /api/stream") {
    // Vercel Serverless 환경에서는 SSE 장시간 연결 대신 204를 반환하여 EventSource 재연결 루프를 정상 종료하고
    // Supabase Realtime + 폴링으로 실시간 동기화합니다.
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    return res.end();
  }

  if (route === "GET /api/state") {
    const [row, step] = await Promise.all([readState(res), getStep()]);
    return row && send(res, 200, statePayload(row, step));
  }

  if (route === "POST /api/mode7") {
    const b = await getJson(req);
    const step = Number(b.mask);
    if (!Number.isInteger(step) || step < 0 || step > 63) return send(res, 400, { error: "bad_mask", message: "모드 7 번호 값이 올바르지 않습니다." });
    const r = await setStep(step);
    if (r.error) return send(res, 503, { error: "mode7", message: `모드 7 번호를 바꾸지 못했습니다: ${r.error}` });
    const row = await readState(res);
    return row && send(res, 200, statePayload(row, step));
  }

  if (route === "POST /api/state") {
    const b = await getJson(req);
    const mode = Number(b.mode);
    if (!Number.isInteger(mode) || mode < 1 || mode > MODE_MAX) {
      return send(res, 400, { error: "bad_mode", message: `모드는 1~${MODE_MAX} 중 하나여야 합니다.` });
    }
    if (isStateLocal()) {
      const prev = memState.mode;
      if (mode === 1 || mode === 2) memState.timer_started_at = null;
      else if (mode === 3 && prev !== 3) memState.timer_started_at = new Date().toISOString();
      else if (mode === 4 && !memState.timer_started_at) memState.timer_started_at = new Date().toISOString();
      memState.mode = mode;
      memState.updated_at = new Date().toISOString();
      if (mode === 7) memStep = 0;
      return send(res, 200, statePayload(memState, memStep));
    }
    // the real mode number goes in the marker row first, then show_state (1~8, same timer rule) wakes the phones
    const rowErr = await setModeRow(mode);
    if (rowErr) return send(res, 503, { error: "no_state", message: `모드 저장 실패: ${rowErr}` });
    let { data, error } = await supabase.rpc("set_show_mode", { p_mode: Math.min(mode, 8), p_secret: SHOW_SECRET });
    if (data && !data.error) data = { ...data, mode };
    // say why it failed, so /tx shows something more useful than "요청 실패"
    if (error) return send(res, 503, { error: "no_state", message: `Supabase 모드 저장 실패: ${error.message}. supabase-schema.sql 5~7번을 다시 실행해주세요.` });
    if (data && data.error === "unauthorized") return send(res, 500, { error: "secret_mismatch", message: "Supabase show_control 비밀번호가 ADMIN_TOKEN 과 다릅니다." });
    if (data && data.error === "bad_mode") return send(res, 400, { error: "bad_mode", message: `Supabase가 아직 모드 ${mode}를 받지 않습니다. supabase-schema.sql 의 모드 범위(1~10) 부분을 다시 실행해주세요.` });
    if (data && data.error) return send(res, 400, { error: data.error, message: `모드를 바꾸지 못했습니다 (${data.error}).` });
    if (mode === 7) await setStep(0); // entering mode 7: every number starts muted
    return send(res, 200, statePayload(data, mode === 7 ? 0 : await getStep()));
  }

  if (route === "GET /api/claims") {
    const client = url.searchParams.get("client");
    const pickMode = await getPickMode();
    if (isStateLocal()) {
      return send(res, 200, {
        taken: memTakenList(),
        mine: validClient(client) ? memClaimByClient.get(client) || null : null,
        pickMode,
      });
    }
    const { data: rows, error } = await supabase
      .from("show_claims")
      .select("num, client_id")
      .order("num", { ascending: true });
    if (error) {
      return send(res, 503, { error: "no_claims", message: "show_claims 테이블이 없습니다. supabase-schema.sql 을 실행해주세요." });
    }
    const list = rows || [];
    const taken = list.map((r) => r.num);
    const mineRow = validClient(client) ? list.find((r) => r.client_id === client) : null;
    return send(res, 200, { taken, mine: mineRow ? mineRow.num : null, pickMode });
  }

  if (route === "GET /api/pickmode") {
    return send(res, 200, { pickMode: await getPickMode() });
  }
  if (route === "POST /api/pickmode") {
    const b = await getJson(req);
    const r = await setPickMode(b.on === true);
    if (r.error) return send(res, 503, { error: "pickmode", message: `번호 선택 모드를 바꾸지 못했습니다: ${r.error}` });
    return send(res, 200, r);
  }

  if (route === "POST /api/claim") {
    const b = await getJson(req);
    const number = Number(b.number);
    if (!validClient(b.client)) return send(res, 400, { error: "client" });
    if (!Number.isInteger(number) || number < 1 || number > 40) {
      return send(res, 400, { error: "number", message: "번호는 1~40 중 하나여야 합니다." });
    }
    if (isStateLocal()) {
      const owner = memClaimByNum.get(number);
      if (owner && owner !== b.client) {
        return send(res, 409, { error: "taken", message: "이미 선택된 번호예요.", taken: memTakenList() });
      }
      const prev = memClaimByClient.get(b.client);
      if (prev && prev !== number) memClaimByNum.delete(prev);
      memClaimByNum.set(number, b.client);
      memClaimByClient.set(b.client, number);
      return send(res, 200, { number, taken: memTakenList() });
    }
    const { data, error } = await supabase.rpc("claim_show_number", {
      p_client: b.client,
      p_number: number,
    });
    if (error) {
      return send(res, 503, { error: "no_claims", message: "claim_show_number 함수가 없습니다. supabase-schema.sql 을 실행해주세요." });
    }
    if (data && data.error === "taken") {
      return send(res, 409, { error: "taken", message: "이미 선택된 번호예요.", taken: data.taken || [] });
    }
    if (data && data.error) {
      return send(res, 400, { error: data.error });
    }
    return send(res, 200, { number: data.number, taken: data.taken || [] });
  }

  // first come, first served: a phone that arrives gets the lowest free number (1, 2, 3 … 40).
  // The same phone (same client id) always gets its number back.
  if (route === "POST /api/claim/auto") {
    const b = await getJson(req);
    if (!validClient(b.client)) return send(res, 400, { error: "client" });
    if (isStateLocal()) {
      const existing = memClaimByClient.get(b.client);
      if (existing) return send(res, 200, { number: existing, taken: memTakenList() });
      for (let n = 1; n <= 40; n++) {
        if (memClaimByNum.has(n)) continue;
        memClaimByNum.set(n, b.client);
        memClaimByClient.set(b.client, n);
        return send(res, 200, { number: n, taken: memTakenList() });
      }
      return send(res, 409, { error: "full", message: "40명이 모두 들어왔어요.", taken: memTakenList() });
    }
    let { data: rows, error: listErr } = await supabase
      .from("show_claims")
      .select("num, client_id")
      .order("num", { ascending: true });
    if (listErr) {
      return send(res, 503, { error: "no_claims", message: "show_claims 테이블이 없습니다. supabase-schema.sql 을 실행해주세요." });
    }
    let list = rows || [];
    const mineRow = list.find((r) => r.client_id === b.client);
    if (mineRow) {
      return send(res, 200, { number: mineRow.num, taken: list.map((r) => r.num) });
    }
    let taken = list.map((r) => r.num);
    for (let n = 1; n <= 40; n++) {
      if (taken.includes(n)) continue;
      const { data, error } = await supabase.rpc("claim_show_number", {
        p_client: b.client,
        p_number: n,
      });
      if (error) {
        return send(res, 503, { error: "no_claims", message: "claim_show_number 함수가 없습니다. supabase-schema.sql 을 실행해주세요." });
      }
      if (data && !data.error) {
        return send(res, 200, { number: data.number, taken: data.taken || [] });
      }
      if (data && data.error !== "taken") {
        return send(res, 400, { error: data.error });
      }
      const { data: retryRows } = await supabase.from("show_claims").select("num, client_id").order("num", { ascending: true });
      list = retryRows || [];
      const retryMine = list.find((r) => r.client_id === b.client);
      if (retryMine) return send(res, 200, { number: retryMine.num, taken: list.map((r) => r.num) });
      taken = list.map((r) => r.num);
      n = 0;
    }
    return send(res, 409, { error: "full", message: "40명이 모두 들어왔어요.", taken });
  }

  if (route === "POST /api/claims/reset") {
    if (isStateLocal()) {
      memClaimByNum.clear();
      memClaimByClient.clear();
      return send(res, 200, { taken: [] });
    }
    const { data, error } = await supabase.rpc("reset_show_claims", { p_secret: SHOW_SECRET });
    if (error) {
      if (error.code === "21000") {
        return send(res, 503, { error: "safeupdate", message: "reset_show_claims 함수 업데이트가 필요합니다. supabase-schema.sql 을 다시 Run 해주세요." });
      }
      return send(res, 503, { error: "no_claims", message: "reset_show_claims 함수가 없습니다. supabase-schema.sql 을 실행해주세요." });
    }
    if (data && data.error === "unauthorized") {
      return send(res, 500, { error: "secret_mismatch", message: "Supabase show_control 비밀번호가 ADMIN_TOKEN 과 다릅니다." });
    }
    if (data && data.error) {
      return send(res, 400, { error: data.error });
    }
    return send(res, 200, { taken: [] });
  }

  // 5. Admin API
  if (url.pathname.startsWith("/api/admin/")) {
    if (!adminOk(req)) return send(res, 401, { error: "unauthorized" });

    if (route === "GET /api/admin/reservations") {
      const { data: rows, error: allErr } = await supabase
        .from("reservations")
        .select("show_id, seat, code, name, phone, created_at")
        .in("show_id", ["A", "B", "C", "D"]) // skip the 번호 선택 모드 switch row (show_id PICK)
        .order("show_id", { ascending: true })
        .order("seat", { ascending: true });

      if (allErr) {
        console.error(allErr);
        return send(res, 500, { error: "db_error", message: allErr.message });
      }

      if (url.searchParams.get("format") === "csv") {
        const head = "회차,예매번호,이름,전화번호,예매시각\n";
        const body = (rows || []).map((r) => {
          const s = SHOWS.find((x) => x.id === r.show_id);
          return [`${s.date} ${s.dowKo} ${s.time}`, r.code, r.name, r.phone, r.created_at].map(csvCell).join(",");
        }).join("\n");
        return send(res, 200, "\uFEFF" + head + body + "\n", {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="buffer-reservations.csv"',
        });
      }

      return send(res, 200, {
        db: "supabase",
        supabaseUrl: SUPABASE_URL,
        seats: SEATS,
        reservations: (rows || []).map((r) => ({
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
      await supabase.from("reservations").delete().eq("code", m[1]);
      return send(res, 200, { ok: true });
    }
  }

  return send(res, 404, { error: "not_found" });
  } catch (e) {
    return send(res, e.status || 500, { error: e.status ? "bad_request" : "server_error", message: e.message });
  }
}

module.exports = handler;
