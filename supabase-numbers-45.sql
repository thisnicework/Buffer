-- 관객 개인번호 1~40 → 1~45 (Supabase SQL Editor 에서 한 번 실행)
-- 이미 배정된 번호는 그대로 둡니다.

ALTER TABLE public.show_claims DROP CONSTRAINT IF EXISTS show_claims_num_check;
ALTER TABLE public.show_claims ADD CONSTRAINT show_claims_num_check CHECK (num BETWEEN 1 AND 45);

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

  DELETE FROM public.show_claims WHERE client_id = p_client AND num <> p_number;

  INSERT INTO public.show_claims (num, client_id, updated_at)
  VALUES (p_number, p_client, NOW())
  ON CONFLICT (num) DO UPDATE SET client_id = EXCLUDED.client_id, updated_at = NOW();

  SELECT COALESCE(jsonb_agg(num ORDER BY num), '[]'::jsonb) INTO v_taken FROM public.show_claims;
  RETURN jsonb_build_object('number', p_number, 'taken', v_taken);
END;
$$;
GRANT EXECUTE ON FUNCTION public.claim_show_number(TEXT, INTEGER) TO anon, authenticated;
