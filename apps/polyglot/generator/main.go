// Polyglot generator — synthetic order producer.
//
// Connects to pgstack's PostgreSQL as a dedicated role and INSERTs orders
// into public.order_events at a configurable rate. Bypasses the
// place_order RPC (which requires auth.uid()) — the generator is a
// trusted internal service, not a user.
//
// The order distribution is intentionally simple: random walk on price
// around a mid, randomised side and qty, occasional cancels. Enough to
// keep the engines busy without being interesting.
package main

import (
	"context"
	"log"
	"math/rand"
	"os"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const generatorClientID = "00000000-0000-0000-0000-000000000001"

type spec struct {
	symbol string
	mid    float64
}

func envFloat(k string, def float64) float64 {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return def
	}
	return f
}

func envInt(k string, def int) int {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL is required")
	}
	ratePerSec := envInt("ORDERS_PER_SEC", 4)
	symbol := os.Getenv("SYMBOL")
	if symbol == "" {
		symbol = "BTC-USD"
	}
	mid := envFloat("MID_PRICE", 50000)
	spread := envFloat("SPREAD", 25)
	maxQty := envFloat("MAX_QTY", 1.5)
	cancelRate := envFloat("CANCEL_RATE", 0.05)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatalf("pool: %v", err)
	}
	defer pool.Close()

	log.Printf("generator: %s @ %.0f ± %.0f, %d orders/sec (cancel rate %.0f%%)",
		symbol, mid, spread, ratePerSec, cancelRate*100)

	interval := time.Second / time.Duration(ratePerSec)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Track recently-placed limit orders so we can cancel them.
	recent := make([]int64, 0, 64)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		if rand.Float64() < cancelRate && len(recent) > 0 {
			i := rand.Intn(len(recent))
			parent := recent[i]
			recent = append(recent[:i], recent[i+1:]...)
			_, err := pool.Exec(ctx, `
				INSERT INTO public.order_events
					(symbol, side, order_type, price, qty, client_id, parent_order)
				VALUES ($1, 'buy', 'cancel', NULL, 0, $2, $3)
			`, symbol, generatorClientID, parent)
			if err != nil {
				log.Printf("cancel: %v", err)
			}
			continue
		}

		side := "buy"
		if rand.Float64() < 0.5 {
			side = "sell"
		}
		orderType := "limit"
		if rand.Float64() < 0.1 {
			orderType = "market"
		}
		// Price walks ±spread from mid; market orders ignore price.
		price := mid + (rand.Float64()-0.5)*2*spread
		qty := 0.05 + rand.Float64()*maxQty
		var priceArg interface{}
		if orderType == "limit" {
			priceArg = price
		} else {
			priceArg = nil
		}

		var id int64
		err := pool.QueryRow(ctx, `
			INSERT INTO public.order_events
				(symbol, side, order_type, price, qty, client_id)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id
		`, symbol, side, orderType, priceArg, qty, generatorClientID).Scan(&id)
		if err != nil {
			log.Printf("insert: %v", err)
			continue
		}
		if orderType == "limit" {
			recent = append(recent, id)
			if len(recent) > 64 {
				recent = recent[1:]
			}
		}
	}
}
