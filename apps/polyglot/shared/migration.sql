-- Polyglot Matching Engines — schema, role, RLS, RPC, subscriptions.
--
-- Applied once at deploy via the polyglot-migration container. Idempotent.
-- See apps/polyglot/SPEC.md for the architecture.

-- ─── pg_reactive extension ────────────────────────────────────────
-- The all-in-one image installs the extension files at /usr/lib but
-- each database needs to CREATE EXTENSION to load it. Without this,
-- every pgr.subscribe(...) call below fails with "schema pgr does not
-- exist" — and because the DO blocks below swallow errors via
-- EXCEPTION WHEN OTHERS, the migration falsely reports success while
-- no subscriptions are actually registered.
CREATE EXTENSION IF NOT EXISTS pg_reactive;

-- ─── Engine worker role ───────────────────────────────────────────
-- Engines connect as polyglot_engine — strictly less privileged than the
-- postgres superuser. The connection still talks raw SQL (LISTEN/INSERT/
-- UPDATE/DELETE) but only against this app's tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'polyglot_engine') THEN
    CREATE ROLE polyglot_engine LOGIN PASSWORD 'polyglot-engine-dev-only';
  END IF;
END $$;

-- The bootstrap account changes the password via ALTER ROLE in the deploy
-- template's first-time setup. In dev the placeholder above is fine.

-- ─── Tables ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.order_events (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  symbol       text NOT NULL,
  side         text NOT NULL CHECK (side IN ('buy','sell')),
  order_type   text NOT NULL CHECK (order_type IN ('limit','market','cancel')),
  price        numeric,
  qty          numeric NOT NULL,
  client_id    uuid NOT NULL,
  parent_order bigint
);
CREATE INDEX IF NOT EXISTS order_events_id_idx ON public.order_events(id);

CREATE TABLE IF NOT EXISTS public.engine_fills (
  id          bigserial PRIMARY KEY,
  engine      text NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now(),
  order_id    bigint NOT NULL REFERENCES public.order_events(id),
  matched_qty numeric NOT NULL,
  fill_price  numeric NOT NULL,
  latency_us  int NOT NULL,
  taker_side  text NOT NULL CHECK (taker_side IN ('buy','sell'))
);
CREATE INDEX IF NOT EXISTS engine_fills_engine_ts_idx ON public.engine_fills(engine, ts DESC);

CREATE TABLE IF NOT EXISTS public.engine_book (
  engine      text NOT NULL,
  symbol      text NOT NULL,
  side        text NOT NULL CHECK (side IN ('buy','sell')),
  price       numeric NOT NULL,
  total_qty   numeric NOT NULL,
  order_count int NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (engine, symbol, side, price)
);
CREATE INDEX IF NOT EXISTS engine_book_engine_symbol_idx ON public.engine_book(engine, symbol);

CREATE TABLE IF NOT EXISTS public.engine_stats (
  engine          text PRIMARY KEY,
  total_orders    bigint  NOT NULL DEFAULT 0,
  total_matches   bigint  NOT NULL DEFAULT 0,
  total_volume    numeric NOT NULL DEFAULT 0,
  avg_latency_us  numeric NOT NULL DEFAULT 0,
  p99_latency_us  numeric NOT NULL DEFAULT 0,
  last_updated    timestamptz NOT NULL DEFAULT now()
);

-- Seed every engine's stats row so the perf panel shows all six from
-- the moment the page loads (instead of empty until the first batch).
INSERT INTO public.engine_stats (engine) VALUES
  ('go'), ('spring'), ('fastapi'), ('rust'), ('dotnet'), ('node')
ON CONFLICT (engine) DO NOTHING;

-- ─── Grants ───────────────────────────────────────────────────────
-- The worker role: write fills/book/stats, read orders, LISTEN.
-- The authenticated role (frontend viewers): read everything live; only
-- placing orders is privileged and goes through the place_order RPC.

GRANT SELECT, INSERT                ON public.order_events     TO polyglot_engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.engine_fills    TO polyglot_engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.engine_book     TO polyglot_engine;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.engine_stats    TO polyglot_engine;
GRANT USAGE, SELECT ON SEQUENCE public.order_events_id_seq     TO polyglot_engine;
GRANT USAGE, SELECT ON SEQUENCE public.engine_fills_id_seq     TO polyglot_engine;

GRANT SELECT ON public.order_events  TO authenticated, anon;
GRANT SELECT ON public.engine_fills  TO authenticated, anon;
GRANT SELECT ON public.engine_book   TO authenticated, anon;
GRANT SELECT ON public.engine_stats  TO authenticated, anon;

-- ─── NOTIFY trigger ───────────────────────────────────────────────
-- Engines LISTEN on 'order_event_added'; payload is the new id. They
-- still do `SELECT ... WHERE id > last_seen_id` so a missed notify (e.g.
-- engine restart) is recovered on the next event.

CREATE OR REPLACE FUNCTION public.order_events_notify()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM pg_notify('order_event_added', NEW.id::text);
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS order_events_notify_trg ON public.order_events;
CREATE TRIGGER order_events_notify_trg
AFTER INSERT ON public.order_events
FOR EACH ROW EXECUTE FUNCTION public.order_events_notify();

-- ─── place_order RPC (frontend) ───────────────────────────────────
-- Frontend posts here instead of INSERTing directly so we can stamp
-- client_id from auth.uid() and validate the payload server-side.

CREATE OR REPLACE FUNCTION public.place_order(
  p_symbol text,
  p_side   text,
  p_type   text,
  p_price  numeric,
  p_qty    numeric,
  p_parent bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  uid    uuid := auth.uid();
  new_id bigint;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF p_side NOT IN ('buy','sell') THEN
    RAISE EXCEPTION 'side must be buy or sell';
  END IF;
  IF p_type NOT IN ('limit','market','cancel') THEN
    RAISE EXCEPTION 'order_type must be limit, market, or cancel';
  END IF;
  IF p_type = 'limit' AND (p_price IS NULL OR p_price <= 0) THEN
    RAISE EXCEPTION 'limit orders require a positive price';
  END IF;
  IF p_qty <= 0 AND p_type <> 'cancel' THEN
    RAISE EXCEPTION 'qty must be positive';
  END IF;

  INSERT INTO public.order_events
    (symbol, side, order_type, price, qty, client_id, parent_order)
  VALUES
    (p_symbol, p_side, p_type, p_price, p_qty, uid, p_parent)
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.place_order(text,text,text,numeric,numeric,bigint) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.place_order(text,text,text,numeric,numeric,bigint) TO authenticated, anon;
-- anon = the guest-JWT path used by signInAnonymously — without this the
-- "Send order" button on the public dashboard returns "insufficient
-- privileges" because the proxy runs the RPC under the JWT's role and
-- the guest token never escalates above anon. Real per-user RPC would
-- of course keep this restricted to authenticated only.

-- ─── pgr.subscribe live queries ───────────────────────────────────
-- All read-only public — no audience binding because the matching state
-- is intentionally observable by every viewer (this is the showcase).

-- pgr.subscribe raises if the query_id is already registered. Wrap in
-- DO blocks with EXCEPTION so re-running migration.sql on an already-
-- bootstrapped DB doesn't abort the file. (SELECT ... ON CONFLICT is
-- INSERT syntax — not valid here.)
DO $$
BEGIN
  PERFORM pgr.subscribe(
    'top_of_book_BTCUSD',
    $sql$
      SELECT side, price, SUM(total_qty) AS total_qty, SUM(order_count) AS order_count
      FROM public.engine_book
      WHERE symbol = 'BTC-USD'
      GROUP BY side, price
      ORDER BY side, CASE WHEN side='buy' THEN -price ELSE price END
      LIMIT 20
    $sql$,
    'delta',
    NULL
  );
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  PERFORM pgr.subscribe(
    'engine_perf_summary',
    $sql$
      SELECT engine, total_orders, total_matches, total_volume,
             ROUND(avg_latency_us::numeric, 1) AS avg_latency_us,
             p99_latency_us, last_updated
      FROM public.engine_stats
      ORDER BY engine
    $sql$,
    'delta',
    NULL
  );
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Per-engine subscriptions are registered in a loop because the engine
-- list is small and stable.
DO $$
DECLARE
  e text;
BEGIN
  FOR e IN SELECT unnest(ARRAY['go','spring','fastapi','rust','dotnet','node']) LOOP
    PERFORM pgr.subscribe(
      'recent_fills_' || e,
      format($sql$
        SELECT id, order_id, matched_qty, fill_price, latency_us, taker_side, ts
        FROM public.engine_fills
        WHERE engine = %L
        ORDER BY ts DESC
        LIMIT 20
      $sql$, e),
      'delta',
      NULL
    );
    PERFORM pgr.subscribe(
      'engine_book_' || e || '_BTCUSD',
      format($sql$
        SELECT side, price, total_qty, order_count
        FROM public.engine_book
        WHERE engine = %L AND symbol = 'BTC-USD'
        ORDER BY side, CASE WHEN side='buy' THEN -price ELSE price END
        LIMIT 10
      $sql$, e),
      'delta',
      NULL
    );
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- subscribe is idempotent on the proxy side but pgr.subscribe itself
  -- raises if the query_id is already present. swallow the duplicate.
  NULL;
END $$;
