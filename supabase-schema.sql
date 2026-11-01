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
