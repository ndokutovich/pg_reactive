-- What to Buy — shopping list schema (apps/shopping/)
--
-- Apply once per shopping-cart deployment via the shop-migration
-- one-shot container in deploy/templates/shop/docker-compose.yml.
-- Idempotent: every CREATE is IF NOT EXISTS / OR REPLACE, every
-- policy is DROP-then-CREATE.
--
-- Discipline (audit rounds 26 + 28 + 33):
--   * Every SECURITY DEFINER carries SET search_path = pg_catalog,
--     pg_temp so a role with CREATE on public cannot shadow auth.uid
--     and run as the definer.
--   * Every object reference is fully qualified — public.*, auth.*,
--     pgr.* — so the pinned path's missing public still resolves.
--   * REVOKE EXECUTE FROM PUBLIC before GRANT EXECUTE TO authenticated
--     so anon callers never reach a privileged function.
--   * pgr.subscribe wrappers bind an `audience` predicate keyed on
--     auth.uid() so REQUIRE_AUTHENTICATED_WS sees per-user scoping —
--     a member cannot listen on another member's stream by guessing
--     query_id (round 33 / audit F1).

-- ─── pg_reactive extension ────────────────────────────────────────
-- The all-in-one image installs the extension files at the OS level
-- but each database needs to CREATE EXTENSION to load it. Without
-- this, subscribe_list_items below fails with "schema pgr does not
-- exist" and live shopping-list updates never reach the browser.
CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- ─── Tables ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.shopping_lists (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  owner_id   uuid NOT NULL,
  share_code text UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.list_members (
  id        serial PRIMARY KEY,
  list_id   int REFERENCES public.shopping_lists(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL,
  role      text NOT NULL DEFAULT 'member',
  joined_at timestamptz DEFAULT now(),
  UNIQUE(list_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.shopping_items (
  id         serial PRIMARY KEY,
  list_id    int REFERENCES public.shopping_lists(id) ON DELETE CASCADE,
  name       text NOT NULL,
  quantity   text DEFAULT '1',
  checked    boolean DEFAULT false,
  added_by   uuid,
  created_at timestamptz DEFAULT now()
);

-- ─── Grants — minimum privileges only ──────────────────────────────
GRANT SELECT, DELETE ON public.shopping_lists                  TO authenticated;
GRANT SELECT          ON public.list_members                    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shopping_items   TO authenticated;
GRANT USAGE, SELECT   ON SEQUENCE public.shopping_items_id_seq  TO authenticated;

-- ─── RLS ───────────────────────────────────────────────────────────

ALTER TABLE public.shopping_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.list_members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopping_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lists_select ON public.shopping_lists;
CREATE POLICY lists_select ON public.shopping_lists FOR SELECT TO authenticated
  USING (id IN (SELECT list_id FROM public.list_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS lists_delete ON public.shopping_lists;
CREATE POLICY lists_delete ON public.shopping_lists FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS members_select ON public.list_members;
CREATE POLICY members_select ON public.list_members FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS items_access ON public.shopping_items;
CREATE POLICY items_access ON public.shopping_items FOR ALL TO authenticated
  USING (list_id IN (SELECT list_id FROM public.list_members WHERE user_id = auth.uid()));

-- ─── SECURITY DEFINER functions ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_shopping_list(list_name text)
RETURNS public.shopping_lists
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  uid    uuid := auth.uid();
  code   text := upper(substr(md5(random()::text), 1, 6));
  result public.shopping_lists;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF length(trim(list_name)) = 0 THEN
    RAISE EXCEPTION 'List name cannot be empty';
  END IF;
  INSERT INTO public.shopping_lists(name, owner_id, share_code)
  VALUES (trim(list_name), uid, code)
  RETURNING * INTO result;
  INSERT INTO public.list_members(list_id, user_id, role)
  VALUES (result.id, uid, 'owner');
  RETURN result;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.create_shopping_list(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_shopping_list(text) TO authenticated;


CREATE OR REPLACE FUNCTION public.join_shopping_list(code text)
RETURNS public.shopping_lists
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  uid    uuid := auth.uid();
  lid    int;
  result public.shopping_lists;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  SELECT id INTO lid FROM public.shopping_lists WHERE upper(share_code) = upper(code);
  IF lid IS NULL THEN
    RAISE EXCEPTION 'Invalid share code';
  END IF;
  INSERT INTO public.list_members(list_id, user_id, role)
  VALUES (lid, uid, 'member')
  ON CONFLICT (list_id, user_id) DO NOTHING;
  SELECT * INTO result FROM public.shopping_lists WHERE id = lid;
  RETURN result;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.join_shopping_list(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.join_shopping_list(text) TO authenticated;


CREATE OR REPLACE FUNCTION public.my_shopping_lists()
RETURNS TABLE(id int, name text, owner_id uuid, share_code text, created_at timestamptz,
              member_count bigint, item_count bigint, checked_count bigint)
LANGUAGE plpgsql
SECURITY DEFINER STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  RETURN QUERY
  SELECT l.id, l.name, l.owner_id, l.share_code, l.created_at,
    (SELECT count(*) FROM public.list_members  m WHERE m.list_id = l.id)              AS member_count,
    (SELECT count(*) FROM public.shopping_items i WHERE i.list_id = l.id)              AS item_count,
    (SELECT count(*) FROM public.shopping_items i WHERE i.list_id = l.id AND i.checked) AS checked_count
  FROM public.shopping_lists l
  JOIN public.list_members lm ON lm.list_id = l.id
  WHERE lm.user_id = uid
  ORDER BY l.created_at DESC;
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.my_shopping_lists() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.my_shopping_lists() TO authenticated;


-- ─── Live-query subscribe wrappers ─────────────────────────────────
-- Per-user query_id + audience binding: each member who joins a list
-- gets their OWN pgr subscription scoped by their auth.uid(). Even
-- if user A guesses user B's query_id `items-{B's list}-{B's uid}`,
-- the proxy's WS audience gate refuses to deliver the deltas because
-- A's JWT.sub ≠ B's uid (round 33 audience hardening).

CREATE OR REPLACE FUNCTION public.subscribe_list_items(p_list_id integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  uid uuid := auth.uid();
  qid text;
  query_sql text;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.list_members
    WHERE list_id = p_list_id AND user_id = uid
  ) THEN
    RAISE EXCEPTION 'not a member of this list';
  END IF;

  qid := 'items-' || p_list_id::text || '-' || replace(uid::text, '-', '');
  query_sql := format(
    'SELECT id, list_id, name, quantity, checked, added_by, created_at '
    'FROM public.shopping_items WHERE list_id = %L '
    'ORDER BY checked, created_at DESC',
    p_list_id
  );

  RETURN pgr.subscribe(
    qid,
    query_sql,
    'delta',
    jsonb_build_object('sub', uid::text)
  );
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.subscribe_list_items(integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.subscribe_list_items(integer) TO authenticated;


CREATE OR REPLACE FUNCTION public.unsubscribe_list_items(p_list_id integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  uid uuid := auth.uid();
  qid text;
BEGIN
  IF uid IS NULL THEN
    RETURN false;
  END IF;
  qid := 'items-' || p_list_id::text || '-' || replace(uid::text, '-', '');
  RETURN pgr.unsubscribe(qid);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.unsubscribe_list_items(integer) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.unsubscribe_list_items(integer) TO authenticated;
