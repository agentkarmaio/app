-- Apply drizzle/0018_indexing_state.sql before this repeatable function file.
-- Only the trusted backend may hold a lease or inspect internal ownership.
ALTER TABLE public.indexing_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.indexing_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.indexing_state TO service_role;

CREATE OR REPLACE FUNCTION public.acquire_indexing_lease(
  p_chain text, p_path text, p_owner uuid, p_lease_ms integer,
  p_interval_ms integer, p_enabled boolean DEFAULT true
) RETURNS SETOF public.indexing_state
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  state public.indexing_state%ROWTYPE;
  checked_at timestamptz;
BEGIN
  IF p_owner IS NULL OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 900000 THEN
    RAISE EXCEPTION 'indexing_lease_invalid' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.indexing_state(chain, path, enabled, interval_ms)
  VALUES (p_chain, p_path, p_enabled, p_interval_ms)
  ON CONFLICT (chain, path) DO NOTHING;
  SELECT * INTO state FROM public.indexing_state
    WHERE chain = p_chain AND path = p_path FOR UPDATE;
  -- Time must be sampled AFTER any wait for the previous owner to commit.
  checked_at := clock_timestamp();
  IF NOT state.enabled OR (state.owner IS NOT NULL AND state.lease_until > checked_at) THEN
    RETURN;
  END IF;
  RETURN QUERY UPDATE public.indexing_state SET
    owner = p_owner,
    lease_until = checked_at + p_lease_ms * interval '1 millisecond',
    last_attempt_at = checked_at,
    interval_ms = p_interval_ms,
    generation = generation + 1
  WHERE chain = p_chain AND path = p_path RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION public.renew_indexing_lease(
  p_chain text, p_path text, p_owner uuid, p_lease_ms integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE state public.indexing_state%ROWTYPE;
BEGIN
  IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 900000 THEN
    RAISE EXCEPTION 'indexing_lease_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO state FROM public.indexing_state
    WHERE chain = p_chain AND path = p_path FOR UPDATE;
  IF NOT FOUND OR NOT state.enabled OR state.owner IS DISTINCT FROM p_owner
     OR state.lease_until IS NULL OR state.lease_until <= clock_timestamp() THEN RETURN false; END IF;
  UPDATE public.indexing_state SET lease_until = clock_timestamp() + p_lease_ms * interval '1 millisecond'
    WHERE chain = p_chain AND path = p_path;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_indexing_run(
  p_chain text, p_path text, p_owner uuid, p_status text,
  p_error_code text DEFAULT NULL, p_checkpoint text DEFAULT NULL, p_head text DEFAULT NULL,
  p_checked_count integer DEFAULT 0, p_pending_count integer DEFAULT 0,
  p_inserted_count integer DEFAULT 0, p_unresolved_count integer DEFAULT 0,
  p_gap_count integer DEFAULT 0
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  state public.indexing_state%ROWTYPE;
  finished_at timestamptz;
  retained_gaps integer;
  effective_status text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('caught_up', 'catching_up', 'dormant', 'failed') THEN
    RAISE EXCEPTION 'indexing_status_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'caught_up' AND (p_pending_count <> 0 OR p_unresolved_count <> 0) THEN
    RAISE EXCEPTION 'indexing_coverage_incomplete' USING ERRCODE = '22023';
  END IF;
  IF p_gap_count IS NULL OR p_gap_count < 0 THEN
    RAISE EXCEPTION 'indexing_gap_count_invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO state FROM public.indexing_state
    WHERE chain = p_chain AND path = p_path FOR UPDATE;
  finished_at := clock_timestamp();
  IF NOT FOUND OR NOT state.enabled OR state.owner IS DISTINCT FROM p_owner
     OR state.lease_until IS NULL OR state.lease_until <= finished_at THEN RETURN false; END IF;
  -- Ordinary incremental success cannot prove historical omissions repaired.
  -- Keep a conservative lower bound, without double-counting the same gap.
  retained_gaps := greatest(state.gaps_count, p_gap_count);
  effective_status := CASE WHEN p_status = 'caught_up' AND retained_gaps > 0 THEN 'catching_up' ELSE p_status END;
  UPDATE public.indexing_state SET
    status = effective_status,
    error_code = CASE WHEN p_status = 'failed' THEN coalesce(p_error_code, 'unknown_error')
      WHEN p_status = 'caught_up' AND retained_gaps > 0 THEN coalesce(p_error_code, 'coverage_gap') ELSE p_error_code END,
    last_finished_at = finished_at,
    last_success_at = CASE WHEN effective_status = 'caught_up' THEN finished_at ELSE last_success_at END,
    checkpoint = CASE WHEN p_status <> 'failed' THEN coalesce(p_checkpoint, checkpoint) ELSE checkpoint END,
    head = CASE WHEN p_status <> 'failed' THEN coalesce(p_head, head) ELSE head END,
    checked_count = p_checked_count, pending_count = p_pending_count,
    inserted_count = p_inserted_count,
    unresolved_count = CASE WHEN p_status = 'failed' THEN greatest(unresolved_count, p_unresolved_count) ELSE p_unresolved_count END,
    gaps_count = retained_gaps,
    owner = NULL, lease_until = NULL
  WHERE chain = p_chain AND path = p_path;
  RETURN true;
END;
$$;

-- Fencing is opt-in on requests, so existing webhook/scoring/legacy writers
-- preserve their current behavior. Once a worker carries context, every write
-- locks and checks its lease in the SAME transaction as its actual mutation.
-- A local AbortSignal alone cannot stop a request already in flight.
CREATE OR REPLACE FUNCTION public.fence_indexing_write()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  headers jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  state public.indexing_state%ROWTYPE;
  context_chain text;
  context_path text;
  context_owner uuid;
BEGIN
  IF NOT (headers ?| ARRAY['x-indexing-chain', 'x-indexing-path', 'x-indexing-owner']) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  -- Check the PostgREST-selected database role, never a client-supplied JWT
  -- field/header. This function's SECURITY DEFINER current_user is its owner.
  IF current_setting('role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'indexing_context_forbidden' USING ERRCODE = '42501';
  END IF;
  context_chain := headers ->> 'x-indexing-chain';
  context_path := headers ->> 'x-indexing-path';
  IF context_chain IS NULL OR context_path IS NULL OR (headers ->> 'x-indexing-owner') IS NULL THEN
    RAISE EXCEPTION 'indexing_context_invalid' USING ERRCODE = '22023';
  END IF;
  BEGIN
    context_owner := (headers ->> 'x-indexing-owner')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'indexing_context_invalid' USING ERRCODE = '22023';
  END;
  IF (TG_OP <> 'DELETE' AND NEW.chain IS DISTINCT FROM context_chain)
     OR (TG_OP <> 'INSERT' AND OLD.chain IS DISTINCT FROM context_chain) THEN
    RAISE EXCEPTION 'indexing_chain_mismatch' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO state FROM public.indexing_state
    WHERE chain = context_chain AND path = context_path FOR UPDATE;
  IF NOT FOUND OR NOT state.enabled OR state.owner IS DISTINCT FROM context_owner
     OR state.lease_until IS NULL OR state.lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION 'indexing_lease_lost' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_indexing_lease(text,text,uuid,integer,integer,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_indexing_lease(text,text,uuid,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_indexing_run(text,text,uuid,text,text,text,text,integer,integer,integer,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fence_indexing_write() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.acquire_indexing_lease(text,text,uuid,integer,integer,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_indexing_lease(text,text,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_indexing_run(text,text,uuid,text,text,text,text,integer,integer,integer,integer,integer) TO service_role;

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['indexer_cursors','transactions','signal_events','wallets','erc8004_agents','erc8004_feedback'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS indexing_write_fence ON public.%I', target);
    EXECUTE format('CREATE TRIGGER indexing_write_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fence_indexing_write()', target);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
