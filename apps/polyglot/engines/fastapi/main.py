"""Polyglot matching engine — Python port of apps/polyglot/engines/go/main.go.

Uses asyncpg for non-blocking LISTEN + drain. The matching algorithm is
identical (price-time priority, FIFO at each level); the book is expressed
with sortedcontainers.SortedDict so price-level retrieval stays O(log n).

The engine name registered with pgstack is `fastapi` to match the
showcase's language flag — the surrounding ecosystem (asyncpg, async/await,
type hints) is what Python brings to the polyglot table, not the FastAPI
HTTP framework specifically. A future variant can layer FastAPI on top to
expose health / metrics endpoints, but the worker loop itself is the
load-bearing piece.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Optional

import asyncpg
from sortedcontainers import SortedDict


ENGINE_NAME = os.environ.get("ENGINE_NAME", "fastapi")
DATABASE_URL = os.environ["DATABASE_URL"]
RESERVOIR_MAX = 1024


@dataclass
class RestingOrder:
    id: int
    qty: float


@dataclass
class Level:
    price: float
    orders: list[RestingOrder] = field(default_factory=list)

    def total_qty(self) -> float:
        return sum(o.qty for o in self.orders)


class Book:
    """One side of one symbol; sorted by best-first."""

    def __init__(self, side: str) -> None:
        self.side = side
        # SortedDict ordered ascending; we read best via index trick.
        self.levels: SortedDict[float, Level] = SortedDict()
        self.by_id: dict[int, tuple[float, RestingOrder]] = {}

    def best(self) -> Optional[float]:
        if not self.levels:
            return None
        return self.levels.peekitem(-1 if self.side == "buy" else 0)[0]

    def total_qty_at(self, price: float) -> float:
        lv = self.levels.get(price)
        return lv.total_qty() if lv else 0.0

    def order_count_at(self, price: float) -> int:
        lv = self.levels.get(price)
        return len(lv.orders) if lv else 0

    def add(self, order_id: int, price: float, qty: float) -> None:
        lv = self.levels.get(price)
        if lv is None:
            lv = Level(price=price)
            self.levels[price] = lv
        ro = RestingOrder(id=order_id, qty=qty)
        lv.orders.append(ro)
        self.by_id[order_id] = (price, ro)

    def cancel(self, order_id: int) -> None:
        ref = self.by_id.pop(order_id, None)
        if ref is None:
            return
        price, ro = ref
        lv = self.levels.get(price)
        if lv is None:
            return
        try:
            lv.orders.remove(ro)
        except ValueError:
            return
        if not lv.orders:
            del self.levels[price]


class SymbolState:
    def __init__(self) -> None:
        self.bids = Book("buy")
        self.asks = Book("sell")

    def match(self, order: asyncpg.Record, started: int) -> list[dict]:
        fills: list[dict] = []
        opposite = self.asks if order["side"] == "buy" else self.bids
        remaining = float(order["qty"])

        while remaining > 0:
            best = opposite.best()
            if best is None:
                break
            if order["order_type"] == "limit":
                limit_price = float(order["price"])
                if order["side"] == "buy" and best > limit_price:
                    break
                if order["side"] == "sell" and best < limit_price:
                    break
            lv = opposite.levels[best]
            while lv.orders and remaining > 0:
                head = lv.orders[0]
                matched = min(head.qty, remaining)
                fills.append({
                    "order_id": order["id"],
                    "matched_qty": matched,
                    "fill_price": best,
                    "latency_us": max(1, (time.monotonic_ns() - started) // 1000),
                    "taker_side": order["side"],
                })
                head.qty -= matched
                remaining -= matched
                if head.qty <= 0:
                    opposite.by_id.pop(head.id, None)
                    lv.orders.pop(0)
            if not lv.orders:
                del opposite.levels[best]

        if order["order_type"] == "limit" and remaining > 0:
            mine = self.bids if order["side"] == "buy" else self.asks
            mine.add(order["id"], float(order["price"]), remaining)
        return fills


class Engine:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.last_seen_id = 0
        self.state: dict[str, SymbolState] = {}
        self.reservoir: list[int] = []

    def get_state(self, symbol: str) -> SymbolState:
        st = self.state.get(symbol)
        if st is None:
            st = SymbolState()
            self.state[symbol] = st
        return st

    def stats(self) -> tuple[float, int]:
        if not self.reservoir:
            return 0.0, 0
        avg = sum(self.reservoir) / len(self.reservoir)
        s = sorted(self.reservoir)
        idx = min(len(s) - 1, int(len(s) * 0.99))
        return avg, s[idx]

    async def drain_once(self) -> None:
        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, symbol, side, order_type, COALESCE(price, 0) AS price,
                       qty, parent_order
                FROM public.order_events
                WHERE id > $1
                ORDER BY id
                LIMIT 256
                """,
                self.last_seen_id,
            )
            if not rows:
                return

            all_fills: list[dict] = []
            touched: dict[str, set[tuple[str, float]]] = {}

            for row in rows:
                started = time.monotonic_ns()
                st = self.get_state(row["symbol"])
                if row["order_type"] == "cancel" and row["parent_order"] is not None:
                    st.bids.cancel(row["parent_order"])
                    st.asks.cancel(row["parent_order"])
                    continue
                fills = st.match(row, started)
                all_fills.extend(fills)
                ts = touched.setdefault(row["symbol"], set())
                opp_side = "sell" if row["side"] == "buy" else "buy"
                ts.add((opp_side, float(row["price"])))
                ts.add((row["side"], float(row["price"])))
                for f in fills:
                    ts.add((opp_side, f["fill_price"]))

            async with conn.transaction():
                for f in all_fills:
                    await conn.execute(
                        """
                        INSERT INTO public.engine_fills
                            (engine, order_id, matched_qty, fill_price, latency_us, taker_side)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        """,
                        ENGINE_NAME, f["order_id"], f["matched_qty"], f["fill_price"],
                        int(f["latency_us"]), f["taker_side"],
                    )
                    self.reservoir.append(int(f["latency_us"]))
                    if len(self.reservoir) > RESERVOIR_MAX:
                        del self.reservoir[: len(self.reservoir) - RESERVOIR_MAX]

                for symbol, levels in touched.items():
                    st = self.get_state(symbol)
                    for side, price in levels:
                        book = st.bids if side == "buy" else st.asks
                        total = book.total_qty_at(price)
                        count = book.order_count_at(price)
                        if total == 0:
                            await conn.execute(
                                """DELETE FROM public.engine_book
                                   WHERE engine=$1 AND symbol=$2 AND side=$3 AND price=$4""",
                                ENGINE_NAME, symbol, side, price,
                            )
                        else:
                            await conn.execute(
                                """
                                INSERT INTO public.engine_book
                                    (engine, symbol, side, price, total_qty, order_count, updated_at)
                                VALUES ($1, $2, $3, $4, $5, $6, now())
                                ON CONFLICT (engine, symbol, side, price) DO UPDATE
                                  SET total_qty = EXCLUDED.total_qty,
                                      order_count = EXCLUDED.order_count,
                                      updated_at = now()
                                """,
                                ENGINE_NAME, symbol, side, price, total, count,
                            )

                avg, p99 = self.stats()
                total_volume = sum(float(f["matched_qty"]) for f in all_fills)
                await conn.execute(
                    """
                    UPDATE public.engine_stats
                    SET total_orders  = total_orders + $2,
                        total_matches = total_matches + $3,
                        total_volume  = total_volume + $4,
                        avg_latency_us = $5,
                        p99_latency_us = $6,
                        last_updated   = now()
                    WHERE engine = $1
                    """,
                    ENGINE_NAME, len(rows), len(all_fills), total_volume, avg, p99,
                )

            self.last_seen_id = rows[-1]["id"]


async def run_session(engine: "Engine") -> None:
    """One LISTEN+drain session. Returns/raises when the connection dies;
    the outer reconnect loop in main() then sleeps and restarts the session.
    Drain calls are serialised by an asyncio.Lock so two NOTIFY arrivals
    can't enter Engine.drain_once concurrently on the shared pool."""
    pool = engine.pool
    try:
        await engine.drain_once()
    except Exception as e:
        print(f"initial drain: {e}", flush=True)

    listen_conn: asyncpg.Connection = await pool.acquire()
    closed = asyncio.Event()
    drain_lock = asyncio.Lock()

    async def on_notify(*_args) -> None:
        try:
            async with drain_lock:
                await engine.drain_once()
        except Exception as e:
            print(f"drain: {e}", flush=True)
            closed.set()

    def on_termination(*_args) -> None:
        print("listen conn terminated by server", flush=True)
        closed.set()

    listen_conn.add_termination_listener(on_termination)
    await listen_conn.add_listener("order_event_added", on_notify)
    print(f"engine {ENGINE_NAME} listening on order_event_added", flush=True)

    try:
        await closed.wait()
    finally:
        try: await listen_conn.remove_listener("order_event_added", on_notify)
        except Exception: pass
        try: listen_conn.remove_termination_listener(on_termination)
        except Exception: pass
        try: await pool.release(listen_conn)
        except Exception: pass


async def main() -> None:
    while True:
        pool = None
        try:
            pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=4)
            engine = Engine(pool)
            await run_session(engine)
            print("session ended cleanly — reconnecting in 2s", flush=True)
        except Exception as e:
            print(f"session error: {e} — reconnecting in 2s", flush=True)
        finally:
            if pool is not None:
                try: await pool.close()
                except Exception: pass
        await asyncio.sleep(2)


if __name__ == "__main__":
    asyncio.run(main())
