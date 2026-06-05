// Polyglot matching engine — Spring Boot port of apps/polyglot/engines/go/main.go.
//
// Spring Boot for application bootstrap; raw JDBC for the LISTEN loop
// (Spring's JdbcTemplate doesn't expose PGConnection.getNotifications()).
// TreeMap for the price-level ladder. Same price-time priority algorithm
// as the Go reference.
package org.pgstack.polyglot;

import org.postgresql.PGConnection;
import org.springframework.boot.CommandLineRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

import java.math.BigDecimal;
import java.sql.*;
import java.util.*;

@SpringBootApplication
public class Application implements CommandLineRunner {

    public static void main(String[] args) { SpringApplication.run(Application.class, args); }

    private final String engineName = System.getenv().getOrDefault("ENGINE_NAME", "spring");
    private final String dsn = jdbcDsn(System.getenv("DATABASE_URL"));

    private final Map<String, SymbolState> state = new HashMap<>();
    private final Deque<Integer> reservoir = new ArrayDeque<>();
    private long lastSeenId = 0L;

    private static final int RESERVOIR_MAX = 1024;

    @Override
    public void run(String... args) throws Exception {
        if (dsn == null) throw new IllegalStateException("DATABASE_URL is required");

        try (Connection drain = DriverManager.getConnection(dsn);
             Connection listen = DriverManager.getConnection(dsn)) {
            try { drainOnce(drain); } catch (Exception e) { System.err.println("initial drain: " + e.getMessage()); }

            try (Statement st = listen.createStatement()) { st.execute("LISTEN order_event_added"); }
            PGConnection pg = listen.unwrap(PGConnection.class);
            System.err.println("engine " + engineName + " listening on order_event_added");

            while (true) {
                try (Statement st = listen.createStatement()) { st.execute("SELECT 1"); }
                var notes = pg.getNotifications(60_000);
                if (notes == null) continue;
                try { drainOnce(drain); } catch (Exception e) { System.err.println("drain: " + e.getMessage()); }
            }
        }
    }

    private static String jdbcDsn(String pgUrl) {
        if (pgUrl == null) return null;
        // postgres://user:pass@host:port/db  ->  jdbc:postgresql://host:port/db + user/pass via DriverManager
        try {
            var u = new java.net.URI(pgUrl);
            String user = "", pass = "";
            if (u.getUserInfo() != null) {
                String[] p = u.getUserInfo().split(":", 2);
                user = p[0]; pass = p.length > 1 ? p[1] : "";
            }
            String host = u.getHost();
            int port   = u.getPort() == -1 ? 5432 : u.getPort();
            String db  = u.getPath().startsWith("/") ? u.getPath().substring(1) : u.getPath();
            return "jdbc:postgresql://" + host + ":" + port + "/" + db
                + "?user=" + user + "&password=" + pass + "&ApplicationName=polyglot-engine-spring";
        } catch (Exception e) { throw new IllegalArgumentException("bad DATABASE_URL: " + e.getMessage()); }
    }

    // ── Engine logic ──

    private SymbolState getState(String symbol) {
        return state.computeIfAbsent(symbol, k -> new SymbolState());
    }

    private void drainOnce(Connection conn) throws SQLException {
        List<OrderRow> rows = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(
                "SELECT id, symbol, side, order_type, COALESCE(price, 0), qty, parent_order " +
                "FROM public.order_events WHERE id > ? ORDER BY id LIMIT 256")) {
            ps.setLong(1, lastSeenId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    long pid = rs.getLong(7);
                    rows.add(new OrderRow(
                            rs.getLong(1),
                            rs.getString(2),
                            rs.getString(3),
                            rs.getString(4),
                            rs.getBigDecimal(5),
                            rs.getBigDecimal(6),
                            rs.wasNull() ? null : pid
                    ));
                }
            }
        }
        if (rows.isEmpty()) return;

        List<Fill> allFills = new ArrayList<>();
        Map<String, Set<LevelKey>> touched = new HashMap<>();
        for (OrderRow o : rows) {
            long start = System.nanoTime();
            SymbolState st = getState(o.symbol);
            if ("cancel".equals(o.orderType) && o.parentOrder != null) {
                st.bids.cancel(o.parentOrder);
                st.asks.cancel(o.parentOrder);
                continue;
            }
            List<Fill> fills = st.match(o, start);
            allFills.addAll(fills);
            Set<LevelKey> ts = touched.computeIfAbsent(o.symbol, k -> new HashSet<>());
            String oppSide = "buy".equals(o.side) ? "sell" : "buy";
            ts.add(new LevelKey(oppSide, o.price));
            ts.add(new LevelKey(o.side, o.price));
            for (Fill f : fills) ts.add(new LevelKey(oppSide, f.fillPrice));
        }

        conn.setAutoCommit(false);
        try {
            try (PreparedStatement ps = conn.prepareStatement(
                    "INSERT INTO public.engine_fills (engine, order_id, matched_qty, fill_price, latency_us, taker_side) " +
                    "VALUES (?, ?, ?, ?, ?, ?)")) {
                for (Fill f : allFills) {
                    ps.setString(1, engineName);
                    ps.setLong(2, f.orderId);
                    ps.setBigDecimal(3, f.matchedQty);
                    ps.setBigDecimal(4, f.fillPrice);
                    ps.setInt(5, f.latencyUs);
                    ps.setString(6, f.takerSide);
                    ps.executeUpdate();
                    reservoir.addLast(f.latencyUs);
                    while (reservoir.size() > RESERVOIR_MAX) reservoir.removeFirst();
                }
            }

            try (PreparedStatement ins = conn.prepareStatement(
                    "INSERT INTO public.engine_book (engine, symbol, side, price, total_qty, order_count, updated_at) " +
                    "VALUES (?, ?, ?, ?, ?, ?, now()) " +
                    "ON CONFLICT (engine, symbol, side, price) DO UPDATE " +
                    "SET total_qty = EXCLUDED.total_qty, order_count = EXCLUDED.order_count, updated_at = now()");
                 PreparedStatement del = conn.prepareStatement(
                    "DELETE FROM public.engine_book WHERE engine=? AND symbol=? AND side=? AND price=?")) {
                for (var entry : touched.entrySet()) {
                    String symbol = entry.getKey();
                    SymbolState st = getState(symbol);
                    for (LevelKey lk : entry.getValue()) {
                        Book book = "buy".equals(lk.side) ? st.bids : st.asks;
                        BigDecimal total = book.totalQtyAt(lk.price);
                        int count = book.orderCountAt(lk.price);
                        if (total.signum() == 0) {
                            del.setString(1, engineName);
                            del.setString(2, symbol);
                            del.setString(3, lk.side);
                            del.setBigDecimal(4, lk.price);
                            del.executeUpdate();
                        } else {
                            ins.setString(1, engineName);
                            ins.setString(2, symbol);
                            ins.setString(3, lk.side);
                            ins.setBigDecimal(4, lk.price);
                            ins.setBigDecimal(5, total);
                            ins.setInt(6, count);
                            ins.executeUpdate();
                        }
                    }
                }
            }

            double[] stats = computeStats();
            BigDecimal totalVolume = BigDecimal.ZERO;
            for (Fill f : allFills) totalVolume = totalVolume.add(f.matchedQty);
            try (PreparedStatement ps = conn.prepareStatement(
                    "UPDATE public.engine_stats SET " +
                    "total_orders = total_orders + ?, " +
                    "total_matches = total_matches + ?, " +
                    "total_volume = total_volume + ?, " +
                    "avg_latency_us = ?, p99_latency_us = ?, last_updated = now() " +
                    "WHERE engine = ?")) {
                ps.setLong(1, rows.size());
                ps.setLong(2, allFills.size());
                ps.setBigDecimal(3, totalVolume);
                ps.setDouble(4, stats[0]);
                ps.setInt(5, (int) stats[1]);
                ps.setString(6, engineName);
                ps.executeUpdate();
            }
            conn.commit();
        } catch (SQLException e) {
            conn.rollback();
            throw e;
        } finally {
            conn.setAutoCommit(true);
        }

        lastSeenId = rows.get(rows.size() - 1).id;
    }

    private double[] computeStats() {
        if (reservoir.isEmpty()) return new double[]{0, 0};
        int[] arr = new int[reservoir.size()];
        int i = 0; long sum = 0;
        for (int v : reservoir) { arr[i++] = v; sum += v; }
        Arrays.sort(arr);
        int idx = Math.min(arr.length - 1, (int) (arr.length * 0.99));
        return new double[]{(double) sum / arr.length, arr[idx]};
    }

    // ── Types ──

    record OrderRow(long id, String symbol, String side, String orderType, BigDecimal price,
                    BigDecimal qty, Long parentOrder) {}
    record Fill(long orderId, BigDecimal matchedQty, BigDecimal fillPrice, int latencyUs, String takerSide) {}
    record LevelKey(String side, BigDecimal price) {}

    static class RestingOrder { long id; BigDecimal qty; RestingOrder(long i, BigDecimal q){id=i;qty=q;} }

    static class Book {
        final String side;
        final TreeMap<BigDecimal, Deque<RestingOrder>> levels;
        final Map<Long, BigDecimal> idToPrice = new HashMap<>();
        Book(String side) {
            this.side = side;
            this.levels = "buy".equals(side)
                ? new TreeMap<>(Comparator.reverseOrder())
                : new TreeMap<>();
        }
        BigDecimal best() { return levels.isEmpty() ? null : levels.firstKey(); }
        BigDecimal totalQtyAt(BigDecimal p) {
            var q = levels.get(p);
            if (q == null) return BigDecimal.ZERO;
            BigDecimal t = BigDecimal.ZERO;
            for (RestingOrder o : q) t = t.add(o.qty);
            return t;
        }
        int orderCountAt(BigDecimal p) { var q = levels.get(p); return q == null ? 0 : q.size(); }
        void add(long id, BigDecimal price, BigDecimal qty) {
            levels.computeIfAbsent(price, k -> new ArrayDeque<>()).addLast(new RestingOrder(id, qty));
            idToPrice.put(id, price);
        }
        void cancel(long id) {
            BigDecimal p = idToPrice.remove(id);
            if (p == null) return;
            Deque<RestingOrder> q = levels.get(p);
            if (q == null) return;
            q.removeIf(o -> o.id == id);
            if (q.isEmpty()) levels.remove(p);
        }
    }

    static class SymbolState {
        Book bids = new Book("buy");
        Book asks = new Book("sell");
        List<Fill> match(OrderRow o, long startNanos) {
            List<Fill> fills = new ArrayList<>();
            Book opposite = "buy".equals(o.side) ? asks : bids;
            BigDecimal remaining = o.qty;
            while (remaining.signum() > 0) {
                BigDecimal best = opposite.best();
                if (best == null) break;
                if ("limit".equals(o.orderType)) {
                    int cmp = best.compareTo(o.price);
                    if ("buy".equals(o.side) && cmp > 0) break;
                    if ("sell".equals(o.side) && cmp < 0) break;
                }
                Deque<RestingOrder> queue = opposite.levels.get(best);
                while (!queue.isEmpty() && remaining.signum() > 0) {
                    RestingOrder head = queue.peekFirst();
                    BigDecimal matched = head.qty.min(remaining);
                    int latency = (int) Math.max(1L, (System.nanoTime() - startNanos) / 1000L);
                    fills.add(new Fill(o.id, matched, best, latency, o.side));
                    head.qty = head.qty.subtract(matched);
                    remaining = remaining.subtract(matched);
                    if (head.qty.signum() <= 0) {
                        opposite.idToPrice.remove(head.id);
                        queue.pollFirst();
                    }
                }
                if (queue.isEmpty()) opposite.levels.remove(best);
            }
            if ("limit".equals(o.orderType) && remaining.signum() > 0) {
                Book mine = "buy".equals(o.side) ? bids : asks;
                mine.add(o.id, o.price, remaining);
            }
            return fills;
        }
    }
}
