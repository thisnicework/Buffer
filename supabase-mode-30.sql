-- 모드 범위를 0~30 으로 넓힘: 새 모드 V(21, 화면에는 "X") 부터 받을 수 있게 (Supabase SQL Editor 에서 한 번 실행)
-- supabase-mode-15.sql 과 같은 내용에서 범위만 20 -> 30. 실행 전에는 X 를 누르면 폰이 잠깐 띵동 모드(8)로 갔다가 1.5초 뒤 X 로 바뀜.

-- 1. 모드 범위 0~20
ALTER TABLE public.show_state DROP CONSTRAINT IF EXISTS show_state_mode_check;
ALTER TABLE public.show_state ADD CONSTRAINT show_state_mode_check CHECK (mode BETWEEN 0 AND 30);

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
  IF p_mode IS NULL OR p_mode < 0 OR p_mode > 30 THEN
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

-- 3. 사이트가 바뀐 함수를 바로 알아보도록
NOTIFY pgrst, 'reload schema';

-- 확인용
SELECT * FROM public.show_state;
