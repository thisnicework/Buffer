// BUFFER 티켓 예매 동시성 및 정원 초과 방지 검증 테스트
"use strict";
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = "https://qatrsegoqwandtsasunp.supabase.co";
const SUPABASE_KEY = "sb_publishable_9f9-AydwUAdKgQ9UuQl83Q_flyWWDL3";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

async function cleanAllTestReservations() {
  const { data, error } = await supabase.from("reservations").delete().like("phone", "0108888%");
  if (error) console.error("Cleanup error:", error);
}

async function runTests() {
  console.log("==================================================");
  console.log("🚀 BUFFER 티켓 예매 무결성 & 동시성 스트레스 테스트 시작");
  console.log("==================================================");

  // 0. 초기 정리
  await cleanAllTestReservations();
  const { data: initialRows } = await supabase.from("reservations").select("id");
  console.log(`[0] 테스트 시작 전 기존 DB 예약 수: ${initialRows ? initialRows.length : 0}건`);

  const TEST_SHOW = "A";
  const TEST_CAP = 35; // 정원 35명
  const CONCURRENT_REQUESTS = 50; // 50명 동시 요청

  console.log(`\n[테스트 1] 50명 동시 예매 시도 (정원: ${TEST_CAP}석)`);
  console.log(`- 50개의 요청을 Promise.all을 통해 완전히 동시에 발송합니다.`);

  const startTime = Date.now();
  const requests = [];
  for (let i = 1; i <= CONCURRENT_REQUESTS; i++) {
    const padNum = String(i).padStart(4, "0");
    const name = `테스터${padNum}`;
    const phone = `0108888${padNum}`;
    requests.push(
      supabase.rpc("book_ticket", {
        p_show_id: TEST_SHOW,
        p_name: name,
        p_phone: phone,
        p_cap: TEST_CAP,
      })
    );
  }

  const results = await Promise.all(requests);
  const elapsed = Date.now() - startTime;
  console.log(`- 50개 동시 요청 완료 (총 소요 시간: ${elapsed}ms)`);

  let successCount = 0;
  let soldoutCount = 0;
  let duplicateCount = 0;
  let otherErrorCount = 0;
  const assignedSeats = new Set();
  const assignedCodes = new Set();

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    if (res.error) {
      console.error(`요청 ${i + 1} RPC 오류:`, res.error);
      otherErrorCount++;
      continue;
    }
    const data = res.data;
    if (data.error === "soldout") {
      soldoutCount++;
    } else if (data.error === "duplicate") {
      duplicateCount++;
    } else if (data.code && data.seat) {
      successCount++;
      assignedSeats.add(data.seat);
      assignedCodes.add(data.code);
    } else {
      otherErrorCount++;
      console.error(`요청 ${i + 1} 알 수 없는 응답:`, data);
    }
  }

  console.log("\n📊 [테스트 1 결과 분석]");
  console.log(`- 성공한 예매 수: ${successCount}건 (기대값: ${TEST_CAP}건)`);
  console.log(`- 매진 거절 수: ${soldoutCount}건 (기대값: ${CONCURRENT_REQUESTS - TEST_CAP}건)`);
  console.log(`- 배정된 고유 좌석 수: ${assignedSeats.size}개`);
  console.log(`- 배정된 고유 예매코드 수: ${assignedCodes.size}개`);

  // 검증: 성공 수는 정확히 TEST_CAP이어야 함
  if (successCount !== TEST_CAP) {
    throw new Error(`❌ 정원 초과 또는 미달 발생! 성공: ${successCount}, 정원: ${TEST_CAP}`);
  }
  // 검증: 매진 거절 수는 정확히 15건이어야 함
  if (soldoutCount !== CONCURRENT_REQUESTS - TEST_CAP) {
    throw new Error(`❌ 매진 거절 수 불일치! 거절: ${soldoutCount}`);
  }
  // 검증: 좌석 번호에 중복이 없어야 함
  if (assignedSeats.size !== TEST_CAP) {
    throw new Error(`❌ 좌석 중복 발생! 고유 좌석: ${assignedSeats.size}`);
  }
  // 검증: 좌석 번호가 1부터 TEST_CAP까지 빈틈없이 채워져야 함
  for (let s = 1; s <= TEST_CAP; s++) {
    if (!assignedSeats.has(s)) {
      throw new Error(`❌ 누락된 좌석 번호 발견: ${s}`);
    }
  }
  console.log("✅ [테스트 1 통과] 50명 동시 접속 시 정확히 35명만 예매되고 15명은 즉시 매진 처리됨. 좌석 중복 0건!");

  // [테스트 2] 매진 후 추가 예매 시도 차단 검증
  console.log(`\n[테스트 2] 매진 상태에서 5명 추가 예매 시도`);
  for (let i = 1; i <= 5; i++) {
    const res = await supabase.rpc("book_ticket", {
      p_show_id: TEST_SHOW,
      p_name: `추가테스터${i}`,
      p_phone: `0108888990${i}`,
      p_cap: TEST_CAP,
    });
    if (res.data && res.data.error === "soldout") {
      // 정상 매진 차단
    } else {
      throw new Error(`❌ 매진 상태인데 예매가 성공했습니다! 응답: ${JSON.stringify(res.data)}`);
    }
  }
  console.log("✅ [테스트 2 통과] 매진 상태에서 추가 예매 시도 5건 전원 즉시 차단됨.");

  // [테스트 3] 1인 1매 동일 전화번호 중복 예매 차단 검증
  console.log(`\n[테스트 3] 동일 전화번호로 5회 동시 예매 시도 (1인 1매 정책)`);
  const dupPhone = "01088887777";
  // 먼저 테스트용 회차 B에 대해 시도 (B는 비어있음)
  const dupRequests = [];
  for (let i = 1; i <= 5; i++) {
    dupRequests.push(
      supabase.rpc("book_ticket", {
        p_show_id: "B",
        p_name: `중복테스터${i}`,
        p_phone: dupPhone,
        p_cap: 35,
      })
    );
  }
  const dupResults = await Promise.all(dupRequests);
  let dupSuccess = 0;
  let dupBlocked = 0;
  for (const r of dupResults) {
    if (r.data && r.data.code) dupSuccess++;
    else if (r.data && r.data.error === "duplicate") dupBlocked++;
  }
  console.log(`- 중복 번호 동시 요청: 성공 ${dupSuccess}건, 중복 차단 ${dupBlocked}건`);
  if (dupSuccess !== 1 || dupBlocked !== 4) {
    throw new Error(`❌ 1인 1매 중복 방지 실패! 성공: ${dupSuccess}, 차단: ${dupBlocked}`);
  }
  console.log("✅ [테스트 3 통과] 동일 전화번호 동시 요청 시 정확히 1건만 성공하고 4건은 duplicate로 차단됨.");

  // [테스트 4] 예매 취소 및 빈 좌석 재배정(회수) 검증
  console.log(`\n[테스트 4] 좌석 취소 및 재배정 검증`);
  // 회차 A의 7번 좌석 취소
  const cancelCode = "BUF-A-07";
  const { data: seat7 } = await supabase.from("reservations").select("*").eq("code", cancelCode).single();
  console.log(`- 취소 대상: ${cancelCode} (${seat7.name}, ${seat7.phone})`);
  const { error: delErr } = await supabase.from("reservations").delete().eq("code", cancelCode);
  if (delErr) throw delErr;
  console.log(`- ${cancelCode} 좌석 취소 완료`);

  // 취소 후 현재 A 회차 예약 수 확인
  const { data: afterCancelRows } = await supabase.from("reservations").select("seat").eq("show_id", TEST_SHOW);
  console.log(`- 취소 후 잔여 예약 수: ${afterCancelRows.length} (정원 35 대비 1자리 여유)`);
  if (afterCancelRows.length !== 34) throw new Error("❌ 취소 후 카운트가 34가 아님");

  // 새로운 사람이 예매 시도 -> 취소된 7번 좌석(가장 작은 빈 번호)을 가져가야 함
  const rebookRes = await supabase.rpc("book_ticket", {
    p_show_id: TEST_SHOW,
    p_name: "재예매테스터",
    p_phone: "01088886666",
    p_cap: TEST_CAP,
  });
  console.log(`- 신규 예매 결과:`, rebookRes.data);
  if (!rebookRes.data || rebookRes.data.seat !== 7 || rebookRes.data.code !== "BUF-A-07") {
    throw new Error(`❌ 취소된 7번 좌석이 재배정되지 않았습니다! 배정: ${JSON.stringify(rebookRes.data)}`);
  }
  console.log("✅ [테스트 4 통과] 취소된 좌석 BUF-A-07이 새 예매자에게 정확히 재배정됨.");

  // 다시 정원 35명이 되었으므로 추가 예매 시도는 매진이어야 함
  const fullAgainRes = await supabase.rpc("book_ticket", {
    p_show_id: TEST_SHOW,
    p_name: "초과시도자",
    p_phone: "01088885555",
    p_cap: TEST_CAP,
  });
  if (!fullAgainRes.data || fullAgainRes.data.error !== "soldout") {
    throw new Error(`❌ 재채움 후 매진 처리 실패: ${JSON.stringify(fullAgainRes.data)}`);
  }
  console.log("✅ [테스트 4-1 통과] 35석 재충원 후 추가 예매 시 즉시 매진 처리됨.");

  // [테스트 5] DB 데이터 정리 및 원복
  console.log(`\n[테스트 5] 테스트 데이터 완전 삭제 및 DB 무결성 원복`);
  await cleanAllTestReservations();
  const { data: finalRows } = await supabase.from("reservations").select("id");
  console.log(`- 테스트 데이터 삭제 후 DB 전체 예약 수: ${finalRows ? finalRows.length : 0}건`);
  if (finalRows && finalRows.length !== 0) {
    throw new Error("❌ 테스트 데이터가 완전히 삭제되지 않았습니다!");
  }
  console.log("✅ [테스트 5 통과] 모든 테스트 데이터가 안전하게 삭제되었으며 DB가 깨끗합니다.");

  console.log("\n==================================================");
  console.log("🎉 모든 티켓 예매 무결성 & 정원 제한 테스트 100% 통과!");
  console.log("==================================================");
}

runTests().catch((err) => {
  console.error("\n❌ 테스트 실패:", err);
  cleanAllTestReservations().finally(() => process.exit(1));
});
