// Polyglot matching engine — Node port of apps/polyglot/engines/go/main.go.
//
// Same wire contract: LISTEN order_event_added, drain new rows, run
// price-time priority limit matching in memory, write fills + book
// snapshots + stats in one transaction per batch.
//
// Normalized profile (shared by all six engines so the leaderboard
// reflects the language, not the implementation): decimal money math
// (decimal.js), an O(log n) sorted price ladder (js-sdsl OrderedMap, a
// red-black tree), O(1)-amortized FIFO at each level, O(1) cancel via
// id→price, a fixed-size latency ring, and a max(1)µs floor on the
// reported latency. Mirrors the Go reference's choices in JS idiom.

'use strict';

const { Client } = require('pg');
const Decimal = require('decimal.js');
const { OrderedMap } = require('js-sdsl');

const ZERO = new Decimal(0);
// OrderedMap comparator: numeric ordering over Decimal keys.
const cmpDecimal = (a, b) => a.cmp(b);

const ENGINE_NAME = process.env.ENGINE_NAME || 'node';
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

// A price level: FIFO queue of resting orders. `head` advances on pop so
// front removal is O(1) amortized — no per-fill array shift. Mirrors the
// Go reference's level.popFront.
function newLevel(price) {
  return { price, orders: [], head: 0 };
}
function levelLen(lv) { return lv.orders.length - lv.head; }
function levelFront(lv) { return lv.orders[lv.head]; }
function levelPopFront(lv) {
  lv.orders[lv.head] = null;
  lv.head++;
  // Compact when the dead prefix dominates, so a hot level doesn't grow
  // its backing array without bound.
  if (lv.head > 8 && lv.head * 2 >= lv.orders.length) {
    lv.orders = lv.orders.slice(lv.head);
    lv.head = 0;
  }
}
function levelTotalQty(lv) {
  let t = ZERO;
  for (let i = lv.head; i < lv.orders.length; i++) t = t.add(lv.orders[i].qty);
  return t;
}

// book is one side of one symbol — a red-black-tree price ladder (O(log n)
// insert, peek, delete) plus an id→price index for O(1) cancel location.
class Book {
  constructor(side) {
    this.side = side;                                 // 'buy' or 'sell'
    this.tree = new OrderedMap([], cmpDecimal);       // Decimal price -> level
    this.byId = new Map();                            // orderId -> Decimal price
  }

  // best returns the level at the top of book: highest bid, lowest ask.
  best() {
    if (this.tree.size() === 0) return null;
    const entry = this.side === 'buy' ? this.tree.back() : this.tree.front();
    return entry[1];
  }

  levelAt(price) {
    return this.tree.getElementByKey(price); // level or undefined
  }

  add(orderId, price, qty) {
    let lv = this.tree.getElementByKey(price);
    if (lv === undefined) {
      lv = newLevel(price);
      this.tree.setElement(price, lv);
    }
    lv.orders.push({ id: orderId, qty });
    this.byId.set(orderId, price);
  }

  removeLevel(price) {
    this.tree.eraseElementByKey(price);
  }

  cancel(orderId) {
    const price = this.byId.get(orderId);
    if (price === undefined) return;
    this.byId.delete(orderId);
    const lv = this.levelAt(price);
    if (lv === undefined) return;
    for (let i = lv.head; i < lv.orders.length; i++) {
      if (lv.orders[i] != null && lv.orders[i].id === orderId) {
        lv.orders.splice(i, 1);
        break;
      }
    }
    if (levelLen(lv) === 0) this.removeLevel(price);
  }
}

class SymbolState {
  constructor() { this.bids = new Book('buy'); this.asks = new Book('sell'); }

  match(order, startHrtime) {
    const fills = [];
    const takerSide = order.side;
    const opposite = takerSide === 'buy' ? this.asks : this.bids;
    let remaining = new Decimal(order.qty);

    while (remaining.gt(ZERO)) {
      const lv = opposite.best();
      if (lv == null) break;
      // limit order: stop matching when the price no longer crosses.
      if (order.order_type === 'limit') {
        if (takerSide === 'buy' && lv.price.gt(order.price)) break;
        if (takerSide === 'sell' && lv.price.lt(order.price)) break;
      }
      while (levelLen(lv) > 0 && remaining.gt(ZERO)) {
        const head = levelFront(lv);
        const matched = Decimal.min(head.qty, remaining);
        const ns = process.hrtime.bigint() - startHrtime;
        fills.push({
          orderId: order.id,
          matchedQty: matched,
          fillPrice: lv.price,
          latencyUs: Math.max(1, Number(ns) / 1000) | 0,
          takerSide,
        });
        head.qty = head.qty.sub(matched);
        remaining = remaining.sub(matched);
        if (head.qty.lte(ZERO)) {
          opposite.byId.delete(head.id);
          levelPopFront(lv);
        }
      }
      if (levelLen(lv) === 0) opposite.removeLevel(lv.price);
    }

    // Rest a remaining limit order on our side.
    if (order.order_type === 'limit' && remaining.gt(ZERO)) {
      const mine = takerSide === 'buy' ? this.bids : this.asks;
      mine.add(order.id, order.price, remaining);
    }
    return fills;
  }

  // snapshotLevels resolves the touched (side, priceString) keys to current
  // book rows. Mirrors the Go reference's snapshotLevels.
  snapshotLevels(levelKeys) {
    const rows = [];
    for (const key of levelKeys.keys()) {
      const sep = key.indexOf('|');
      const side = key.slice(0, sep);
      const price = new Decimal(key.slice(sep + 1));
      const src = side === 'buy' ? this.bids : this.asks;
      const lv = src.levelAt(price);
      if (lv !== undefined) {
        rows.push({ side, price, totalQty: levelTotalQty(lv), orderCount: levelLen(lv) });
      } else {
        rows.push({ side, price, totalQty: ZERO, orderCount: 0 });
      }
    }
    return rows;
  }
}

const state = new Map();      // symbol -> SymbolState
let lastSeenId = 0n;

// Fixed-size ring buffer for the latency reservoir — no slice grow/shift.
const LAT_RING_SIZE = 1024;
const latRing = new Array(LAT_RING_SIZE).fill(0);
let latIdx = 0;
let latCount = 0;
function recordLatency(us) {
  latRing[latIdx] = us;
  latIdx = (latIdx + 1) % LAT_RING_SIZE;
  if (latCount < LAT_RING_SIZE) latCount++;
}
function stats() {
  if (latCount === 0) return [0, 0];
  let sum = 0;
  for (let i = 0; i < latCount; i++) sum += latRing[i];
  const avg = sum / latCount;
  const sorted = latRing.slice(0, latCount).sort((a, b) => a - b);
  const idx = Math.min(latCount - 1, Math.floor(latCount * 0.99));
  return [avg, sorted[idx]];
}

function oppositeSide(side) { return side === 'buy' ? 'sell' : 'buy'; }

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
  const touched = new Map(); // symbol -> Map(side|priceString -> true)

  for (const row of res.rows) {
    const start = process.hrtime.bigint();
    let st = state.get(row.symbol);
    if (!st) { st = new SymbolState(); state.set(row.symbol, st); }

    if (row.order_type === 'cancel' && row.parent_order != null) {
      st.bids.cancel(Number(row.parent_order));
      st.asks.cancel(Number(row.parent_order));
      continue;
    }

    // node-postgres returns NUMERIC columns as strings; parse to Decimal.
    const order = {
      id: row.id,
      side: row.side,
      order_type: row.order_type,
      price: new Decimal(row.price),
      qty: new Decimal(row.qty),
    };
    const fills = st.match(order, start);
    allFills.push(...fills);

    let t = touched.get(row.symbol);
    if (!t) { t = new Map(); touched.set(row.symbol, t); }
    const priceKey = order.price.toString();
    t.set(oppositeSide(row.side) + '|' + priceKey, true);
    t.set(row.side + '|' + priceKey, true);
    for (const f of fills) {
      t.set(oppositeSide(row.side) + '|' + f.fillPrice.toString(), true);
    }
  }

  await client.query('BEGIN');
  try {
    for (const f of allFills) {
      await client.query(
        `INSERT INTO public.engine_fills (engine, order_id, matched_qty, fill_price, latency_us, taker_side)
         VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6)`,
        [ENGINE_NAME, f.orderId, f.matchedQty.toString(), f.fillPrice.toString(), f.latencyUs, f.takerSide]
      );
      recordLatency(f.latencyUs);
    }

    for (const [symbol, levelKeys] of touched) {
      const st = state.get(symbol);
      for (const row of st.snapshotLevels(levelKeys)) {
        if (row.totalQty.lte(ZERO)) {
          await client.query(
            `DELETE FROM public.engine_book WHERE engine=$1 AND symbol=$2 AND side=$3 AND price=$4::numeric`,
            [ENGINE_NAME, symbol, row.side, row.price.toString()]
          );
        } else {
          await client.query(
            `INSERT INTO public.engine_book (engine, symbol, side, price, total_qty, order_count, updated_at)
             VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, now())
             ON CONFLICT (engine, symbol, side, price) DO UPDATE
               SET total_qty = EXCLUDED.total_qty,
                   order_count = EXCLUDED.order_count,
                   updated_at = now()`,
            [ENGINE_NAME, symbol, row.side, row.price.toString(), row.totalQty.toString(), row.orderCount]
          );
        }
      }
    }

    const [avg, p99] = stats();
    const totalVolume = allFills.reduce((s, f) => s.add(f.matchedQty), ZERO);
    await client.query(
      `UPDATE public.engine_stats
          SET total_orders   = total_orders + $2,
              total_matches  = total_matches + $3,
              total_volume   = total_volume  + $4::numeric,
              avg_latency_us = $5,
              p99_latency_us = $6,
              last_updated   = now()
        WHERE engine = $1`,
      [ENGINE_NAME, res.rows.length, allFills.length, totalVolume.toString(), avg, p99 | 0]
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

if (require.main === module) {
  main().catch(err => { console.error('fatal:', err); process.exit(1); });
}

module.exports = { Book, SymbolState, Decimal };
