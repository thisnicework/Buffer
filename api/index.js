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

const SEATS = (() => {
  const m = { A: CAP, B: CAP, C: CAP, D: CAP };
  for (const part of String(process.env.SEATS || "").split(",")) {
    const r = /^\s*([A-D])\s*=\s*(\d{1,2})\s*$/i.exec(part);
    if (r) m[r[1].toUpperCase()] = Number(r[2]);
  }
  return m;
})();

const SHOWS = [
  { id: "A", date: "11.14", dow: "SAT", dowKo: "토", time: "3PM" },
  { id: "B", date: "11.14", dow: "SAT", dowKo: "토", time: "7PM" },
  { id: "C", date: "11.15", dow: "SUN", dowKo: "일", time: "3PM" },
  { id: "D", date: "11.15", dow: "SUN", dowKo: "일", time: "7PM" },
];
const SHOW_IDS = new Set(SHOWS.map((s) => s.id));

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

async function handler(req, res) {
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
    const shows = SHOWS.map((s) => ({ ...s, soldOut: (counts[s.id] || 0) >= SEATS[s.id] }));
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

  // 2. POST /api/book
  if (route === "POST /api/book") {
    const b = await getJson(req);
    if (!isOpen()) return send(res, 403, { error: "not_open", message: "아직 예매가 열리지 않았습니다." });
    if (b.consent !== true) return send(res, 400, { error: "consent", message: "아카이빙·트리거 워닝 안내를 확인해야 예매할 수 있습니다." });
    if (!SHOW_IDS.has(b.show)) return send(res, 400, { error: "show", message: "회차를 선택해주세요." });
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

  // 4. Admin API
  if (url.pathname.startsWith("/api/admin/")) {
    if (!adminOk(req)) return send(res, 401, { error: "unauthorized" });

    if (route === "GET /api/admin/reservations") {
      const { data: rows, error: allErr } = await supabase
        .from("reservations")
        .select("show_id, seat, code, name, phone, created_at")
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
}

module.exports = handler;
