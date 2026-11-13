-- 모드 전환 딜레이 줄이기 (Supabase SQL Editor 에서 한 번 실행)
-- show_state 에 실제 모드 번호(0~13)와 모드 7 번호 ON/OFF(open7)를 바로 담아,
-- 폰이 Realtime 알림만 받고 곧바로 화면·소리를 바꿀 수 있게 합니다.
-- 실행 전에도 사이트는 지금처럼 동작하고, 실행하면 그때부터 빨라집니다.

-- 1. 모드 범위 0~13, open7 칸 추가
ALTER TABLE public.show_state DROP CONSTRAINT IF EXISTS show_state_mode_check;
ALTER TABLE public.show_state ADD CONSTRAINT show_state_mode_check CHECK (mode BETWEEN 0 AND 13);
ALTER TABLE public.show_state ADD COLUMN IF NOT EXISTS open7 INTEGER NOT NULL DEFAULT 0 CHECK (open7 BETWEEN 0 AND 63);

-- 2. 모드 변경: 실제 번호 그대로 저장. 모드 7 로 들어오면 번호 ON/OFF 는 모두 꺼짐(0)
CREATE OR REPLACE FUNCTION public.set_show_mode(p_mode INTEGER, p_secret TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev INTEGER;
  v_timer TIMESTAMPTZ;
  v_open7 INTEGER;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.show_control WHERE id = 1 AND secret = p_secret) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  IF p_mode IS NULL OR p_mode < 0 OR p_mode > 13 THEN
    RETURN jsonb_build_object('error', 'bad_mode');
  END IF;

  INSERT INTO public.show_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT mode, timer_started_at, open7 INTO v_prev, v_timer, v_open7 FROM public.show_state WHERE id = 1 FOR UPDATE;

  IF p_mode <= 2 THEN
    v_timer := NULL;                                  -- 카운트다운 이전 단계(0~2)로 돌아가면 초기화
  ELSIF p_mode = 3 AND v_prev IS DISTINCT FROM 3 THEN
    v_timer := v_now;                                 -- 모드 3 진입 = 800초 시작
  ELSIF p_mode = 4 AND v_timer IS NULL THEN
    v_timer := v_now;                                 -- 3을 건너뛰고 4로 왔을 때만 새로 시작
  END IF;
  IF p_mode = 7 THEN v_open7 := 0; END IF;

  UPDATE public.show_state SET mode = p_mode, timer_started_at = v_timer, open7 = v_open7, updated_at = v_now WHERE id = 1;
  RETURN jsonb_build_object('mode', p_mode, 'timer_started_at', v_timer, 'updated_at', v_now, 'open7', v_open7);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_show_mode(INTEGER, TEXT) TO anon, authenticated;

-- 3. 모드 7 번호 ON/OFF (비트 0~4 = 17, 32, 11, 31, 10, 비트 5 = 전체). 모드 시작 시각(updated_at)은 그대로 둠
CREATE OR REPLACE FUNCTION public.set_show_open7(p_mask INTEGER, p_secret TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.show_control WHERE id = 1 AND secret = p_secret) THEN
    RETURN jsonb_build_object('error', 'unauthorized');
  END IF;
  IF p_mask IS NULL OR p_mask < 0 OR p_mask > 63 THEN
    RETURN jsonb_build_object('error', 'bad_mask');
  END IF;
  UPDATE public.show_state SET open7 = p_mask WHERE id = 1;
  RETURN jsonb_build_object('open7', p_mask);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_show_open7(INTEGER, TEXT) TO anon, authenticated;

-- 4. show_state 변경이 Realtime 으로 폰에 바로 전달되도록 (이미 되어 있으면 건너뜀)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'show_state') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.show_state;
  END IF;
END $$;

-- 5. 사이트가 새 칸(open7)과 새 함수(set_show_open7)를 바로 알아보도록
NOTIFY pgrst, 'reload schema';

-- 확인용: 아래 결과에 open7 칸이 보이면 성공
SELECT * FROM public.show_state;
