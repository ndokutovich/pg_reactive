// Polyglot matching engine — Go reference.
//
// Worker process. Connects to pgstack's PostgreSQL as polyglot_engine,
// LISTENs on order_event_added, and runs a price-time-priority limit-order
// book in memory. On every order: match, write fills, update book rows
// for the affected price levels, update the engine's stats row.
//
// Normalized profile (shared by all six engines so the leaderboard reflects
// the language, not the implementation): decimal money math, an O(log n)
// sorted price ladder (google/btree), O(1)-amortized FIFO at each level,
// O(1) cancel via id→price, a fixed-size latency ring, and a max(1)µs floor
// on the reported latency. The other five ports mirror these choices in
// their language's idiom (Java TreeMap, Python SortedDict, Rust BTreeMap,
// .NET SortedDictionary, Node js-sdsl OrderedMap).
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

	"github.com/google/btree"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/shopspring/decimal"
)

var zero = decimal.Zero

type orderEvent struct {
	id          int64
	symbol      string
	side        string
	orderType   string
	price       decimal.Decimal
	qty         decimal.Decimal
	parentOrder sql.NullInt64
}

// restingOrder tracks a single open limit order in the book.
type restingOrder struct {
	id  int64
	qty decimal.Decimal
}

// level is a price level: FIFO queue of resting orders. head advances on
// pop so the front removal is O(1) amortized — no per-fill array shift.
type level struct {
	price  decimal.Decimal
	orders []*restingOrder
	head   int
}

func (l *level) len() int          { return len(l.orders) - l.head }
func (l *level) front() *restingOrder { return l.orders[l.head] }

func (l *level) popFront() {
	l.orders[l.head] = nil
	l.head++
	// Compact when the dead prefix dominates, so a hot level doesn't grow
	// its backing array without bound.
	if l.head > 8 && l.head*2 >= len(l.orders) {
		l.orders = append(l.orders[:0], l.orders[l.head:]...)
		l.head = 0
	}
}

func (l *level) totalQty() decimal.Decimal {
	t := zero
	for _, o := range l.orders[l.head:] {
		t = t.Add(o.qty)
	}
	return t
}

// book is one side of one symbol — a B-tree price ladder (O(log n) insert,
// peek, delete) plus an id→price index for O(1) cancel location.
type book struct {
	side string // "buy" or "sell"
	tree *btree.BTreeG[*level]
	byID map[int64]decimal.Decimal
}

func priceLess(a, b *level) bool { return a.price.LessThan(b.price) }

func newBook(side string) *book {
	return &book{
		side: side,
		tree: btree.NewG[*level](8, priceLess),
		byID: map[int64]decimal.Decimal{},
	}
}

// best returns the level at the top of book: highest bid, lowest ask.
func (b *book) best() (*level, bool) {
	if b.tree.Len() == 0 {
		return nil, false
	}
	if b.side == "buy" {
		return b.tree.Max()
	}
	return b.tree.Min()
}

func (b *book) levelAt(price decimal.Decimal) (*level, bool) {
	return b.tree.Get(&level{price: price})
}

func (b *book) add(o *restingOrder, price decimal.Decimal) {
	lv, ok := b.tree.Get(&level{price: price})
	if !ok {
		lv = &level{price: price}
		b.tree.ReplaceOrInsert(lv)
	}
	lv.orders = append(lv.orders, o)
	b.byID[o.id] = price
}

func (b *book) removeLevel(price decimal.Decimal) {
	b.tree.Delete(&level{price: price})
}

func (b *book) cancel(id int64) {
	price, ok := b.byID[id]
	if !ok {
		return
	}
	delete(b.byID, id)
	lv, ok := b.levelAt(price)
	if !ok {
		return
	}
	for i := lv.head; i < len(lv.orders); i++ {
		if lv.orders[i] != nil && lv.orders[i].id == id {
			lv.orders = append(lv.orders[:i], lv.orders[i+1:]...)
			break
		}
	}
	if lv.len() == 0 {
		b.removeLevel(price)
	}
}

// fill represents one match output by the engine.
type fill struct {
	orderID    int64
	matchedQty decimal.Decimal
	fillPrice  decimal.Decimal
	latencyUs  int
	takerSide  string
}

// engine state per symbol — one book per side.
type symbolState struct {
	bids *book
	asks *book
}

// match appends fills into *dest. The caller owns the buffer and reuses it
// across drains, so the matching hot path allocates little per order.
func (s *symbolState) match(o *orderEvent, latencyStart time.Time, dest *[]fill) {
	takerSide := o.side

	var opposite *book
	if o.side == "buy" {
		opposite = s.asks
	} else {
		opposite = s.bids
	}

	remaining := o.qty

	for remaining.GreaterThan(zero) {
		lv, ok := opposite.best()
		if !ok {
			break
		}
		// limit order: stop matching when the price no longer crosses
		if o.orderType == "limit" {
			if takerSide == "buy" && lv.price.GreaterThan(o.price) {
				break
			}
			if takerSide == "sell" && lv.price.LessThan(o.price) {
				break
			}
		}
		for lv.len() > 0 && remaining.GreaterThan(zero) {
			head := lv.front()
			matched := head.qty
			if matched.GreaterThan(remaining) {
				matched = remaining
			}
			lat := int(time.Since(latencyStart).Microseconds())
			if lat < 1 {
				lat = 1
			}
			*dest = append(*dest, fill{
				orderID:    o.id,
				matchedQty: matched,
				fillPrice:  lv.price,
				latencyUs:  lat,
				takerSide:  takerSide,
			})
			head.qty = head.qty.Sub(matched)
			remaining = remaining.Sub(matched)
			if head.qty.LessThanOrEqual(zero) {
				delete(opposite.byID, head.id)
				lv.popFront()
			}
		}
		if lv.len() == 0 {
			opposite.removeLevel(lv.price)
		}
	}

	// Rest a remaining limit order on our side.
	if o.orderType == "limit" && remaining.GreaterThan(zero) {
		var mine *book
		if o.side == "buy" {
			mine = s.bids
		} else {
			mine = s.asks
		}
		mine.add(&restingOrder{id: o.id, qty: remaining}, o.price)
	}
}

// touchedKey identifies a (side, price) level the engine touched. Price is
// the canonical decimal string so equal values collapse to one key.
type touchedKey struct {
	side  string
	price string
}

type bookRow struct {
	side       string
	price      decimal.Decimal
	totalQty   decimal.Decimal
	orderCount int
}

func (s *symbolState) snapshotLevels(touched map[touchedKey]struct{}) []bookRow {
	rows := []bookRow{}
	for tk := range touched {
		price := decimal.RequireFromString(tk.price)
		var src *book
		if tk.side == "buy" {
			src = s.bids
		} else {
			src = s.asks
		}
		if lv, ok := src.levelAt(price); ok {
			rows = append(rows, bookRow{
				side:       tk.side,
				price:      price,
				totalQty:   lv.totalQty(),
				orderCount: lv.len(),
			})
		} else {
			rows = append(rows, bookRow{side: tk.side, price: price, totalQty: zero, orderCount: 0})
		}
	}
	return rows
}

// Engine wraps a pool + per-symbol state + watermark. Hot-path buffers are
// reused across drains to keep GC pressure off the match loop.
type Engine struct {
	pool       *pgxpool.Pool
	name       string
	mu         sync.Mutex
	lastSeenID int64
	state      map[string]*symbolState

	batchBuf    []*orderEvent
	allFillsBuf []fill
	touchedBuf  map[string]map[touchedKey]struct{}

	// Fixed-size ring buffer for the latency reservoir — no slice grow.
	latRing  [1024]int
	latIdx   int
	latCount int
	sortBuf  []int
}

func newEngine(pool *pgxpool.Pool, name string) *Engine {
	return &Engine{
		pool:        pool,
		name:        name,
		state:       map[string]*symbolState{},
		batchBuf:    make([]*orderEvent, 0, 256),
		allFillsBuf: make([]fill, 0, 1024),
		touchedBuf:  map[string]map[touchedKey]struct{}{},
	}
}

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
		SELECT id, symbol, side, order_type,
		       COALESCE(price, 0)::text, qty::text, parent_order
		FROM public.order_events
		WHERE id > $1
		ORDER BY id
		LIMIT 256
	`, since)
	if err != nil {
		return fmt.Errorf("select orders: %w", err)
	}
	defer rows.Close()

	batch := e.batchBuf[:0]
	allFills := e.allFillsBuf[:0]
	for k := range e.touchedBuf {
		delete(e.touchedBuf, k)
	}

	for rows.Next() {
		o := &orderEvent{}
		var priceStr, qtyStr string
		if err := rows.Scan(&o.id, &o.symbol, &o.side, &o.orderType, &priceStr, &qtyStr, &o.parentOrder); err != nil {
			return fmt.Errorf("scan: %w", err)
		}
		o.price = decimal.RequireFromString(priceStr)
		o.qty = decimal.RequireFromString(qtyStr)
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
			t = make(map[touchedKey]struct{}, 8)
			e.touchedBuf[o.symbol] = t
		}
		t[touchedKey{side: oppositeSide(o.side), price: o.price.String()}] = struct{}{}
		t[touchedKey{side: o.side, price: o.price.String()}] = struct{}{}
		for _, f := range allFills[before:] {
			t[touchedKey{side: oppositeSide(o.side), price: f.fillPrice.String()}] = struct{}{}
		}
	}
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
			VALUES ($1, $2, $3::numeric, $4::numeric, $5, $6)
		`, e.name, f.orderID, f.matchedQty.String(), f.fillPrice.String(), f.latencyUs, f.takerSide)
		if err != nil {
			return fmt.Errorf("insert fill: %w", err)
		}
		e.recordLatency(f.latencyUs)
	}

	for symbol, levels := range touchedBy {
		st := e.getState(symbol)
		for _, row := range st.snapshotLevels(levels) {
			if row.totalQty.LessThanOrEqual(zero) {
				_, err := tx.Exec(ctx, `
					DELETE FROM public.engine_book
					WHERE engine = $1 AND symbol = $2 AND side = $3 AND price = $4::numeric
				`, e.name, symbol, row.side, row.price.String())
				if err != nil {
					return fmt.Errorf("delete book level: %w", err)
				}
				continue
			}
			_, err := tx.Exec(ctx, `
				INSERT INTO public.engine_book (engine, symbol, side, price, total_qty, order_count, updated_at)
				VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6, now())
				ON CONFLICT (engine, symbol, side, price) DO UPDATE
				SET total_qty = EXCLUDED.total_qty,
				    order_count = EXCLUDED.order_count,
				    updated_at = now()
			`, e.name, symbol, row.side, row.price.String(), row.totalQty.String(), row.orderCount)
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
		    total_volume   = total_volume  + $4::numeric,
		    avg_latency_us = $5,
		    p99_latency_us = $6,
		    last_updated   = now()
		WHERE engine = $1
	`, e.name, int64(len(batch)), int64(len(allFills)), totalVolume(allFills).String(), avg, p99)
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

func totalVolume(fills []fill) decimal.Decimal {
	t := zero
	for _, f := range fills {
		t = t.Add(f.matchedQty)
	}
	return t
}

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
	if err := eng.drainOnce(ctx); err != nil {
		log.Printf("initial drain: %v", err)
	}

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
			return fmt.Errorf("notif: %w", err)
		}
		_, _ = strconv.ParseInt(notif.Payload, 10, 64)
		if err := eng.drainOnce(ctx); err != nil {
			log.Printf("drain: %v", err)
		}
	}
}
