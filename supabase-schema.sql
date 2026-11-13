-- ==============================================================================
-- BUFFER 티켓 예매 시스템 - Supabase SQL 마이그레이션 스크립트
-- Supabase Dashboard -> SQL Editor에 붙여넣고 [Run] 버튼을 누르면 즉시 적용됩니다.
-- ==============================================================================

-- 1. 예매 테이블 생성
CREATE TABLE IF NOT EXISTS public.reservations (
  id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  show_id TEXT NOT NULL,                -- 회차 (A, B, C, D)
  seat INTEGER NOT NULL,                 -- 좌석 번호 (1, 2, 3, ...)
  code TEXT NOT NULL UNIQUE,             -- 예매 코드 (예: BUF-A-01)
  name TEXT NOT NULL,                    -- 예매자 이름
  phone TEXT NOT NULL UNIQUE,            -- 전화번호 (1인 1매 정책)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_show_seat UNIQUE (show_id, seat)
);

-- 2. 검색 및 정렬 성능 최적화를 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_reservations_show_id ON public.reservations (show_id);
CREATE INDEX IF NOT EXISTS idx_reservations_phone ON public.reservations (phone);
CREATE INDEX IF NOT EXISTS idx_reservations_code_phone ON public.reservations (code, phone);
CREATE INDEX IF NOT EXISTS idx_reservations_created_at ON public.reservations (created_at DESC);

-- 3. Row Level Security (RLS) 활성화 및 API 접근 정책 설정
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

-- 기존 정책이 있다면 삭제 후 재생성 (중복 생성 에러 방지)
DROP POLICY IF EXISTS "Allow all operations for anon and authenticated" ON public.reservations;

CREATE POLICY "Allow all operations for anon and authenticated"
  ON public.reservations
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- 4. 동시성 보장 원자적 예매 함수 (RPC: book_ticket)
-- 대용량 동시 접속 시에도 분산 트랜잭션 락(pg_advisory_xact_lock)을 통해
-- 정원 초과 및 좌석 중복 배정을 100% 방지합니다.
CREATE OR REPLACE FUNCTION public.book_ticket(
  p_show_id TEXT,
  p_name TEXT,
  p_phone TEXT,
  p_cap INTEGER DEFAULT 35
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_used INTEGER[];
  v_seat INTEGER := 1;
  v_code TEXT;
  v_count INTEGER;
BEGIN
  -- 회차별 배타적 락(advisory lock) 획득 - 동일 회차 예매 요청을 순차 처리하여 충돌 차단
  PERFORM pg_advisory_xact_lock(hashtext('buffer_booking_' || p_show_id));

  -- 1) 전화번호 중복 확인 (1인 1매 제한)
  IF EXISTS (SELECT 1 FROM public.reservations WHERE phone = p_phone) THEN
    RETURN jsonb_build_object('error', 'duplicate');
  END IF;

  -- 2) 잔여 좌석 확인 (정원 확인)
  SELECT COUNT(*) INTO v_count FROM public.reservations WHERE show_id = p_show_id;
  IF v_count >= p_cap THEN
    RETURN jsonb_build_object('error', 'soldout');
  END IF;

  -- 3) 가장 작은 빈 좌석 번호 탐색 (1번부터 순서대로)
  SELECT array_agg(seat ORDER BY seat) INTO v_used FROM public.reservations WHERE show_id = p_show_id;
  WHILE v_used IS NOT NULL AND v_seat = ANY(v_used) LOOP
    v_seat := v_seat + 1;
  END LOOP;

  v_code := 'BUF-' || p_show_id || '-' || lpad(v_seat::text, 2, '0');

  -- 4) 예매 데이터 등록
  INSERT INTO public.reservations (show_id, seat, code, name, phone, created_at)
  VALUES (p_show_id, v_seat, v_code, p_name, p_phone, NOW());

  RETURN jsonb_build_object('code', v_code, 'seat', v_seat, 'show', p_show_id);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'duplicate');
END;
$$;

-- 함수 실행 권한 부여
GRANT EXECUTE ON FUNCTION public.book_ticket(TEXT, TEXT, TEXT, INTEGER) TO anon, authenticated;

-- ==============================================================================
-- DEVICE 공연 제어 & 관객 개인번호 1~45 (/tx 운영 콘솔 · /rx 관객 휴대폰)
-- ==============================================================================

-- 5. 현재 공연 상태 (행 하나만 존재)
--    mode: 1~10 (DEVICE 표의 MODE)
--    timer_started_at: 800초 카운트다운 시작 시각. 모드 3 진입 시 기록되며 모드 4는 그대로 이어간다.
CREATE TABLE IF NOT EXISTS public.show_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode INTEGER NOT NULL DEFAULT 1 CHECK (mode BETWEEN 1 AND 10),
  timer_started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.show_state DROP CONSTRAINT IF EXISTS show_state_mode_check;
ALTER TABLE public.show_state ADD CONSTRAINT show_state_mode_check CHECK (mode BETWEEN 1 AND 10);
INSERT INTO public.show_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 누구나 읽기 가능 (관객 휴대폰 /rx 가 실시간 구독). 쓰기는 set_show_mode 함수로만 허용.
ALTER TABLE public.show_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read show state" ON public.show_state;
CREATE POLICY "Anyone can read show state"
  ON public.show_state
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- 6. 공연 제어 비밀번호 보관 (RLS 정책이 없으므로 anon 은 읽을 수 없음)
CREATE TABLE IF NOT EXISTS public.show_control (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  secret TEXT NOT NULL
);
ALTER TABLE public.show_control ENABLE ROW LEVEL SECURITY;
-- ⚠️ 기본값은 서버(.env / Vercel)의 기본 ADMIN_TOKEN('admin1234')과 맞춰져 있습니다.
-- ADMIN_TOKEN 환경변수를 다른 값으로 바꾸셨다면 아래 'admin1234'도 똑같은 값으로 바꾼 뒤 실행하세요.
INSERT INTO public.show_control (id, secret) VALUES (1, 'admin1234')
  ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret;

-- 7. 모드 변경 함수 (RPC: set_show_mode — 서버가 ADMIN_TOKEN 으로 호출)
CREATE OR REPLACE FUNCTION public.set_show_mode(p_mode INTEGER, p_secret TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev INTEGER;
  v_timer TIMESTAMPTZ;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.show_control WHERE id = 1 AND secret = p_secret) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  IF p_mode IS NULL OR p_mode < 1 OR p_mode > 10 THEN
    RETURN jsonb_build_object('error', 'bad_mode');
  END IF;

  INSERT INTO public.show_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT mode, timer_started_at INTO v_prev, v_timer FROM public.show_state WHERE id = 1 FOR UPDATE;

  IF p_mode IN (1, 2) THEN
    v_timer := NULL;                                  -- 카운트다운 이전 단계로 돌아가면 초기화
  ELSIF p_mode = 3 AND v_prev IS DISTINCT FROM 3 THEN
    v_timer := v_now;                                 -- 모드 3 진입 = 800초 시작
  ELSIF p_mode = 4 AND v_timer IS NULL THEN
    v_timer := v_now;                                 -- 3을 건너뛰고 4로 왔을 때만 새로 시작
  END IF;

  UPDATE public.show_state SET mode = p_mode, timer_started_at = v_timer, updated_at = v_now WHERE id = 1;
  RETURN jsonb_build_object('mode', p_mode, 'timer_started_at', v_timer, 'updated_at', v_now);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_show_mode(INTEGER, TEXT) TO anon, authenticated;

-- 8. 관객 개인번호 점유 테이블 (1~45번, 휴대폰당 1개 번호)
CREATE TABLE IF NOT EXISTS public.show_claims (
  num INTEGER PRIMARY KEY CHECK (num BETWEEN 1 AND 45),
  client_id TEXT NOT NULL UNIQUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 누구나 현재 선택된 번호 상태를 조회·구독 가능. 변경/초기화는 아래 RPC 함수로만 허용.
ALTER TABLE public.show_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read show claims" ON public.show_claims;
CREATE POLICY "Anyone can read show claims"
  ON public.show_claims
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- 9. 관객 개인번호 원자적 배정 함수 (RPC: claim_show_number)
-- 여러 관객이 동시에 같은 번호를 눌러도 pg_advisory_xact_lock 으로 중복 배정을 100% 차단합니다.
CREATE OR REPLACE FUNCTION public.claim_show_number(p_client TEXT, p_number INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner TEXT;
  v_taken JSONB;
BEGIN
  IF p_client IS NULL OR p_client !~ '^[A-Za-z0-9-]{8,64}$' THEN
    RETURN jsonb_build_object('error', 'client');
  END IF;
  IF p_number IS NULL OR p_number < 1 OR p_number > 45 THEN
    RETURN jsonb_build_object('error', 'number');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('buffer_show_claims'));

  SELECT client_id INTO v_owner FROM public.show_claims WHERE num = p_number;
  IF v_owner IS NOT NULL AND v_owner <> p_client THEN
    SELECT COALESCE(jsonb_agg(num ORDER BY num), '[]'::jsonb) INTO v_taken FROM public.show_claims;
    RETURN jsonb_build_object('error', 'taken', 'taken', v_taken);
  END IF;

  -- 이 휴대폰이 기존에 잡고 있던 다른 번호가 있으면 해제
  DELETE FROM public.show_claims WHERE client_id = p_client AND num <> p_number;

  -- 번호 배정 (이미 본인 번호면 시각만 갱신)
  INSERT INTO public.show_claims (num, client_id, updated_at)
  VALUES (p_number, p_client, NOW())
  ON CONFLICT (num) DO UPDATE SET client_id = EXCLUDED.client_id, updated_at = NOW();

  SELECT COALESCE(jsonb_agg(num ORDER BY num), '[]'::jsonb) INTO v_taken FROM public.show_claims;
  RETURN jsonb_build_object('number', p_number, 'taken', v_taken);
END;
$$;
GRANT EXECUTE ON FUNCTION public.claim_show_number(TEXT, INTEGER) TO anon, authenticated;

-- 10. 관객 개인번호 전체 초기화 함수 (RPC: reset_show_claims — 회차 전환 시 /tx 에서 호출)
CREATE OR REPLACE FUNCTION public.reset_show_claims(p_secret TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.show_control WHERE id = 1 AND secret = p_secret) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('buffer_show_claims'));
  DELETE FROM public.show_claims WHERE num >= 1;
  RETURN jsonb_build_object('taken', '[]'::jsonb);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reset_show_claims(TEXT) TO anon, authenticated;

-- 11. 실시간 구독(Supabase Realtime) 활성화 (관객 휴대폰 /rx 가 즉시 반영하도록)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'show_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.show_state;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'show_claims'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.show_claims;
  END IF;
END $$;
