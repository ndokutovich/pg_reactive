-- Example 03 — Per-user Inventory (audience-bound, flagship)
--
-- The pattern: a SECURITY DEFINER function derives the query_id AND the
-- audience predicate from the verified JWT (`auth.uid()`). The client
-- never invents either — it just calls the function and uses whatever
-- query_id comes back.
--
-- Why it matters:
--   * The query_id `inv_<uuid>` is not a secret. Anyone can guess
--     another player's uuid (they're broadcast in chat, logs, screenshots).
--   * The audience `{"sub":"<uuid>"}` makes pg_reactive's proxy reject the
--     WebSocket upgrade at connect time — BEFORE any row is sent — when
--     the JWT.sub does not match.
--   * Client cannot bypass it: the helper is SECURITY DEFINER and derives
--     both query_id and audience from auth.uid(). Even a malicious client
--     passing `player_id=other_user` as a parameter would be ignored.
--
-- This is the reference pattern for any per-user / per-tenant live data
-- (player inventory, account stats, private notifications, ...).

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- The data table. RLS makes the table itself safe even if someone got a
-- service_role connection — only auth.uid() can see their own rows.
CREATE TABLE IF NOT EXISTS player_inventory (
  player_id uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  item      text NOT NULL,
  count     int  NOT NULL DEFAULT 1 CHECK (count > 0),
  PRIMARY KEY (player_id, item)
);

ALTER TABLE player_inventory ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inv_own_select ON player_inventory;
DROP POLICY IF EXISTS inv_own_insert ON player_inventory;
DROP POLICY IF EXISTS inv_own_update ON player_inventory;
DROP POLICY IF EXISTS inv_own_delete ON player_inventory;

CREATE POLICY inv_own_select ON player_inventory FOR SELECT
  TO authenticated USING (player_id = auth.uid());
CREATE POLICY inv_own_insert ON player_inventory FOR INSERT
  TO authenticated WITH CHECK (player_id = auth.uid());
CREATE POLICY inv_own_update ON player_inventory FOR UPDATE
  TO authenticated USING (player_id = auth.uid());
CREATE POLICY inv_own_delete ON player_inventory FOR DELETE
  TO authenticated USING (player_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON player_inventory TO authenticated;

-- The capability helper. Returns the query_id; client opens
-- /ws/<query_id> with its JWT and the audience matcher does the rest.
--
-- search_path note: SECURITY DEFINER functions must avoid schemas where
-- an attacker can create shadowing objects. We pin search_path to the
-- two built-in schemas (pg_catalog for system funcs, pg_temp for the
-- temp namespace) and reference every app object with its explicit
-- schema (public.player_inventory, pgr.subscribe, auth.uid). Audit
-- round 28 F2: keeping `public` on search_path of a SECURITY DEFINER
-- helper lets a CREATE-on-public role shadow auth.uid or format() and
-- run code as the definer.
CREATE OR REPLACE FUNCTION public.subscribe_my_inventory()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_qid text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  v_qid := 'inv_' || v_uid::text;

  -- pgr.subscribe is idempotent on query_id: re-subscribing the same key
  -- updates in place. Safe to call on every login.
  PERFORM pgr.subscribe(
    v_qid,
    format('SELECT item, count FROM public.player_inventory WHERE player_id = %L',
           v_uid),
    'delta',
    jsonb_build_object('sub', v_uid::text)
  );

  RETURN v_qid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.subscribe_my_inventory() TO authenticated;
