// Polyglot matching engine — Rust port of apps/polyglot/engines/go/main.go.
//
// tokio-postgres for the LISTEN/queries side. BTreeMap is the natural fit
// for the price-level ladder (sorted, O(log n) insert/peek). Same
// price-time priority algorithm as the Go reference.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::env;
use std::time::Instant;

use futures_util::stream::StreamExt;
use tokio_postgres::{AsyncMessage, Client, NoTls};

const RESERVOIR_MAX: usize = 1024;

#[derive(Debug, Clone, Copy)]
struct OrderId(i64);

#[derive(Debug)]
struct RestingOrder {
    id: i64,
    qty: f64,
}

struct Book {
    side: &'static str, // "buy" or "sell"
    /// Price levels. For bids we read in reverse; for asks ascending.
    levels: BTreeMap<u64, VecDeque<RestingOrder>>, // key = price * 1e8 as int for total ordering
    by_id: HashMap<i64, u64>, // order id -> price key
}

fn price_key(p: f64) -> u64 { (p * 1e8).round() as u64 }
fn price_val(k: u64) -> f64 { (k as f64) / 1e8 }

impl Book {
    fn new(side: &'static str) -> Self {
        Self { side, levels: BTreeMap::new(), by_id: HashMap::new() }
    }

    fn best(&self) -> Option<u64> {
        if self.side == "buy" {
            self.levels.keys().next_back().copied()
        } else {
            self.levels.keys().next().copied()
        }
    }

    fn total_qty_at(&self, k: u64) -> f64 {
        self.levels.get(&k).map(|q| q.iter().map(|o| o.qty).sum()).unwrap_or(0.0)
    }

    fn order_count_at(&self, k: u64) -> usize {
        self.levels.get(&k).map(|q| q.len()).unwrap_or(0)
    }

    fn add(&mut self, id: i64, price: f64, qty: f64) {
        let k = price_key(price);
        self.levels.entry(k).or_default().push_back(RestingOrder { id, qty });
        self.by_id.insert(id, k);
    }

    fn cancel(&mut self, id: i64) {
        if let Some(k) = self.by_id.remove(&id) {
            if let Some(q) = self.levels.get_mut(&k) {
                if let Some(pos) = q.iter().position(|o| o.id == id) {
                    q.remove(pos);
                }
                if q.is_empty() {
                    self.levels.remove(&k);
                }
            }
        }
    }
}

struct SymbolState { bids: Book, asks: Book }

impl SymbolState {
    fn new() -> Self { Self { bids: Book::new("buy"), asks: Book::new("sell") } }

    fn match_order(&mut self, order: &OrderRow, started: Instant) -> Vec<Fill> {
        let mut fills = Vec::new();
        let (opposite, mine_side_is_buy) = match order.side.as_str() {
            "buy"  => (&mut self.asks, true),
            "sell" => (&mut self.bids, false),
            _      => return fills,
        };
        let mut remaining = order.qty;
        let limit_key = if order.order_type == "limit" { Some(price_key(order.price)) } else { None };

        while remaining > 0.0 {
            let Some(best) = opposite.best() else { break };
            if let Some(lk) = limit_key {
                let crosses = if mine_side_is_buy { best <= lk } else { best >= lk };
                if !crosses { break; }
            }
            let queue = opposite.levels.get_mut(&best).unwrap();
            while let Some(head) = queue.front_mut() {
                if remaining <= 0.0 { break; }
                let matched = head.qty.min(remaining);
                fills.push(Fill {
                    order_id: order.id,
                    matched_qty: matched,
                    fill_price: price_val(best),
                    latency_us: (started.elapsed().as_micros() as i64).max(1) as i32,
                    taker_side: order.side.clone(),
                });
                head.qty -= matched;
                remaining -= matched;
                if head.qty <= 0.0 {
                    let popped = queue.pop_front().unwrap();
                    opposite.by_id.remove(&popped.id);
                }
            }
            if queue.is_empty() {
                opposite.levels.remove(&best);
            }
        }
        if order.order_type == "limit" && remaining > 0.0 {
            let mine = if mine_side_is_buy { &mut self.bids } else { &mut self.asks };
            mine.add(order.id, order.price, remaining);
        }
        fills
    }
}

#[derive(Debug, Clone)]
struct OrderRow {
    id: i64,
    symbol: String,
    side: String,
    order_type: String,
    price: f64,
    qty: f64,
    parent_order: Option<i64>,
}

#[derive(Debug)]
struct Fill {
    order_id: i64,
    matched_qty: f64,
    fill_price: f64,
    latency_us: i32,
    taker_side: String,
}

struct Engine {
    name: String,
    last_seen_id: i64,
    state: HashMap<String, SymbolState>,
    reservoir: VecDeque<i32>,
}

impl Engine {
    fn new(name: String) -> Self {
        Self { name, last_seen_id: 0, state: HashMap::new(), reservoir: VecDeque::with_capacity(RESERVOIR_MAX) }
    }

    fn stats(&self) -> (f64, i32) {
        if self.reservoir.is_empty() { return (0.0, 0); }
        let sum: i64 = self.reservoir.iter().map(|&v| v as i64).sum();
        let avg = sum as f64 / self.reservoir.len() as f64;
        let mut s: Vec<i32> = self.reservoir.iter().copied().collect();
        s.sort_unstable();
        let idx = ((s.len() as f64 * 0.99) as usize).min(s.len() - 1);
        (avg, s[idx])
    }

    async fn drain_once(&mut self, client: &mut Client) -> Result<(), Box<dyn std::error::Error>> {
        let rows = client.query(
            "SELECT id, symbol, side, order_type, COALESCE(price, 0)::float8, qty::float8, parent_order \
             FROM public.order_events WHERE id > $1 ORDER BY id LIMIT 256",
            &[&self.last_seen_id],
        ).await?;
        if rows.is_empty() { return Ok(()); }

        let mut all_fills: Vec<Fill> = Vec::new();
        let mut touched: HashMap<String, HashSet<(String, u64)>> = HashMap::new();
        let mut order_list: Vec<OrderRow> = Vec::with_capacity(rows.len());

        for r in &rows {
            order_list.push(OrderRow {
                id: r.get(0),
                symbol: r.get(1),
                side: r.get(2),
                order_type: r.get(3),
                price: r.get(4),
                qty: r.get(5),
                parent_order: r.get(6),
            });
        }

        for o in &order_list {
            let started = Instant::now();
            let st = self.state.entry(o.symbol.clone()).or_insert_with(SymbolState::new);
            if o.order_type == "cancel" {
                if let Some(parent) = o.parent_order {
                    st.bids.cancel(parent);
                    st.asks.cancel(parent);
                }
                continue;
            }
            let fills = st.match_order(o, started);
            all_fills.extend(fills.into_iter().inspect(|f| {
                touched.entry(o.symbol.clone()).or_default()
                    .insert((opposite_side(&o.side), price_key(f.fill_price)));
            }));
            let ts = touched.entry(o.symbol.clone()).or_default();
            ts.insert((opposite_side(&o.side), price_key(o.price)));
            ts.insert((o.side.clone(), price_key(o.price)));
        }

        let tx = client.build_transaction().start().await?;
        for f in &all_fills {
            tx.execute(
                "INSERT INTO public.engine_fills \
                   (engine, order_id, matched_qty, fill_price, latency_us, taker_side) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
                &[&self.name, &f.order_id, &f.matched_qty, &f.fill_price, &f.latency_us, &f.taker_side],
            ).await?;
            if self.reservoir.len() >= RESERVOIR_MAX { self.reservoir.pop_front(); }
            self.reservoir.push_back(f.latency_us);
        }

        for (symbol, levels) in &touched {
            let st = self.state.get(symbol).unwrap();
            for (side, k) in levels {
                let book = if side == "buy" { &st.bids } else { &st.asks };
                let total = book.total_qty_at(*k);
                let count = book.order_count_at(*k) as i32;
                let price = price_val(*k);
                if total == 0.0 {
                    tx.execute(
                        "DELETE FROM public.engine_book WHERE engine=$1 AND symbol=$2 AND side=$3 AND price=$4",
                        &[&self.name, symbol, side, &price],
                    ).await?;
                } else {
                    tx.execute(
                        "INSERT INTO public.engine_book (engine, symbol, side, price, total_qty, order_count, updated_at) \
                         VALUES ($1, $2, $3, $4, $5, $6, now()) \
                         ON CONFLICT (engine, symbol, side, price) DO UPDATE \
                           SET total_qty = EXCLUDED.total_qty, \
                               order_count = EXCLUDED.order_count, \
                               updated_at = now()",
                        &[&self.name, symbol, side, &price, &total, &count],
                    ).await?;
                }
            }
        }

        let (avg, p99) = self.stats();
        let total_orders = order_list.len() as i64;
        let total_matches = all_fills.len() as i64;
        let total_volume: f64 = all_fills.iter().map(|f| f.matched_qty).sum();
        tx.execute(
            "UPDATE public.engine_stats SET \
               total_orders   = total_orders   + $2, \
               total_matches  = total_matches  + $3, \
               total_volume   = total_volume   + $4, \
               avg_latency_us = $5, \
               p99_latency_us = $6, \
               last_updated   = now() \
             WHERE engine = $1",
            &[&self.name, &total_orders, &total_matches, &total_volume, &avg, &p99],
        ).await?;
        tx.commit().await?;

        self.last_seen_id = order_list.last().unwrap().id;
        Ok(())
    }
}

fn opposite_side(s: &str) -> String {
    if s == "buy" { "sell".to_string() } else { "buy".to_string() }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dsn = env::var("DATABASE_URL").expect("DATABASE_URL is required");
    let name = env::var("ENGINE_NAME").unwrap_or_else(|_| "rust".to_string());

    let (mut drain_client, drain_conn) = tokio_postgres::connect(&dsn, NoTls).await?;
    tokio::spawn(async move {
        if let Err(e) = drain_conn.await { eprintln!("drain conn error: {e}"); }
    });

    let (listen_client, mut listen_conn) = tokio_postgres::connect(&dsn, NoTls).await?;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        let mut stream = futures_util::stream::poll_fn(move |cx| listen_conn.poll_message(cx));
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(AsyncMessage::Notification(n)) => {
                    let _ = tx.send(n.channel().to_string());
                }
                Ok(_) => {}
                Err(e) => { eprintln!("listen err: {e}"); break; }
            }
        }
    });

    listen_client.batch_execute("LISTEN order_event_added").await?;
    let mut engine = Engine::new(name.clone());
    if let Err(e) = engine.drain_once(&mut drain_client).await { eprintln!("initial drain: {e}"); }
    eprintln!("engine {name} listening on order_event_added");

    while let Some(_chan) = rx.recv().await {
        if let Err(e) = engine.drain_once(&mut drain_client).await { eprintln!("drain: {e}"); }
    }
    Ok(())
}
