-- Example 04 — RLS + Audience: Multi-user Shared Shopping List
--
-- The "shared by code" pattern: a list belongs to its owner, but other
-- users can join by share_code. Both layers of safety are demonstrated:
--
--   1. RLS on the tables — even with a service_role-style backdoor, only
--      members of a list can read its items.
--   2. Audience on the live subscription — even if a member learns the
--      query_id, only their JWT (matching the bound member.user_id) can
--      open the WebSocket.
--
-- This is the right shape for any multi-tenant or invite-based shared
-- data (team channels, classroom rosters, family budgets).

CREATE EXTENSION IF NOT EXISTS pg_reactive;

CREATE TABLE IF NOT EXISTS lists (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  owner_id    uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  share_code  text UNIQUE NOT NULL DEFAULT lower(substr(md5(random()::text), 1, 8)),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS list_members (
  list_id  int  NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES pgstack.users(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, user_id)
);

CREATE TABLE IF NOT EXISTS list_items (
  id          serial PRIMARY KEY,
  list_id     int  NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  text        text NOT NULL,
  done        boolean NOT NULL DEFAULT false,
  added_by    uuid NOT NULL REFERENCES pgstack.users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- RLS — only members see lists / items / membership.
ALTER TABLE lists        ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_items   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lists_member_select ON lists;
DROP POLICY IF EXISTS lists_owner_insert  ON lists;
DROP POLICY IF EXISTS lists_owner_update  ON lists;
DROP POLICY IF EXISTS lists_owner_delete  ON lists;

CREATE POLICY lists_member_select ON lists FOR SELECT TO authenticated USING (
  owner_id = auth.uid()
  OR EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = lists.id AND m.user_id = auth.uid())
);
CREATE POLICY lists_owner_insert ON lists FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY lists_owner_update ON lists FOR UPDATE TO authenticated
  USING (owner_id = auth.uid());
CREATE POLICY lists_owner_delete ON lists FOR DELETE TO authenticated
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS members_self_select ON list_members;
DROP POLICY IF EXISTS members_self_insert ON list_members;
DROP POLICY IF EXISTS members_self_delete ON list_members;

CREATE POLICY members_self_select ON list_members FOR SELECT TO authenticated USING (
  user_id = auth.uid()
  OR EXISTS (SELECT 1 FROM lists l WHERE l.id = list_members.list_id AND l.owner_id = auth.uid())
);
CREATE POLICY members_self_insert ON list_members FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY members_self_delete ON list_members FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR EXISTS (
    SELECT 1 FROM lists l WHERE l.id = list_members.list_id AND l.owner_id = auth.uid()
  ));

DROP POLICY IF EXISTS items_member_select ON list_items;
DROP POLICY IF EXISTS items_member_insert ON list_items;
DROP POLICY IF EXISTS items_member_update ON list_items;
DROP POLICY IF EXISTS items_member_delete ON list_items;

CREATE POLICY items_member_select ON list_items FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM lists l WHERE l.id = list_items.list_id AND (
    l.owner_id = auth.uid()
    OR EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = l.id AND m.user_id = auth.uid())
  ))
);
CREATE POLICY items_member_insert ON list_items FOR INSERT TO authenticated WITH CHECK (
  added_by = auth.uid()
  AND EXISTS (SELECT 1 FROM lists l WHERE l.id = list_items.list_id AND (
    l.owner_id = auth.uid()
    OR EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = l.id AND m.user_id = auth.uid())
  ))
);
CREATE POLICY items_member_update ON list_items FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM lists l WHERE l.id = list_items.list_id AND (
    l.owner_id = auth.uid()
    OR EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = l.id AND m.user_id = auth.uid())
  ))
);
CREATE POLICY items_member_delete ON list_items FOR DELETE TO authenticated USING (
  added_by = auth.uid()
  OR EXISTS (SELECT 1 FROM lists l WHERE l.id = list_items.list_id AND l.owner_id = auth.uid())
);

GRANT SELECT, INSERT, UPDATE, DELETE ON lists, list_members, list_items TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE lists_id_seq, list_items_id_seq TO authenticated;

-- Capability helpers (SECURITY DEFINER — audience always derived from JWT).

-- Join a list by share_code. Returns the list_id.
CREATE OR REPLACE FUNCTION public.join_list(p_code text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgstack, pg_temp
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_list  int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '28000'; END IF;
  SELECT id INTO v_list FROM lists WHERE share_code = p_code;
  IF v_list IS NULL THEN RAISE EXCEPTION 'list not found'; END IF;
  INSERT INTO list_members (list_id, user_id) VALUES (v_list, v_uid)
  ON CONFLICT DO NOTHING;
  RETURN v_list;
END;
$$;

-- Open a subscription bound to (list_id, current user). The audience
-- predicate makes the subscription only deliverable to the caller's JWT
-- — even other list members get their OWN subscription with their OWN
-- audience. The query body is the same; only the listener differs.
CREATE OR REPLACE FUNCTION public.subscribe_list(p_list_id int)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pgr, pgstack, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_qid text;
  v_is_member boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth required' USING ERRCODE = '28000'; END IF;

  SELECT (l.owner_id = v_uid)
         OR EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = l.id AND m.user_id = v_uid)
    INTO v_is_member
    FROM lists l WHERE l.id = p_list_id;
  IF NOT COALESCE(v_is_member, false) THEN
    RAISE EXCEPTION 'not a member of this list' USING ERRCODE = '42501';
  END IF;

  v_qid := format('list_%s_user_%s', p_list_id, v_uid::text);

  PERFORM pgr.subscribe(
    v_qid,
    format('SELECT id, text, done, added_by, created_at
            FROM list_items WHERE list_id = %s
            ORDER BY created_at ASC', p_list_id),
    'delta',
    jsonb_build_object('sub', v_uid::text)
  );

  RETURN v_qid;
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_list(text)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.subscribe_list(int)    TO authenticated;
