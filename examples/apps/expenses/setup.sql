-- Apps / expenses — per-user expense tracker with running totals.
--
-- Demonstrates:
--   * per-user data with RLS + audience (same flagship pattern)
--   * a SECOND, derived live query — running monthly totals — bound to the
--     same user. Both subscriptions update in lockstep when expenses change.

CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- Re-seed-safe: DROP first so a table left over from an OLDER demo schema is
-- replaced with the current one. `CREATE TABLE IF NOT EXISTS` silently keeps a
-- stale table when the schema EVOLVED, so subscribe_my_expenses would select
-- columns that don't exist → "column ... does not exist" (SQLSTATE 42703) →
-- 400. Demo data is disposable and the setup service re-seeds on boot, so a
-- drop+recreate is the right idempotency. (Mirrors examples/apps/todo.)
DROP TABLE IF EXISTS public.expenses CASCADE;
CREATE TABLE IF NOT EXISTS expenses (
  id          serial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  amount      numeric(10,2) NOT NULL CHECK (amount > 0),
  category    text NOT NULL,
  description text,
  spent_at    date NOT NULL DEFAULT CURRENT_DATE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_expenses_user_spent ON expenses(user_id, spent_at);

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exp_own_select ON expenses;
DROP POLICY IF EXISTS exp_own_insert ON expenses;
DROP POLICY IF EXISTS exp_own_update ON expenses;
DROP POLICY IF EXISTS exp_own_delete ON expenses;

CREATE POLICY exp_own_select ON expenses FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY exp_own_insert ON expenses FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY exp_own_update ON expenses FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY exp_own_delete ON expenses FOR DELETE TO authenticated USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON expenses TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE expenses_id_seq TO authenticated;

-- SECURITY DEFINER with a pinned search_path of pg_catalog + pg_temp
-- (audit round 28 F2). Every app object is fully qualified so a
-- CREATE-on-public role cannot shadow auth.uid / format / public.expenses
-- and run code as the definer.
CREATE OR REPLACE FUNCTION public.subscribe_my_expenses()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_items  text;
  v_totals text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '28000'; END IF;

  v_items  := 'expenses_'  || v_uid::text;
  v_totals := 'totals_'    || v_uid::text;

  PERFORM pgr.subscribe(
    v_items,
    format('SELECT id, amount, category, description, spent_at
            FROM public.expenses WHERE user_id = %L
            ORDER BY spent_at DESC, id DESC', v_uid),
    'delta',
    jsonb_build_object('sub', v_uid::text)
  );

  PERFORM pgr.subscribe(
    v_totals,
    format('SELECT category,
                   SUM(amount)::numeric(10,2)  AS total,
                   COUNT(*)::int               AS items
            FROM public.expenses
            WHERE user_id = %L
              AND spent_at >= date_trunc(''month'', CURRENT_DATE)
            GROUP BY category
            ORDER BY total DESC', v_uid),
    'delta',
    jsonb_build_object('sub', v_uid::text)
  );

  RETURN jsonb_build_object('items', v_items, 'totals', v_totals);
END;
$$;

GRANT EXECUTE ON FUNCTION public.subscribe_my_expenses() TO authenticated;
