// Polyglot matching engine — Go reference.
//
// Worker process. Connects to pgstack's PostgreSQL as polyglot_engine,
// LISTENs on order_event_added, and runs a price-time-priority limit-order
// book in memory. On every order: match, write fills, update book rows
// for the affected price levels, update the engine's stats row.
//
// Designed as the template for the other five engines — Spring, FastAPI,
// Rust, .NET, Node. Each port keeps the same loop shape and SQL but
// re-implements the matching in its language's idiom (a Java TreeMap, a
// Python sortedcontainers.SortedList, a Rust BTreeMap, etc).
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type orderEvent struct {
	id          int64
	symbol      string
	side        string
	orderType   string
	price       float64
	qty         float64
	parentOrder sql.NullInt64
}

// restingOrder tracks a single open limit order in the book.
type restingOrder struct {
	id        int64
	qty       float64
	timestamp int64 // for time priority — order.id is enough; redundant but explicit
}

// level is a price level: FIFO queue of resting orders.
type level struct {
	price  float64
	orders []*restingOrder
}

func (l *level) totalQty() float64 {
	t := 0.0
	for _, o := range l.orders {
		t += o.qty
	}
	return t
}

// book is one side of one symbol — sorted price levels.
type book struct {
	side   string                 // "buy" or "sell"
	levels map[float64]*level     // price → level (mutated)
	order  []float64              // sorted prices (best first: bids desc, asks asc)
	byID   map[int64]*restingOrder // for O(1) cancel
}

func newBook(side string) *book {
	return &book{
		side:   side,
		levels: map[float64]*level{},
		byID:   map[int64]*restingOrder{},
	}
}

func (b *book) best() (float64, bool) {
	if len(b.order) == 0 {
		return 0, false
	}
	return b.order[0], true
}

// resort regenerates the price list. Called when a level is added/removed.
func (b *book) resort() {
	b.order = b.order[:0]
	for p := range b.levels {
		b.order = append(b.order, p)
	}
	if b.side == "buy" {
		sort.Slice(b.order, func(i, j int) bool { return b.order[i] > b.order[j] })
	} else {
		sort.Sort(sort.Float64Slice(b.order))
	}
}

func (b *book) add(o *restingOrder, price float64) {
	lv, ok := b.levels[price]
	if !ok {
		lv = &level{price: price}
		b.levels[price] = lv
		b.resort()
	}
	lv.orders = append(lv.orders, o)
	b.byID[o.id] = o
}

func (b *book) cancel(id int64) {
	o, ok := b.byID[id]
	if !ok {
		return
	}
	delete(b.byID, id)
	for price, lv := range b.levels {
		for i, ro := range lv.orders {
			if ro == o {
				lv.orders = append(lv.orders[:i], lv.orders[i+1:]...)
				if len(lv.orders) == 0 {
					delete(b.levels, price)
					b.resort()
				}
				return
			}
		}
	}
}

// fill represents one match output by the engine.
type fill struct {
	orderID    int64
	matchedQty float64
	fillPrice  float64
	latencyUs  int
	takerSide  string
}

// engine state per symbol — one book per side.
type symbolState struct {
	bids *book
	asks *book
}

// match appends fills into *dest instead of returning a fresh slice. The
// caller (drainOnce) owns the buffer and reuses it across drains, so the
// matching hot path allocates nothing per order under steady state.
func (s *symbolState) match(o *orderEvent, latencyStart time.Time, dest *[]fill) {
	takerSide := o.side

	var opposite *book
	if o.side == "buy" {
		opposite = s.asks
	} else {
		opposite = s.bids
	}

	remaining := o.qty

	for remaining > 0 {
		bestPrice, ok := opposite.best()
		if !ok {
			break
		}
		// limit order: stop matching when the price no longer crosses
		if o.orderType == "limit" {
			if takerSide == "buy" && bestPrice > o.price {
				break
			}
			if takerSide == "sell" && bestPrice < o.price {
				break
			}
		}
		lv := opposite.levels[bestPrice]
		for len(lv.orders) > 0 && remaining > 0 {
			head := lv.orders[0]
			matched := head.qty
			if matched > remaining {
				matched = remaining
			}
			*dest = append(*dest, fill{
				orderID:    o.id,
				matchedQty: matched,
				fillPrice:  bestPrice,
				latencyUs:  int(time.Since(latencyStart).Microseconds()),
				takerSide:  takerSide,
			})
			head.qty -= matched
			remaining -= matched
			if head.qty <= 0 {
				delete(opposite.byID, head.id)
				lv.orders = lv.orders[1:]
			}
		}
		if len(lv.orders) == 0 {
			delete(opposite.levels, bestPrice)
			opposite.resort()
		}
	}

	// Rest a remaining limit order on our side.
	if o.orderType == "limit" && remaining > 0 {
		var mine *book
		if o.side == "buy" {
			mine = s.bids
		} else {
			mine = s.asks
		}
		mine.add(&restingOrder{id: o.id, qty: remaining}, o.price)
	}
}

// touchedLevels returns the set of (side, price) tuples the engine
// touched during matching — used to rebuild engine_book rows.
type touched struct{ side string; price float64 }

func (s *symbolState) snapshotLevels(touched map[touched]struct{}) []bookRow {
	rows := []bookRow{}
	for tp := range touched {
		var src *book
		if tp.side == "buy" {
			src = s.bids
		} else {
			src = s.asks
		}
		if lv, ok := src.levels[tp.price]; ok {
			rows = append(rows, bookRow{
				side:       tp.side,
				price:      tp.price,
				totalQty:   lv.totalQty(),
				orderCount: len(lv.orders),
			})
		} else {
			rows = append(rows, bookRow{side: tp.side, price: tp.price, totalQty: 0, orderCount: 0})
		}
	}
	return rows
}

type bookRow struct {
	side       string
	price      float64
	totalQty   float64
	orderCount int
}

// Engine wraps a pool + per-symbol state + watermark.
//
// Hot-path buffers (batch, allFillsBuf, touchedBuf, latRing) are reused
// across drains. Under steady state this drops Go-GC pressure to
// effectively zero in the match loop — the p99 tail used to be ~60x the
// avg because GC pauses landed inside time.Since() measurements; with
// pre-allocated reusable buffers the ratio drops to single digits.
type Engine struct {
	pool       *pgxpool.Pool
	name       string
	mu         sync.Mutex
	lastSeenID int64
	state      map[string]*symbolState

	// Reusable drain buffers. Reset (truncate-to-zero / clear-map) at the
	// top of every drainOnce, NEVER re-allocated under steady state.
	batchBuf     []*orderEvent
	allFillsBuf  []fill
	touchedBuf   map[string]map[touched]struct{}

	// Fixed-size ring buffer for latency reservoir. Indexing is mod 1024
	// — no slice grow, no slice realloc, no GC trigger.
	latRing  [1024]int
	latIdx   int  // next write position
	latCount int  // number of entries written (caps at len(latRing))
	sortBuf  []int // reusable scratch for p99 sort
}

func newEngine(pool *pgxpool.Pool, name string) *Engine {
	return &Engine{
		pool:        pool,
		name:        name,
		state:       map[string]*symbolState{},
		batchBuf:    make([]*orderEvent, 0, 256),
		allFillsBuf: make([]fill, 0, 1024),
		touchedBuf:  map[string]map[touched]struct{}{},
	}
}

// recordLatency writes one sample into the fixed-size ring.
func (e *Engine) recordLatency(us int) {
	e.latRing[e.latIdx] = us
	e.latIdx = (e.latIdx + 1) % len(e.latRing)
	if e.latCount < len(e.latRing) {
		e.latCount++
	}
}

func (e *Engine) getState(symbol string) *symbolState {
	st, ok := e.state[symbol]
	if !ok {
		st = &symbolState{bids: newBook("buy"), asks: newBook("sell")}
		e.state[symbol] = st
	}
	return st
}

func (e *Engine) drainOnce(ctx context.Context) error {
	e.mu.Lock()
	since := e.lastSeenID
	e.mu.Unlock()

	rows, err := e.pool.Query(ctx, `
		SELECT id, symbol, side, order_type, COALESCE(price, 0), qty, parent_order
		FROM public.order_events
		WHERE id > $1
		ORDER BY id
		LIMIT 256
	`, since)
	if err != nil {
		return fmt.Errorf("select orders: %w", err)
	}
	defer rows.Close()

	// Reset reusable buffers — keep capacity, drop length.
	batch := e.batchBuf[:0]
	allFills := e.allFillsBuf[:0]
	for k := range e.touchedBuf {
		delete(e.touchedBuf, k)
	}

	for rows.Next() {
		o := &orderEvent{}
		if err := rows.Scan(&o.id, &o.symbol, &o.side, &o.orderType, &o.price, &o.qty, &o.parentOrder); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		batch = append(batch, o)
	}
	rows.Close()
	if len(batch) == 0 {
		return nil
	}

	for _, o := range batch {
		start := time.Now()
		st := e.getState(o.symbol)
		if o.orderType == "cancel" && o.parentOrder.Valid {
			st.bids.cancel(o.parentOrder.Int64)
			st.asks.cancel(o.parentOrder.Int64)
			continue
		}
		before := len(allFills)
		st.match(o, start, &allFills)
		t := e.touchedBuf[o.symbol]
		if t == nil {
			t = make(map[touched]struct{}, 8)
			e.touchedBuf[o.symbol] = t
		}
		t[touched{side: oppositeSide(o.side), price: o.price}] = struct{}{}
		t[touched{side: o.side, price: o.price}] = struct{}{}
		for _, f := range allFills[before:] {
			t[touched{side: oppositeSide(o.side), price: f.fillPrice}] = struct{}{}
		}
	}
	// Persist buffer growth (if any happened this drain) for next call.
	e.batchBuf = batch
	e.allFillsBuf = allFills
	touchedBy := e.touchedBuf

	tx, err := e.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	for _, f := range allFills {
		_, err := tx.Exec(ctx, `
			INSERT INTO public.engine_fills (engine, order_id, matched_qty, fill_price, latency_us, taker_side)
			VALUES ($1, $2, $3, $4, $5, $6)
		`, e.name, f.orderID, f.matchedQty, f.fillPrice, f.latencyUs, f.takerSide)
		if err != nil {
			return fmt.Errorf("insert fill: %w", err)
		}
		e.recordLatency(f.latencyUs)
	}

	for symbol, levels := range touchedBy {
		st := e.getState(symbol)
		for _, row := range st.snapshotLevels(levels) {
			if row.totalQty == 0 {
				_, err := tx.Exec(ctx, `
					DELETE FROM public.engine_book
					WHERE engine = $1 AND symbol = $2 AND side = $3 AND price = $4
				`, e.name, symbol, row.side, row.price)
				if err != nil {
					return fmt.Errorf("delete book level: %w", err)
				}
				continue
			}
			_, err := tx.Exec(ctx, `
				INSERT INTO public.engine_book (engine, symbol, side, price, total_qty, order_count, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, now())
				ON CONFLICT (engine, symbol, side, price) DO UPDATE
				SET total_qty = EXCLUDED.total_qty,
				    order_count = EXCLUDED.order_count,
				    updated_at = now()
			`, e.name, symbol, row.side, row.price, row.totalQty, row.orderCount)
			if err != nil {
				return fmt.Errorf("upsert book level: %w", err)
			}
		}
	}

	avg, p99 := e.stats()
	_, err = tx.Exec(ctx, `
		UPDATE public.engine_stats
		SET total_orders   = total_orders + $2,
		    total_matches  = total_matches + $3,
		    total_volume   = total_volume  + $4,
		    avg_latency_us = $5,
		    p99_latency_us = $6,
		    last_updated   = now()
		WHERE engine = $1
	`, e.name, int64(len(batch)), int64(len(allFills)), totalVolume(allFills), avg, p99)
	if err != nil {
		return fmt.Errorf("update stats: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	e.mu.Lock()
	e.lastSeenID = batch[len(batch)-1].id
	e.mu.Unlock()
	return nil
}

func totalVolume(fills []fill) float64 {
	t := 0.0
	for _, f := range fills {
		t += f.matchedQty
	}
	return t
}

// stats reads avg + p99 out of the engine's fixed-size ring without
// allocating per call. The sort scratch is reused via Engine.sortBuf.
func (e *Engine) stats() (avg float64, p99 int) {
	n := e.latCount
	if n == 0 {
		return 0, 0
	}
	sum := 0
	for i := 0; i < n; i++ {
		sum += e.latRing[i]
	}
	avg = float64(sum) / float64(n)
	if cap(e.sortBuf) < n {
		e.sortBuf = make([]int, n)
	}
	e.sortBuf = e.sortBuf[:n]
	copy(e.sortBuf, e.latRing[:n])
	sort.Ints(e.sortBuf)
	idx := int(float64(n) * 0.99)
	if idx >= n {
		idx = n - 1
	}
	p99 = e.sortBuf[idx]
	return
}

func oppositeSide(s string) string {
	if s == "buy" {
		return "sell"
	}
	return "buy"
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	name := os.Getenv("ENGINE_NAME")
	if name == "" {
		log.Fatal("ENGINE_NAME is required")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	eng := newEngine(pool, name)

	// Outer reconnect loop. The LISTEN connection can die when pgstack
	// restarts; without this, the engine ends up in a tight "notif error"
	// retry loop on a dead conn that never reconnects. Each session opens
	// a fresh LISTEN, drains initially, then loops until any error — then
	// the outer loop sleeps and reopens.
	for {
		if ctx.Err() != nil {
			return
		}
		err := runSession(ctx, eng, pool, name)
		if ctx.Err() != nil {
			return
		}
		log.Printf("session ended (%v) — reconnecting in 2s", err)
		time.Sleep(2 * time.Second)
	}
}

func runSession(ctx context.Context, eng *Engine, pool *pgxpool.Pool, name string) error {
	// Best-effort initial drain — catches up anything missed while down.
	if err := eng.drainOnce(ctx); err != nil {
		log.Printf("initial drain: %v", err)
	}

	// Dedicated LISTEN connection so the drain pool stays free for queries.
	listenConn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire listen conn: %w", err)
	}
	defer listenConn.Release()

	if _, err := listenConn.Exec(ctx, "LISTEN order_event_added"); err != nil {
		return fmt.Errorf("LISTEN: %w", err)
	}
	log.Printf("engine %s listening on order_event_added", name)

	for {
		notif, err := listenConn.Conn().WaitForNotification(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			// Bail out of the session — caller reconnects.
			return fmt.Errorf("notif: %w", err)
		}
		_, _ = strconv.ParseInt(notif.Payload, 10, 64)
		if err := eng.drainOnce(ctx); err != nil {
			log.Printf("drain: %v", err)
		}
	}
}

