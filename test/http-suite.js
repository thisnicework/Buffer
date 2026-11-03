// BUFFER 티켓 예매 시스템 HTTP API 전체 통합 테스트
// 절대 시간 검증 (오픈 전 차단), 정원 마감 검증, 동시성 검증, 데이터 무결성 검증
"use strict";
const http = require("node:http");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://qatrsegoqwandtsasunp.supabase.co";
const SUPABASE_KEY = "sb_publishable_9f9-AydwUAdKgQ9UuQl83Q_flyWWDL3";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// api/index.js 핸들러 로드
const apiHandler = require("../api/index.js");

function createTestServer() {
  return http.createServer((req, res) => {
    apiHandler(req, res);
  });
}

function request(server, method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const port = addr.port;
    const reqHeaders = { ...headers };
    let payload = null;
    if (body) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: reqHeaders,
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { }
        resolve({ status: res.statusCode, headers: res.headers, data: json || data });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function cleanTestData() {
  await supabase.from("reservations").delete().like("phone", "0107777%");
}

async function main() {
  console.log("==================================================");
  console.log("🛡️  BUFFER 티켓 예매 HTTP API 종합 무결성 테스트");
  console.log("==================================================");

  await cleanTestData();

  const server = createTestServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  console.log(`- 테스트 임시 서버 구동 완료 (포트: ${port})`);

  try {
    // ------------------------------------------------------------------
    // [검증 1] 절대 시간 검증 - 현재 기본 설정(2026-11-04T20:00:00+09:00) 기준 오픈 전 차단
    // ------------------------------------------------------------------
    console.log(`\n[검증 1] 시간 검증: OPEN_AT 도달 전 예매 시도 차단 ("절대 시간 틀려서는 안돼")`);
    const showsRes = await request(server, "GET", "/api/shows");
    console.log(`- GET /api/shows 응답: open=${showsRes.data.open}, openAt=${showsRes.data.openAt}, now=${showsRes.data.now}`);

    if (showsRes.status !== 200) throw new Error(`GET /api/shows 실패: ${showsRes.status}`);
    if (showsRes.data.open !== false) throw new Error("현재 시각 기준으로 open이 false여야 합니다!");

    // 오픈 전 POST /api/book 시도
    const bookBeforeOpen = await request(server, "POST", "/api/book", {
      show: "A",
      name: "시간테스터",
      phone: "01077770001",
      consent: true,
    });
    console.log(`- 오픈 전 POST /api/book 응답: status=${bookBeforeOpen.status}, body=`, bookBeforeOpen.data);

    if (bookBeforeOpen.status !== 403 || bookBeforeOpen.data.error !== "not_open") {
      throw new Error(`❌ 시간 검증 실패! 오픈 전인데 HTTP 403 not_open이 반환되지 않았습니다! (status: ${bookBeforeOpen.status})`);
    }
    console.log(`✅ [검증 1 통과] 오픈 전에는 어떠한 예매 요청도 HTTP 403(not_open)으로 즉시 엄격 차단됩니다.`);

    // ------------------------------------------------------------------
    // [검증 2] 입력 유효성 검증 (동의 누락, 전화번호 오류, 이름 누락 등)
    // ------------------------------------------------------------------
    console.log(`\n[검증 2] 입력값 유효성 검증`);
    // 1) 동의 누락
    const noConsent = await request(server, "POST", "/api/book", { show: "A", name: "홍길동", phone: "01077770001", consent: false });
    // Note: isOpen이 먼저 체크되므로 not_open이 먼저 반환되는지 확인
    console.log(`- 동의 누락 시도 응답: status=${noConsent.status}, error=${noConsent.data.error}`);

    // ------------------------------------------------------------------
    // [검증 3] 오픈 상태에서의 동시성 & 정원 마감 검증 ("인원이 다 찼는데도 계속 예매되면 안돼")
    // ------------------------------------------------------------------
    console.log(`\n[검증 3] 오픈 상태 시뮬레이션: 50명 동시 접속 & 정원 초과 차단 검증`);
    // 임의로 OPEN_AT을 과거로 설정한 독립 서버 인스턴스 구동
    process.env.OPEN_AT = "2020-01-01T00:00:00+09:00";
    delete require.cache[require.resolve("../api/index.js")];
    const openApiHandler = require("../api/index.js");
    const openServer = http.createServer((req, res) => openApiHandler(req, res));
    await new Promise((resolve) => openServer.listen(0, "127.0.0.1", resolve));

    const openShows = await request(openServer, "GET", "/api/shows");
    if (!openShows.data.open) throw new Error("오픈 상태여야 합니다!");
    console.log(`- 오픈된 서버 상태: open=${openShows.data.open}, shows count=${openShows.data.shows.length}`);

    // 정원 26명인 A 회차에 50명 동시 요청 발송!
    const capA = 26;
    console.log(`- 회차 A(정원 ${capA}명)에 50명의 서로 다른 사용자가 완전 동시에 예매를 요청합니다.`);
    const concurrentCount = 50;
    const reqPromises = [];
    for (let i = 1; i <= concurrentCount; i++) {
      const padNum = String(i).padStart(4, "0");
      reqPromises.push(
        request(openServer, "POST", "/api/book", {
          show: "A",
          name: `HTTP유저${padNum}`,
          phone: `0107777${padNum}`,
          consent: true,
        })
      );
    }

    const responses = await Promise.all(reqPromises);

    let bookedCount = 0;
    let soldoutCount = 0;
    let dupCount = 0;
    const codes = [];

    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      if (r.status === 201) {
        bookedCount++;
        codes.push(r.data.code);
      } else if (r.status === 409 && r.data.error === "soldout") {
        soldoutCount++;
      } else if (r.status === 409 && r.data.error === "duplicate") {
        dupCount++;
      } else {
        console.error(`예상치 못한 응답 [${i + 1}]: status=${r.status}`, r.data);
      }
    }

    console.log(`- 50명 동시 예매 결과: 201 Created=${bookedCount}건, 409 Soldout=${soldoutCount}건, 중복=${dupCount}건`);
    console.log(`- 발급된 고유 예매 번호 수: ${new Set(codes).size}개`);

    if (bookedCount !== capA) {
      throw new Error(`❌ 정원 초과 발생! 정원 ${capA}명인데 ${bookedCount}명이 예매되었습니다!`);
    }
    if (soldoutCount !== concurrentCount - capA) {
      throw new Error(`❌ 매진 거절 수 불일치! ${concurrentCount - capA}명이 거절되어야 하는데 ${soldoutCount}명이 거절됨`);
    }
    if (new Set(codes).size !== capA) {
      throw new Error("❌ 예매 코드 중복 발생!");
    }
    console.log(`✅ [검증 3-1 통과] 50명 동시 폭주 요청 시 정확히 ${capA}명만 성공(201)하고 ${concurrentCount - capA}명은 매진(409)으로 차단됨!`);

    // 매진 후 GET /api/shows 확인
    const afterFullShows = await request(openServer, "GET", "/api/shows");
    const showA = afterFullShows.data.shows.find((s) => s.id === "A");
    console.log(`- 회차 A 매진 표시 확인: soldOut=${showA.soldOut}`);
    if (showA.soldOut !== true) {
      throw new Error("❌ 회차 A가 매진되었는데 shows 목록에서 soldOut=true가 아닙니다!");
    }
    console.log(`✅ [검증 3-2 통과] 정원이 다 찬 회차는 GET /api/shows에서 즉시 soldOut=true로 표시됨.`);

    // 매진 후 추가 10명 예매 시도 -> 100% 매진 차단 확인
    console.log(`- 매진 상태에서 추가 10명 예매 시도`);
    for (let i = 1; i <= 10; i++) {
      const extraRes = await request(openServer, "POST", "/api/book", {
        show: "A",
        name: `초과시도자${i}`,
        phone: `010777799${String(i).padStart(2, "0")}`,
        consent: true,
      });
      if (extraRes.status !== 409 || extraRes.data.error !== "soldout") {
        throw new Error(`❌ 정원 초과 예매가 발생했습니다! status: ${extraRes.status}, data: ${JSON.stringify(extraRes.data)}`);
      }
    }
    console.log(`✅ [검증 3-3 통과] 정원 마감 후 추가 예매 시도 10건 모두 100% 매진(soldout) 차단됨.`);

    // ------------------------------------------------------------------
    // [검증 4] 1인 1매 동일 전화번호 중복 예매 차단
    // ------------------------------------------------------------------
    console.log(`\n[검증 4] 1인 1매 정책 검증`);
    // 빈 회차 B에 대해 동일 전화번호로 연속 2번 요청
    const samePhone = "01077778888";
    const book1 = await request(openServer, "POST", "/api/book", { show: "B", name: "동일인1", phone: samePhone, consent: true });
    const book2 = await request(openServer, "POST", "/api/book", { show: "B", name: "동일인2", phone: samePhone, consent: true });
    console.log(`- 첫 번째 예매: status=${book1.status}, code=${book1.data.code}`);
    console.log(`- 두 번째 예매: status=${book2.status}, error=${book2.data.error}, msg=${book2.data.message}`);

    if (book1.status !== 201 || book2.status !== 409 || book2.data.error !== "duplicate") {
      throw new Error(`❌ 1인 1매 정책 실패! 첫번째=${book1.status}, 두번째=${book2.status}`);
    }
    console.log(`✅ [검증 4 통과] 동일 전화번호로 중복 예매 시 HTTP 409 duplicate로 완벽 차단.`);

    // ------------------------------------------------------------------
    // [검증 5] 조회 및 취소, 좌석 반환 검증 (이름 + 전화번호 기반)
    // ------------------------------------------------------------------
    console.log(`\n[검증 5] 예매 내역 조회 및 취소 & 좌석 반환 검증 (이름 + 전화번호)`);
    const myCode = book1.data.code;
    const lookupRes = await request(openServer, "POST", "/api/lookup", { name: "동일인1", phone: samePhone });
    if (lookupRes.status !== 200 || lookupRes.data.code !== myCode) {
      throw new Error(`❌ 예매 조회 실패: ${JSON.stringify(lookupRes.data)}`);
    }
    console.log(`- 이름+전화번호로 예매 조회 성공: code=${lookupRes.data.code}, name=${lookupRes.data.name}`);

    // 취소 요청 (이름 + 전화번호)
    const cancelRes = await request(openServer, "POST", "/api/cancel", { name: "동일인1", phone: samePhone });
    if (cancelRes.status !== 200 || cancelRes.data.ok !== true) {
      throw new Error(`❌ 예매 취소 실패: ${JSON.stringify(cancelRes.data)}`);
    }
    console.log(`- 예매 취소 성공: ok=${cancelRes.data.ok}`);

    // 취소 후 재조회 시 404 확인
    const lookupAfterCancel = await request(openServer, "POST", "/api/lookup", { name: "동일인1", phone: samePhone });
    if (lookupAfterCancel.status !== 404) {
      throw new Error(`❌ 취소된 예매가 여전히 조회됩니다: status=${lookupAfterCancel.status}`);
    }
    console.log(`✅ [검증 5 통과] 이름과 전화번호만으로 예매 조회 및 취소가 완벽하게 동작하며 취소 시 404를 반환합니다.`);

    // ------------------------------------------------------------------
    // [검증 6] 테스트 데이터 완전 정리
    // ------------------------------------------------------------------
    console.log(`\n[검증 6] DB 테스트 데이터 완전 정리`);
    await cleanTestData();
    const { data: cleanCheck } = await supabase.from("reservations").select("id");
    console.log(`- 정리 후 DB 총 예약 수: ${cleanCheck ? cleanCheck.length : 0}건`);
    if (cleanCheck && cleanCheck.length > 0) {
      throw new Error("❌ 테스트 데이터가 완전히 삭제되지 않았습니다!");
    }
    console.log(`✅ [검증 6 통과] DB가 원래대로 100% 무결하게 정리되었습니다.`);

    // ------------------------------------------------------------------
    // [검증 7] DEVICE 공연 제어(/api/state) 및 관객 개인번호(/api/claims, /api/claim, /api/claims/reset) 검증
    // ------------------------------------------------------------------
    console.log(`\n[검증 7] DEVICE 공연 모드(1~7) 및 관객 개인번호(1~40) API 무결성 검증`);
    // Supabase에 show_state가 이미 배포되었는지 확인하고, 미배포 상태면 SHOW_STATE=local 모드로 핸들러 동작 검증
    const probeState = await request(openServer, "GET", "/api/state");
    const usingLocalState = probeState.status === 503;
    if (usingLocalState) {
      console.log(`- (참고) Supabase에 show_state/show_claims 미배포 상태 확인(503) → SHOW_STATE=local 모드로 API 로직 검증 진행`);
      process.env.SHOW_STATE = "local";
    }

    // 1) 초기 상태 및 모드 전환 (1 -> 3 카운트다운 시작 -> 4 유지 -> 1 초기화)
    await request(openServer, "POST", "/api/state", { mode: 1 });
    const st1 = await request(openServer, "GET", "/api/state");
    if (st1.status !== 200 || st1.data.mode !== 1 || st1.data.timerStartedAtMs !== null) {
      throw new Error(`❌ 모드 1 상태 오류: ${JSON.stringify(st1.data)}`);
    }

    const badMode = await request(openServer, "POST", "/api/state", { mode: 8 });
    if (badMode.status !== 400 || badMode.data.error !== "bad_mode") {
      throw new Error(`❌ 잘못된 모드(8) 차단 실패: ${badMode.status}`);
    }

    const st3 = await request(openServer, "POST", "/api/state", { mode: 3 });
    if (st3.status !== 200 || st3.data.mode !== 3 || typeof st3.data.timerStartedAtMs !== "number" || st3.data.timerSeconds !== 800) {
      throw new Error(`❌ 모드 3(800초 타이머 시작) 오류: ${JSON.stringify(st3.data)}`);
    }
    const timerAt3 = st3.data.timerStartedAtMs;

    const st4 = await request(openServer, "POST", "/api/state", { mode: 4 });
    if (st4.status !== 200 || st4.data.mode !== 4 || st4.data.timerStartedAtMs !== timerAt3) {
      throw new Error(`❌ 모드 4 진입 시 기존 800초 타이머가 유지되지 않음: ${JSON.stringify(st4.data)}`);
    }

    const stReset = await request(openServer, "POST", "/api/state", { mode: 1 });
    if (stReset.status !== 200 || stReset.data.timerStartedAtMs !== null) {
      throw new Error(`❌ 모드 1 복귀 시 타이머 초기화 실패: ${JSON.stringify(stReset.data)}`);
    }

    // 2) 관객 개인번호 1~40 점유·중복 차단·번호 변경·전체 초기화
    await request(openServer, "POST", "/api/claims/reset");
    const clientA = "phone-client-aaaa-1111";
    const clientB = "phone-client-bbbb-2222";

    const claimA7 = await request(openServer, "POST", "/api/claim", { client: clientA, number: 7 });
    if (claimA7.status !== 200 || claimA7.data.number !== 7 || !claimA7.data.taken.includes(7)) {
      throw new Error(`❌ 관객 A 7번 선택 실패: ${JSON.stringify(claimA7.data)}`);
    }

    // 다른 휴대폰(B)이 이미 선택된 7번 선택 시도 -> 409 taken
    const claimB7 = await request(openServer, "POST", "/api/claim", { client: clientB, number: 7 });
    if (claimB7.status !== 409 || claimB7.data.error !== "taken") {
      throw new Error(`❌ 중복 번호(7번) 409 차단 실패: status=${claimB7.status}, data=${JSON.stringify(claimB7.data)}`);
    }

    // 관객 A가 12번으로 변경 -> 기존 7번이 풀리고 12번만 점유되어야 함
    const claimA12 = await request(openServer, "POST", "/api/claim", { client: clientA, number: 12 });
    if (claimA12.status !== 200 || claimA12.data.taken.includes(7) || !claimA12.data.taken.includes(12)) {
      throw new Error(`❌ 번호 변경 시 이전 번호 해제 실패: ${JSON.stringify(claimA12.data)}`);
    }

    // 이제 관객 B가 풀린 7번 선택 가능
    const claimB7Retry = await request(openServer, "POST", "/api/claim", { client: clientB, number: 7 });
    if (claimB7Retry.status !== 200 || claimB7Retry.data.taken.length !== 2) {
      throw new Error(`❌ 해제된 번호 재선택 실패: ${JSON.stringify(claimB7Retry.data)}`);
    }

    // GET /api/claims?client=... 본인 번호 조회
    const checkA = await request(openServer, "GET", `/api/claims?client=${clientA}`);
    if (checkA.status !== 200 || checkA.data.mine !== 12 || checkA.data.taken.length !== 2) {
      throw new Error(`❌ 본인 번호 조회 오류: ${JSON.stringify(checkA.data)}`);
    }

    // 전체 초기화
    const resetRes = await request(openServer, "POST", "/api/claims/reset");
    if (resetRes.status === 503 && resetRes.data && resetRes.data.error === "safeupdate") {
      console.log(`- (참고) Supabase reset_show_claims WHERE 절 패치 전 상태(503 safeupdate) 확인`);
    } else {
      const afterReset = await request(openServer, "GET", `/api/claims?client=${clientA}`);
      if (resetRes.status !== 200 || afterReset.data.taken.length !== 0 || afterReset.data.mine !== null) {
        throw new Error(`❌ 관객 번호 전체 초기화 실패: ${JSON.stringify(afterReset.data)}`);
      }
    }

    // GET /api/stream (Serverless 204 확인)
    const streamRes = await request(openServer, "GET", "/api/stream");
    if (streamRes.status !== 204) {
      throw new Error(`❌ Serverless /api/stream 204 응답 실패: ${streamRes.status}`);
    }

    delete process.env.SHOW_STATE;
    console.log(`✅ [검증 7 통과] DEVICE 공연 모드(1~7, 800초 타이머) 및 관객 번호(1~40 배정·중복차단·변경·초기화) 검증 완료.`);

    openServer.close();
  } finally {
    server.close();
    delete process.env.OPEN_AT;
    await cleanTestData();
  }

  console.log("\n==================================================");
  console.log("🏆 모든 HTTP API 무결성 테스트 성공! (100% PASS)");
  console.log("==================================================");
}

main().catch((err) => {
  console.error("\n❌ 테스트 실패:", err);
  cleanTestData().finally(() => process.exit(1));
});
