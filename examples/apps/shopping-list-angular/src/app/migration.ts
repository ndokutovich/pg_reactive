export const MIGRATION_SQL: string[] = [
  `CREATE TABLE IF NOT EXISTS shopping_lists (
  id serial PRIMARY KEY,
  name text NOT NULL,
  owner_id uuid NOT NULL,
  share_code text UNIQUE DEFAULT substr(md5(random()::text), 1, 6),
  created_at timestamptz DEFAULT now()
)`,
  `CREATE TABLE IF NOT EXISTS list_members (
  id serial PRIMARY KEY,
  list_id integer NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text DEFAULT 'member',
  joined_at timestamptz DEFAULT now(),
  UNIQUE(list_id, user_id)
)`,
  `CREATE TABLE IF NOT EXISTS shopping_items (
  id serial PRIMARY KEY,
  list_id integer NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  name text NOT NULL,
  quantity text DEFAULT '1',
  checked boolean DEFAULT false,
  added_by uuid,
  created_at timestamptz DEFAULT now()
)`,
  `GRANT ALL ON shopping_lists TO authenticated`,
  `GRANT USAGE, SELECT ON SEQUENCE shopping_lists_id_seq TO authenticated`,
  `GRANT ALL ON list_members TO authenticated`,
  `GRANT USAGE, SELECT ON SEQUENCE list_members_id_seq TO authenticated`,
  `GRANT ALL ON shopping_items TO authenticated`,
  `GRANT USAGE, SELECT ON SEQUENCE shopping_items_id_seq TO authenticated`,
  `ALTER TABLE shopping_lists ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE list_members ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE shopping_items ENABLE ROW LEVEL SECURITY`,
  `DROP POLICY IF EXISTS lists_select ON shopping_lists`,
  `CREATE POLICY lists_select ON shopping_lists FOR SELECT TO authenticated
  USING (id IN (SELECT list_id FROM list_members WHERE user_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid))`,
  `DROP POLICY IF EXISTS lists_insert ON shopping_lists`,
  `CREATE POLICY lists_insert ON shopping_lists FOR INSERT TO authenticated
  WITH CHECK (owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid)`,
  `DROP POLICY IF EXISTS lists_delete ON shopping_lists`,
  `CREATE POLICY lists_delete ON shopping_lists FOR DELETE TO authenticated
  USING (owner_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid)`,
  `DROP POLICY IF EXISTS members_own ON list_members`,
  `CREATE POLICY members_own ON list_members FOR SELECT TO authenticated
  USING (user_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid)`,
  `DROP POLICY IF EXISTS items_access ON shopping_items`,
  `CREATE POLICY items_access ON shopping_items FOR ALL TO authenticated
  USING (list_id IN (SELECT list_id FROM list_members WHERE user_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid))
  WITH CHECK (list_id IN (SELECT list_id FROM list_members WHERE user_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid))`,
  `CREATE OR REPLACE FUNCTION public.create_shopping_list(list_name text) RETURNS json AS $$ DECLARE uid uuid := (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid; new_list record; BEGIN INSERT INTO shopping_lists (name, owner_id) VALUES (list_name, uid) RETURNING * INTO new_list; INSERT INTO list_members (list_id, user_id, role) VALUES (new_list.id, uid, 'owner'); RETURN row_to_json(new_list); END; $$ LANGUAGE plpgsql SECURITY DEFINER`,
  `GRANT EXECUTE ON FUNCTION public.create_shopping_list(text) TO authenticated`,
  `CREATE OR REPLACE FUNCTION public.join_shopping_list(code text) RETURNS json AS $$ DECLARE uid uuid := (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid; found_list record; BEGIN SELECT * INTO found_list FROM shopping_lists WHERE share_code = lower(code); IF NOT FOUND THEN RAISE EXCEPTION 'List not found. Check the share code and try again.'; END IF; INSERT INTO list_members (list_id, user_id, role) VALUES (found_list.id, uid, 'member') ON CONFLICT (list_id, user_id) DO NOTHING; RETURN row_to_json(found_list); END; $$ LANGUAGE plpgsql SECURITY DEFINER`,
  `GRANT EXECUTE ON FUNCTION public.join_shopping_list(text) TO authenticated`,
  `CREATE OR REPLACE FUNCTION public.my_shopping_lists() RETURNS TABLE(id integer, name text, share_code text, owner_id uuid, member_count bigint, item_count bigint, checked_count bigint, created_at timestamptz) AS $$ SELECT sl.id, sl.name, sl.share_code, sl.owner_id, (SELECT COUNT(*) FROM list_members WHERE list_id = sl.id), (SELECT COUNT(*) FROM shopping_items WHERE list_id = sl.id), (SELECT COUNT(*) FROM shopping_items WHERE list_id = sl.id AND checked = true), sl.created_at FROM shopping_lists sl INNER JOIN list_members lm ON lm.list_id = sl.id WHERE lm.user_id = (current_setting('request.jwt.claims', true)::jsonb->>'sub')::uuid ORDER BY sl.created_at DESC $$ LANGUAGE sql SECURITY DEFINER`,
  `GRANT EXECUTE ON FUNCTION public.my_shopping_lists() TO authenticated`
];
