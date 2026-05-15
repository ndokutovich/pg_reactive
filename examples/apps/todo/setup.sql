-- Apps / todo — minimal per-user task tracker.
--
-- Pattern: RLS on table + audience-bound subscription via SECURITY DEFINER
-- function. Same shape as examples/03-per-user-inventory, optimised for a
-- realistic UX (priority, due dates, soft-delete).

CREATE EXTENSION IF NOT EXISTS pg_reactive;

CREATE TABLE IF NOT EXISTS todos (
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

CREATE OR REPLACE FUNCTION public.subscribe_my_todos()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgr, pgstack, pg_temp
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
            FROM todos WHERE user_id = %L
            ORDER BY done ASC, priority DESC, created_at DESC', v_uid),
    'delta',
    jsonb_build_object('sub', v_uid::text)
  );
  RETURN v_qid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.subscribe_my_todos() TO authenticated;
