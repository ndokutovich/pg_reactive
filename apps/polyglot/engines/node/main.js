// Polyglot matching engine — Node port of apps/polyglot/engines/go/main.go.
//
// Same wire contract: LISTEN order_event_added, drain new rows, run
// price-time priority limit matching in memory, write fills + book
// snapshots + stats in one transaction per batch.
//
// Implementation differs from the Go reference in the book data
// structure — Node has no sorted-map primitive in stdlib, so the
// price levels are a plain object keyed by price and we re-sort the
// price array when levels are added/removed. Same asymptotic shape
// as the Go version, just expressed in JS idiom.

'use strict';

const { Client } = require('pg');

const ENGINE_NAME = process.env.ENGINE_NAME || 'node';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

class Book {
  constructor(side) {
    this.side = side;           // 'buy' or 'sell'
    this.levels = Object.create(null);   // price -> { price, orders: [] }
    this.prices = [];           // sorted prices; best first
    this.byId = new Map();      // orderId -> { price, qty }
  }

  resort() {
    this.prices = Object.keys(this.levels).map(Number);
    if (this.side === 'buy') {
      this.prices.sort((a, b) => b - a);
    } else {
      this.prices.sort((a, b) => a - b);
    }
  }

  best() {
    return this.prices.length > 0 ? this.prices[0] : null;
  }

  totalQtyAt(price) {
    const lv = this.levels[price];
    if (!lv) return 0;
    let t = 0;
    for (const o of lv.orders) t += o.qty;
    return t;
  }

  add(orderId, price, qty) {
    let lv = this.levels[price];
    if (!lv) {
      lv = { price, orders: [] };
      this.levels[price] = lv;
      this.resort();
    }
    const ro = { id: orderId, qty };
    lv.orders.push(ro);
    this.byId.set(orderId, { price, ro });
  }

  cancel(orderId) {
    const ref = this.byId.get(orderId);
    if (!ref) return;
    this.byId.delete(orderId);
    const lv = this.levels[ref.price];
    if (!lv) return;
    const i = lv.orders.indexOf(ref.ro);
    if (i >= 0) lv.orders.splice(i, 1);
    if (lv.orders.length === 0) {
      delete this.levels[ref.price];
      this.resort();
    }
  }
}

class SymbolState {
  constructor() { this.bids = new Book('buy'); this.asks = new Book('sell'); }
  match(order, startHrtime) {
    const fills = [];
    const opposite = order.side === 'buy' ? this.asks : this.bids;
    let remaining = Number(order.qty);

    while (remaining > 0) {
      const bestPrice = opposite.best();
      if (bestPrice == null) break;
      if (order.order_type === 'limit') {
        if (order.side === 'buy'  && bestPrice > Number(order.price)) break;
        if (order.side === 'sell' && bestPrice < Number(order.price)) break;
      }
      const lv = opposite.levels[bestPrice];
      while (lv.orders.length > 0 && remaining > 0) {
        const head = lv.orders[0];
        const matched = Math.min(head.qty, remaining);
        const ns = process.hrtime.bigint() - startHrtime;
        fills.push({
          orderId: order.id,
          matchedQty: matched,
          fillPrice: bestPrice,
          latencyUs: Math.max(1, Number(ns) / 1000) | 0,
          takerSide: order.side,
        });
        head.qty -= matched;
        remaining -= matched;
        if (head.qty <= 0) {
          opposite.byId.delete(head.id);
          lv.orders.shift();
        }
      }
      if (lv.orders.length === 0) {
        delete opposite.levels[bestPrice];
        opposite.resort();
      }
    }
    if (order.order_type === 'limit' && remaining > 0) {
      const mine = order.side === 'buy' ? this.bids : this.asks;
      mine.add(order.id, Number(order.price), remaining);
    }
    return fills;
  }
}

const state = new Map();      // symbol -> SymbolState
const latencyReservoir = [];  // capped at 1024
let lastSeenId = 0n;

function statsFor(reservoir) {
  if (reservoir.length === 0) return [0, 0];
  let sum = 0;
  for (const v of reservoir) sum += v;
  const avg = sum / reservoir.length;
  const sorted = reservoir.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
  return [avg, sorted[idx]];
}

async function drainOnce(client) {
  const res = await client.query(
    `SELECT id, symbol, side, order_type, COALESCE(price, 0) AS price, qty, parent_order
       FROM public.order_events
      WHERE id > $1
      ORDER BY id
      LIMIT 256`,
    [String(lastSeenId)]
  );
  if (res.rows.length === 0) return;

  const allFills = [];
  const touched = new Map(); // symbol -> Map((side,price) -> true)

  for (const row of res.rows) {
    const start = process.hrtime.bigint();
    let st = state.get(row.symbol);
    if (!st) { st = new SymbolState(); state.set(row.symbol, st); }

    if (row.order_type === 'cancel' && row.parent_order != null) {
      st.bids.cancel(Number(row.parent_order));
      st.asks.cancel(Number(row.parent_order));
      continue;
    }
    const fills = st.match(row, start);
    allFills.push(...fills);

    let t = touched.get(row.symbol);
    if (!t) { t = new Map(); touched.set(row.symbol, t); }
    t.set(row.side === 'buy' ? 'sell|' + Number(row.price) : 'buy|' + Number(row.price), true);
    t.set(row.side + '|' + Number(row.price), true);
    for (const f of fills) {
      t.set((row.side === 'buy' ? 'sell|' : 'buy|') + f.fillPrice, true);
    }
  }

  await client.query('BEGIN');
  try {
    for (const f of allFills) {
      await client.query(
        `INSERT INTO public.engine_fills (engine, order_id, matched_qty, fill_price, latency_us, taker_side)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ENGINE_NAME, f.orderId, f.matchedQty, f.fillPrice, f.latencyUs, f.takerSide]
      );
      latencyReservoir.push(f.latencyUs);
      while (latencyReservoir.length > 1024) latencyReservoir.shift();
    }

    for (const [symbol, levels] of touched) {
      const st = state.get(symbol);
      for (const key of levels.keys()) {
        const [side, priceStr] = key.split('|');
        const price = Number(priceStr);
        const book = side === 'buy' ? st.bids : st.asks;
        const total = book.totalQtyAt(price);
        const count = book.levels[price] ? book.levels[price].orders.length : 0;
        if (total === 0) {
          await client.query(
            `DELETE FROM public.engine_book WHERE engine=$1 AND symbol=$2 AND side=$3 AND price=$4`,
            [ENGINE_NAME, symbol, side, price]
          );
        } else {
          await client.query(
            `INSERT INTO public.engine_book (engine, symbol, side, price, total_qty, order_count, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (engine, symbol, side, price) DO UPDATE
               SET total_qty = EXCLUDED.total_qty,
                   order_count = EXCLUDED.order_count,
                   updated_at = now()`,
            [ENGINE_NAME, symbol, side, price, total, count]
          );
        }
      }
    }

    const [avg, p99] = statsFor(latencyReservoir);
    const totalVolume = allFills.reduce((s, f) => s + Number(f.matchedQty), 0);
    await client.query(
      `UPDATE public.engine_stats
          SET total_orders   = total_orders + $2,
              total_matches  = total_matches + $3,
              total_volume   = total_volume  + $4,
              avg_latency_us = $5,
              p99_latency_us = $6,
              last_updated   = now()
        WHERE engine = $1`,
      [ENGINE_NAME, res.rows.length, allFills.length, totalVolume, avg, p99 | 0]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }

  lastSeenId = BigInt(res.rows[res.rows.length - 1].id);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Serialize drain so two notifications in-flight don't collide on the same
// pg client (manifests as "client.query when already executing").
let draining = false;
let pending = false;
async function safeDrain(client) {
  if (draining) { pending = true; return; }
  draining = true;
  try {
    do {
      pending = false;
      await drainOnce(client);
    } while (pending);
  } finally { draining = false; }
}

async function connectClient() {
  const c = new Client({ connectionString: DATABASE_URL });
  await c.connect();
  return c;
}

async function main() {
  let drainClient = null;
  let listenClient = null;

  while (true) {
    try {
      drainClient = await connectClient();
      listenClient = await connectClient();
      listenClient.on('error', (e) => { console.error('listen err:', e.message); listenClient?.end().catch(()=>{}); listenClient = null; });
      drainClient.on('error',  (e) => { console.error('drain err:',  e.message); drainClient?.end().catch(()=>{});  drainClient  = null; });
      listenClient.on('notification', () => {
        if (drainClient) safeDrain(drainClient).catch(e => console.error('drain:', e.message));
      });
      await listenClient.query('LISTEN order_event_added');
      console.log(`engine ${ENGINE_NAME} listening on order_event_added`);
      try { await safeDrain(drainClient); } catch (e) { console.error('initial drain:', e.message); }
      // Block until either client dies.
      while (drainClient && listenClient) await sleep(1000);
      console.error('a client died — reconnecting in 2s');
    } catch (e) {
      console.error('connect error:', e.message);
    }
    try { await drainClient?.end(); } catch {}
    try { await listenClient?.end(); } catch {}
    drainClient = null; listenClient = null;
    await sleep(2000);
  }
}

main().catch(err => { console.error('fatal:', err); process.exit(1); });
