-- Apps / todo — minimal per-user task tracker.
--
-- Pattern: RLS on table + audience-bound subscription via SECURITY DEFINER
-- function. Same shape as examples/03-per-user-inventory, optimised for a
-- realistic UX (priority, due dates, soft-delete).

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Re-seed-safe: DROP first so a table left over from an OLDER demo schema is
-- replaced with the current one. `CREATE TABLE IF NOT EXISTS` silently kept a
-- stale table (e.g. an early `title`/`done`-only todos), so subscribe_my_todos
-- selected columns (text, priority, due_at, created_at) that didn't exist →
-- "column \"text\" does not exist" (SQLSTATE 42703) → 400 → the app's boot()
-- surfaced it as a misleading "auth failed". Demo data is disposable and the
-- setup service re-seeds on boot, so a drop+recreate is the right idempotency.
DROP TABLE IF EXISTS public.todos CASCADE;
CREATE TABLE public.todos (
  id          serial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  text        text NOT NULL,
  priority    int  NOT NULL DEFAULT 1 CHECK (priority BETWEEN 0 AND 2),
  done        boolean NOT NULL DEFAULT false,
  due_at      timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS todos_own_select ON todos;
DROP POLICY IF EXISTS todos_own_insert ON todos;
DROP POLICY IF EXISTS todos_own_update ON todos;
DROP POLICY IF EXISTS todos_own_delete ON todos;

CREATE POLICY todos_own_select ON todos FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY todos_own_insert ON todos FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY todos_own_update ON todos FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY todos_own_delete ON todos FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE todos_id_seq TO authenticated;

-- SECURITY DEFINER + pinned search_path (audit round 28 F2):
-- pg_catalog + pg_temp only, every app object fully qualified
-- (public.todos, pgr.subscribe, auth.uid). Keeping `public` on a
-- definer's search_path lets a CREATE-on-public role shadow auth.uid
-- or format() and run code as the definer.
CREATE OR REPLACE FUNCTION public.subscribe_my_todos()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_qid text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '28000'; END IF;
  v_qid := 'todos_' || v_uid::text;
  PERFORM pgr.subscribe(
    v_qid,
    format('SELECT id, text, priority, done, due_at, created_at
            FROM public.todos WHERE user_id = %L
            ORDER BY done ASC, priority DESC, created_at DESC', v_uid),
    'delta',
    jsonb_build_object('sub', v_uid::text)
  );
  RETURN v_qid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.subscribe_my_todos() TO authenticated;
