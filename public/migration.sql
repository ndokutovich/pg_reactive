-- What to Buy — shopping list schema
-- Runs at DB startup via docker-entrypoint-initdb.d

-- Role
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
GRANT authenticated TO CURRENT_USER;

-- Tables
CREATE TABLE IF NOT EXISTS shopping_lists (
  id         serial PRIMARY KEY,
  name       text NOT NULL,
  owner_id   uuid NOT NULL,
  share_code text UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS list_members (
  id        serial PRIMARY KEY,
  list_id   int REFERENCES shopping_lists(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL,
  role       text NOT NULL DEFAULT 'member',
  joined_at timestamptz DEFAULT now(),
  UNIQUE(list_id, user_id)
);

CREATE TABLE IF NOT EXISTS shopping_items (
  id         serial PRIMARY KEY,
  list_id    int REFERENCES shopping_lists(id) ON DELETE CASCADE,
  name       text NOT NULL,
  quantity   text DEFAULT '1',
  checked    boolean DEFAULT false,
  added_by   uuid,
  created_at timestamptz DEFAULT now()
);

-- Grants
GRANT ALL ON shopping_lists TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE shopping_lists_id_seq TO authenticated;
GRANT ALL ON list_members TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE list_members_id_seq TO authenticated;
GRANT ALL ON shopping_items TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE shopping_items_id_seq TO authenticated;

-- RLS
ALTER TABLE shopping_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lists_select ON shopping_lists;
CREATE POLICY lists_select ON shopping_lists FOR SELECT TO authenticated
  USING (id IN (SELECT list_id FROM list_members WHERE user_id = (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid));

DROP POLICY IF EXISTS lists_insert ON shopping_lists;
CREATE POLICY lists_insert ON shopping_lists FOR INSERT TO authenticated
  WITH CHECK (owner_id = (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid);

DROP POLICY IF EXISTS lists_delete ON shopping_lists;
CREATE POLICY lists_delete ON shopping_lists FOR DELETE TO authenticated
  USING (owner_id = (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid);

DROP POLICY IF EXISTS members_own ON list_members;
CREATE POLICY members_own ON list_members FOR ALL TO authenticated
  USING (user_id = (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid);

DROP POLICY IF EXISTS items_access ON shopping_items;
CREATE POLICY items_access ON shopping_items FOR ALL TO authenticated
  USING (list_id IN (SELECT list_id FROM list_members WHERE user_id = (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid));

-- Functions
DROP FUNCTION IF EXISTS create_shopping_list(text);
CREATE OR REPLACE FUNCTION create_shopping_list(list_name text)
RETURNS shopping_lists LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  uid uuid := (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid;
  code text := upper(substr(md5(random()::text), 1, 6));
  result shopping_lists;
BEGIN
  INSERT INTO shopping_lists(name, owner_id, share_code)
  VALUES (list_name, uid, code) RETURNING * INTO result;
  INSERT INTO list_members(list_id, user_id, role)
  VALUES (result.id, uid, 'owner');
  RETURN result;
END; $fn$;

DROP FUNCTION IF EXISTS join_shopping_list(text);
CREATE OR REPLACE FUNCTION join_shopping_list(code text)
RETURNS shopping_lists LANGUAGE plpgsql SECURITY DEFINER AS $fn$
DECLARE
  uid uuid := (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid;
  lid int;
  result shopping_lists;
BEGIN
  SELECT id INTO lid FROM shopping_lists WHERE upper(share_code) = upper(code);
  IF lid IS NULL THEN RAISE EXCEPTION 'Invalid share code'; END IF;
  INSERT INTO list_members(list_id, user_id, role)
  VALUES (lid, uid, 'member') ON CONFLICT (list_id, user_id) DO NOTHING;
  SELECT * INTO result FROM shopping_lists WHERE id = lid;
  RETURN result;
END; $fn$;

DROP FUNCTION IF EXISTS my_shopping_lists();
CREATE OR REPLACE FUNCTION my_shopping_lists()
RETURNS TABLE(id int, name text, owner_id uuid, share_code text, created_at timestamptz,
              member_count bigint, item_count bigint, checked_count bigint)
LANGUAGE plpgsql SECURITY DEFINER STABLE AS $fn$
DECLARE
  uid uuid := (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid;
BEGIN
  RETURN QUERY
  SELECT l.id, l.name, l.owner_id, l.share_code, l.created_at,
    (SELECT count(*) FROM list_members m WHERE m.list_id = l.id) AS member_count,
    (SELECT count(*) FROM shopping_items i WHERE i.list_id = l.id) AS item_count,
    (SELECT count(*) FROM shopping_items i WHERE i.list_id = l.id AND i.checked) AS checked_count
  FROM shopping_lists l
  JOIN list_members lm ON lm.list_id = l.id
  WHERE lm.user_id = uid
  ORDER BY l.created_at DESC;
END; $fn$;

-- Function grants
GRANT EXECUTE ON FUNCTION create_shopping_list(text) TO authenticated;
GRANT EXECUTE ON FUNCTION join_shopping_list(text) TO authenticated;
GRANT EXECUTE ON FUNCTION my_shopping_lists() TO authenticated;
